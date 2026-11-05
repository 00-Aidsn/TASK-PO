/**
 * A minimal fake of Microsoft Entra ID (OpenID Connect) for tests and `npm run dev:mock`.
 * It performs the real steps: discovery, authorize (code + PKCE), token exchange checking the client
 * secret and PKCE verifier, and RS256-signed ID tokens. Not for production use.
 */
import crypto from 'node:crypto';
import express from 'express';

export const MOCK_TENANT_ID = '11111111-2222-4333-8444-555555555555';
export const MOCK_CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const MOCK_CLIENT_SECRET = 'mock-entra-client-secret';

export const MOCK_ENTRA_USERS = {
  admin: {
    oid: '0a0a0a0a-0000-4000-8000-000000000001',
    name: 'Alex Admin',
    preferred_username: 'admin@madmex.example',
    tid: MOCK_TENANT_ID,
  },
  other: {
    oid: '0b0b0b0b-0000-4000-8000-000000000002',
    name: 'Sam Staff',
    preferred_username: 'staff@madmex.example',
    tid: MOCK_TENANT_ID,
  },
  // Same user name as the admin, but from another organisation's tenant.
  outsider: {
    oid: '0c0c0c0c-0000-4000-8000-000000000003',
    name: 'Alex Admin (other tenant)',
    preferred_username: 'admin@madmex.example',
    tid: '99999999-9999-4999-8999-999999999999',
  },
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function createMockEntra({ tenantId = MOCK_TENANT_ID, clientId = MOCK_CLIENT_ID, clientSecret = MOCK_CLIENT_SECRET } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'mock-entra-key';
  const state = {
    base: '', // set by the caller once listening, e.g. http://127.0.0.1:4011
    nextUser: 'admin', // who "signs in" when not interactive
    interactive: false, // show a picker page instead (demo mode)
    codes: new Map(),
    tokenRequests: [],
  };
  const issuer = () => `${state.base}/${tenantId}/v2.0`;
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get(`/${tenantId}/v2.0/.well-known/openid-configuration`, (req, res) => {
    res.json({
      issuer: issuer(),
      authorization_endpoint: `${state.base}/${tenantId}/oauth2/v2.0/authorize`,
      token_endpoint: `${state.base}/${tenantId}/oauth2/v2.0/token`,
      jwks_uri: `${state.base}/${tenantId}/discovery/v2.0/keys`,
      end_session_endpoint: `${state.base}/${tenantId}/oauth2/v2.0/logout`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      subject_types_supported: ['pairwise'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      scopes_supported: ['openid', 'profile', 'email'],
    });
  });

  app.get(`/${tenantId}/discovery/v2.0/keys`, (req, res) => {
    res.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] });
  });

  function approve(userKey, q, res) {
    const user = MOCK_ENTRA_USERS[userKey];
    if (!user) return res.status(400).send('Unknown user');
    const code = crypto.randomBytes(24).toString('base64url');
    state.codes.set(code, { user, clientId: q.client_id, redirectUri: q.redirect_uri, challenge: q.code_challenge, nonce: q.nonce });
    const target = new URL(q.redirect_uri);
    target.searchParams.set('code', code);
    if (q.state) target.searchParams.set('state', q.state);
    res.redirect(302, target.href);
  }

  app.get(`/${tenantId}/oauth2/v2.0/authorize`, (req, res) => {
    const q = req.query;
    if (q.client_id !== clientId) return res.status(400).send('AADSTS700016: unknown application');
    if (q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge || !q.redirect_uri) {
      return res.status(400).send('Bad authorize request');
    }
    if (q.user) return approve(String(q.user), q, res);
    if (!state.interactive) return approve(state.nextUser, q, res);
    const links = Object.entries(MOCK_ENTRA_USERS)
      .map(([key, u]) => {
        const params = new URLSearchParams({ ...q, user: key });
        return `<li><a href="?${params.toString().replace(/&/g, '&amp;')}">${u.name} &lt;${u.preferred_username}&gt;${key === 'outsider' ? ' (other organisation)' : ''}</a></li>`;
      })
      .join('');
    res
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>Mock Microsoft sign-in</title><body style="font-family:system-ui;padding:24px"><h1>Mock Microsoft sign-in</h1><p>Demo only. Pick an account:</p><ul>${links}</ul></body>`,
      );
  });

  app.post(`/${tenantId}/oauth2/v2.0/token`, (req, res) => {
    const b = req.body || {};
    state.tokenRequests.push({ ...b, client_secret: b.client_secret ? '(sent)' : undefined });
    if (b.client_id !== clientId || b.client_secret !== clientSecret) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret' });
    }
    const grant = state.codes.get(b.code);
    state.codes.delete(b.code); // single use
    if (!grant || grant.redirectUri !== b.redirect_uri || grant.clientId !== b.client_id) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'AADSTS70008: code expired or already used' });
    }
    const challenge = crypto.createHash('sha256').update(String(b.code_verifier || '')).digest('base64url');
    if (challenge !== grant.challenge) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'AADSTS501481: PKCE verifier mismatch' });
    }
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', kid };
    const u = grant.user;
    const payload = {
      ver: '2.0',
      iss: `${state.base}/${u.tid}/v2.0`,
      aud: clientId,
      sub: `sub-${u.oid}`,
      oid: u.oid,
      tid: u.tid,
      name: u.name,
      preferred_username: u.preferred_username,
      nonce: grant.nonce,
      iat: now,
      nbf: now,
      exp: now + 3600,
    };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
    res.json({
      token_type: 'Bearer',
      scope: 'openid profile email',
      expires_in: 3600,
      access_token: crypto.randomBytes(24).toString('base64url'),
      id_token: `${signingInput}.${b64url(signature)}`,
    });
  });

  app.get(`/${tenantId}/oauth2/v2.0/logout`, (req, res) => {
    const back = req.query.post_logout_redirect_uri;
    res.type('html').send(`<!doctype html><meta charset="utf-8"><p>Signed out of mock Microsoft.</p>${back ? `<p><a href="${String(back).replace(/"/g, '')}">Back</a></p>` : ''}`);
  });

  return { app, state };
}
