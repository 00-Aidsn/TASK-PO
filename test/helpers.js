import { loadConfig } from '../src/config.js';
import { createTaskClient } from '../src/taskClient.js';
import { createSessionStore } from '../src/session.js';
import { createApp } from '../src/app.js';
import { createMockTask, MOCK_API_KEY, MOCK_PASSWORD } from './mockTask.js';

export { MOCK_API_KEY, MOCK_PASSWORD };

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

export function fakeMailer() {
  return {
    mode: 'log',
    fail: false,
    sent: [],
    async send(message) {
      if (this.fail) throw new Error('SMTP relay unavailable');
      this.sent.push(message);
      return { messageId: `msg-${this.sent.length}` };
    },
  };
}

/** Starts the fake TASK API and the app on random ports. */
export async function startStack({ env = {}, now } = {}) {
  const mock = createMockTask();
  const mockServer = await listen(mock.app);
  const config = loadConfig({
    TASK_BASE_URL: `http://127.0.0.1:${mockServer.address().port}`,
    TASK_API_KEY: MOCK_API_KEY,
    TASK_PAGE_SIZE: '2', // small pages so the tests exercise paging
    MAIL_MODE: 'log',
    SESSION_IDLE_MINUTES: '30',
    ...env,
  });
  const mailer = fakeMailer();
  const store = createSessionStore({ idleMinutes: config.sessionIdleMinutes, now });
  const app = createApp({ config, task: createTaskClient(config.task), mailer, store });
  const appServer = await listen(app);
  const base = `http://127.0.0.1:${appServer.address().port}`;
  const responses = [];

  function client() {
    let cookie = '';
    return {
      get cookie() {
        return cookie;
      },
      async req(method, path, body, { headers = {}, raw } = {}) {
        const h = { Accept: 'application/json', ...headers };
        if (cookie) h.Cookie = cookie;
        let payload;
        if (raw !== undefined) payload = raw;
        else if (body !== undefined) {
          h['Content-Type'] = 'application/json';
          payload = JSON.stringify(body);
        }
        const res = await fetch(`${base}${path}`, { method, headers: h, body: payload });
        const setCookie = res.headers.get('set-cookie');
        if (setCookie) {
          const [pair] = setCookie.split(';');
          cookie = /=$/.test(pair) ? '' : pair;
        }
        const text = await res.text();
        responses.push(text);
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = text;
        }
        return { status: res.status, data, headers: res.headers, text };
      },
    };
  }

  async function signIn(login = 'manager@example.com') {
    const c = client();
    const res = await c.req('POST', '/api/login', { login, password: MOCK_PASSWORD, loginType: 0 });
    if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${res.text}`);
    return c;
  }

  async function close() {
    await new Promise((r) => appServer.close(r));
    await new Promise((r) => mockServer.close(r));
  }

  return { base, config, mock: mock.state, mailer, store, client, signIn, responses, close };
}

export function tomorrow() {
  const d = new Date(Date.now() + 2 * 86_400_000);
  return d.toISOString().slice(0, 10);
}
