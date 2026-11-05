import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { createSessionStore, sessionMiddleware } from './session.js';
import { TaskApiError } from './taskClient.js';
import { CatalogueChangedError, OrderError, ValidationError } from './poService.js';
import { authRoutes } from './routes/auth.js';
import { lookupRoutes } from './routes/lookups.js';
import { orderRoutes } from './routes/orders.js';
import { receivingRoutes } from './routes/receiving.js';
import { ReceiptError } from './receiving.js';
import { adminRoutes } from './routes/admin.js';
import { createSettingsStore } from './settings.js';
import { SyncError } from './sync/clerkSync.js';
import { HubError } from './sync/hubClient.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

/**
 * Only serve requests that came through Cloudflare: a Cloudflare Transform Rule adds the header
 * X-Origin-Verify with the shared secret. Compared in constant time (via SHA-256 so lengths match).
 */
function cloudflareOnly(secrets) {
  const expected = secrets.map(digest);
  return (req, res, next) => {
    const got = req.get('x-origin-verify');
    if (got && expected.some((e) => crypto.timingSafeEqual(e, digest(got)))) return next();
    res.status(403).type('text/plain').send('Forbidden');
  };
}

/**
 * @param {object} deps
 * @param {object} [deps.settings]  live TASK connection settings (see settings.js); defaults to the .env values
 * @param {object} [deps.entra]     Entra sign-in (see admin/entra.js); required when the admin panel is enabled
 */
export function createApp({
  config,
  task,
  mailer,
  store = createSessionStore({ idleMinutes: config.sessionIdleMinutes }),
  settings = createSettingsStore({
    defaults: { baseUrl: config.task.baseUrl, apiKey: config.task.apiKey, environmentName: config.task.environmentName },
    allowedHosts: config.task.allowedHosts,
    production: config.production,
  }),
  entra = null,
  sync = null,
}) {
  // A new TASK URL or key signs every clerk out: their sessions belong to the old connection.
  settings.onChange(() => store.clear());

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  // Health check for Azure App Service and monitoring: no secrets, no TASK call, no session.
  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  });
  if (config.originSecrets?.length) app.use(cloudflareOnly(config.originSecrets));

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.cookieSecure ? [] : null,
        },
      },
    }),
  );

  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Writes must be JSON. Together with the SameSite=Strict cookie this blocks cross-site form posts.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['content-length'] !== '0' && !req.is('application/json')) {
      return res.status(415).json({ error: 'Requests must be JSON.' });
    }
    next();
  });
  app.use('/api', express.json({ limit: '200kb' }));
  app.use('/api', sessionMiddleware({ store, cookieSecure: config.cookieSecure }));

  if (config.admin.enabled) {
    if (!entra) throw new Error('The admin panel is enabled but Entra sign-in was not set up');
    app.use(adminRoutes({ config, settings, entra, clerkStore: store, sync }));
  }
  app.use('/api', authRoutes({ task, config, settings }));
  app.use('/api', lookupRoutes({ task, config }));
  app.use('/api', orderRoutes({ task, mailer, config }));
  app.use('/api', receivingRoutes({ task, config }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use(express.static(publicDir, { index: 'index.html', maxAge: config.production ? '1h' : 0 }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON.' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'The order is too large.' });
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message, fields: err.fields });
    if (err instanceof CatalogueChangedError) {
      return res.status(409).json({ code: 'catalogue_changed', error: err.message, changes: err.changes });
    }
    if (err instanceof SyncError) return res.status(err.status).json({ code: err.code, error: err.message });
    if (err instanceof HubError) return res.status(502).json({ code: 'hub_error', error: err.message });
    if (err instanceof ReceiptError) {
      return res
        .status(err.status)
        .json({ code: err.code, error: err.message, invoiceId: err.invoiceId, rolledBack: err.rolledBack });
    }
    if (err instanceof OrderError) {
      return res.status(502).json({ error: err.message, poId: err.poId, rolledBack: err.rolledBack });
    }
    if (err instanceof TaskApiError && err.kind === 'not_configured') {
      return res.status(503).json({ code: 'not_configured', error: err.message });
    }
    if (err instanceof TaskApiError) {
      if (err.kind === 'unauthorized' || err.kind === 'session_expired') {
        if (req.sessionId) res.endSession();
        return res.status(401).json({ code: 'session_expired', error: 'Your TASK session has ended. Please sign in again.' });
      }
      if (err.kind === 'forbidden') {
        return res.status(403).json({ error: 'TASK says your account does not have permission to do that.' });
      }
      if (err.kind === 'not_found') return res.status(404).json({ error: err.message });
      console.error(`[task] ${req.method} ${req.originalUrl} -> ${err.status} ${err.message}`);
      return res.status(502).json({ error: `TASK API error: ${err.message}` });
    }
    console.error(`[app] ${req.method} ${req.originalUrl}`, err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}
