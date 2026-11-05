/**
 * TASK connection settings (API URL, API key, environment name) that an administrator can change
 * in the admin panel. Every TASK call reads them through `connection()`, so a change applies
 * everywhere at once.
 *
 * - Saved to DATA_DIR/settings.json. The API key is encrypted with AES-256-GCM using
 *   SETTINGS_ENCRYPTION_KEY and is never returned in full (only its last 4 characters).
 * - Until an administrator saves settings, the values from the environment (.env) are used.
 * - Every change is appended to DATA_DIR/admin-audit.log (no key material, only the last 4 characters).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from './poService.js';

const AAD = Buffer.from('task-po-settings-v1');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Parses SETTINGS_ENCRYPTION_KEY: 32 bytes as base64 or 64 hex characters. */
export function parseEncryptionKey(value) {
  if (!value) return null;
  const text = String(value).trim();
  const buf = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  return buf.length === 32 ? buf : null;
}

function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(box, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
}

/** "*.xchangefusion.com" matches any subdomain; other patterns must match exactly. */
export function hostAllowed(hostname, patterns) {
  const host = String(hostname).toLowerCase();
  return patterns.some((raw) => {
    const p = String(raw).trim().toLowerCase();
    if (!p) return false;
    if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
    return host === p;
  });
}

/** Validates a TASK API URL and returns just its origin, e.g. https://madmexuatapi.xchangefusion.com */
export function normaliseTaskUrl(input, { allowedHosts, production }) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw new ValidationError('Enter the full TASK API address, for example https://madmexuatapi.xchangefusion.com', {
      baseUrl: 'Not a valid URL',
    });
  }
  if (url.username || url.password) {
    throw new ValidationError('The address must not include a user name or password.', { baseUrl: 'Remove credentials' });
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && !production)) {
    throw new ValidationError('The TASK API address must start with https://', { baseUrl: 'Use https' });
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  if ((pathname && pathname.toLowerCase() !== '/api/v3') || url.search || url.hash) {
    throw new ValidationError('Enter only the server address, without a path. The app adds /api/v3 itself.', {
      baseUrl: 'Remove the path',
    });
  }
  if (!hostAllowed(url.hostname, allowedHosts)) {
    throw new ValidationError(
      `${url.hostname} is not an approved TASK server. Approved: ${allowedHosts.join(', ')}. IT can change this with TASK_ALLOWED_HOSTS.`,
      { baseUrl: 'Not an approved server' },
    );
  }
  return url.origin;
}

export function keyHint(apiKey) {
  if (!apiKey) return null;
  return apiKey.length >= 8 ? `••••${apiKey.slice(-4)}` : '••••';
}

export function defaultEnvironmentName(baseUrl) {
  try {
    return /uat|test|staging|dev/i.test(new URL(baseUrl).hostname) ? 'UAT' : 'Production';
  } catch {
    return '';
  }
}

/**
 * @param {object} o
 * @param {{ baseUrl: string, apiKey: string, environmentName?: string }} o.defaults  values from .env
 * @param {string} [o.dataDir]        where settings.json and admin-audit.log live (admin panel only)
 * @param {Buffer} [o.encryptionKey]  32-byte key (admin panel only)
 * @param {string[]} o.allowedHosts
 * @param {boolean} o.production
 */
export function createSettingsStore({ defaults, dataDir = null, encryptionKey = null, allowedHosts = ['*.xchangefusion.com'], production = false }) {
  const editable = Boolean(dataDir && encryptionKey);
  const file = editable ? path.join(dataDir, 'settings.json') : null;
  const auditFile = editable ? path.join(dataDir, 'admin-audit.log') : null;
  const listeners = [];

  let saved = null; // { taskBaseUrl, environmentName, apiKey (plain, in memory), apiKeyHint, updatedAt, updatedBy, keyUpdatedAt, keyUpdatedBy }
  if (editable && fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    let apiKey;
    try {
      apiKey = raw.apiKey ? decrypt(raw.apiKey, encryptionKey) : '';
    } catch {
      throw new Error(
        `Cannot decrypt ${file}. SETTINGS_ENCRYPTION_KEY has changed or the file is damaged. Restore the original key, or delete the file and set the TASK connection again in the admin panel.`,
      );
    }
    saved = { ...raw, apiKey };
  }

  function current() {
    const baseUrl = saved?.taskBaseUrl || defaults.baseUrl || '';
    const apiKey = saved?.apiKey || defaults.apiKey || '';
    return {
      baseUrl,
      apiKey,
      environmentName: saved?.environmentName ?? defaults.environmentName ?? defaultEnvironmentName(baseUrl),
      source: saved ? 'admin' : 'environment',
      updatedAt: saved?.updatedAt || null,
      updatedBy: saved?.updatedBy || null,
      keyUpdatedAt: saved?.keyUpdatedAt || null,
      keyUpdatedBy: saved?.keyUpdatedBy || null,
    };
  }

  function writeAtomic(target, text) {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, target);
  }

  function audit(action, actor, details = {}) {
    if (!auditFile) return;
    const entry = {
      at: new Date().toISOString(),
      action,
      actor: actor ? { name: actor.name || '', email: actor.email || '', oid: actor.oid || '' } : null,
      details,
    };
    fs.mkdirSync(path.dirname(auditFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(auditFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  function readAudit(limit = 50) {
    if (!auditFile || !fs.existsSync(auditFile)) return [];
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /**
   * Saves new settings. `apiKey` blank/undefined keeps the current key.
   * Returns { changed: string[], settings } and notifies onChange listeners when something changed.
   */
  function update({ baseUrl, apiKey, environmentName }, actor) {
    if (!editable) throw new Error('Settings can only be changed when the admin panel is enabled.');
    const before = current();
    const nextUrl = baseUrl === undefined ? before.baseUrl : normaliseTaskUrl(baseUrl, { allowedHosts, production });
    const nextKey = apiKey === undefined || apiKey === null || String(apiKey).trim() === '' ? before.apiKey : String(apiKey).trim();
    const nextName = environmentName === undefined ? before.environmentName : String(environmentName).trim().slice(0, 40);

    const changed = [];
    if (nextUrl !== before.baseUrl) changed.push('baseUrl');
    if (nextKey !== before.apiKey) changed.push('apiKey');
    if (nextName !== before.environmentName) changed.push('environmentName');
    if (!changed.length) return { changed, settings: publicView() };

    const now = new Date().toISOString();
    const who = actor ? { name: actor.name || '', email: actor.email || '', oid: actor.oid || '' } : null;
    const record = {
      version: 1,
      taskBaseUrl: nextUrl,
      environmentName: nextName,
      apiKey: nextKey ? encrypt(nextKey, encryptionKey) : null,
      apiKeyHint: keyHint(nextKey),
      updatedAt: now,
      updatedBy: who,
      keyUpdatedAt: changed.includes('apiKey') ? now : saved?.keyUpdatedAt || null,
      keyUpdatedBy: changed.includes('apiKey') ? who : saved?.keyUpdatedBy || null,
    };
    writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
    saved = { ...record, apiKey: nextKey };

    const details = {};
    if (changed.includes('baseUrl')) details.baseUrl = { from: before.baseUrl, to: nextUrl };
    if (changed.includes('environmentName')) details.environmentName = { from: before.environmentName, to: nextName };
    if (changed.includes('apiKey')) details.apiKey = { from: keyHint(before.apiKey), to: keyHint(nextKey) };
    let signedOut = 0;
    for (const fn of listeners) signedOut += Number(fn({ changed, settings: current() })) || 0;
    details.signedOutClerks = signedOut;
    audit('settings_updated', actor, details);
    return { changed, signedOutClerks: signedOut, settings: publicView() };
  }

  /** Settings as the admin panel may see them: never the full API key. */
  function publicView() {
    const c = current();
    return {
      baseUrl: c.baseUrl,
      environmentName: c.environmentName,
      apiKeyHint: keyHint(c.apiKey),
      configured: Boolean(c.baseUrl && c.apiKey),
      source: c.source,
      updatedAt: c.updatedAt,
      updatedBy: c.updatedBy,
      keyUpdatedAt: c.keyUpdatedAt,
      keyUpdatedBy: c.keyUpdatedBy,
      allowedHosts,
    };
  }

  return {
    editable,
    /** What the TASK client uses on every request. */
    connection: () => {
      const c = current();
      return { baseUrl: c.baseUrl, apiKey: c.apiKey };
    },
    current,
    publicView,
    update,
    audit,
    readAudit,
    normaliseUrl: (url) => normaliseTaskUrl(url, { allowedHosts, production }),
    /** fn({ changed, settings }) is called after each change; it may return a number of signed-out sessions. */
    onChange: (fn) => listeners.push(fn),
  };
}
