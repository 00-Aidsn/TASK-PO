/**
 * Runs the PO interface against an in-memory fake of the TASK API, for demos and UI work.
 * No real TASK data is touched and emails are written to ./outbox only.
 *
 *   npm run dev:mock
 */
import { loadConfig } from '../src/config.js';
import { createTaskClient } from '../src/taskClient.js';
import { createMailer } from '../src/mailer.js';
import { createApp } from '../src/app.js';
import { createMockTask, MOCK_API_KEY, MOCK_PASSWORD } from '../test/mockTask.js';

const mockPort = Number(process.env.MOCK_TASK_PORT || 4010);
const appPort = Number(process.env.PORT || 3000);

const { app: mockApp } = createMockTask();
mockApp.listen(mockPort, '127.0.0.1', () => {
  const config = loadConfig({
    TASK_BASE_URL: `http://127.0.0.1:${mockPort}`,
    TASK_API_KEY: MOCK_API_KEY,
    TASK_LOGIN_TYPE: '0',
    MAIL_MODE: 'log',
    MAIL_FROM: 'purchase-orders@localhost',
    COMPANY_NAME: process.env.COMPANY_NAME || 'Mad Mex (demo data)',
    PORT: String(appPort),
  });
  const app = createApp({
    config,
    task: createTaskClient(config.task),
    mailer: createMailer(config.mail),
  });
  app.listen(appPort, () => {
    console.log(`Demo running on http://localhost:${appPort} (fake TASK API on :${mockPort})`);
    console.log(`Sign in with login type "Email" and password "${MOCK_PASSWORD}":`);
    console.log('  manager@example.com  - orders (approved and emailed) and receives (invoices completed)');
    console.log('  crew@example.com     - orders (Awaiting approval) and receives (invoices left for a manager)');
    console.log('  receiver@example.com - receive only');
    console.log('  buyer@example.com    - order only');
    console.log('  viewer@example.com   - no PO or invoice permission (sign-in refused)');
  });
});
