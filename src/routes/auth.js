import { Router } from 'express';
import { LOGIN_TYPES } from '../config.js';
import { TaskApiError } from '../taskClient.js';

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60_000;

function createLoginLimiter(now = () => Date.now()) {
  const failures = new Map();
  return {
    blocked(key) {
      const f = failures.get(key);
      if (!f) return false;
      if (now() > f.resetAt) {
        failures.delete(key);
        return false;
      }
      return f.count >= MAX_FAILURES;
    },
    fail(key) {
      const f = failures.get(key);
      if (!f || now() > f.resetAt) failures.set(key, { count: 1, resetAt: now() + WINDOW_MS });
      else f.count += 1;
    },
    reset(key) {
      failures.delete(key);
    },
  };
}

export function publicClerk(clerk) {
  return {
    id: clerk.id,
    name: clerk.name,
    email: clerk.email,
    canOrder: clerk.canOrder,
    canApprove: clerk.canApprove,
    canReceive: clerk.canReceive,
    canCommitInvoices: clerk.canCommitInvoices,
  };
}

export function authRoutes({ task, config, settings }) {
  const router = Router();
  const limiter = createLoginLimiter();

  router.get('/config', (req, res) => {
    res.json({
      companyName: config.companyName,
      loginTypes: LOGIN_TYPES,
      defaultLoginType: config.task.defaultLoginType,
      sessionIdleMinutes: config.sessionIdleMinutes,
      mailMode: config.mail.mode,
      // Live TASK connection: an administrator may change it at any time.
      environmentName: settings ? settings.current().environmentName : '',
      configured: settings ? settings.publicView().configured : true,
    });
  });

  router.post('/login', async (req, res, next) => {
    const login = typeof req.body?.login === 'string' ? req.body.login.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const loginType = req.body?.loginType === undefined ? config.task.defaultLoginType : Number(req.body.loginType);

    if (!login || !password) {
      return res.status(400).json({ error: 'Enter your login and password.' });
    }
    if (login.length > 200 || password.length > 200 || !LOGIN_TYPES.some((t) => t.value === loginType)) {
      return res.status(400).json({ error: 'Sign-in details are not valid.' });
    }
    const key = req.ip || 'unknown';
    if (limiter.blocked(key)) {
      return res.status(429).json({ error: 'Too many failed sign-ins. Wait 15 minutes and try again.' });
    }

    let tokens;
    try {
      tokens = await task.loginClerk({ login, password, loginType });
    } catch (err) {
      if (err instanceof TaskApiError && ['unauthorized', 'forbidden', 'rejected', 'not_found'].includes(err.kind)) {
        limiter.fail(key);
        return res.status(401).json({ error: 'Sign-in failed. Check your login type, login and password.' });
      }
      return next(err);
    }
    const accessToken = tokens?.AccessToken || tokens?.accessToken || tokens?.access_token;
    if (!accessToken) {
      return res.status(502).json({ error: 'TASK did not return a session token. Try again or contact IT.' });
    }

    const me = await task.currentClerk(accessToken);
    if (!me || me.IsAuthenticated === false) {
      limiter.fail(key);
      return res.status(401).json({ error: 'Sign-in failed. TASK did not confirm your clerk account.' });
    }
    // Ordering needs "create purchase orders"; receiving needs "create invoices" (TASK books deliveries as invoices).
    if (!me.CanCreatePurchaseOrders && !me.CanCreateInvoices) {
      return res.status(403).json({
        error:
          'Your TASK account is not allowed to create purchase orders or receive stock. Ask your manager to update your TASK permissions.',
      });
    }
    limiter.reset(key);

    const clerk = {
      id: me.UserId,
      name: me.AuthNiceName || login,
      email: me.Email || '',
      locations: Array.isArray(me.Locations) ? me.Locations : [],
      canOrder: Boolean(me.CanCreatePurchaseOrders),
      canApprove: Boolean(me.CanCreatePurchaseOrders && me.CanApprovePurchaseOrders),
      canReceive: Boolean(me.CanCreateInvoices),
      canCommitInvoices: Boolean(me.CanCreateInvoices && me.CanCommitInvoices),
    };
    res.startSession({ accessToken, clerk });
    res.json({ clerk: publicClerk(clerk) });
  });

  router.post('/logout', (req, res) => {
    res.endSession();
    res.status(204).end();
  });

  router.get('/me', (req, res) => {
    if (!req.session) return res.status(401).json({ code: 'signed_out', error: 'Not signed in.' });
    res.json({ clerk: publicClerk(req.session.clerk) });
  });

  return router;
}
