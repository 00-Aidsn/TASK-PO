import { loadConfigFromDotenv } from './config.js';
import { createTaskClient } from './taskClient.js';
import { createMailer } from './mailer.js';
import { createSessionStore } from './session.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfigFromDotenv();
} catch (err) {
  console.error(err.message);
  console.error('Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

const task = createTaskClient(config.task);
const mailer = createMailer(config.mail);
const store = createSessionStore({ idleMinutes: config.sessionIdleMinutes });
setInterval(() => store.sweep(), 60_000).unref();

const app = createApp({ config, task, mailer, store });
app.listen(config.port, () => {
  console.log(`TASK purchase orders running on http://localhost:${config.port}`);
  console.log(`  TASK API: ${config.task.baseUrl}`);
  console.log(`  Email:    ${config.mail.mode === 'smtp' ? `SMTP via ${config.mail.smtp.host}` : `log only (written to ./${config.mail.outboxDir})`}`);
});
