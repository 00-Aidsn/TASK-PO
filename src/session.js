import crypto from 'node:crypto';

export const COOKIE_NAME = 'po_sid';

/**
 * In-memory session store. A session holds the clerk's TASK access token and profile.
 * Sessions end on sign-out, after `idleMinutes` without activity, or when the browser closes
 * (the cookie has no Max-Age). Restarting the server signs everyone out.
 */
export function createSessionStore({ idleMinutes, now = () => Date.now() }) {
  const sessions = new Map();
  const idleMs = idleMinutes * 60_000;

  const expired = (s) => now() - s.lastSeen > idleMs;

  return {
    create(data) {
      const id = crypto.randomBytes(32).toString('base64url');
      sessions.set(id, { ...data, createdAt: now(), lastSeen: now() });
      return id;
    },
    get(id) {
      if (!id) return null;
      const s = sessions.get(id);
      if (!s) return null;
      if (expired(s)) {
        sessions.delete(id);
        return null;
      }
      s.lastSeen = now();
      return s;
    },
    destroy(id) {
      if (id) sessions.delete(id);
    },
    sweep() {
      for (const [id, s] of sessions) if (expired(s)) sessions.delete(id);
    },
    get size() {
      return sessions.size;
    },
  };
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!key || key in out) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function cookieString(value, { secure, clear = false }) {
  const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secure) parts.push('Secure');
  if (clear) parts.push('Max-Age=0');
  return parts.join('; ');
}

/** Attaches req.session / req.sessionId and cookie helpers to every request. */
export function sessionMiddleware({ store, cookieSecure }) {
  return (req, res, next) => {
    const id = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const session = store.get(id);
    req.sessionId = session ? id : null;
    req.session = session;
    res.startSession = (data) => {
      if (req.sessionId) store.destroy(req.sessionId);
      const newId = store.create(data);
      res.append('Set-Cookie', cookieString(newId, { secure: cookieSecure }));
      req.sessionId = newId;
      req.session = store.get(newId);
    };
    res.endSession = () => {
      store.destroy(req.sessionId);
      req.sessionId = null;
      req.session = null;
      res.append('Set-Cookie', cookieString('', { secure: cookieSecure, clear: true }));
    };
    next();
  };
}

/** Route guard for a TASK permission held in the session, e.g. requirePermission('canReceive', '...'). */
export function requirePermission(flag, message) {
  return (req, res, next) => {
    if (!req.session?.clerk?.[flag]) return res.status(403).json({ code: 'not_permitted', error: message });
    next();
  };
}

export function requireClerk(req, res, next) {
  if (!req.session) {
    return res.status(401).json({ code: 'signed_out', error: 'Please sign in with your TASK clerk login.' });
  }
  next();
}
