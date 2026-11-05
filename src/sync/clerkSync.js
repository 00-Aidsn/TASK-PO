/**
 * Central hub (Supabase) -> TASK clerk sync. The hub is the master.
 *
 * Matching, in order:
 *   1. a link saved by an earlier sync (hub user id -> TASK clerk id, per TASK server),
 *   2. email address (the primary key once emails are in TASK),
 *   3. first + last name, only when exactly one TASK clerk has that name. Name matches are only
 *      applied when an administrator approves those exact pairs in a "Sync now" preview.
 *
 * For matched clerks the sync writes ONLY: first name, surname, email, mobile, payroll ID and
 * active status. Empty hub values never blank TASK fields. Other TASK clerk data (password, date of
 * birth, tax number, pay rate, addresses, emergency contacts, groups, roles) is never changed: each
 * clerk is re-read just before saving, only the synced fields are replaced, and the password field
 * is never sent back.
 *
 * Hub users with no match are created in TASK (default clerk group and venue, no password).
 * A TASK clerk is deactivated only when the hub explicitly marks the person inactive; people missing
 * from the hub are only reported. Administrators and the sync's own TASK account are never
 * deactivated automatically. Nothing is ever deleted.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TaskApiError } from '../taskClient.js';

export class SyncError extends Error {
  constructor(message, { status = 502, code } = {}) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
    this.code = code;
  }
}

/** Lower-case, accents removed, punctuation dropped, single spaces. "  Zoë  O'Brien-Smith " -> "zoe obriensmith" */
export function normaliseName(first, last) {
  const part = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const full = `${part(first)} ${part(last)}`.trim();
  return full.includes(' ') ? full : ''; // need both names
}

const normEmail = (e) => String(e || '').trim().toLowerCase();
const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
const displayName = (first, last) => `${first || ''} ${last || ''}`.trim() || '(no name)';

/** The only TASK clerk fields the sync reads for planning. */
export function safeClerk(c) {
  return {
    ClerkId: Number(c.ClerkId),
    ClerkLogon: Number(c.ClerkLogon) || null,
    ClerkName: String(c.ClerkName || '').trim(),
    ClerkSurname: String(c.ClerkSurname || '').trim(),
    Email: String(c.Email || '').trim(),
    MobilePhone: String(c.MobilePhone || '').trim(),
    PayrollIDNumber: String(c.PayrollIDNumber || '').trim(),
    IsActive: c.IsActive !== false,
    IsAdministrator: Boolean(c.IsAdministrator),
  };
}

/** Hub value -> TASK field. Only these are ever written to existing clerks. */
const FIELD_MAP = [
  ['firstName', 'ClerkName'],
  ['lastName', 'ClerkSurname'],
  ['email', 'Email'],
  ['mobile', 'MobilePhone'],
  ['payrollId', 'PayrollIDNumber'],
];

function fieldChanges(hubUser, clerk) {
  const changes = {};
  for (const [hubField, taskField] of FIELD_MAP) {
    const to = hubUser[hubField];
    if (!to) continue; // never blank a TASK field from an empty hub value
    const from = clerk[taskField];
    const differs = taskField === 'Email' ? normEmail(from) !== normEmail(to) : !same(from, to);
    if (differs) changes[taskField] = { from, to };
  }
  return changes;
}

/**
 * Works out what the sync would do. Pure: reads nothing, writes nothing.
 * @param {object} p
 * @param {Array} p.hubUsers   from hubClient.getUsers()
 * @param {Array} p.clerks     TASK clerks (safeClerk shape)
 * @param {Map}   p.links      hubId -> clerkId saved by earlier syncs (this TASK server)
 * @param {number|null} p.syncClerkId  the TASK clerk the sync signs in as
 */
export function buildSyncPlan({ hubUsers: allHubUsers, clerks, links = new Map(), syncClerkId = null }) {
  const byId = new Map(clerks.map((c) => [c.ClerkId, c]));
  const issues = [];
  // One row per hub user id; repeated ids are reported and ignored.
  const seenHubIds = new Set();
  const hubUsers = [];
  for (const u of allHubUsers) {
    if (seenHubIds.has(u.hubId)) {
      issues.push({
        type: 'duplicate_hub_id',
        hubId: u.hubId,
        name: displayName(u.firstName, u.lastName),
        message: `Hub user id ${u.hubId} appears more than once; only the first row is used.`,
      });
      continue;
    }
    seenHubIds.add(u.hubId);
    hubUsers.push(u);
  }
  const claimed = new Map(); // clerkId -> hubId
  const matches = new Map(); // hubId -> { clerk, match }
  const actions = [];

  const index = (keyFn) => {
    const m = new Map();
    for (const c of clerks) {
      const k = keyFn(c);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(c);
    }
    return m;
  };
  const byEmail = index((c) => normEmail(c.Email));
  const byName = index((c) => normaliseName(c.ClerkName, c.ClerkSurname));

  // Hub emails used by more than one person can't be used for matching.
  const hubEmailCount = new Map();
  for (const u of hubUsers) if (u.email) hubEmailCount.set(u.email, (hubEmailCount.get(u.email) || 0) + 1);

  const claim = (u, clerk, match) => {
    claimed.set(clerk.ClerkId, u.hubId);
    matches.set(u.hubId, { clerk, match });
  };

  // 1. Saved links
  for (const u of hubUsers) {
    const clerkId = links.get(u.hubId);
    const clerk = clerkId != null ? byId.get(Number(clerkId)) : null;
    if (clerk && !claimed.has(clerk.ClerkId)) claim(u, clerk, 'link');
  }

  // 2. Email
  for (const u of hubUsers) {
    if (matches.has(u.hubId) || !u.email) continue;
    if (hubEmailCount.get(u.email) > 1) {
      issues.push({
        type: 'duplicate_hub_email',
        hubId: u.hubId,
        name: displayName(u.firstName, u.lastName),
        message: `${u.email} is used by more than one person in the hub, so it can't be matched by email.`,
      });
      continue;
    }
    const candidates = (byEmail.get(u.email) || []).filter((c) => !claimed.has(c.ClerkId));
    if (candidates.length === 1) claim(u, candidates[0], 'email');
    else if (candidates.length > 1) {
      issues.push({
        type: 'duplicate_task_email',
        hubId: u.hubId,
        name: displayName(u.firstName, u.lastName),
        message: `${candidates.length} TASK clerks have the email ${u.email} (clerk IDs ${candidates.map((c) => c.ClerkId).join(', ')}). Fix this in TASK.`,
      });
      matches.set(u.hubId, { clerk: null, match: 'blocked' });
    }
  }

  // 3. First + last name (needs approval), else create
  for (const u of hubUsers) {
    if (matches.has(u.hubId)) continue;
    const name = displayName(u.firstName, u.lastName);
    const key = normaliseName(u.firstName, u.lastName);
    const candidates = key ? (byName.get(key) || []).filter((c) => !claimed.has(c.ClerkId)) : [];
    if (candidates.length === 1) {
      claim(u, candidates[0], 'name');
      continue;
    }
    if (candidates.length > 1) {
      issues.push({
        type: 'ambiguous_name',
        hubId: u.hubId,
        name,
        message: `${candidates.length} TASK clerks are called ${name} (clerk IDs ${candidates.map((c) => c.ClerkId).join(', ')}). Add ${u.email || 'their email'} to the right one in TASK, then sync again.`,
      });
      continue;
    }
    if (u.active !== true) continue; // inactive (or unclear) and not in TASK: nothing to do
    if (!u.firstName || !u.lastName || !u.email) {
      issues.push({
        type: 'missing_details',
        hubId: u.hubId,
        name,
        message: `Not created in TASK: the hub record needs a first name, last name and email.`,
      });
      continue;
    }
    actions.push({
      type: 'create',
      hubId: u.hubId,
      clerkId: null,
      name,
      match: 'new',
      needsApproval: false,
      changes: Object.fromEntries(
        FIELD_MAP.filter(([h]) => u[h]).map(([h, t]) => [t, { from: '', to: u[h] }]),
      ),
      hub: { venueNo: u.venueNo, clerkLogon: u.clerkLogon },
    });
  }

  // Changes for matched clerks
  for (const u of hubUsers) {
    const m = matches.get(u.hubId);
    if (!m || !m.clerk) continue;
    const { clerk, match } = m;
    const name = displayName(u.firstName, u.lastName);
    const changes = fieldChanges(u, clerk);
    let status = null;
    if (u.active === false && clerk.IsActive) {
      if (clerk.ClerkId === syncClerkId) {
        issues.push({ type: 'protected', hubId: u.hubId, name, message: `Not deactivated: clerk ${clerk.ClerkId} is the account the sync uses.` });
      } else if (clerk.IsAdministrator) {
        issues.push({
          type: 'protected',
          hubId: u.hubId,
          name,
          message: `Not deactivated: clerk ${clerk.ClerkId} is a TASK administrator. Deactivate them in TASK if that's right.`,
        });
      } else {
        status = 'deactivate';
      }
    } else if (u.active === true && !clerk.IsActive) {
      status = 'reactivate';
    }
    const newLink = match !== 'link';
    if (!Object.keys(changes).length && !status && !newLink) continue; // already in sync
    actions.push({
      type: status || (Object.keys(changes).length ? 'update' : 'link'),
      hubId: u.hubId,
      clerkId: clerk.ClerkId,
      name,
      match,
      needsApproval: match === 'name',
      changes,
      status,
      taskName: displayName(clerk.ClerkName, clerk.ClerkSurname),
      taskEmail: clerk.Email,
    });
  }

  const notInHub = clerks
    .filter((c) => c.IsActive && !claimed.has(c.ClerkId))
    .map((c) => ({ clerkId: c.ClerkId, name: displayName(c.ClerkName, c.ClerkSurname), email: c.Email }));

  const count = (t) => actions.filter((a) => a.type === t).length;
  return {
    hubCount: allHubUsers.length,
    taskCount: clerks.length,
    actions,
    issues,
    notInHub,
    summary: {
      create: count('create'),
      update: count('update'),
      link: count('link'),
      deactivate: count('deactivate'),
      reactivate: count('reactivate'),
      needsApproval: actions.filter((a) => a.needsApproval).length,
      issues: issues.length,
      notInHub: notInHub.length,
    },
  };
}

// ---------------------------------------------------------------- links file
function linksStore(dataDir) {
  const file = path.join(dataDir, 'clerk-links.json');
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { version: 1, servers: {} };
    }
  };
  return {
    load(baseUrl) {
      return new Map(Object.entries(read().servers?.[baseUrl] || {}).map(([k, v]) => [k, Number(v)]));
    },
    save(baseUrl, map) {
      const all = read();
      all.servers ??= {};
      all.servers[baseUrl] = Object.fromEntries(map);
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

const isSessionError = (err) => err instanceof TaskApiError && (err.kind === 'unauthorized' || err.kind === 'session_expired');

/**
 * The sync service: preview, run (manual or scheduled), status, and a scheduler.
 */
export function createClerkSync({ config, task, settings, hub }) {
  const opts = config.sync;
  const links = linksStore(config.settings.dataDir);
  let token = null;
  let syncClerkId = null;
  let running = false;
  let lastRun = null;
  let timer = null;

  settings.onChange(() => {
    token = null; // a new TASK server or key needs a new sign-in
    syncClerkId = null;
    return 0;
  });

  async function signIn() {
    let tokens;
    try {
      tokens = await task.loginClerk({ login: opts.taskLogin, password: opts.taskPassword, loginType: opts.taskLoginType });
    } catch (err) {
      if (err instanceof TaskApiError && ['unauthorized', 'forbidden', 'rejected'].includes(err.kind)) {
        throw new SyncError('TASK did not accept the sync clerk login (SYNC_TASK_LOGIN / SYNC_TASK_PASSWORD).', { code: 'task_login' });
      }
      throw err;
    }
    token = tokens?.AccessToken || tokens?.accessToken;
    if (!token) throw new SyncError('TASK did not return a session for the sync clerk.');
    try {
      syncClerkId = Number((await task.currentClerk(token))?.UserId) || null;
    } catch {
      syncClerkId = null;
    }
    return token;
  }

  /** Runs fn(token), signing in again once if the TASK session has expired. */
  async function withTask(fn) {
    if (!token) await signIn();
    try {
      return await fn(token);
    } catch (err) {
      if (!isSessionError(err)) throw err;
      await signIn();
      return fn(token);
    }
  }

  async function loadPlan() {
    const baseUrl = settings.connection().baseUrl;
    const [hubUsers, rawClerks] = await Promise.all([hub.getUsers(), withTask((t) => task.getClerks(t))]);
    if (!hubUsers.length) {
      throw new SyncError('The central hub returned no users, so nothing was changed. Check HUB_TABLE and the hub key.', {
        code: 'hub_empty',
      });
    }
    const clerks = rawClerks.filter((c) => Number.isInteger(Number(c?.ClerkId)) && Number(c.ClerkId) > 0).map(safeClerk);
    const savedLinks = links.load(baseUrl);
    const plan = buildSyncPlan({ hubUsers, clerks, links: savedLinks, syncClerkId });
    return { baseUrl, plan, clerks, savedLinks };
  }

  async function preview() {
    if (running) throw new SyncError('A sync is running. Try again in a moment.', { status: 409, code: 'busy' });
    const { baseUrl, plan } = await loadPlan();
    return { ...plan, taskBaseUrl: baseUrl, generatedAt: new Date().toISOString(), limits: limits() };
  }

  function limits() {
    return { maxDeactivations: opts.maxDeactivations, maxCreations: opts.maxCreations };
  }

  /**
   * Applies a freshly built plan.
   * @param {object} o
   * @param {'manual'|'scheduled'} o.mode
   * @param {Array<{hubId:string, clerkId:number}>} [o.approvedNameLinks]  exact name matches approved in a preview
   * @param {boolean} [o.confirmLargeChanges]  allow more creations/deactivations than the limits (manual only)
   * @param {object} [o.actor]  the admin who ran it
   */
  async function run({ mode = 'manual', approvedNameLinks = [], confirmLargeChanges = false, actor = null } = {}) {
    if (running) throw new SyncError('A sync is already running.', { status: 409, code: 'busy' });
    running = true;
    const startedAt = new Date().toISOString();
    try {
      const { baseUrl, plan, clerks, savedLinks } = await loadPlan();
      const approved = new Set(mode === 'manual' ? approvedNameLinks.map((a) => `${a.hubId}:${Number(a.clerkId)}`) : []);
      const allowLarge = mode === 'manual' && confirmLargeChanges === true;
      const held = [];
      if (plan.summary.deactivate > opts.maxDeactivations && !allowLarge) {
        held.push(`${plan.summary.deactivate} deactivations (limit ${opts.maxDeactivations})`);
      }
      if (plan.summary.create > opts.maxCreations && !allowLarge) {
        held.push(`${plan.summary.create} new clerks (limit ${opts.maxCreations})`);
      }
      const holdDeactivate = held.some((h) => h.includes('deactivations'));
      const holdCreate = held.some((h) => h.includes('new clerks'));

      let nextLogon = clerks.reduce((max, c) => Math.max(max, c.ClerkLogon || 0), 0);
      const usedLogons = new Set(clerks.map((c) => c.ClerkLogon).filter(Boolean));
      const takeLogon = (wanted) => {
        if (wanted && !usedLogons.has(wanted)) {
          usedLogons.add(wanted);
          return wanted;
        }
        do nextLogon += 1;
        while (usedLogons.has(nextLogon));
        usedLogons.add(nextLogon);
        return nextLogon;
      };

      const results = [];
      for (const action of plan.actions) {
        const base = { type: action.type, hubId: action.hubId, clerkId: action.clerkId, name: action.name, fields: Object.keys(action.changes || {}) };
        if (action.needsApproval && !approved.has(`${action.hubId}:${action.clerkId}`)) {
          results.push({ ...base, result: 'waiting_for_approval' });
          continue;
        }
        if ((action.type === 'deactivate' && holdDeactivate) || (action.type === 'create' && holdCreate)) {
          results.push({ ...base, result: 'held' });
          continue;
        }
        try {
          if (action.type === 'create') {
            const model = {
              ClerkName: action.changes.ClerkName.to,
              ClerkSurname: action.changes.ClerkSurname.to,
              Email: action.changes.Email.to,
              IsActive: true,
              ClerkGroupId: opts.newClerkGroupId,
              HomeVenueNo: action.hub.venueNo || opts.newClerkVenueNo,
              ClerkLogon: takeLogon(action.hub.clerkLogon),
            };
            if (action.changes.MobilePhone) model.MobilePhone = action.changes.MobilePhone.to;
            if (action.changes.PayrollIDNumber) model.PayrollIDNumber = action.changes.PayrollIDNumber.to;
            const created = await withTask((t) => task.createClerk(t, model));
            const clerkId = Number(created?.ClerkId);
            if (!Number.isInteger(clerkId) || clerkId <= 0) throw new Error('TASK did not return the new clerk ID');
            savedLinks.set(action.hubId, clerkId);
            results.push({ ...base, clerkId, logon: model.ClerkLogon, result: 'done' });
          } else {
            if (Object.keys(action.changes).length || action.status) {
              await withTask(async (t) => {
                const current = await task.getClerk(t, action.clerkId);
                if (!current || Number(current.ClerkId) !== action.clerkId) throw new Error('TASK did not return the clerk');
                const next = { ...current };
                delete next.ClerkPassword; // never send a password back to TASK
                for (const [field, { to }] of Object.entries(action.changes)) next[field] = to;
                if (action.status) next.IsActive = action.status === 'reactivate';
                await task.updateClerk(t, next);
              });
            }
            savedLinks.set(action.hubId, action.clerkId);
            results.push({ ...base, result: 'done' });
          }
        } catch (err) {
          if (err instanceof SyncError) throw err;
          results.push({ ...base, result: 'failed', error: String(err.message || err).slice(0, 300) });
        }
      }
      links.save(baseUrl, savedLinks);

      const tally = (r) => results.filter((x) => x.result === r).length;
      const report = {
        mode,
        startedAt,
        finishedAt: new Date().toISOString(),
        taskBaseUrl: baseUrl,
        hubCount: plan.hubCount,
        taskCount: plan.taskCount,
        summary: { ...plan.summary, done: tally('done'), failed: tally('failed'), waiting: tally('waiting_for_approval'), held: tally('held') },
        held,
        results,
        issues: plan.issues,
        notInHub: plan.notInHub,
      };
      lastRun = report;
      // Change history: who/what/when, clerk IDs and which fields changed. No field values.
      settings.audit('clerk_sync', actor, {
        mode,
        summary: report.summary,
        held,
        changes: results
          .filter((r) => r.result !== 'waiting_for_approval')
          .map(({ type, clerkId, hubId, name, fields, result }) => ({ type, clerkId, hubId, name, fields, result })),
      });
      return report;
    } catch (err) {
      lastRun = { mode, startedAt, finishedAt: new Date().toISOString(), error: err.message };
      settings.audit('clerk_sync_failed', actor, { mode, error: String(err.message).slice(0, 300) });
      throw err;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer || !opts.intervalMinutes) return;
    timer = setInterval(() => {
      run({ mode: 'scheduled' }).catch((err) => console.error(`[sync] scheduled run failed: ${err.message}`));
    }, opts.intervalMinutes * 60_000);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** Supplier and store names from TASK (signed in as the sync clerk), for the admin panel's dropdowns. */
  async function taskLists() {
    const [suppliers, stores] = await Promise.all([
      withTask((t) => task.getSuppliers(t)),
      withTask((t) => task.getTerminalLocations(t)),
    ]);
    const byName = (a, b) => a.name.localeCompare(b.name, 'en-AU', { sensitivity: 'base' });
    return {
      suppliers: suppliers
        .filter((s) => Number.isInteger(Number(s?.SupplierID)) && !s.Deleted && s.IsActive !== false)
        .map((s) => ({ id: Number(s.SupplierID), name: String(s.SupplierName || `Supplier ${s.SupplierID}`).trim() }))
        .sort(byName),
      stores: stores
        .filter((r) => Number.isInteger(Number(r?.LocationNo)) && r.IsActive !== false)
        .map((r) => ({ locationNo: Number(r.LocationNo), name: String(r.LocationFriendlyName || r.LocationDescription || `Store ${r.LocationNo}`).trim() }))
        .sort(byName),
    };
  }

  return {
    preview,
    run,
    start,
    stop,
    taskLists,
    check: () => hub.check(),
    status: () => ({
      configured: true,
      running,
      intervalMinutes: opts.intervalMinutes,
      hubTable: config.sync.hub.table,
      hubHost: new URL(config.sync.hub.url).host,
      limits: limits(),
      lastRun,
    }),
  };
}
