import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountNumberStore, parseCsv } from '../src/accountNumbers.js';
import { MOCK_PASSWORD, startAdminStack } from './helpers.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'po-acct-'));
const admin = { name: 'Alex Admin', email: 'admin@madmex.example' };

describe('account number list', () => {
  test('add, change, remove, and it survives a restart', () => {
    const dir = tmpDir();
    const audit = [];
    const store = createAccountNumberStore({ dataDir: dir, audit: (action, actor, details) => audit.push({ action, details }) });
    assert.equal(store.get(1, 11), '');
    store.set({ supplierId: 1, locationNo: 11, accountNo: ' MADMEXWAUR ', supplierName: 'MorCo Fresh VIC', locationName: 'Waurn Ponds' }, admin);
    assert.equal(store.get(1, 11), 'MADMEXWAUR');
    assert.equal(store.get('1', '11'), 'MADMEXWAUR');
    assert.deepEqual(store.set({ supplierId: 1, locationNo: 11, accountNo: 'MADMEXWAUR' }, admin), { changed: false });
    store.set({ supplierId: 1, locationNo: 11, accountNo: 'MADMEXWP2' }, admin);
    assert.equal(createAccountNumberStore({ dataDir: dir }).get(1, 11), 'MADMEXWP2'); // read back from disk
    assert.equal((fs.statSync(path.join(dir, 'account-numbers.json')).mode & 0o777).toString(8), '600');
    store.set({ supplierId: 1, locationNo: 11, accountNo: '' }, admin);
    assert.equal(store.get(1, 11), '');
    assert.deepEqual(audit.map((a) => a.action), ['account_number_set', 'account_number_set', 'account_number_removed']);
    assert.deepEqual(audit[1].details.accountNo, { from: 'MADMEXWAUR', to: 'MADMEXWP2' });
  });

  test('validation', () => {
    const store = createAccountNumberStore({ dataDir: tmpDir() });
    assert.throws(() => store.set({ supplierId: 'x', locationNo: 11, accountNo: 'A' }), /highlighted/);
    assert.throws(() => store.set({ supplierId: 1, locationNo: 11, accountNo: 'A'.repeat(51) }), /highlighted/);
  });

  test('without the admin panel there is no list and nothing can be saved', () => {
    const store = createAccountNumberStore({ dataDir: null });
    assert.equal(store.editable, false);
    assert.equal(store.get(1, 11), '');
    assert.throws(() => store.set({ supplierId: 1, locationNo: 11, accountNo: 'A' }), /admin panel/);
  });

  test('CSV export and import (merge or replace)', () => {
    const store = createAccountNumberStore({ dataDir: tmpDir() });
    store.set({ supplierId: 1, locationNo: 11, accountNo: 'MADMEXWAUR', supplierName: 'MorCo Fresh VIC', locationName: 'Waurn Ponds' }, admin);
    store.set({ supplierId: 1, locationNo: 12, accountNo: 'MADMEXGEEL', supplierName: 'MorCo Fresh VIC', locationName: 'Geelong' }, admin);
    const csv = store.exportCsv();
    assert.ok(csv.startsWith('﻿Supplier ID,Supplier,Store No,Store,Account No\r\n'));
    assert.match(csv, /\r\n1,MorCo Fresh VIC,12,Geelong,MADMEXGEEL\r\n/);

    // Merge: change one, add one, remove one with a blank account number; names in quotes with commas
    const merged = store.importCsv(
      'Supplier ID,Supplier,Store No,Store,Account No\n1,MorCo Fresh VIC,11,Waurn Ponds,MADMEXWP\n2,"Packaging, Co",11,Waurn Ponds,PKG-001\n1,,12,,\n',
      {},
      admin,
    );
    assert.deepEqual(merged, { added: 1, changed: 1, removed: 1, total: 2 });
    assert.equal(store.get(1, 11), 'MADMEXWP');
    assert.equal(store.get(2, 11), 'PKG-001');
    assert.equal(store.list().find((e) => e.supplierId === 2).supplierName, 'Packaging, Co');

    // Replace: the file becomes the whole list
    const replaced = store.importCsv('Supplier ID,Store No,Account No\r\n3,13,NEW-1\r\n', { replace: true }, admin);
    assert.deepEqual(replaced, { added: 1, changed: 0, removed: 2, total: 1 });
    assert.deepEqual(store.list().map((e) => [e.supplierId, e.locationNo, e.accountNo]), [[3, 13, 'NEW-1']]);
  });

  test('a bad CSV imports nothing', () => {
    const store = createAccountNumberStore({ dataDir: tmpDir() });
    store.set({ supplierId: 1, locationNo: 11, accountNo: 'KEEP' }, admin);
    assert.throws(() => store.importCsv('Name,Number\nx,1\n'), /needs the columns/);
    assert.throws(() => store.importCsv('Supplier ID,Store No,Account No\nabc,11,X\n1,11,Y\n1,11,Z\n'), /Nothing was imported.*Line 2.*Line 4/);
    assert.equal(store.get(1, 11), 'KEEP');
  });

  test('CSV reader handles quotes, commas and new lines', () => {
    assert.deepEqual(parseCsv('﻿a,"b, c","d ""e"""\r\n"multi\nline",2,3\n\n'), [
      ['a', 'b, c', 'd "e"'],
      ['multi\nline', '2', '3'],
    ]);
  });
});

describe('account numbers in the admin panel and on purchase orders', () => {
  let s;
  let adminClient;
  before(async () => {
    s = await startAdminStack({ withSync: true });
    adminClient = s.client();
    await s.adminSignIn(adminClient);
  });
  after(async () => {
    await s.close();
  });

  test('the admin panel lists suppliers and stores from TASK for choosing', async () => {
    const res = await adminClient.req('GET', '/api/admin/account-numbers');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.editable, true);
    assert.ok(res.data.lists.suppliers.some((x) => x.id === 1 && x.name === 'Demo Fresh Produce'));
    assert.ok(res.data.lists.stores.some((x) => x.locationNo === 11 && x.name === 'Demo Store - City'));
    assert.equal((await s.client().req('GET', '/api/admin/account-numbers')).status, 401);
  });

  test('an account number saved in the admin panel appears on the emailed PO', async () => {
    const saved = await adminClient.req('PUT', '/api/admin/account-numbers', {
      supplierId: 1,
      locationNo: 11,
      accountNo: 'MADMEXCITY',
      supplierName: 'Demo Fresh Produce',
      locationName: 'Demo Store - City',
    });
    assert.equal(saved.status, 200, saved.text);

    const clerk = s.client();
    await clerk.req('POST', '/api/login', { login: 'manager@example.com', password: MOCK_PASSWORD, loginType: 0 });
    const order = await clerk.req('POST', '/api/orders', {
      supplierId: 1,
      locationNo: 11,
      deliveryInstructions: 'Rear door',
      lines: [{ productSupplierId: 501, cases: 1, caseCost: 45, unitCost: 2.25 }],
    });
    assert.equal(order.status, 201, order.text);
    const mail = s.mailer.sent.at(-1);
    assert.match(mail.text, /\nAccount No:\tMADMEXCITY\n/);
    assert.match(mail.text, /\nComments:\tDelivery instructions: Rear door\n/);
    assert.match(mail.attachments[1].content.toString('utf8'), /\r\nAccount No:,MADMEXCITY\r\n/);

    // Other stores of the same supplier have no account number yet
    const other = await clerk.req('POST', '/api/orders', {
      supplierId: 1,
      locationNo: 12,
      lines: [{ productSupplierId: 501, cases: 1, caseCost: 47, unitCost: 2.35 }],
    });
    assert.equal(other.status, 201, other.text);
    assert.match(s.mailer.sent.at(-1).text, /\nAccount No:\t\n/);
  });

  test('CSV download and import through the admin panel, recorded in the change history', async () => {
    const download = await adminClient.req('GET', '/api/admin/account-numbers/export');
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /supplier-account-numbers\.csv/);
    assert.match(download.text, /1,Demo Fresh Produce,11,Demo Store - City,MADMEXCITY/);

    const imported = await adminClient.req('POST', '/api/admin/account-numbers/import', {
      csv: 'Supplier ID,Supplier,Store No,Store,Account No\n1,Demo Fresh Produce,12,Demo Store - Beach,MADMEXBEACH\n',
    });
    assert.equal(imported.status, 200, imported.text);
    assert.deepEqual(imported.data, { added: 1, changed: 0, removed: 0, total: 2 });

    const bad = await adminClient.req('POST', '/api/admin/account-numbers/import', { csv: 'nope\n' });
    assert.equal(bad.status, 400);

    const audit = await adminClient.req('GET', '/api/admin/audit');
    const actions = audit.data.entries.map((e) => e.action);
    assert.ok(actions.includes('account_number_set'));
    assert.ok(actions.includes('account_numbers_imported'));
  });
});
