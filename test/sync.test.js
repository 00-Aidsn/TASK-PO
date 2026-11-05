import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startAdminStack } from './helpers.js';
import { sampleHubRows } from './mockSupabase.js';
import { buildSyncPlan, normaliseName } from '../src/sync/clerkSync.js';
import { parseActive } from '../src/sync/hubClient.js';

const clerkWrites = (s) => s.taskA.clerkWrites;
const clerk = (s, id) => s.taskA.data.clerks.find((c) => c.ClerkId === id);
const byHub = (list, hubId) => list.find((a) => a.hubId === hubId);

describe('central hub -> TASK clerk sync', () => {
  let s;
  let admin;
  before(async () => {
    s = await startAdminStack({ withSync: true });
    admin = s.client();
    await s.adminSignIn(admin);
  });
  after(async () => {
    await s.close();
  });
  beforeEach(() => {
    s.taskA.reset();
    s.hub.rows = sampleHubRows();
    s.hub.failStatus = null;
    fs.rmSync(path.join(s.dataDir, 'clerk-links.json'), { force: true });
  });

  test('only the admin can use the sync', async () => {
    assert.equal((await s.client().req('POST', '/api/admin/sync/preview', {})).status, 401);
    const status = await admin.req('GET', '/api/admin/sync');
    assert.equal(status.data.configured, true);
    assert.equal(status.data.hubTable, 'staff');
  });

  test('checking the hub reads one row of the mapped columns only', async () => {
    const res = await admin.req('POST', '/api/admin/sync/check', {});
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.check.ok, true);
    const req = s.hub.requests.at(-1);
    assert.equal(req.query.limit, '1');
    assert.equal(req.profile, 'public');
    assert.ok(!req.query.select.includes('tax_file_number'), 'sensitive hub columns are never requested');
  });

  test('preview shows what would change, and changes nothing', async () => {
    const res = await admin.req('POST', '/api/admin/sync/preview', {});
    assert.equal(res.status, 200, res.text);
    const { plan } = res.data;
    assert.deepEqual(plan.summary, {
      create: 1,
      update: 2, // Sam (mobile, payroll) and Alex (email, by name)
      link: 1, // Pat: linked, but as an administrator not deactivated
      deactivate: 1,
      reactivate: 1,
      needsApproval: 1,
      issues: 3,
      notInHub: 4, // Taylor, the sync account, and both Chris Smiths (couldn't be matched safely)
    });
    const sam = byHub(plan.actions, 'h-1');
    assert.equal(sam.match, 'email');
    assert.deepEqual(Object.keys(sam.changes).sort(), ['MobilePhone', 'PayrollIDNumber']);
    const alex = byHub(plan.actions, 'h-2');
    assert.deepEqual([alex.match, alex.needsApproval, alex.clerkId, alex.changes.Email.to], ['name', true, 202, 'alex.crew@madmex.example']);
    assert.equal(byHub(plan.actions, 'h-3').type, 'deactivate');
    assert.equal(byHub(plan.actions, 'h-6').type, 'reactivate');
    assert.equal(byHub(plan.actions, 'h-5').type, 'create');
    assert.deepEqual(plan.issues.map((i) => [i.hubId, i.type]).sort(), [
      ['h-4', 'ambiguous_name'],
      ['h-8', 'protected'],
      ['h-9', 'missing_details'],
    ]);
    assert.deepEqual(plan.notInHub.map((c) => c.clerkId).sort(), [204, 205, 206, 290]);
    assert.equal(byHub(plan.actions, 'h-8').type, 'link');
    assert.equal(clerkWrites(s).length, 0, 'preview must not write to TASK');
  });

  test('sync now applies changes, leaves name matches for approval, and never touches other clerk data', async () => {
    const before201 = structuredClone(clerk(s, 201));
    const res = await admin.req('POST', '/api/admin/sync/run', {});
    assert.equal(res.status, 200, res.text);
    const { report } = res.data;
    assert.deepEqual(
      { done: report.summary.done, waiting: report.summary.waiting, failed: report.summary.failed, held: report.summary.held },
      { done: 5, waiting: 1, failed: 0, held: 0 },
    );

    // Updated: only the synced fields changed
    const after201 = clerk(s, 201);
    assert.equal(after201.MobilePhone, '0400 000 999');
    assert.equal(after201.PayrollIDNumber, 'P001');
    for (const field of ['DateOfBirth', 'SocialSecurityNumber', 'ClerkPayRate', 'HomeAddress', 'EmergencyContactPhone', 'ClerkGroupId', 'ClerkLogon']) {
      assert.deepEqual(after201[field], before201[field], `${field} must not change`);
    }
    assert.deepEqual(after201.LabourRoleIDs, before201.LabourRoleIDs);
    for (const w of clerkWrites(s).filter((x) => x.method === 'PUT')) {
      assert.ok(!('ClerkPassword' in w.body), 'the password must never be sent back');
    }

    // Deactivated, reactivated, admin protected, ambiguous untouched, name match waiting
    assert.equal(clerk(s, 203).IsActive, false);
    assert.equal(clerk(s, 207).IsActive, true);
    assert.equal(clerk(s, 208).IsActive, true);
    assert.equal(clerk(s, 204).Email, '');
    assert.equal(clerk(s, 202).Email, '');

    // Created: default group, hub venue, next free logon, no password
    const created = clerkWrites(s).find((w) => w.method === 'POST').body;
    assert.deepEqual(
      [created.ClerkName, created.ClerkSurname, created.Email, created.ClerkGroupId, created.HomeVenueNo, created.ClerkLogon, created.IsActive],
      ['Morgan', 'New', 'morgan.new@madmex.example', 3, 2, 191, true],
    );
    assert.ok(!('ClerkPassword' in created));
    assert.equal(created.PayrollIDNumber, 'P005');

    // Links saved for this TASK server
    const links = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'clerk-links.json'), 'utf8'));
    assert.deepEqual(links.servers[s.taskAUrl], { 'h-1': 201, 'h-3': 203, 'h-5': 301, 'h-6': 207, 'h-8': 208 });

    // Change history: who and which fields, but no personal values or HR data
    const audit = await admin.req('GET', '/api/admin/audit');
    const entry = audit.data.entries.find((e) => e.action === 'clerk_sync');
    assert.equal(entry.details.mode, 'manual');
    assert.ok(entry.actor.email);
    const raw = fs.readFileSync(path.join(s.dataDir, 'admin-audit.log'), 'utf8');
    for (const secret of ['0400 000 999', 'P001', 'TFN-', 'morgan.new@madmex.example', '1990-01-01']) {
      assert.ok(!raw.includes(secret), `audit log must not contain ${secret}`);
    }

    // Running again changes nothing except the waiting name match
    const again = await admin.req('POST', '/api/admin/sync/preview', {});
    assert.deepEqual(again.data.plan.actions.map((a) => a.hubId), ['h-2']);
  });

  test('approved name matches are applied for the exact pairs approved only', async () => {
    await admin.req('POST', '/api/admin/sync/run', {});
    let res = await admin.req('POST', '/api/admin/sync/run', { approvedNameLinks: [{ hubId: 'h-2', clerkId: 999 }] });
    assert.equal(res.data.report.summary.waiting, 1);
    assert.equal(clerk(s, 202).Email, '');

    res = await admin.req('POST', '/api/admin/sync/run', { approvedNameLinks: [{ hubId: 'h-2', clerkId: 202 }] });
    assert.equal(res.data.report.summary.done, 1);
    assert.equal(clerk(s, 202).Email, 'alex.crew@madmex.example');
    const preview = await admin.req('POST', '/api/admin/sync/preview', {});
    assert.equal(preview.data.plan.actions.length, 0, 'everything is now in sync');

    // From now on email is the key: an email change in the hub follows the saved link
    s.hub.rows.find((r) => r.id === 'h-2').email = 'alex.c@madmex.example';
    const follow = await admin.req('POST', '/api/admin/sync/preview', {});
    const alex = byHub(follow.data.plan.actions, 'h-2');
    assert.deepEqual([alex.match, alex.needsApproval, alex.changes.Email.to], ['link', false, 'alex.c@madmex.example']);
  });

  test('the scheduled run never applies name matches', async () => {
    const report = await s.sync.run({ mode: 'scheduled', approvedNameLinks: [{ hubId: 'h-2', clerkId: 202 }] });
    assert.equal(report.mode, 'scheduled');
    assert.equal(byHub(report.results, 'h-2').result, 'waiting_for_approval');
    assert.equal(clerk(s, 202).Email, '');
  });

  test('large numbers of deactivations are held until you confirm', async () => {
    for (const r of s.hub.rows) if (['h-1', 'h-6'].includes(r.id)) r.is_active = false;
    s.taskA.data.clerks.find((c) => c.ClerkId === 207).IsActive = true;
    const limited = await startAdminStack({ withSync: true, env: { SYNC_MAX_DEACTIVATIONS: '2' } });
    try {
      limited.hub.rows = s.hub.rows;
      limited.taskA.data.clerks = s.taskA.data.clerks;
      const scheduled = await limited.sync.run({ mode: 'scheduled' });
      assert.equal(scheduled.summary.held, 3);
      assert.match(scheduled.held[0], /3 deactivations \(limit 2\)/);
      assert.equal(clerk(limited, 203).IsActive, true);

      const c = limited.client();
      await limited.adminSignIn(c);
      const manual = await c.req('POST', '/api/admin/sync/run', { confirmLargeChanges: true });
      assert.equal(manual.data.report.summary.held, 0);
      assert.equal(clerk(limited, 203).IsActive, false);
      assert.equal(clerk(limited, 201).IsActive, false);
    } finally {
      await limited.close();
    }
  });

  test('an empty or unreachable hub changes nothing', async () => {
    s.hub.rows = [];
    let res = await admin.req('POST', '/api/admin/sync/run', {});
    assert.equal(res.status, 502);
    assert.equal(res.data.code, 'hub_empty');

    s.hub.rows = sampleHubRows();
    s.hub.failStatus = 401;
    res = await admin.req('POST', '/api/admin/sync/run', {});
    assert.equal(res.status, 502);
    assert.match(res.data.error, /did not accept HUB_SUPABASE_KEY/);
    assert.equal(clerkWrites(s).length, 0);
  });

  test('the sync signs in to TASK again when its session ends', async () => {
    await admin.req('POST', '/api/admin/sync/preview', {});
    s.taskA.tokens.clear();
    const res = await admin.req('POST', '/api/admin/sync/preview', {});
    assert.equal(res.status, 200, res.text);
    const logins = s.taskA.requests.filter((r) => r.path === '/api/v3/auth/clerk/login' && r.body?.Login === 'sync@example.com');
    assert.ok(logins.length >= 2);
  });

  test("the sync's own TASK account is never deactivated", async () => {
    s.hub.rows.push({ id: 'h-10', first_name: 'Sync', last_name: 'Service', email: 'sync@example.com', is_active: false, mobile: '', payroll_id: '', venue_no: 1, tax_file_number: '' });
    const res = await admin.req('POST', '/api/admin/sync/preview', {});
    const issue = res.data.plan.issues.find((i) => i.hubId === 'h-10');
    assert.match(issue.message, /account the sync uses/);
  });

  test('links are kept per TASK server', async () => {
    await admin.req('POST', '/api/admin/sync/run', {});
    s.taskB.apiKeys.add('server-b-key-0000');
    await admin.req('PUT', '/api/admin/settings', { baseUrl: s.taskBUrl, apiKey: 'server-b-key-0000' });
    const res = await admin.req('POST', '/api/admin/sync/run', {});
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.report.taskBaseUrl, s.taskBUrl);
    const links = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'clerk-links.json'), 'utf8'));
    assert.deepEqual(Object.keys(links.servers).sort(), [s.taskAUrl, s.taskBUrl].sort());
    assert.ok(s.taskB.clerkWrites.length > 0);
    await admin.req('PUT', '/api/admin/settings', { baseUrl: s.taskAUrl, apiKey: 'mock-api-key' });
  });
});

describe('sync without a hub', () => {
  test('the admin API says it is not set up', async () => {
    const s = await startAdminStack();
    try {
      const c = s.client();
      await s.adminSignIn(c);
      assert.deepEqual((await c.req('GET', '/api/admin/sync')).data, { configured: false });
      assert.equal((await c.req('POST', '/api/admin/sync/preview', {})).status, 404);
    } finally {
      await s.close();
    }
  });
});

describe('sync rules', () => {
  test('names are compared without case, accents or punctuation', () => {
    assert.equal(normaliseName('  Zoë ', "O'Brien-Smith"), 'zoe obriensmith');
    assert.equal(normaliseName('Cher', ''), '');
  });

  test('active values from the hub', () => {
    for (const v of [true, 1, 'true', 'Active', 'yes']) assert.equal(parseActive(v), true);
    for (const v of [false, 0, 'false', 'Terminated', 'inactive']) assert.equal(parseActive(v), false);
    for (const v of [null, '', 'maybe', 2]) assert.equal(parseActive(v), null);
  });

  test('unclear active values never deactivate; empty hub values never blank TASK fields', () => {
    const plan = buildSyncPlan({
      hubUsers: [{ hubId: 'x', firstName: 'Sam', lastName: 'Manager', email: 'sam@x.example', active: null, mobile: '', payrollId: '' }],
      clerks: [{ ClerkId: 1, ClerkLogon: 1, ClerkName: 'Sam', ClerkSurname: 'Manager', Email: 'sam@x.example', MobilePhone: '0400', PayrollIDNumber: 'P1', IsActive: true, IsAdministrator: false }],
    });
    assert.deepEqual(plan.actions.map((a) => [a.type, a.changes]), [['link', {}]]);
  });

  test('one TASK clerk is never matched to two hub users', () => {
    const plan = buildSyncPlan({
      hubUsers: [
        { hubId: 'a', firstName: 'Sam', lastName: 'Lee', email: 'sam.lee@x.example', active: true },
        { hubId: 'b', firstName: 'Sam', lastName: 'Lee', email: 'sam.lee2@x.example', active: true },
      ],
      clerks: [{ ClerkId: 1, ClerkLogon: 1, ClerkName: 'Sam', ClerkSurname: 'Lee', Email: '', MobilePhone: '', PayrollIDNumber: '', IsActive: true, IsAdministrator: false }],
    });
    const linked = plan.actions.filter((a) => a.clerkId === 1);
    assert.equal(linked.length, 1);
    assert.equal(plan.actions.filter((a) => a.type === 'create').length, 1);
  });
});
