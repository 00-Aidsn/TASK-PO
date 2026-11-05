import path from 'node:path';
import dotenv from 'dotenv';
import { parseEncryptionKey } from './settings.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LOGIN_TYPES = [
  { value: 0, label: 'Email' },
  { value: 1, label: 'Clerk ID' },
  { value: 2, label: 'Clerk alpha name' },
  { value: 3, label: 'Clerk logon' },
];

function int(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${name} must be a whole number (got "${value}")`);
  return n;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

/**
 * Express "trust proxy": a hop count must be a number. The text "2" would be read as an IP address.
 * Accepts a number of hops (e.g. 2 for Cloudflare + Azure), true/false, or Express names like "loopback".
 */
export function parseTrustProxy(value) {
  const text = String(value ?? '').trim();
  if (!text || /^(false|no|off|0)$/i.test(text)) return false;
  if (/^\d+$/.test(text)) return Number(text);
  if (/^(true|yes|on)$/i.test(text)) return true;
  return text;
}

function list(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Builds the app configuration from environment variables.
 * Throws if anything required is missing so the server fails fast at start-up.
 */
export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const config = {
    port: int(env.PORT, 3000, 'PORT'),
    production,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    // When set, only requests carrying X-Origin-Verify with one of these values are served (added by a
    // Cloudflare Transform Rule), so nobody can bypass Cloudflare. Comma-separate two values while rotating.
    originSecrets: list(env.CLOUDFLARE_ORIGIN_SECRET),
    cookieSecure: bool(env.COOKIE_SECURE, production),
    sessionIdleMinutes: int(env.SESSION_IDLE_MINUTES, 30, 'SESSION_IDLE_MINUTES'),
    displayTimeZone: env.DISPLAY_TIMEZONE || 'Australia/Sydney',
    companyName: env.COMPANY_NAME || 'Mad Mex',
    catalogue: {
      // Only offer products that have a supplier cost for the location's venue.
      requireVenueCost: bool(env.REQUIRE_VENUE_COST, true),
      // Parallel GET /products/{id} calls when checking product status.
      productLookupConcurrency: int(env.PRODUCT_LOOKUP_CONCURRENCY, 6, 'PRODUCT_LOOKUP_CONCURRENCY'),
    },
    task: {
      baseUrl: (env.TASK_BASE_URL || 'https://madmexuatapi.xchangefusion.com').replace(/\/+$/, ''),
      apiKey: env.TASK_API_KEY || '',
      defaultLoginType: int(env.TASK_LOGIN_TYPE, 0, 'TASK_LOGIN_TYPE'),
      firstPageNo: int(env.TASK_FIRST_PAGE_NO, 1, 'TASK_FIRST_PAGE_NO'),
      pageSize: int(env.TASK_PAGE_SIZE, 100, 'TASK_PAGE_SIZE'),
      timeoutMs: int(env.TASK_TIMEOUT_MS, 20000, 'TASK_TIMEOUT_MS'),
      // Shown to clerks, e.g. "UAT". Defaults from the URL. Can be changed in the admin panel.
      environmentName: env.TASK_ENVIRONMENT_NAME || undefined,
      // The only servers the TASK API URL may point at (set by IT; not editable in the admin panel).
      allowedHosts: list(env.TASK_ALLOWED_HOSTS || '*.xchangefusion.com'),
    },
    // Admin panel (Microsoft Entra ID sign-in). Enabled when ENTRA_TENANT_ID / ENTRA_CLIENT_ID are set.
    admin: {
      enabled: Boolean(env.ENTRA_TENANT_ID || env.ENTRA_CLIENT_ID),
      tenantId: (env.ENTRA_TENANT_ID || '').trim().toLowerCase(),
      clientId: (env.ENTRA_CLIENT_ID || '').trim(),
      clientSecret: env.ENTRA_CLIENT_SECRET || '',
      authority: (env.ENTRA_AUTHORITY || 'https://login.microsoftonline.com').replace(/\/+$/, ''),
      publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
      allowedUsers: list(env.ADMIN_ALLOWED_USERS).map((u) => u.toLowerCase()),
      allowedObjectIds: list(env.ADMIN_ALLOWED_OBJECT_IDS).map((u) => u.toLowerCase()),
      sessionIdleMinutes: int(env.ADMIN_SESSION_IDLE_MINUTES, 30, 'ADMIN_SESSION_IDLE_MINUTES'),
      sessionMaxHours: int(env.ADMIN_SESSION_MAX_HOURS, 8, 'ADMIN_SESSION_MAX_HOURS'),
      allowInsecureIdp: false, // tests only
    },
    // Central hub (Supabase) -> TASK clerk sync. Enabled when HUB_SUPABASE_URL is set.
    sync: {
      enabled: Boolean(env.HUB_SUPABASE_URL),
      hub: {
        url: (env.HUB_SUPABASE_URL || '').replace(/\/+$/, ''),
        key: env.HUB_SUPABASE_KEY || '',
        schema: env.HUB_SCHEMA || 'public',
        table: env.HUB_TABLE || '',
        allowedHosts: list(env.HUB_ALLOWED_HOSTS || '*.supabase.co'),
        columns: {
          id: env.HUB_COL_ID || 'id',
          firstName: env.HUB_COL_FIRST_NAME || 'first_name',
          lastName: env.HUB_COL_LAST_NAME || 'last_name',
          email: env.HUB_COL_EMAIL || 'email',
          active: env.HUB_COL_ACTIVE ?? 'is_active', // blank = everyone in the hub is active
          mobile: env.HUB_COL_MOBILE || '',
          payrollId: env.HUB_COL_PAYROLL_ID || '',
          venueNo: env.HUB_COL_VENUE_NO || '',
          clerkLogon: env.HUB_COL_CLERK_LOGON || '',
        },
      },
      // The TASK clerk the sync signs in as. It needs permission to view and edit clerks.
      taskLogin: env.SYNC_TASK_LOGIN || '',
      taskPassword: env.SYNC_TASK_PASSWORD || '',
      taskLoginType: int(env.SYNC_TASK_LOGIN_TYPE, 0, 'SYNC_TASK_LOGIN_TYPE'),
      newClerkGroupId: int(env.SYNC_NEW_CLERK_GROUP_ID, 0, 'SYNC_NEW_CLERK_GROUP_ID'),
      newClerkVenueNo: int(env.SYNC_NEW_CLERK_VENUE_NO, 0, 'SYNC_NEW_CLERK_VENUE_NO'),
      intervalMinutes: int(env.SYNC_INTERVAL_MINUTES, 15, 'SYNC_INTERVAL_MINUTES'),
      maxDeactivations: int(env.SYNC_MAX_DEACTIVATIONS, 10, 'SYNC_MAX_DEACTIVATIONS'),
      maxCreations: int(env.SYNC_MAX_CREATIONS, 25, 'SYNC_MAX_CREATIONS'),
    },
    settings: {
      dataDir: path.resolve(env.DATA_DIR || 'data'),
      encryptionKey: parseEncryptionKey(env.SETTINGS_ENCRYPTION_KEY),
    },
    mail: {
      mode: (env.MAIL_MODE || 'log').toLowerCase(),
      from: env.MAIL_FROM || '',
      cc: list(env.MAIL_CC),
      outboxDir: env.MAIL_OUTBOX_DIR || 'outbox',
      smtp: {
        host: env.SMTP_HOST || '',
        port: int(env.SMTP_PORT, 587, 'SMTP_PORT'),
        secure: bool(env.SMTP_SECURE, false),
        user: env.SMTP_USER || '',
        pass: env.SMTP_PASS || '',
      },
    },
  };

  const problems = [];
  const { admin } = config;
  // Without the admin panel the API key must come from the environment; with it, it can be set in the panel.
  if (!config.task.apiKey && !admin.enabled) problems.push('TASK_API_KEY is required');
  if (!config.task.allowedHosts.length) problems.push('TASK_ALLOWED_HOSTS must list at least one host');
  if (config.originSecrets.some((s) => s.length < 32)) {
    problems.push('CLOUDFLARE_ORIGIN_SECRET must be at least 32 characters, e.g. from: openssl rand -hex 32');
  }
  if (admin.enabled) {
    if (!GUID.test(admin.tenantId)) problems.push('ENTRA_TENANT_ID must be your Entra directory (tenant) ID');
    if (!GUID.test(admin.clientId)) problems.push('ENTRA_CLIENT_ID must be the app registration\'s application (client) ID');
    if (!admin.clientSecret) problems.push('ENTRA_CLIENT_SECRET is required for the admin panel');
    if (!admin.allowedUsers.length && !admin.allowedObjectIds.length) {
      problems.push('Set ADMIN_ALLOWED_USERS and/or ADMIN_ALLOWED_OBJECT_IDS to the people allowed into the admin panel');
    }
    let publicUrl = null;
    try {
      publicUrl = new URL(admin.publicBaseUrl);
    } catch {
      problems.push('PUBLIC_BASE_URL is required for the admin panel, e.g. https://po.madmex.com.au');
    }
    if (publicUrl && publicUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(publicUrl.hostname)) {
      problems.push('PUBLIC_BASE_URL must use https');
    }
    if (!config.settings.encryptionKey) {
      problems.push('SETTINGS_ENCRYPTION_KEY must be 32 random bytes (base64), e.g. from: openssl rand -base64 32');
    }
    if (admin.sessionIdleMinutes < 1 || admin.sessionMaxHours < 1) problems.push('Admin session times must be at least 1');
  }
  const { sync } = config;
  if (sync.enabled) {
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!admin.enabled) problems.push('The hub sync needs the admin panel (ENTRA_* settings) for previews and approvals');
    let hubUrl = null;
    try {
      hubUrl = new URL(sync.hub.url);
    } catch {
      problems.push('HUB_SUPABASE_URL must be your Supabase project URL, e.g. https://abcd1234.supabase.co');
    }
    if (hubUrl) {
      const local = ['localhost', '127.0.0.1'].includes(hubUrl.hostname);
      if (hubUrl.protocol !== 'https:' && !(local && !production)) problems.push('HUB_SUPABASE_URL must use https');
      const allowed = sync.hub.allowedHosts.some((p) =>
        p.startsWith('*.') ? hubUrl.hostname.endsWith(p.slice(1)) : hubUrl.hostname === p,
      );
      if (!allowed) problems.push(`HUB_SUPABASE_URL host must be one of HUB_ALLOWED_HOSTS (${sync.hub.allowedHosts.join(', ')})`);
    }
    if (!sync.hub.key) problems.push('HUB_SUPABASE_KEY is required for the hub sync');
    if (!identifier.test(sync.hub.table)) problems.push('HUB_TABLE must be the hub table or view name');
    if (!identifier.test(sync.hub.schema)) problems.push('HUB_SCHEMA must be a schema name');
    for (const [name, col] of Object.entries(sync.hub.columns)) {
      if (col && !identifier.test(col)) problems.push(`HUB_COL_* for ${name} must be a column name (got "${col}")`);
    }
    for (const required of ['id', 'firstName', 'lastName', 'email']) {
      if (!sync.hub.columns[required]) problems.push(`The hub column for ${required} must be set`);
    }
    if (!sync.taskLogin || !sync.taskPassword) {
      problems.push('SYNC_TASK_LOGIN and SYNC_TASK_PASSWORD (a TASK clerk allowed to edit clerks) are required for the hub sync');
    }
    if (!sync.newClerkGroupId) problems.push('SYNC_NEW_CLERK_GROUP_ID (TASK clerk group for new clerks) is required for the hub sync');
    if (!sync.newClerkVenueNo && !sync.hub.columns.venueNo) {
      problems.push('Set SYNC_NEW_CLERK_VENUE_NO or HUB_COL_VENUE_NO so new clerks get a home venue');
    }
    if (sync.intervalMinutes < 0) problems.push('SYNC_INTERVAL_MINUTES must be 0 (off) or more');
    if (sync.maxDeactivations < 0 || sync.maxCreations < 0) problems.push('SYNC_MAX_* limits must be 0 or more');
  }
  if (!LOGIN_TYPES.some((t) => t.value === config.task.defaultLoginType)) {
    problems.push('TASK_LOGIN_TYPE must be 0, 1, 2 or 3');
  }
  if (config.task.pageSize < 1 || config.task.pageSize > 1000) {
    problems.push('TASK_PAGE_SIZE must be between 1 and 1000');
  }
  if (config.catalogue.productLookupConcurrency < 1 || config.catalogue.productLookupConcurrency > 20) {
    problems.push('PRODUCT_LOOKUP_CONCURRENCY must be between 1 and 20');
  }
  if (config.sessionIdleMinutes < 1) problems.push('SESSION_IDLE_MINUTES must be at least 1');
  if (!['log', 'smtp'].includes(config.mail.mode)) problems.push('MAIL_MODE must be "log" or "smtp"');
  if (config.mail.mode === 'smtp') {
    if (!config.mail.smtp.host) problems.push('SMTP_HOST is required when MAIL_MODE=smtp');
    if (!config.mail.from) problems.push('MAIL_FROM is required when MAIL_MODE=smtp');
  }
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: config.displayTimeZone });
  } catch {
    problems.push(`DISPLAY_TIMEZONE "${config.displayTimeZone}" is not a valid time zone`);
  }
  if (problems.length) {
    throw new Error(`Configuration error:\n  - ${problems.join('\n  - ')}`);
  }
  return config;
}

export function loadConfigFromDotenv() {
  dotenv.config({ quiet: true });
  return loadConfig(process.env);
}
