import dotenv from 'dotenv';

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
    task: {
      baseUrl: (env.TASK_BASE_URL || 'https://madmexuatapi.xchangefusion.com').replace(/\/+$/, ''),
      apiKey: env.TASK_API_KEY || '',
      defaultLoginType: int(env.TASK_LOGIN_TYPE, 0, 'TASK_LOGIN_TYPE'),
      firstPageNo: int(env.TASK_FIRST_PAGE_NO, 1, 'TASK_FIRST_PAGE_NO'),
      pageSize: int(env.TASK_PAGE_SIZE, 100, 'TASK_PAGE_SIZE'),
      timeoutMs: int(env.TASK_TIMEOUT_MS, 20000, 'TASK_TIMEOUT_MS'),
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
  if (!config.task.apiKey) problems.push('TASK_API_KEY is required');
  if (!LOGIN_TYPES.some((t) => t.value === config.task.defaultLoginType)) {
    problems.push('TASK_LOGIN_TYPE must be 0, 1, 2 or 3');
  }
  if (config.task.pageSize < 1 || config.task.pageSize > 1000) {
    problems.push('TASK_PAGE_SIZE must be between 1 and 1000');
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
