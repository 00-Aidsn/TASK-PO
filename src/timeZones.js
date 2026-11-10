/**
 * Store time zones.
 *
 * TASK's store records (GET /terminals/locations) carry a TimeZoneId. It may be a standard (IANA) name,
 * e.g. "Australia/Perth", or a Windows/.NET name, e.g. "W. Australia Standard Time". TASK's
 * GET /lookup/timezones maps between the two. resolveStoreTimeZone() turns whatever TASK holds into a
 * standard name, falling back to the store's state, then to DISPLAY_TIMEZONE.
 */

/** Windows/.NET names for Australian and New Zealand zones, used if TASK's lookup isn't available. */
export const WINDOWS_TO_IANA = Object.freeze({
  'aus eastern standard time': 'Australia/Sydney',
  'e. australia standard time': 'Australia/Brisbane',
  'cen. australia standard time': 'Australia/Adelaide',
  'aus central standard time': 'Australia/Darwin',
  'w. australia standard time': 'Australia/Perth',
  'tasmania standard time': 'Australia/Hobart',
  'aus central w. standard time': 'Australia/Eucla',
  'lord howe standard time': 'Australia/Lord_Howe',
  'new zealand standard time': 'Pacific/Auckland',
});

/** When TASK has no usable TimeZoneId: the time zone of the store's state. */
export const STATE_TO_IANA = Object.freeze({
  NSW: 'Australia/Sydney',
  ACT: 'Australia/Sydney',
  VIC: 'Australia/Melbourne',
  QLD: 'Australia/Brisbane',
  SA: 'Australia/Adelaide',
  WA: 'Australia/Perth',
  TAS: 'Australia/Hobart',
  NT: 'Australia/Darwin',
});

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A standard name such as Australia/Perth (or UTC). */
const isStandardName = (tz) => (tz.includes('/') || /^(utc|gmt)$/i.test(tz)) && isValidTimeZone(tz);

/** TASK's /lookup/timezones dictionary ({ "Australia/Perth": "W. Australia Standard Time" } or [{Key, Value}]) as a Map. */
export function timeZoneLookup(dict) {
  const map = new Map();
  if (Array.isArray(dict)) {
    for (const r of dict) {
      const k = String(r?.Key ?? r?.key ?? '').trim();
      const v = String(r?.Value ?? r?.value ?? '').trim();
      if (k && v) map.set(k, v);
    }
  } else if (dict && typeof dict === 'object') {
    for (const [k, v] of Object.entries(dict)) if (k.trim() && String(v ?? '').trim()) map.set(k.trim(), String(v).trim());
  }
  return map;
}

/**
 * The store's time zone as a standard name, or `fallback` if it can't be worked out.
 * Order: a standard TimeZoneId; TimeZoneId translated by TASK's lookup (either direction); the built-in
 * Windows table; the store's state; the fallback.
 */
export function resolveStoreTimeZone({ timeZoneId, state, lookup = new Map(), fallback = null }) {
  const id = String(timeZoneId ?? '').trim();
  if (id) {
    if (isStandardName(id)) return id;
    const lower = id.toLowerCase();
    for (const [k, v] of lookup) {
      if (v.toLowerCase() === lower && isStandardName(k)) return k;
      if (k.toLowerCase() === lower && isStandardName(v)) return v;
    }
    if (WINDOWS_TO_IANA[lower]) return WINDOWS_TO_IANA[lower];
  }
  const byState = STATE_TO_IANA[String(state ?? '').trim().toUpperCase()];
  return byState || fallback;
}

/** The wall-clock parts of an instant in a time zone: { year, month, day, hour, minute, second }. */
export function wallClock(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-AU', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    year: +parts.year,
    month: +parts.month,
    day: +parts.day,
    hour: +parts.hour % 24,
    minute: +parts.minute,
    second: +parts.second,
  };
}

/** How far the time zone's clock is ahead of UTC at that instant, in milliseconds. */
function offsetMs(instantMs, timeZone) {
  const whole = Math.floor(instantMs / 1000) * 1000;
  const w = wallClock(new Date(whole), timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - whole;
}

/**
 * The exact moment a wall-clock time happened in a time zone, e.g. 10:19:57 on 5/11/2026 in Sydney.
 * Checked twice so daylight-saving changes come out right.
 */
export function zonedTimeToInstant({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = wall - offsetMs(wall, timeZone);
  instant = wall - offsetMs(instant, timeZone);
  return new Date(instant);
}
