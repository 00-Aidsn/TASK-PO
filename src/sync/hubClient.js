/**
 * Reads hub users from Supabase through its REST API (PostgREST):
 *   GET {HUB_SUPABASE_URL}/rest/v1/{HUB_TABLE}?select=<mapped columns>&order=<id>.asc&limit=..&offset=..
 * Only the mapped columns are requested, so nothing else from the hub (e.g. HR details) is read.
 * Read-only: the hub is the master and is never written to.
 */

export class HubError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause });
    this.name = 'HubError';
    this.status = status;
  }
}

const TRUE_WORDS = new Set(['true', 't', '1', 'yes', 'y', 'active', 'current', 'employed', 'enabled']);
const FALSE_WORDS = new Set(['false', 'f', '0', 'no', 'n', 'inactive', 'terminated', 'left', 'disabled', 'resigned']);

/** true / false, or null when the value doesn't clearly say (then nothing is deactivated). */
export function parseActive(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  const text = String(value ?? '').trim().toLowerCase();
  if (TRUE_WORDS.has(text)) return true;
  if (FALSE_WORDS.has(text)) return false;
  return null;
}

const clean = (v) => (v === null || v === undefined ? '' : String(v).trim());

export function createHubClient(hub, { fetchImpl = fetch, timeoutMs = 20000, pageSize = 1000 } = {}) {
  const cols = hub.columns;
  const selected = [...new Set(Object.values(cols).filter(Boolean))];

  async function fetchPage(offset, limit = pageSize) {
    const url = new URL(`/rest/v1/${hub.table}`, hub.url);
    url.searchParams.set('select', selected.join(','));
    url.searchParams.set('order', `${cols.id}.asc`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    let res;
    try {
      res = await fetchImpl(url, {
        headers: {
          apikey: hub.key,
          Authorization: `Bearer ${hub.key}`,
          Accept: 'application/json',
          'Accept-Profile': hub.schema,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new HubError(`Could not reach the central hub (${url.host})`, { cause: err });
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = '';
      try {
        const body = JSON.parse(text);
        detail = body.message || body.error || body.hint || '';
      } catch {
        detail = text.slice(0, 200);
      }
      const why =
        res.status === 401 || res.status === 403
          ? 'the hub did not accept HUB_SUPABASE_KEY'
          : res.status === 404
            ? `table or view "${hub.table}" was not found`
            : `HTTP ${res.status}`;
      throw new HubError(`The central hub refused the request: ${why}${detail ? ` (${String(detail).slice(0, 200)})` : ''}`, {
        status: res.status,
      });
    }
    try {
      const rows = JSON.parse(text);
      if (!Array.isArray(rows)) throw new Error('not a list');
      return rows;
    } catch {
      throw new HubError('The central hub returned something that is not a list of users');
    }
  }

  /** All hub users, mapped to { hubId, firstName, lastName, email, active, mobile, payrollId, venueNo, clerkLogon }. */
  async function getUsers({ maxRows = 50000 } = {}) {
    const users = [];
    for (let offset = 0; offset < maxRows; offset += pageSize) {
      const rows = await fetchPage(offset);
      for (const r of rows) {
        const hubId = clean(r[cols.id]);
        if (!hubId) continue;
        const venue = cols.venueNo ? Number(r[cols.venueNo]) : NaN;
        const logon = cols.clerkLogon ? Number(r[cols.clerkLogon]) : NaN;
        users.push({
          hubId,
          firstName: clean(r[cols.firstName]),
          lastName: clean(r[cols.lastName]),
          email: clean(r[cols.email]).toLowerCase(),
          active: cols.active ? parseActive(r[cols.active]) : true,
          mobile: cols.mobile ? clean(r[cols.mobile]) : '',
          payrollId: cols.payrollId ? clean(r[cols.payrollId]) : '',
          venueNo: Number.isInteger(venue) && venue > 0 ? venue : null,
          clerkLogon: Number.isInteger(logon) && logon > 0 ? logon : null,
        });
      }
      if (rows.length < pageSize) break;
    }
    return users;
  }

  /** Reads one row to check the URL, key, table and column names. */
  async function check() {
    await fetchPage(0, 1);
    return { ok: true, table: hub.table, columns: selected };
  }

  return { getUsers, check };
}
