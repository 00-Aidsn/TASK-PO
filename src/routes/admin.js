/**
 * Admin panel: Microsoft Entra ID sign-in, then manage the TASK API URL, API key and environment name.
 *
 *   GET  /admin                     the admin page
 *   GET  /admin/login               redirect to Microsoft sign-in
 *   GET  /admin/callback            Microsoft redirects back here
 *   GET  /api/admin/me              signed-in admin (or 401)
 *   POST /api/admin/logout
 *   GET  /api/admin/settings        current settings (API key masked)
 *   POST /api/admin/settings/test   test a URL + key against TASK without saving
 *   PUT  /api/admin/settings        save (only after a successful test); signs out all clerks
 *   GET  /api/admin/audit           change history
 *
 * Admin sessions are separate from clerk sessions: cookie po_admin (HttpOnly, SameSite=Strict),
 * ending after ADMIN_SESSION_IDLE_MINUTES idle or ADMIN_SESSION_MAX_HOURS in total.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { createSessionStore, parseCookies } from '../session.js';
import { checkTaskConnection } from '../taskClient.js';
import { adminIdentity, isAllowedAdmin } from '../admin/entra.js';

const ADMIN_COOKIE = 'po_admin';
const TX_COOKIE = 'po_admin_tx';
const TX_MAX_AGE_S = 600;
const adminPage = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'admin.html');

function cookie(name, value, { secure, sameSite, path: cookiePath = '/', maxAge }) {
  const parts = [`${name}=${value}`, `Path=${cookiePath}`, 'HttpOnly', `SameSite=${sameSite}`];
  if (secure) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

export function adminRoutes({ config, settings, entra, clerkStore }) {
  const router = Router();
  const { admin } = config;
  const secure = config.cookieSecure;
  const sessions = createSessionStore({ idleMinutes: admin.sessionIdleMinutes });
  const transactions = new Map(); // sign-in attempts waiting for the Microsoft callback
  const maxAgeMs = admin.sessionMaxHours * 3_600_000;
  const publicOrigin = new URL(admin.publicBaseUrl).origin;

  const sweep = setInterval(() => {
    sessions.sweep();
    for (const [id, tx] of transactions) if (Date.now() - tx.createdAt > TX_MAX_AGE_S * 1000) transactions.delete(id);
  }, 60_000);
  sweep.unref();

  function currentAdmin(req) {
    const id = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
    const s = sessions.get(id);
    if (!s) return null;
    if (Date.now() - s.createdAt > maxAgeMs) {
      sessions.destroy(id);
      return null;
    }
    return { id, ...s };
  }

  function requireAdmin(req, res, next) {
    const session = currentAdmin(req);
    if (!session) return res.status(401).json({ code: 'admin_signed_out', error: 'Please sign in to the admin panel.' });
    // Writes must come from this site's own pages.
    if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== publicOrigin) {
      return res.status(403).json({ error: 'Request blocked: it did not come from the admin panel.' });
    }
    req.admin = session.admin;
    req.adminSessionId = session.id;
    next();
  }

  // ---------------------------------------------------------------- sign-in with Microsoft
  router.get('/admin', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(adminPage);
  });

  router.get('/admin/login', async (req, res, next) => {
    try {
      const { url, transaction } = await entra.startLogin();
      const txId = crypto.randomBytes(24).toString('base64url');
      // Keep at most 500 sign-ins in progress; the oldest are dropped first.
      while (transactions.size >= 500) transactions.delete(transactions.keys().next().value);
      transactions.set(txId, transaction);
      // Lax, because Microsoft sends the browser back to /admin/callback from another site.
      res.append('Set-Cookie', cookie(TX_COOKIE, txId, { secure, sameSite: 'Lax', path: '/admin', maxAge: TX_MAX_AGE_S }));
      res.set('Cache-Control', 'no-store');
      res.redirect(302, url);
    } catch (err) {
      console.error(`[admin] could not start Entra sign-in: ${err.message}`);
      next(err);
    }
  });

  router.get('/admin/callback', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const txId = parseCookies(req.headers.cookie)[TX_COOKIE];
    const transaction = txId ? transactions.get(txId) : null;
    if (txId) transactions.delete(txId); // single use
    res.append('Set-Cookie', cookie(TX_COOKIE, '', { secure, sameSite: 'Lax', path: '/admin', maxAge: 0 }));
    if (!transaction || Date.now() - transaction.createdAt > TX_MAX_AGE_S * 1000) {
      return res.redirect(302, '/admin?error=expired');
    }

    let claims;
    try {
      claims = await entra.finishLogin(new URL(req.originalUrl, admin.publicBaseUrl), transaction);
    } catch (err) {
      console.error(`[admin] Entra sign-in failed: ${err.error || err.code || ''} ${err.message}`);
      return res.redirect(302, '/admin?error=signin_failed');
    }

    const who = adminIdentity(claims);
    if (!isAllowedAdmin(claims, admin)) {
      console.warn(`[admin] refused sign-in for ${who.username || '(unknown)'} oid=${who.oid} tid=${who.tid}`);
      settings.audit('admin_sign_in_refused', who, { tenant: who.tid });
      return res.redirect(302, '/admin?error=not_allowed');
    }

    const old = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
    if (old) sessions.destroy(old);
    const id = sessions.create({ admin: who });
    res.append('Set-Cookie', cookie(ADMIN_COOKIE, id, { secure, sameSite: 'Strict' }));
    settings.audit('admin_signed_in', who);
    res.redirect(302, '/admin');
  });

  // ---------------------------------------------------------------- admin API
  router.use('/api/admin', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/api/admin/me', (req, res) => {
    const session = currentAdmin(req);
    if (!session) return res.status(401).json({ code: 'admin_signed_out', error: 'Not signed in.' });
    const { name, email, oid } = session.admin;
    res.json({ admin: { name, email, oid } });
  });

  router.post('/api/admin/logout', requireAdmin, async (req, res) => {
    sessions.destroy(req.adminSessionId);
    res.append('Set-Cookie', cookie(ADMIN_COOKIE, '', { secure, sameSite: 'Strict', maxAge: 0 }));
    res.json({ logoutUrl: await entra.logoutUrl() });
  });

  router.get('/api/admin/settings', requireAdmin, (req, res) => {
    res.json({ settings: settings.publicView(), activeClerkSessions: clerkStore.size });
  });

  async function testCandidate(body) {
    const current = settings.current();
    const baseUrl = body?.baseUrl ? settings.normaliseUrl(body.baseUrl) : current.baseUrl;
    const apiKey = typeof body?.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : current.apiKey;
    if (!baseUrl) return { baseUrl, ok: false, message: 'Enter the TASK API address.' };
    if (!apiKey) return { baseUrl, ok: false, message: 'Enter the TASK API key.' };
    return { baseUrl, ...(await checkTaskConnection({ baseUrl, apiKey, timeoutMs: config.task.timeoutMs })) };
  }

  router.post('/api/admin/settings/test', requireAdmin, async (req, res) => {
    const result = await testCandidate(req.body);
    res.json({ test: result });
  });

  router.put('/api/admin/settings', requireAdmin, async (req, res) => {
    const body = req.body || {};
    if (body.apiKey !== undefined && typeof body.apiKey !== 'string') return res.status(400).json({ error: 'The API key must be text.' });
    if (typeof body.apiKey === 'string' && body.apiKey.length > 500) return res.status(400).json({ error: 'That API key is too long.' });
    if (body.environmentName !== undefined && typeof body.environmentName !== 'string') {
      return res.status(400).json({ error: 'The environment name must be text.' });
    }

    const current = settings.current();
    const nextUrl = body.baseUrl ? settings.normaliseUrl(body.baseUrl) : current.baseUrl;
    const keyChanging = typeof body.apiKey === 'string' && body.apiKey.trim() !== '' && body.apiKey.trim() !== current.apiKey;
    // A new URL or key is only saved once TASK has accepted it.
    if (nextUrl !== current.baseUrl || keyChanging) {
      const test = await testCandidate(body);
      if (!test.ok) return res.status(422).json({ error: `Not saved. ${test.message}`, test });
    }
    const result = settings.update(
      { baseUrl: nextUrl, apiKey: body.apiKey, environmentName: body.environmentName },
      req.admin,
    );
    res.json(result);
  });

  router.get('/api/admin/audit', requireAdmin, (req, res) => {
    res.json({ entries: settings.readAudit(50) });
  });

  return router;
}
