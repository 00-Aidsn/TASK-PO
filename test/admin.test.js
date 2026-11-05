import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MOCK_API_KEY, MOCK_ENTRA_USERS, startAdminStack, startStack } from './helpers.js';
import { isAllowedAdmin } from '../src/admin/entra.js';

const NEW_KEY = 'second-api-key-7Q9Z';

describe('admin panel is off unless Entra is configured', () => {
  test('no admin routes without ENTRA_* settings', async () => {
    const s = await startStack();
    try {
      const c = s.client();
      assert.equal((await c.req('GET', '/admin')).status, 404);
      assert.equal((await c.req('GET', '/api/admin/me')).status, 401); // falls through to the clerk API guard
      assert.notEqual((await c.req('GET', '/admin/login')).status, 302);
    } finally {
      await s.close();
    }
  });
});

describe('admin panel', () => {
  let s;
  before(async () => {
    s = await startAdminStack();
  });
  after(async () => {
    await s.close();
  });

  describe('Microsoft Entra sign-in', () => {
    test('login redirects to Entra with PKCE, state and nonce', async () => {
      const c = s.client();
      const res = await c.req('GET', '/admin/login');
      assert.equal(res.status, 302);
      const url = new URL(res.headers.get('location'));
      assert.equal(`${url.origin}${url.pathname}`, `${s.entra.base}/${s.config.admin.tenantId}/oauth2/v2.0/authorize`);
      const q = url.searchParams;
      assert.equal(q.get('client_id'), s.config.admin.clientId);
      assert.equal(q.get('redirect_uri'), `${s.base}/admin/callback`);
      assert.equal(q.get('response_type'), 'code');
      assert.equal(q.get('code_challenge_method'), 'S256');
      assert.ok(q.get('code_challenge') && q.get('state') && q.get('nonce'));
      assert.match(q.get('scope'), /openid/);
      const txCookie = res.headers.getSetCookie().find((c2) => c2.startsWith('po_admin_tx='));
      assert.match(txCookie, /HttpOnly/);
      assert.match(txCookie, /SameSite=Lax/);
    });

    test('the allowed admin gets in', async () => {
      const c = s.client();
      const res = await s.adminSignIn(c, 'admin');
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/admin');
      const cookie = res.headers.getSetCookie().find((x) => x.startsWith('po_admin='));
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);
      const me = await c.req('GET', '/api/admin/me');
      assert.equal(me.status, 200);
      assert.deepEqual(me.data.admin, {
        name: MOCK_ENTRA_USERS.admin.name,
        email: MOCK_ENTRA_USERS.admin.preferred_username,
        oid: MOCK_ENTRA_USERS.admin.oid,
      });
      // The token exchange used the client secret and the PKCE verifier.
      const tokenReq = s.entra.tokenRequests.at(-1);
      assert.equal(tokenReq.client_secret, '(sent)');
      assert.ok(tokenReq.code_verifier);
    });

    test('someone else in the organisation is refused', async () => {
      const c = s.client();
      const res = await s.adminSignIn(c, 'other');
      assert.equal(res.headers.get('location'), '/admin?error=not_allowed');
      assert.ok(!c.jar.has('po_admin'));
      assert.equal((await c.req('GET', '/api/admin/me')).status, 401);
    });

    test('the same user name from another tenant is refused', async () => {
      const c = s.client();
      const res = await s.adminSignIn(c, 'outsider');
      // Rejected while checking the token (its issuer is the other tenant), before the allow-list.
      assert.match(res.headers.get('location'), /^\/admin\?error=(signin_failed|not_allowed)$/);
      assert.ok(!c.jar.has('po_admin'));
    });

    test('a callback without the sign-in cookie, or replayed, is refused', async () => {
      s.entra.nextUser = 'admin';
      const c = s.client();
      await c.req('GET', '/admin/login');
      const login = await c.req('GET', '/admin/login');
      const authorize = await fetch(login.headers.get('location'), { redirect: 'manual' });
      const callback = new URL(authorize.headers.get('location'));
      const stranger = s.client(); // no transaction cookie
      const res = await stranger.req('GET', `${callback.pathname}${callback.search}`);
      assert.equal(res.headers.get('location'), '/admin?error=expired');

      const ok = await c.req('GET', `${callback.pathname}${callback.search}`);
      assert.equal(ok.headers.get('location'), '/admin');
      const replay = await c.req('GET', `${callback.pathname}${callback.search}`);
      assert.equal(replay.headers.get('location'), '/admin?error=expired');
    });

    test('a tampered state is refused', async () => {
      s.entra.nextUser = 'admin';
      const c = s.client();
      const login = await c.req('GET', '/admin/login');
      const authorize = await fetch(login.headers.get('location'), { redirect: 'manual' });
      const callback = new URL(authorize.headers.get('location'));
      callback.searchParams.set('state', 'not-the-real-state');
      const res = await c.req('GET', `${callback.pathname}${callback.search}`);
      assert.equal(res.headers.get('location'), '/admin?error=signin_failed');
      assert.ok(!c.jar.has('po_admin'));
    });

    test('a clerk session does not open the admin API', async () => {
      const clerk = await s.clerkSignIn();
      assert.equal((await clerk.req('GET', '/api/admin/settings')).status, 401);
    });

    test('sign out ends the admin session and offers Microsoft sign-out', async () => {
      const c = s.client();
      await s.adminSignIn(c);
      const out = await c.req('POST', '/api/admin/logout', {});
      assert.equal(out.status, 200);
      assert.match(out.data.logoutUrl, /oauth2\/v2\.0\/logout/);
      assert.equal((await c.req('GET', '/api/admin/me')).status, 401);
    });
  });

  describe('managing the TASK connection', () => {
    let admin;
    before(async () => {
      admin = s.client();
      await s.adminSignIn(admin);
    });

    test('settings show the URL and only the end of the API key', async () => {
      const res = await admin.req('GET', '/api/admin/settings');
      assert.equal(res.status, 200);
      assert.equal(res.data.settings.baseUrl, s.taskAUrl);
      assert.equal(res.data.settings.apiKeyHint, `••••${MOCK_API_KEY.slice(-4)}`);
      assert.equal(res.data.settings.source, 'environment');
      assert.ok(!res.text.includes(MOCK_API_KEY), 'full API key must never be returned');
    });

    test('testing a connection checks the key against TASK without saving', async () => {
      s.taskB.apiKeys.add(NEW_KEY);
      let res = await admin.req('POST', '/api/admin/settings/test', { baseUrl: s.taskBUrl, apiKey: NEW_KEY });
      assert.equal(res.data.test.ok, true);
      assert.equal(res.data.test.appName, 'TASK PO app (mock)');
      res = await admin.req('POST', '/api/admin/settings/test', { baseUrl: s.taskBUrl, apiKey: 'wrong-key-0000' });
      assert.equal(res.data.test.ok, false);
      assert.match(res.data.test.message, /did not accept that API key/);
      assert.equal(s.settings.current().baseUrl, s.taskAUrl); // nothing saved
    });

    test('only approved servers and https addresses are accepted', async () => {
      let res = await admin.req('POST', '/api/admin/settings/test', { baseUrl: 'https://evil.example.com', apiKey: 'x' });
      assert.equal(res.status, 400);
      assert.match(res.data.error, /not an approved TASK server/);
      res = await admin.req('PUT', '/api/admin/settings', { baseUrl: `${s.taskBUrl}/some/path` });
      assert.equal(res.status, 400);
      assert.match(res.data.error, /without a path/);
      res = await admin.req('PUT', '/api/admin/settings', { baseUrl: 'ftp://127.0.0.1' });
      assert.equal(res.status, 400);
    });

    test('a URL or key TASK does not accept is not saved', async () => {
      const res = await admin.req('PUT', '/api/admin/settings', { baseUrl: s.taskBUrl, apiKey: 'wrong-key-0000' });
      assert.equal(res.status, 422);
      assert.match(res.data.error, /^Not saved/);
      assert.equal(s.settings.current().baseUrl, s.taskAUrl);
      assert.ok(!fs.existsSync(path.join(s.dataDir, 'settings.json')));
    });

    test('writes from another site are blocked', async () => {
      const res = await admin.req('PUT', '/api/admin/settings', { environmentName: 'Hacked' }, { headers: { Origin: 'https://evil.example.com' } });
      assert.equal(res.status, 403);
    });

    test('saving a new URL and key flows everywhere: clerks are signed out and every TASK call uses the new values', async () => {
      const clerk = await s.clerkSignIn();
      assert.equal((await clerk.req('GET', '/api/me')).status, 200);
      s.taskB.apiKeys.add(NEW_KEY);
      s.taskB.requests.length = 0;

      const res = await admin.req('PUT', '/api/admin/settings', { baseUrl: `${s.taskBUrl}/`, apiKey: NEW_KEY, environmentName: 'Live' });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.data.changed.sort(), ['apiKey', 'baseUrl', 'environmentName']);
      assert.ok(res.data.signedOutClerks >= 1); // this clerk, plus any left signed in by earlier tests
      assert.equal(s.store.size, 0);
      assert.equal(res.data.settings.apiKeyHint, `••••${NEW_KEY.slice(-4)}`);
      assert.equal(res.data.settings.updatedBy.email, MOCK_ENTRA_USERS.admin.preferred_username);
      assert.ok(!res.text.includes(NEW_KEY));

      // The clerk's old session has ended...
      const old = await clerk.req('GET', '/api/suppliers');
      assert.equal(old.status, 401);
      assert.equal(old.data.code, 'session_expired');

      // ...and signing in again goes to server B with the new key.
      const before = s.taskA.requests.length;
      const again = await s.clerkSignIn();
      await again.req('GET', '/api/suppliers');
      assert.equal(s.taskA.requests.length, before, 'nothing should go to the old server');
      const calls = s.taskB.requests.filter((r) => r.path.startsWith('/api/v3/'));
      assert.ok(calls.some((r) => r.path === '/api/v3/auth/clerk/login'));
      assert.ok(calls.some((r) => r.path === '/api/v3/supplier'));
      assert.ok(calls.every((r) => r.key === NEW_KEY));

      // Clerks see the environment name.
      const cfg = await again.req('GET', '/api/config');
      assert.equal(cfg.data.environmentName, 'Live');
    });

    test('the API key is stored encrypted and survives a restart', async () => {
      const file = path.join(s.dataDir, 'settings.json');
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!text.includes(NEW_KEY), 'API key must not be stored in plain text');
      assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');

      const restarted = await startAdminStack({ dataDir: s.dataDir, env: { SETTINGS_ENCRYPTION_KEY: s.encryptionKey } });
      try {
        assert.equal(restarted.settings.current().apiKey, NEW_KEY);
        assert.equal(restarted.settings.current().source, 'admin');
      } finally {
        await restarted.close();
      }
      await assert.rejects(startAdminStack({ dataDir: s.dataDir }), /Cannot decrypt/); // different encryption key
    });

    test('leaving the key blank keeps it; the change history records who changed what, without the key', async () => {
      const res = await admin.req('PUT', '/api/admin/settings', { environmentName: 'Prod', apiKey: '' });
      assert.equal(res.status, 200);
      assert.deepEqual(res.data.changed, ['environmentName']);
      assert.equal(s.settings.current().apiKey, NEW_KEY);

      const audit = await admin.req('GET', '/api/admin/audit');
      const updates = audit.data.entries.filter((e) => e.action === 'settings_updated');
      assert.equal(updates[0].details.environmentName.to, 'Prod');
      const keyChange = updates.find((e) => e.details.apiKey);
      assert.deepEqual(keyChange.details.apiKey, { from: `••••${MOCK_API_KEY.slice(-4)}`, to: `••••${NEW_KEY.slice(-4)}` });
      assert.equal(keyChange.actor.oid, MOCK_ENTRA_USERS.admin.oid);
      assert.ok(audit.data.entries.some((e) => e.action === 'admin_sign_in_refused'));
      assert.ok(!audit.text.includes(NEW_KEY) && !audit.text.includes(MOCK_API_KEY));
      const raw = fs.readFileSync(path.join(s.dataDir, 'admin-audit.log'), 'utf8');
      assert.ok(!raw.includes(NEW_KEY) && !raw.includes(MOCK_API_KEY));
    });
  });
});

describe('who is allowed in', () => {
  const admin = {
    tenantId: '11111111-2222-4333-8444-555555555555',
    allowedUsers: ['me@madmex.example'],
    allowedObjectIds: [],
  };
  const claims = { tid: admin.tenantId, oid: 'abc', preferred_username: 'Me@MadMex.example' };
  test('tenant and user name must both match', () => {
    assert.equal(isAllowedAdmin(claims, admin), true); // user names are compared case-insensitively
    assert.equal(isAllowedAdmin({ ...claims, tid: '99999999-9999-4999-8999-999999999999' }, admin), false);
    assert.equal(isAllowedAdmin({ ...claims, tid: undefined }, admin), false);
    assert.equal(isAllowedAdmin({ ...claims, preferred_username: 'someone@madmex.example' }, admin), false);
  });
  test('object IDs, when listed, must match too', () => {
    assert.equal(isAllowedAdmin(claims, { ...admin, allowedObjectIds: ['abc'] }), true);
    assert.equal(isAllowedAdmin(claims, { ...admin, allowedObjectIds: ['xyz'] }), false);
    assert.equal(isAllowedAdmin(claims, { ...admin, allowedUsers: [], allowedObjectIds: ['abc'] }), true);
  });
});

describe('object ID allow-list', () => {
  test('when ADMIN_ALLOWED_OBJECT_IDS is set, the object ID must match', async () => {
    const s = await startAdminStack({ env: { ADMIN_ALLOWED_OBJECT_IDS: MOCK_ENTRA_USERS.other.oid } });
    try {
      // admin@ matches the user list but not the object ID list -> refused
      assert.equal((await s.adminSignIn(s.client(), 'admin')).headers.get('location'), '/admin?error=not_allowed');
    } finally {
      await s.close();
    }
    const s2 = await startAdminStack({ env: { ADMIN_ALLOWED_USERS: '', ADMIN_ALLOWED_OBJECT_IDS: MOCK_ENTRA_USERS.other.oid } });
    try {
      assert.equal((await s2.adminSignIn(s2.client(), 'other')).headers.get('location'), '/admin');
    } finally {
      await s2.close();
    }
  });
});

describe('before TASK is configured', () => {
  test('clerks are told an administrator needs to set it up', async () => {
    const s = await startAdminStack({ env: { TASK_API_KEY: '' } });
    try {
      const c = s.client();
      const cfg = await c.req('GET', '/api/config');
      assert.equal(cfg.data.configured, false);
      const login = await c.req('POST', '/api/login', { login: 'manager@example.com', password: 'demo-password', loginType: 0 });
      assert.equal(login.status, 503);
      assert.equal(login.data.code, 'not_configured');
    } finally {
      await s.close();
    }
  });
});
