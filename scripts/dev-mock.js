/**
 * Runs the PO interface against in-memory fakes of the TASK API and Microsoft Entra ID, for demos
 * and UI work. No real TASK data is touched, emails are written to ./outbox only, and admin settings
 * are kept in a temporary folder.
 *
 *   npm run dev:mock
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createTaskClient } from '../src/taskClient.js';
import { createMailer } from '../src/mailer.js';
import { createApp } from '../src/app.js';
import { createSessionStore } from '../src/session.js';
import { createSettingsStore } from '../src/settings.js';
import { createEntraAuth } from '../src/admin/entra.js';
import { createMockTask, MOCK_API_KEY, MOCK_PASSWORD } from '../test/mockTask.js';
import { createMockEntra, MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, MOCK_ENTRA_USERS, MOCK_TENANT_ID } from '../test/mockEntra.js';
import { createMockSupabase, MOCK_SUPABASE_KEY } from '../test/mockSupabase.js';
import { createHubClient } from '../src/sync/hubClient.js';
import { createClerkSync } from '../src/sync/clerkSync.js';

const appPort = Number(process.env.PORT || 3000);
const mockPort = Number(process.env.MOCK_TASK_PORT || 4010);
const mock2Port = mockPort + 1;
const entraPort = mockPort + 2;
const hubPort = mockPort + 3;
const SECOND_KEY = 'demo-second-api-key';

const listen = (app, port) => new Promise((resolve) => http.createServer(app).listen(port, '127.0.0.1', resolve));

const taskA = createMockTask();
const taskB = createMockTask(); // a second "TASK server" to switch to in the admin panel
taskA.state.apiKeys.add(SECOND_KEY);
taskB.state.apiKeys.add(SECOND_KEY);
const entra = createMockEntra();
const hub = createMockSupabase(); // a fake "central hub" staff table
entra.state.base = `http://localhost:${entraPort}`;
entra.state.interactive = true; // show a page to pick which account signs in

await Promise.all([listen(taskA.app, mockPort), listen(taskB.app, mock2Port), listen(entra.app, entraPort), listen(hub.app, hubPort)]);

const config = loadConfig({
  TASK_BASE_URL: `http://127.0.0.1:${mockPort}`,
  TASK_API_KEY: MOCK_API_KEY,
  TASK_ALLOWED_HOSTS: '127.0.0.1,localhost',
  TASK_ENVIRONMENT_NAME: 'Demo',
  TASK_LOGIN_TYPE: '0',
  MAIL_MODE: 'log',
  MAIL_FROM: 'purchase-orders@localhost',
  COMPANY_NAME: process.env.COMPANY_NAME || 'Mad Mex (demo data)',
  PORT: String(appPort),
  ENTRA_TENANT_ID: MOCK_TENANT_ID,
  ENTRA_CLIENT_ID: MOCK_CLIENT_ID,
  ENTRA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
  ENTRA_AUTHORITY: entra.state.base,
  PUBLIC_BASE_URL: `http://localhost:${appPort}`,
  ADMIN_ALLOWED_USERS: MOCK_ENTRA_USERS.admin.preferred_username,
  SETTINGS_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'task-po-demo-')),
  HUB_SUPABASE_URL: `http://127.0.0.1:${hubPort}`,
  HUB_SUPABASE_KEY: MOCK_SUPABASE_KEY,
  HUB_ALLOWED_HOSTS: '127.0.0.1',
  HUB_TABLE: 'staff',
  HUB_COL_MOBILE: 'mobile',
  HUB_COL_PAYROLL_ID: 'payroll_id',
  HUB_COL_VENUE_NO: 'venue_no',
  SYNC_TASK_LOGIN: 'sync@example.com',
  SYNC_TASK_PASSWORD: MOCK_PASSWORD,
  SYNC_NEW_CLERK_GROUP_ID: '3',
  SYNC_NEW_CLERK_VENUE_NO: '1',
  SYNC_INTERVAL_MINUTES: '0', // demo: only when you press Sync now
});
config.admin.allowInsecureIdp = true; // the fake Entra runs on http://localhost

const settings = createSettingsStore({
  defaults: { baseUrl: config.task.baseUrl, apiKey: config.task.apiKey, environmentName: config.task.environmentName },
  dataDir: config.settings.dataDir,
  encryptionKey: config.settings.encryptionKey,
  allowedHosts: config.task.allowedHosts,
  production: false,
});
const task = createTaskClient({ ...config.task, getConnection: settings.connection });
const sync = createClerkSync({ config, task, settings, hub: createHubClient(config.sync.hub) });
const app = createApp({
  config,
  task,
  sync,
  mailer: createMailer(config.mail),
  store: createSessionStore({ idleMinutes: config.sessionIdleMinutes }),
  settings,
  entra: createEntraAuth(config.admin),
});

app.listen(appPort, () => {
  console.log(`Demo running on http://localhost:${appPort} (fake TASK API on :${mockPort} and :${mock2Port}, fake Microsoft sign-in on :${entraPort})`);
  console.log(`Clerks: sign in with login type "Email" and password "${MOCK_PASSWORD}":`);
  console.log('  manager@example.com  - orders (approved and emailed) and receives (invoices completed)');
  console.log('  crew@example.com     - orders (Awaiting approval) and receives (invoices left for a manager)');
  console.log('  receiver@example.com - receive only');
  console.log('  buyer@example.com    - order only');
  console.log('  viewer@example.com   - no PO or invoice permission (sign-in refused)');
  console.log(`Admin panel: http://localhost:${appPort}/admin and pick "${MOCK_ENTRA_USERS.admin.name}" on the fake Microsoft page.`);
  console.log(`  To try switching: address http://127.0.0.1:${mock2Port}, key ${SECOND_KEY}`);
  console.log('  Central hub sync: use "Preview sync" in the admin panel (fake hub staff table, fake TASK clerks).');
});
