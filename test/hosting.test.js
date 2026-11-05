import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MOCK_PASSWORD, startStack } from './helpers.js';
import { loadConfig, parseTrustProxy } from '../src/config.js';

const SECRET = 'cf-origin-secret-0123456789abcdef0123456789';
const NEXT_SECRET = 'cf-origin-secret-NEXT-456789abcdef0123456789';

describe('health check', () => {
  test('/healthz answers without a session', async () => {
    const s = await startStack();
    try {
      const res = await s.client().req('GET', '/healthz');
      assert.equal(res.status, 200);
      assert.deepEqual(res.data, { status: 'ok' });
      assert.equal(res.headers.get('cache-control'), 'no-store');
    } finally {
      await s.close();
    }
  });
});

describe('Cloudflare-only access (CLOUDFLARE_ORIGIN_SECRET)', () => {
  test('requests without the Cloudflare header are refused; /healthz still works', async () => {
    const s = await startStack({ env: { CLOUDFLARE_ORIGIN_SECRET: SECRET } });
    try {
      const c = s.client();
      assert.equal((await c.req('GET', '/')).status, 403);
      assert.equal((await c.req('GET', '/api/config')).status, 403);
      assert.equal((await c.req('GET', '/api/config', undefined, { headers: { 'X-Origin-Verify': 'wrong' } })).status, 403);
      assert.equal((await c.req('GET', '/healthz')).status, 200);

      const ok = await c.req('GET', '/api/config', undefined, { headers: { 'X-Origin-Verify': SECRET } });
      assert.equal(ok.status, 200);
      const login = await c.req(
        'POST',
        '/api/login',
        { login: 'manager@example.com', password: MOCK_PASSWORD, loginType: 0 },
        { headers: { 'X-Origin-Verify': SECRET } },
      );
      assert.equal(login.status, 200);
    } finally {
      await s.close();
    }
  });

  test('two secrets can be accepted while rotating', async () => {
    const s = await startStack({ env: { CLOUDFLARE_ORIGIN_SECRET: `${SECRET},${NEXT_SECRET}` } });
    try {
      const c = s.client();
      for (const secret of [SECRET, NEXT_SECRET]) {
        assert.equal((await c.req('GET', '/api/config', undefined, { headers: { 'X-Origin-Verify': secret } })).status, 200);
      }
    } finally {
      await s.close();
    }
  });

  test('short secrets are rejected at start-up', () => {
    assert.throws(() => loadConfig({ TASK_API_KEY: 'k', CLOUDFLARE_ORIGIN_SECRET: 'too-short' }), /at least 32 characters/);
  });
});

describe('TRUST_PROXY', () => {
  test('a hop count becomes a number (the text "2" would be read as an IP address)', () => {
    assert.equal(parseTrustProxy('2'), 2);
    assert.equal(parseTrustProxy('true'), true);
    assert.equal(parseTrustProxy(''), false);
    assert.equal(parseTrustProxy('0'), false);
    assert.equal(parseTrustProxy('loopback'), 'loopback');
    assert.equal(loadConfig({ TASK_API_KEY: 'k', TRUST_PROXY: '2' }).trustProxy, 2);
  });

  test('behind Cloudflare and Azure, the sign-in limiter sees each clerk\'s own IP', async () => {
    const s = await startStack({ env: { TRUST_PROXY: '2' } });
    try {
      const c = s.client();
      const tryLogin = (ip) =>
        c.req('POST', '/api/login', { login: 'manager@example.com', password: 'wrong', loginType: 0 }, {
          // client IP, then Cloudflare's address as seen by Azure's front end
          headers: { 'X-Forwarded-For': `${ip}, 172.68.1.1` },
        });
      for (let i = 0; i < 10; i++) assert.equal((await tryLogin('203.0.113.7')).status, 401);
      assert.equal((await tryLogin('203.0.113.7')).status, 429, 'the same clerk IP is limited');
      assert.equal((await tryLogin('198.51.100.9')).status, 401, 'a different clerk IP is not affected');
    } finally {
      await s.close();
    }
  });
});
