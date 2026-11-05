import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MOCK_API_KEY, startStack } from './helpers.js';

let stack;
before(async () => {
  stack = await startStack();
});
after(async () => {
  const all = stack.responses.join('\n');
  assert.ok(!all.includes(MOCK_API_KEY), 'API key leaked in a response');
  await stack.close();
});
beforeEach(() => stack.mock.reset());

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
const daysFromToday = (n) => {
  const [y, m, d] = today().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const fullReceipt = (overrides = {}) => ({
  purchaseOrderId: 4001,
  supplierId: 1,
  locationNo: 11,
  invoiceNumber: 'INV-1001',
  invoiceDate: today(),
  lines: [
    { purchaseItemId: 9101, productSupplierId: 501, cases: 4, units: 0, caseCost: 45 },
    { purchaseItemId: 9102, productSupplierId: 502, cases: 2, units: 1, caseCost: 18.5 },
    { purchaseItemId: 9103, productSupplierId: 503, cases: 1, units: 0, caseCost: 15.6 },
  ],
  ...overrides,
});

const stockAt = (loc, productId) => stack.mock.data.stock.find((s) => s.LocationNo === loc && s.ProductId === productId)?.Stock;
const lastInvoice = () => [...stack.mock.invoices.values()].at(-1);
const poItem = (poId, itemId) => stack.mock.purchaseOrderItems.get(poId).find((i) => i.PurchaseItemID === itemId);

describe('receiving permissions', () => {
  test('a receive-only clerk can sign in and receive, but not order', async () => {
    const c = stack.client();
    const login = await c.req('POST', '/api/login', { login: 'receiver@example.com', password: 'demo-password', loginType: 0 });
    assert.equal(login.status, 200);
    assert.equal(login.data.clerk.canOrder, false);
    assert.equal(login.data.clerk.canReceive, true);
    assert.equal((await c.req('GET', '/api/receiving/orders?locationNo=11')).status, 200);
    const order = await c.req('POST', '/api/orders', { supplierId: 1, locationNo: 11, lines: [{ productSupplierId: 501, cases: 1 }] });
    assert.equal(order.status, 403);
  });

  test('a clerk without the TASK "create invoices" permission cannot receive', async () => {
    const c = await stack.signIn('buyer@example.com');
    const res = await c.req('GET', '/api/receiving/orders?locationNo=11');
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'not_permitted');
    assert.equal((await c.req('POST', '/api/receiving', fullReceipt())).status, 403);
  });
});

describe('purchase orders to receive', () => {
  test('lists receivable POs for the location, by delivery date', async () => {
    const c = await stack.signIn();
    stack.mock.requests.length = 0;
    const res = await c.req('GET', '/api/receiving/orders?locationNo=11');
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.data.orders.map((o) => [o.poId, o.supplierName, o.statusLabel, o.deliveryDate]),
      [
        [4002, 'Demo Packaging', 'Partially received', '2026-11-04'],
        [4001, 'Demo Fresh Produce', 'Approved', '2026-11-06'],
      ],
    );
    const statusQueries = stack.mock.requests.filter((r) => r.path === '/api/v3/purchaseOrder').map((r) => Number(r.query.orderStatus));
    assert.deepEqual(statusQueries.sort((a, b) => a - b), [1, 2, 3, 10]);
  });

  test('a PO shows ordered, already received and outstanding quantities', async () => {
    const c = await stack.signIn();
    const res = await c.req('GET', '/api/receiving/orders/4001');
    assert.equal(res.status, 200);
    assert.equal(res.data.po.supplierName, 'Demo Fresh Produce');
    const limes = res.data.lines.find((l) => l.code === 'LIME-5KG');
    assert.equal(limes.name, 'Limes');
    assert.deepEqual(
      [limes.orderedCases, limes.orderedUnits, limes.outstandingCases, limes.outstandingUnits, limes.poCaseCost],
      [2, 1, 2, 1, 18.5],
    );
    const partly = await c.req('GET', '/api/receiving/orders/4002');
    assert.deepEqual([partly.data.lines[0].receivedCases, partly.data.lines[0].outstandingCases], [1, 1]);
  });

  test('POs that are not approved or already received cannot be opened for receiving', async () => {
    const c = await stack.signIn();
    assert.equal((await c.req('GET', '/api/receiving/orders/4004')).data.code, 'po_not_receivable');
    assert.equal((await c.req('GET', '/api/receiving/orders/4005')).status, 409);
    const receiver = await stack.signIn('receiver@example.com');
    assert.equal((await receiver.req('GET', '/api/receiving/orders/4003')).status, 403); // other location
  });
});

describe('receiving a delivery', () => {
  test('full delivery: invoice created and completed, stock booked in, PO marked received', async () => {
    const c = await stack.signIn();
    stack.mock.requests.length = 0;
    const res = await c.req('POST', '/api/receiving', fullReceipt());
    assert.equal(res.status, 201, res.text);
    assert.equal(res.data.completed, true);
    assert.equal(res.data.poStatus, 4);
    assert.equal(res.data.poStatusLabel, 'Stock received');
    assert.equal(res.data.lineCount, 3);
    assert.equal(res.data.totalExGst, 236.3);
    assert.deepEqual(res.data.warnings, []);
    assert.deepEqual(res.data.shortages, []);

    const inv = lastInvoice();
    assert.equal(res.data.invoiceId, inv.InvoiceId);
    assert.deepEqual(
      [inv.SupplierId, inv.LocationNo, inv.Reference, inv.PurchaseOrderNo, inv.InvoiceType, inv.InvoiceDate, inv.IsComplete],
      [1, 11, 'INV-1001', 4001, 0, `${today()}T00:00:00.000Z`, true],
    );
    const items = stack.mock.invoiceItems.get(inv.InvoiceId);
    assert.deepEqual(
      items.map((i) => [i.ProductId, i.SupplierProductCode, i.CaseQty, i.CaseCount, i.UnitCount, i.Cost, i.UnitCost]),
      [
        [1001, 'AVO-20', 20, 4, 0, 45, 2.25],
        [1002, 'LIME-5KG', 5, 2, 1, 18.5, 3.7],
        [1003, 'COR-12', 12, 1, 0, 15.6, 1.3],
      ],
    );

    // Stock booked in by completing the invoice
    assert.equal(stockAt(11, 1001), 15 + 80);
    assert.equal(stockAt(11, 1002), 12 + 11);
    assert.equal(stockAt(11, 1003), 30 + 12);

    assert.deepEqual([poItem(4001, 9101).ReceivedCases, poItem(4001, 9102).ReceivedCases, poItem(4001, 9102).ReceivedUnits], [4, 2, 1]);
    assert.equal(stack.mock.purchaseOrders.get(4001).OrderStatus, 4);

    const order = stack.mock.requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path.replace(/\d+/g, '#')}`);
    assert.deepEqual(order.slice(0, 5), [
      'POST /api/v#/invoice',
      'POST /api/v#/invoice/#/items',
      'POST /api/v#/invoice/#/items',
      'POST /api/v#/invoice/#/items',
      'PUT /api/v#/invoice/#',
    ]);

    // The PO is no longer listed for receiving
    const list = await c.req('GET', '/api/receiving/orders?locationNo=11');
    assert.deepEqual(list.data.orders.map((o) => o.poId), [4002]);
  });

  test('short delivery: PO stays partially received, the rest can be received later', async () => {
    const c = await stack.signIn();
    const res = await c.req(
      'POST',
      '/api/receiving',
      fullReceipt({
        lines: [
          { purchaseItemId: 9101, productSupplierId: 501, cases: 3, units: 0, caseCost: 45 },
          { purchaseItemId: 9102, productSupplierId: 502, cases: 0, units: 0, caseCost: 18.5 },
          { purchaseItemId: 9103, productSupplierId: 503, cases: 1, units: 0, caseCost: 15.6 },
        ],
      }),
    );
    assert.equal(res.status, 201, res.text);
    assert.equal(res.data.poStatusLabel, 'Partially received');
    assert.deepEqual(res.data.shortages.map((s) => [s.name, s.short]), [['Avocados', 20], ['Limes', 11]]);
    assert.equal(stack.mock.invoiceItems.get(res.data.invoiceId).length, 2); // nothing invoiced for limes

    const detail = await c.req('GET', '/api/receiving/orders/4001');
    const outstanding = Object.fromEntries(detail.data.lines.map((l) => [l.code, [l.outstandingCases, l.outstandingUnits]]));
    assert.deepEqual(outstanding, { 'AVO-20': [1, 0], 'LIME-5KG': [2, 1], 'COR-12': [0, 0] });

    const rest = await c.req(
      'POST',
      '/api/receiving',
      fullReceipt({
        invoiceNumber: 'INV-1002',
        lines: [
          { purchaseItemId: 9101, productSupplierId: 501, cases: 1, units: 0, caseCost: 45 },
          { purchaseItemId: 9102, productSupplierId: 502, cases: 2, units: 1, caseCost: 18.5 },
        ],
      }),
    );
    assert.equal(rest.status, 201, rest.text);
    assert.equal(rest.data.poStatusLabel, 'Stock received');
    assert.equal(poItem(4001, 9101).ReceivedCases, 4);
    assert.equal(stack.mock.invoices.size, 2);
  });

  test('a short PO can be closed when the rest will not come', async () => {
    const c = await stack.signIn();
    const res = await c.req(
      'POST',
      '/api/receiving',
      fullReceipt({ closeShort: true, lines: [{ purchaseItemId: 9101, productSupplierId: 501, cases: 4, caseCost: 45 }] }),
    );
    assert.equal(res.status, 201, res.text);
    assert.equal(res.data.poStatusLabel, 'Stock received');
    assert.equal(res.data.shortages.length, 2);
  });

  test('without the "commit invoices" permission the invoice waits for a manager', async () => {
    const c = await stack.signIn('crew@example.com');
    const res = await c.req('POST', '/api/receiving', fullReceipt());
    assert.equal(res.status, 201, res.text);
    assert.equal(res.data.completed, false);
    assert.match(res.data.invoiceStatusLabel, /waiting for a manager/);
    assert.equal(lastInvoice().IsComplete, false);
    assert.equal(stockAt(11, 1001), 15); // not booked in yet
    assert.equal(stack.mock.purchaseOrders.get(4001).OrderStatus, 4); // delivery recorded on the PO
  });

  test('a changed invoice cost is used and reported', async () => {
    const c = await stack.signIn();
    const receipt = fullReceipt();
    receipt.lines[0].caseCost = 47;
    const res = await c.req('POST', '/api/receiving', receipt);
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(res.data.costChanges.map((x) => [x.name, x.from, x.to]), [['Avocados', 45, 47]]);
    const avo = stack.mock.invoiceItems.get(res.data.invoiceId)[0];
    assert.deepEqual([avo.Cost, avo.UnitCost], [47, 2.35]);
    assert.match(avo.Notes, /Case cost changed from \$45\.00 \(PO\)/);
  });

  test('items that were not ordered can be added, including ones without a venue cost', async () => {
    const c = await stack.signIn();
    const receipt = fullReceipt();
    receipt.lines.push({ productSupplierId: 504, cases: 1, units: 0, caseCost: 12 }); // red onions, 10 kg sack
    const res = await c.req('POST', '/api/receiving', receipt);
    assert.equal(res.status, 201, res.text);
    assert.equal(res.data.unorderedCount, 1);
    const onions = stack.mock.invoiceItems.get(res.data.invoiceId).find((i) => i.ProductId === 1004);
    assert.equal(onions.Notes, 'Not on PO');
    assert.equal(stockAt(11, 1004), 10);
    assert.equal(stack.mock.purchaseOrderItems.get(4001).length, 3); // PO lines unchanged
  });

  test('inactive products and products already on the PO cannot be added as extras', async () => {
    const c = await stack.signIn();
    const inactive = fullReceipt();
    inactive.lines.push({ productSupplierId: 506, cases: 1, caseCost: 22 });
    const res = await c.req('POST', '/api/receiving', inactive);
    assert.equal(res.status, 400);
    assert.match(Object.values(res.data.fields).join(' '), /inactive in TASK/);

    const dup = fullReceipt();
    dup.lines.push({ productSupplierId: 501, cases: 1, caseCost: 45 });
    const res2 = await c.req('POST', '/api/receiving', dup);
    assert.equal(res2.status, 400);
    assert.equal(stack.mock.invoices.size, 0);
  });

  test('a delivery with no PO is received against the supplier', async () => {
    const c = await stack.signIn('receiver@example.com');
    const res = await c.req('POST', '/api/receiving', {
      supplierId: 2,
      locationNo: 11,
      invoiceNumber: 'D-555',
      invoiceDate: today(),
      lines: [{ productSupplierId: 603, cases: 1, units: 0, caseCost: 40 }],
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.data.poId, null);
    assert.equal(res.data.completed, true);
    const inv = lastInvoice();
    assert.equal(inv.PurchaseOrderNo, undefined);
    assert.equal(stack.mock.invoiceItems.get(inv.InvoiceId)[0].Notes, undefined);
    assert.equal(stockAt(11, 2003), 1000 + 2000);

    const products = await c.req('GET', '/api/receiving/products?supplierId=1&locationNo=11');
    assert.ok(products.data.products.some((p) => p.code === 'ONR-10KG')); // no venue cost, still receivable
    assert.ok(!products.data.products.some((p) => p.code === 'JAL-2KG')); // inactive
  });

  test('the same supplier invoice number cannot be received twice', async () => {
    const c = await stack.signIn();
    assert.equal((await c.req('POST', '/api/receiving', fullReceipt({ closeShort: true, lines: [fullReceipt().lines[0]] }))).status, 201);
    stack.mock.purchaseOrders.get(4001).OrderStatus = 1; // pretend it is still open
    const again = await c.req('POST', '/api/receiving', fullReceipt({ invoiceNumber: 'inv-1001' }));
    assert.equal(again.status, 409);
    assert.equal(again.data.code, 'duplicate_invoice');
    assert.equal(stack.mock.invoices.size, 1);

    // The same number from a different supplier is fine.
    const other = await c.req('POST', '/api/receiving', {
      supplierId: 2,
      locationNo: 11,
      invoiceNumber: 'INV-1001',
      invoiceDate: today(),
      lines: [{ productSupplierId: 603, cases: 1, caseCost: 40 }],
    });
    assert.equal(other.status, 201, other.text);
  });

  test('if an invoice line fails, the invoice is removed and nothing is received', async () => {
    const c = await stack.signIn();
    stack.mock.failInvoiceItemForProductId = 1002;
    const res = await c.req('POST', '/api/receiving', fullReceipt());
    assert.equal(res.status, 502);
    assert.equal(res.data.rolledBack, true);
    assert.match(res.data.error, /Nothing was received/);
    assert.equal(stack.mock.invoices.size, 0);
    assert.equal(stack.mock.purchaseOrders.get(4001).OrderStatus, 1);
    assert.equal(poItem(4001, 9101).ReceivedCases, 0);
    assert.equal(stockAt(11, 1001), 15);
  });

  test('if the rollback also fails, the invoice number is reported', async () => {
    const c = await stack.signIn();
    stack.mock.failInvoiceItemForProductId = 1002;
    stack.mock.failInvoiceDelete = true;
    const res = await c.req('POST', '/api/receiving', fullReceipt());
    assert.equal(res.status, 502);
    assert.equal(res.data.rolledBack, false);
    assert.match(res.data.error, new RegExp(`Check invoice #${res.data.invoiceId} in TASK`));
  });

  test('if TASK cannot complete the invoice, it is left for a manager with a warning', async () => {
    const c = await stack.signIn();
    stack.mock.failInvoiceComplete = true;
    const res = await c.req('POST', '/api/receiving', fullReceipt());
    assert.equal(res.status, 201, res.text);
    assert.equal(res.data.completed, false);
    assert.match(res.data.warnings[0], /could not complete it/);
    assert.equal(stack.mock.purchaseOrders.get(4001).OrderStatus, 4);
  });

  test('if the PO cannot be updated, the clerk is told to update it in TASK', async () => {
    const c = await stack.signIn();
    stack.mock.failPoItemPut = true;
    const res = await c.req('POST', '/api/receiving', fullReceipt());
    assert.equal(res.status, 201, res.text);
    assert.equal(res.data.completed, true);
    assert.equal(res.data.poStatus, null);
    assert.match(res.data.warnings[0], /purchase order #4001 could not be updated/);
  });

  test('receipts are checked against the live PO', async () => {
    const c = await stack.signIn();
    let res = await c.req('POST', '/api/receiving', fullReceipt({ purchaseOrderId: 4005 }));
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'po_not_receivable');

    res = await c.req('POST', '/api/receiving', fullReceipt({ purchaseOrderId: 4003 })); // location 12
    assert.equal(res.status, 400);
    assert.match(res.data.error, /different location/);

    res = await c.req('POST', '/api/receiving', fullReceipt({ supplierId: 2 }));
    assert.equal(res.status, 400);
    assert.match(res.data.error, /different supplier/);

    res = await c.req('POST', '/api/receiving', fullReceipt({ lines: [{ purchaseItemId: 9201, productSupplierId: 602, cases: 1, caseCost: 96 }] }));
    assert.equal(res.status, 400);
    assert.match(Object.values(res.data.fields).join(' '), /not on purchase order #4001/);
    assert.equal(stack.mock.invoices.size, 0);
  });

  test('validation', async () => {
    const c = await stack.signIn();
    const check = async (overrides, field) => {
      const res = await c.req('POST', '/api/receiving', fullReceipt(overrides));
      assert.equal(res.status, 400, `${field}: ${res.text}`);
      assert.ok(Object.keys(res.data.fields).some((k) => k.startsWith(field)), `${field}: ${res.text}`);
    };
    await check({ invoiceNumber: '' }, 'invoiceNumber');
    await check({ invoiceNumber: '   ' }, 'invoiceNumber');
    await check({ invoiceDate: daysFromToday(1) }, 'invoiceDate');
    await check({ invoiceDate: '2026-02-30' }, 'invoiceDate');
    await check({ lines: [{ purchaseItemId: 9101, productSupplierId: 501, cases: -1, caseCost: 45 }] }, 'lines.0');
    await check({ lines: [{ purchaseItemId: 9101, productSupplierId: 501, cases: 1 }] }, 'lines.0');
    await check({ lines: [{ purchaseItemId: 9101, productSupplierId: 501, cases: 0, caseCost: 45 }] }, 'lines');
    await check(
      {
        lines: [
          { purchaseItemId: 9101, productSupplierId: 501, cases: 1, caseCost: 45 },
          { purchaseItemId: 9101, productSupplierId: 501, cases: 1, caseCost: 45 },
        ],
      },
      'lines.1',
    );
    assert.equal(stack.mock.invoices.size, 0);
  });

  test('a PO line with no supplier product link can still be received', async () => {
    const c = await stack.signIn();
    delete poItem(4001, 9103).ProductSupplierID;
    const receipt = fullReceipt();
    delete receipt.lines[2].productSupplierId;
    const res = await c.req('POST', '/api/receiving', receipt);
    assert.equal(res.status, 201, res.text);
    const coriander = stack.mock.invoiceItems.get(res.data.invoiceId).find((i) => i.ProductId === 1003);
    assert.deepEqual([coriander.CaseCount, coriander.CaseQty, coriander.Cost], [1, 12, 15.6]);
    assert.equal(poItem(4001, 9103).ReceivedCases, 1);
  });

  test('a repeated submit with the same key receives once', async () => {
    const c = await stack.signIn();
    const body = fullReceipt({ idempotencyKey: 'receipt-key-0001' });
    const first = await c.req('POST', '/api/receiving', body);
    const second = await c.req('POST', '/api/receiving', body);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.data.invoiceId, first.data.invoiceId);
    assert.equal(stack.mock.invoices.size, 1);
  });
});
