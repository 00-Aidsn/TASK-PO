import { loadConfigFromDotenv } from './config.js';
import { createTaskClient } from './taskClient.js';
import { createMailer } from './mailer.js';
import { createSessionStore } from './session.js';
import { createApp } from './app.js';
import { createSettingsStore } from './settings.js';
import { createEntraAuth } from './admin/entra.js';
import { createHubClient } from './sync/hubClient.js';
import { createClerkSync } from './sync/clerkSync.js';

let config;
try {
  config = loadConfigFromDotenv();
} catch (err) {
  console.error(err.message);
  console.error('Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

let settings;
try {
  settings = createSettingsStore({
    defaults: { baseUrl: config.task.baseUrl, apiKey: config.task.apiKey, environmentName: config.task.environmentName },
    dataDir: config.admin.enabled ? config.settings.dataDir : null,
    encryptionKey: config.admin.enabled ? config.settings.encryptionKey : null,
    allowedHosts: config.task.allowedHosts,
    production: config.production,
  });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// Every TASK call reads the current URL and key, so changes in the admin panel apply everywhere at once.
const task = createTaskClient({ ...config.task, getConnection: settings.connection });
const mailer = createMailer(config.mail);
const store = createSessionStore({ idleMinutes: config.sessionIdleMinutes });
setInterval(() => store.sweep(), 60_000).unref();

const entra = config.admin.enabled ? createEntraAuth(config.admin) : null;
// Central hub (Supabase) -> TASK clerk sync: scheduled, plus "Sync now" in the admin panel.
const sync = config.sync.enabled
  ? createClerkSync({ config, task, settings, hub: createHubClient(config.sync.hub, { timeoutMs: config.task.timeoutMs }) })
  : null;
sync?.start();
const app = createApp({ config, task, mailer, store, settings, entra, sync });
const server = app.listen(config.port, () => {
  console.log(`TASK purchase orders running on http://localhost:${config.port}`);
  const c = settings.current();
  console.log(`  TASK API: ${c.baseUrl || '(not set)'} [${c.environmentName || 'environment not named'}] from ${c.source === 'admin' ? 'admin panel' : '.env'}`);
  console.log(`  Admin:    ${config.admin.enabled ? `${config.admin.publicBaseUrl}/admin (Microsoft Entra sign-in)` : 'disabled (set ENTRA_* to enable)'}`);
  console.log(`  Hub sync: ${sync ? `${config.sync.hub.table} at ${new URL(config.sync.hub.url).host}, ${config.sync.intervalMinutes ? `every ${config.sync.intervalMinutes} min` : 'manual only'}` : 'off (set HUB_SUPABASE_URL to enable)'}`);
  console.log(`  Email:    ${config.mail.mode === 'smtp' ? `SMTP via ${config.mail.smtp.host}` : `log only (written to ./${config.mail.outboxDir})`}`);
});

// Clean shutdown (Azure App Service sends SIGTERM on restarts and deploys): stop the sync timer, let a
// running sync and in-flight requests finish, then exit. Gives up after 15 seconds.
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[server] ${signal}: shutting down`);
  sync?.stop();
  const force = setTimeout(() => {
    console.error('[server] still busy after 15s; exiting anyway');
    process.exit(1);
  }, 15_000);
  force.unref();
  server.close(() => {
    const waitForSync = () => {
      if (sync?.status().running) return setTimeout(waitForSync, 200);
      console.log('[server] stopped');
      process.exit(0);
    };
    waitForSync();
  });
  server.closeIdleConnections?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
