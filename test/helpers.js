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

// ---------------------------------------------------------------- admin panel test stack
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSettingsStore } from '../src/settings.js';
import { createEntraAuth } from '../src/admin/entra.js';
import { createMockEntra, MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, MOCK_ENTRA_USERS, MOCK_TENANT_ID } from './mockEntra.js';

export { MOCK_ENTRA_USERS };

function listenServer(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** A browser-like cookie jar client (several cookies, manual redirects). */
export function jarClient(base) {
  const jar = new Map();
  return {
    jar,
    async req(method, pathOrUrl, body, { headers = {}, raw } = {}) {
      const h = { Accept: 'application/json', ...headers };
      if (jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      let payload;
      if (raw !== undefined) payload = raw;
      else if (body !== undefined) {
        h['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(pathOrUrl.startsWith('http') ? pathOrUrl : `${base}${pathOrUrl}`, {
        method,
        headers: h,
        body: payload,
        redirect: 'manual',
      });
      for (const c of res.headers.getSetCookie()) {
        const [pair, ...attrs] = c.split(';');
        const i = pair.indexOf('=');
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        if (!value || attrs.some((a) => /max-age=0/i.test(a.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      return { status: res.status, data, text, headers: res.headers };
    },
  };
}

/**
 * App with the admin panel enabled: a fake Entra, two fake TASK servers (A is the starting URL),
 * and a temporary DATA_DIR. Returns helpers to sign in as an admin or a clerk.
 */
export async function startAdminStack({ env = {}, dataDir } = {}) {
  const taskA = createMockTask();
  const taskB = createMockTask();
  const entra = createMockEntra();
  const [taskAServer, taskBServer, entraServer] = await Promise.all([
    listenServer(http.createServer(taskA.app)),
    listenServer(http.createServer(taskB.app)),
    listenServer(http.createServer(entra.app)),
  ]);
  entra.state.base = `http://127.0.0.1:${entraServer.address().port}`;
  const appServer = await listenServer(http.createServer());
  const base = `http://127.0.0.1:${appServer.address().port}`;
  dataDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'task-po-admin-'));
  const encryptionKey = env.SETTINGS_ENCRYPTION_KEY || crypto.randomBytes(32).toString('base64');

  const config = loadConfig({
    TASK_BASE_URL: `http://127.0.0.1:${taskAServer.address().port}`,
    TASK_API_KEY: MOCK_API_KEY,
    TASK_ALLOWED_HOSTS: '127.0.0.1,localhost',
    MAIL_MODE: 'log',
    ENTRA_TENANT_ID: MOCK_TENANT_ID,
    ENTRA_CLIENT_ID: MOCK_CLIENT_ID,
    ENTRA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
    ENTRA_AUTHORITY: entra.state.base,
    PUBLIC_BASE_URL: base,
    ADMIN_ALLOWED_USERS: MOCK_ENTRA_USERS.admin.preferred_username,
    SETTINGS_ENCRYPTION_KEY: encryptionKey,
    DATA_DIR: dataDir,
    ...env,
  });
  config.admin.allowInsecureIdp = true; // the fake Entra runs on http://127.0.0.1

  async function close() {
    await Promise.all(
      [appServer, taskAServer, taskBServer, entraServer].map(
        (srv) =>
          new Promise((r) => {
            srv.closeAllConnections?.();
            srv.close(r);
          }),
      ),
    );
  }

  let settings;
  try {
    settings = createSettingsStore({
      defaults: { baseUrl: config.task.baseUrl, apiKey: config.task.apiKey, environmentName: config.task.environmentName },
      dataDir: config.settings.dataDir,
      encryptionKey: config.settings.encryptionKey,
      allowedHosts: config.task.allowedHosts,
      production: false,
    });
  } catch (err) {
    await close(); // don't leave servers running when start-up fails
    throw err;
  }
  const task = createTaskClient({ ...config.task, getConnection: settings.connection });
  const store = createSessionStore({ idleMinutes: config.sessionIdleMinutes });
  const app = createApp({ config, task, mailer: fakeMailer(), store, settings, entra: createEntraAuth(config.admin) });
  appServer.on('request', app);

  /** Runs the whole Microsoft sign-in as `user` ('admin', 'other', 'outsider'). Returns the final callback response. */
  async function adminSignIn(client, user = 'admin') {
    entra.state.nextUser = user;
    const start = await client.req('GET', '/admin/login', undefined, { headers: { Accept: 'text/html' } });
    if (start.status !== 302) throw new Error(`login did not redirect: ${start.status} ${start.text}`);
    const authorize = await fetch(start.headers.get('location'), { redirect: 'manual' });
    const callback = new URL(authorize.headers.get('location'));
    return client.req('GET', `${callback.pathname}${callback.search}`, undefined, { headers: { Accept: 'text/html' } });
  }

  async function clerkSignIn(login = 'manager@example.com') {
    const c = jarClient(base);
    const res = await c.req('POST', '/api/login', { login, password: MOCK_PASSWORD, loginType: 0 });
    if (res.status !== 200) throw new Error(`clerk sign-in failed: ${res.status} ${res.text}`);
    return c;
  }

  return {
    base,
    config,
    settings,
    store,
    dataDir,
    encryptionKey,
    taskA: taskA.state,
    taskB: taskB.state,
    taskAUrl: `http://127.0.0.1:${taskAServer.address().port}`,
    taskBUrl: `http://127.0.0.1:${taskBServer.address().port}`,
    entra: entra.state,
    client: () => jarClient(base),
    adminSignIn,
    clerkSignIn,
    close,
  };
}
