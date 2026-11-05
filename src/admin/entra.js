/**
 * Microsoft Entra ID sign-in for the admin panel (OpenID Connect authorization code flow with PKCE).
 *
 * openid-client checks the state, the nonce, the PKCE verifier, and the ID token's issuer
 * (this tenant only), audience (this app) and expiry. isAllowedAdmin() then checks the person
 * against ADMIN_ALLOWED_OBJECT_IDS / ADMIN_ALLOWED_USERS.
 */
import * as oidc from 'openid-client';

export function createEntraAuth(admin, { fetchImpl } = {}) {
  const redirectUri = `${admin.publicBaseUrl}/admin/callback`;
  let configPromise = null;

  function getConfig() {
    if (!configPromise) {
      const options = {};
      if (admin.allowInsecureIdp) options.execute = [oidc.allowInsecureRequests]; // tests against a local mock only
      if (fetchImpl) options[oidc.customFetch] = fetchImpl;
      configPromise = oidc
        .discovery(
          new URL(`${admin.authority}/${admin.tenantId}/v2.0`),
          admin.clientId,
          { redirect_uris: [redirectUri], response_types: ['code'] },
          oidc.ClientSecretPost(admin.clientSecret),
          options,
        )
        .catch((err) => {
          configPromise = null; // retry discovery next time
          throw err;
        });
    }
    return configPromise;
  }

  /** Starts sign-in: returns the Microsoft sign-in URL and the values to keep until the callback. */
  async function startLogin() {
    const config = await getConfig();
    const transaction = {
      verifier: oidc.randomPKCECodeVerifier(),
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      createdAt: Date.now(),
    };
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      response_type: 'code',
      response_mode: 'query',
      code_challenge: await oidc.calculatePKCECodeChallenge(transaction.verifier),
      code_challenge_method: 'S256',
      state: transaction.state,
      nonce: transaction.nonce,
      prompt: 'select_account',
    });
    return { url: url.href, transaction };
  }

  /** Completes sign-in from the callback URL. Returns the ID token claims. Throws if anything doesn't check out. */
  async function finishLogin(callbackUrl, transaction) {
    const config = await getConfig();
    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: transaction.verifier,
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error('Entra did not return an ID token');
    return claims;
  }

  /** Where to send the browser to also sign out of Microsoft (if the tenant supports it). */
  async function logoutUrl() {
    try {
      const config = await getConfig();
      if (!config.serverMetadata().end_session_endpoint) return null;
      return oidc.buildEndSessionUrl(config, { post_logout_redirect_uri: `${admin.publicBaseUrl}/admin` }).href;
    } catch {
      return null;
    }
  }

  return { startLogin, finishLogin, logoutUrl, redirectUri };
}

/** Who the signed-in person is, from the ID token. */
export function adminIdentity(claims) {
  return {
    name: String(claims.name || claims.preferred_username || '').slice(0, 200),
    email: String(claims.email || claims.preferred_username || claims.upn || '').slice(0, 200),
    username: String(claims.preferred_username || claims.upn || claims.email || '').slice(0, 200),
    oid: String(claims.oid || '').toLowerCase(),
    tid: String(claims.tid || '').toLowerCase(),
  };
}

/**
 * Only people in this tenant, and on the allow-list, get in.
 * If ADMIN_ALLOWED_OBJECT_IDS is set the Entra object ID must match (recommended: it never changes);
 * if ADMIN_ALLOWED_USERS is set the user name / email must match. If both are set, both must match.
 */
export function isAllowedAdmin(claims, admin) {
  const who = adminIdentity(claims);
  if (!who.tid || who.tid !== admin.tenantId) return false;
  if (admin.allowedObjectIds.length && !admin.allowedObjectIds.includes(who.oid)) return false;
  if (admin.allowedUsers.length) {
    const names = [claims.preferred_username, claims.email, claims.upn].filter(Boolean).map((v) => String(v).toLowerCase());
    if (!names.some((n) => admin.allowedUsers.includes(n))) return false;
  }
  return true;
}
