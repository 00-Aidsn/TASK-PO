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
    trustProxy: env.TRUST_PROXY || false,
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
    settings: {
      dataDir: path.resolve(env.DATA_DIR || 'data'),
      encryptionKey: parseEncryptionKey(env.SETTINGS_ENCRYPTION_KEY),
    },
    mail: {
      mode: (env.MAIL_MODE || 'log').toLowerCase(),
      from: env.MAIL_FROM || '',
      cc: list(env.MAIL_CC),
      showPrices: bool(env.MAIL_SHOW_PRICES, true),
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
