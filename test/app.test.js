import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MOCK_API_KEY, MOCK_PASSWORD, startStack, tomorrow } from './helpers.js';

let stack;
before(async () => {
  stack = await startStack();
});
after(async () => {
  // The API key and clerk tokens must never reach the browser.
  const all = stack.responses.join('\n');
  assert.ok(!all.includes(MOCK_API_KEY), 'API key leaked in a response');
  for (const token of stack.mock.tokens.keys()) assert.ok(!all.includes(token), 'TASK token leaked in a response');
  await stack.close();
});
beforeEach(() => {
  stack.mock.reset(); // fresh TASK data, sample POs and failure switches for every test
  stack.mailer.fail = false;
  stack.mailer.sent.length = 0;
});

const order = (overrides = {}) => ({
  supplierId: 1,
  locationNo: 11,
  deliveryDate: tomorrow(),
  customerPo: 'Weekly produce',
  comments: 'Please deliver before 10am',
  lines: [
    { productSupplierId: 501, cases: 2, units: 3 },
    { productSupplierId: 502, cases: 1, units: 0 },
  ],
  ...overrides,
});

describe('sign-in', () => {
  test('public config is available without signing in', async () => {
    const res = await stack.client().req('GET', '/api/config');
    assert.equal(res.status, 200);
    assert.equal(res.data.loginTypes.length, 4);
    assert.equal(res.data.mailMode, 'log');
  });

  test('wrong password is refused and no session is created', async () => {
    const c = stack.client();
    const res = await c.req('POST', '/api/login', { login: 'manager@example.com', password: 'nope', loginType: 0 });
    assert.equal(res.status, 401);
    assert.match(res.data.error, /Sign-in failed/);
    assert.equal(c.cookie, '');
  });

  test('missing fields are rejected before calling TASK', async () => {
    const before = stack.mock.requests.length;
    const res = await stack.client().req('POST', '/api/login', { login: '', password: '' });
    assert.equal(res.status, 400);
    assert.equal(stack.mock.requests.length, before);
  });

  test('clerk without PO permission is refused', async () => {
    const c = stack.client();
    const res = await c.req('POST', '/api/login', { login: 'viewer@example.com', password: MOCK_PASSWORD, loginType: 0 });
    assert.equal(res.status, 403);
    assert.match(res.data.error, /not allowed to create purchase orders or receive stock/);
    assert.equal(c.cookie, '');
  });

  test('successful sign-in sets a secure session cookie and sends Key + Bearer to TASK', async () => {
    stack.mock.requests.length = 0;
    const c = stack.client();
    const res = await c.req('POST', '/api/login', { login: 'manager@example.com', password: MOCK_PASSWORD, loginType: 0 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.clerk, {
      id: 101,
      name: 'Sam Manager',
      email: 'manager@example.com',
      canOrder: true,
      canApprove: true,
      canReceive: true,
      canCommitInvoices: true,
    });
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /Max-Age/);

    const [login, me] = stack.mock.requests;
    assert.equal(login.path, '/api/v3/auth/clerk/login');
    assert.equal(login.key, MOCK_API_KEY);
    assert.equal(login.authorization, undefined);
    assert.deepEqual(login.body, { Login: 'manager@example.com', Password: MOCK_PASSWORD, LoginType: 0 });
    assert.equal(me.path, '/api/v3/auth/clerk/currentUser');
    assert.match(me.authorization, /^Bearer /);
    assert.equal(me.key, MOCK_API_KEY);

    assert.equal((await c.req('GET', '/api/me')).status, 200);
  });

  test('sign out ends the session', async () => {
    const c = await stack.signIn();
    const out = await c.req('POST', '/api/logout', {});
    assert.equal(out.status, 204);
    assert.equal((await c.req('GET', '/api/me')).status, 401);
  });

  test('a TASK session expiry (440) signs the clerk out of this app', async () => {
    const c = await stack.signIn();
    stack.mock.expireTokens = true;
    const res = await c.req('GET', '/api/suppliers');
    assert.equal(res.status, 401);
    assert.equal(res.data.code, 'session_expired');
    stack.mock.expireTokens = false;
    assert.equal((await c.req('GET', '/api/me')).status, 401);
  });

  test('API routes need a session', async () => {
    const res = await stack.client().req('GET', '/api/suppliers');
    assert.equal(res.status, 401);
    assert.equal(res.data.code, 'signed_out');
  });

  test('writes must be JSON', async () => {
    const res = await stack.client().req('POST', '/api/login', undefined, {
      raw: 'login=a&password=b',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.status, 415);
  });
});

describe('reference data', () => {
  test('locations are limited to the clerk and sorted by name', async () => {
    const c = await stack.signIn();
    const res = await c.req('GET', '/api/locations');
    assert.deepEqual(res.data.locations, [
      { locationNo: 12, venueNo: 2, name: 'Demo Store - Beach' },
      { locationNo: 11, venueNo: 1, name: 'Demo Store - City' },
    ]);
  });

  test('inactive suppliers are hidden (all pages are read)', async () => {
    const c = await stack.signIn();
    const res = await c.req('GET', '/api/suppliers');
    assert.deepEqual(
      res.data.suppliers.map((s) => s.name),
      ['Demo Dairy', 'Demo Fresh Produce', 'Demo Packaging'],
    );
  });

  test('products are built live from supplier codes, venue costs and product records', async () => {
    const c = await stack.signIn();
    stack.mock.requests.length = 0;
    const res = await c.req('GET', '/api/suppliers/1/products?locationNo=11');
    assert.equal(res.status, 200);
    const byCode = Object.fromEntries(res.data.products.map((p) => [p.code, p]));
    assert.deepEqual(Object.keys(byCode).sort(), ['AVO-20', 'COR-12', 'LIME-5KG']);
    assert.deepEqual(res.data.hidden, { unavailable: 1, inactive: 1, missing: 1, noCost: 1 });
    assert.equal(byCode['AVO-20'].name, 'Avocados'); // from GET /products/{id}
    assert.equal(byCode['AVO-20'].caseCost, 45);
    assert.equal(byCode['COR-12'].unitCost, 1.3); // derived from case cost / case qty
    assert.equal(byCode['AVO-20'].hiddenReason, undefined);
    assert.deepEqual(res.data.supplier, { id: 1, name: 'Demo Fresh Produce', email: 'orders@produce.example' });
    assert.ok(Date.parse(res.data.checkedAt));

    const paths = stack.mock.requests.map((r) => `${r.method} ${r.path}`);
    assert.ok(paths.includes('GET /api/v3/supplier/1'));
    assert.ok(paths.includes('GET /api/v3/supplier/1/productCodes'));
    assert.ok(paths.includes('GET /api/v3/supplier/1/venueCosts'));
    const productCalls = stack.mock.requests.filter((r) => /^\/api\/v3\/products\/\d+$/.test(r.path));
    assert.equal(productCalls.length, 7);
    assert.ok(productCalls.every((r) => r.query.locationNo === '11'));
    assert.equal(stack.mock.requests.find((r) => r.path.endsWith('/venueCosts')).query.venueNo, '1');

    const beach = await c.req('GET', '/api/suppliers/1/products?locationNo=12');
    assert.deepEqual(beach.data.products.map((p) => [p.code, p.caseCost]), [['AVO-20', 47]]);
  });

  test('nothing is cached: changes in TASK show on the next load', async () => {
    const c = await stack.signIn();
    await c.req('GET', '/api/suppliers');
    await c.req('GET', '/api/suppliers/1/products?locationNo=11');

    stack.mock.data.venueCosts.find((v) => v.ID === 1).CaseCost = 50;
    stack.mock.data.products[1002].IsActive = false;
    stack.mock.data.suppliers.find((s) => s.SupplierID === 2).IsActive = false;
    stack.mock.data.suppliers.find((s) => s.SupplierID === 1).EmailAddress = 'new@produce.example';

    const products = await c.req('GET', '/api/suppliers/1/products?locationNo=11');
    assert.equal(products.data.products.find((p) => p.code === 'AVO-20').caseCost, 50);
    assert.equal(products.data.products.find((p) => p.code === 'LIME-5KG'), undefined);
    assert.equal(products.data.hidden.inactive, 2);
    assert.equal(products.data.supplier.email, 'new@produce.example');

    const suppliers = await c.req('GET', '/api/suppliers');
    assert.deepEqual(suppliers.data.suppliers.map((s) => s.id), [3, 1]);
  });

  test('an inactive supplier has no products', async () => {
    const c = await stack.signIn();
    stack.mock.data.suppliers.find((s) => s.SupplierID === 1).IsActive = false;
    const res = await c.req('GET', '/api/suppliers/1/products?locationNo=11');
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'supplier_inactive');
  });

  test('products without a venue cost can be allowed by setting', async () => {
    const s = await startStack({ env: { REQUIRE_VENUE_COST: 'false' } });
    try {
      const c = await s.signIn();
      const res = await c.req('GET', '/api/suppliers/1/products?locationNo=11');
      const onions = res.data.products.find((p) => p.code === 'ONR-10KG');
      assert.equal(onions.caseCost, null);
      assert.equal(res.data.hidden.noCost, 0);
    } finally {
      await s.close();
    }
  });

  test('locations the clerk cannot access are refused', async () => {
    const c = await stack.signIn();
    const res = await c.req('GET', '/api/suppliers/1/products?locationNo=13');
    assert.equal(res.status, 403);
  });

  test('templates exclude deleted ones and return their lines', async () => {
    const c = await stack.signIn();
    const list = await c.req('GET', '/api/templates?supplierId=1&locationNo=11');
    assert.deepEqual(list.data.templates, [{ id: 9001, name: 'Weekly produce' }]);
    const items = await c.req('GET', '/api/templates/9001/items');
    assert.equal(items.data.items.length, 3);
    assert.deepEqual(items.data.items[1], { productSupplierId: 502, productId: 1002, cases: 2, units: 1, notes: '' });
  });
});

describe('sending a purchase order', () => {
  test('approver: PO is created, approved, emailed and marked as emailed', async () => {
    const c = await stack.signIn();
    stack.mock.requests.length = 0;
    const res = await c.req(
      'POST',
      '/api/orders',
      order({
        expectedSupplierEmail: 'orders@produce.example',
        lines: [
          { productSupplierId: 501, cases: 2, units: 3, caseCost: 45, unitCost: 2.25 },
          { productSupplierId: 502, cases: 1, units: 0, caseCost: 18.5, unitCost: 3.7 },
        ],
      }),
    );
    assert.equal(res.status, 201, res.text);
    const { poId } = res.data;
    assert.equal(res.data.status, 1);
    assert.equal(res.data.statusLabel, 'Approved');
    assert.equal(res.data.lineCount, 2);
    assert.equal(res.data.totalExGst, 2 * 45 + 3 * 2.25 + 18.5);
    assert.equal(res.data.email.sent, true);
    assert.equal(res.data.email.to, 'orders@produce.example');
    assert.equal(res.data.email.markedInTask, true);

    const created = stack.mock.requests.find((r) => r.method === 'POST' && r.path === '/api/v3/purchaseOrder');
    assert.equal(created.body.OrderStatus, 7, 'created as Incomplete first');
    assert.equal(created.body.ClerkID, 101);
    assert.equal(created.body.SupplierID, 1);
    assert.equal(created.body.StockLocationNo, 11);
    assert.equal(created.body.DeliveryDate, `${tomorrow()}T00:00:00.000Z`);

    const po = stack.mock.purchaseOrders.get(poId);
    assert.equal(po.OrderStatus, 1);
    assert.equal(po.ApprovedByClerkID, 101);
    assert.equal(po.Emailed, true);
    assert.ok(po.EmailedDate);
    assert.equal(po.CustomerPO, 'Weekly produce');

    const items = stack.mock.purchaseOrderItems.get(poId);
    assert.equal(items.length, 2);
    assert.deepEqual(
      { ...items[0], PurchaseItemID: undefined },
      {
        PurchaseItemID: undefined,
        PurchaseOrderID: poId,
        ProductID: 1001,
        ProductSupplierID: 501,
        Cases: 2,
        Units: 3,
        CaseQty: 20,
        TotalUnits: 43,
        ExGST: 45,
        UnitExGST: 2.25,
      },
    );

    assert.equal(stack.mailer.sent.length, 1);
    const mail = stack.mailer.sent[0];
    assert.equal(mail.to, 'orders@produce.example');
    assert.equal(mail.replyTo, 'manager@example.com');
    assert.match(mail.subject, new RegExp(`Purchase Order #${poId}`));
    assert.match(mail.html, /AVO-20/);
    assert.match(mail.text, /Avocados/);
    assert.match(mail.text, /Please deliver before 10am/);
  });

  test('the same idempotency key does not create a second PO', async () => {
    const c = await stack.signIn();
    const body = order({ idempotencyKey: 'abc123-def456-key' });
    const first = await c.req('POST', '/api/orders', body);
    const count = stack.mock.purchaseOrders.size;
    const second = await c.req('POST', '/api/orders', body);
    assert.equal(second.status, 200);
    assert.equal(second.data.poId, first.data.poId);
    assert.equal(stack.mock.purchaseOrders.size, count);
    assert.equal(stack.mailer.sent.length, 1);
  });

  test('clerk without approval permission: saved as Awaiting approval, not emailed', async () => {
    const c = await stack.signIn('crew@example.com');
    const res = await c.req('POST', '/api/orders', order());
    assert.equal(res.status, 201, res.text);
    assert.equal(res.data.status, 0);
    assert.equal(res.data.email.sent, false);
    assert.equal(res.data.email.reason, 'awaiting_approval');
    const po = stack.mock.purchaseOrders.get(res.data.poId);
    assert.equal(po.OrderStatus, 0);
    assert.equal(po.ApprovedByClerkID, undefined);
    assert.equal(po.ClerkID, 102);
    assert.equal(stack.mailer.sent.length, 0);

    const retry = await c.req('POST', `/api/orders/${res.data.poId}/email`, {});
    assert.equal(retry.status, 403);
  });

  test('a failed line rolls the PO back', async () => {
    const c = await stack.signIn();
    const before = stack.mock.purchaseOrders.size;
    stack.mock.failItemForProductId = 1002;
    const res = await c.req('POST', '/api/orders', order());
    assert.equal(res.status, 502);
    assert.equal(res.data.rolledBack, true);
    assert.match(res.data.error, /Nothing was sent/);
    assert.equal(stack.mock.purchaseOrders.size, before);
    assert.equal(stack.mailer.sent.length, 0);
  });

  test('if rollback also fails, the PO number is reported', async () => {
    const c = await stack.signIn();
    stack.mock.failPurchaseOrderPut = true;
    stack.mock.failDelete = true;
    const res = await c.req('POST', '/api/orders', order());
    assert.equal(res.status, 502);
    assert.equal(res.data.rolledBack, false);
    assert.ok(res.data.poId);
    assert.match(res.data.error, new RegExp(`Check PO #${res.data.poId} in TASK`));
  });

  test('supplier without an email address: PO approved, not emailed', async () => {
    const c = await stack.signIn();
    const res = await c.req('POST', '/api/orders', order({ supplierId: 3, lines: [{ productSupplierId: 701, cases: 1 }] }));
    assert.equal(res.status, 201, res.text);
    assert.equal(res.data.status, 1);
    assert.equal(res.data.email.reason, 'no_supplier_email');
    assert.equal(stack.mailer.sent.length, 0);
  });

  test('email failure can be retried once, then is blocked as already emailed', async () => {
    const c = await stack.signIn();
    stack.mailer.fail = true;
    const res = await c.req('POST', '/api/orders', order());
    assert.equal(res.status, 201, res.text);
    assert.equal(res.data.email.sent, false);
    assert.equal(res.data.email.reason, 'send_failed');
    assert.equal(stack.mock.purchaseOrders.get(res.data.poId).Emailed, false);

    stack.mailer.fail = false;
    const retry = await c.req('POST', `/api/orders/${res.data.poId}/email`, {});
    assert.equal(retry.status, 200, retry.text);
    assert.equal(retry.data.email.sent, true);
    assert.equal(stack.mock.purchaseOrders.get(res.data.poId).Emailed, true);
    assert.match(stack.mailer.sent[0].text, /Avocados/);

    const again = await c.req('POST', `/api/orders/${res.data.poId}/email`, {});
    assert.equal(again.status, 409);
    assert.equal(stack.mailer.sent.length, 1);
  });

  test('validation: past delivery date, empty order, unknown product, other location', async () => {
    const c = await stack.signIn();
    let res = await c.req('POST', '/api/orders', order({ deliveryDate: '2020-01-01' }));
    assert.equal(res.status, 400);
    assert.ok(res.data.fields.deliveryDate);

    res = await c.req('POST', '/api/orders', order({ lines: [{ productSupplierId: 501, cases: 0, units: 0 }] }));
    assert.equal(res.status, 400);
    assert.ok(res.data.fields.lines);

    res = await c.req('POST', '/api/orders', order({ lines: [{ productSupplierId: 999999, cases: 1 }] }));
    assert.equal(res.status, 409);
    assert.equal(res.data.changes[0].type, 'removed');

    res = await c.req('POST', '/api/orders', order({ lines: [{ productSupplierId: 501, cases: -1 }] }));
    assert.equal(res.status, 400);

    res = await c.req('POST', '/api/orders', order({ locationNo: 13 }));
    assert.equal(res.status, 400);
    assert.ok(res.data.fields.locationNo);
  });

  test('costs always come from TASK, never from the browser', async () => {
    const c = await stack.signIn();
    const res = await c.req('POST', '/api/orders', order({ lines: [{ productSupplierId: 501, cases: 1, units: 0, ExGST: 0.01 }] }));
    assert.equal(res.status, 201, res.text);
    assert.equal(res.data.totalExGst, 45);
    assert.equal(stack.mock.purchaseOrderItems.get(res.data.poId)[0].ExGST, 45);
  });
});

describe('live re-check when sending', () => {
  const reviewed = (overrides = {}) =>
    order({
      expectedSupplierEmail: 'orders@produce.example',
      lines: [
        { productSupplierId: 501, cases: 2, units: 0, caseCost: 45, unitCost: 2.25 },
        { productSupplierId: 503, cases: 1, units: 0, caseCost: 15.6, unitCost: 1.3 },
      ],
      ...overrides,
    });

  async function expectNothingSent(res) {
    assert.equal(res.status, 409, res.text);
    assert.equal(res.data.code, 'catalogue_changed');
    assert.match(res.data.error, /Nothing was sent/);
    assert.equal(stack.mailer.sent.length, 0);
    assert.ok(!stack.mock.requests.some((r) => r.method === 'POST' && r.path === '/api/v3/purchaseOrder'));
    return res.data.changes;
  }

  test('a price change in TASK since review stops the send', async () => {
    const c = await stack.signIn();
    stack.mock.data.venueCosts.find((v) => v.ID === 1).CaseCost = 48;
    stack.mock.requests.length = 0;
    const changes = await expectNothingSent(await c.req('POST', '/api/orders', reviewed()));
    assert.deepEqual(changes.map((x) => x.type), ['price']);
    assert.match(changes[0].message, /Avocados: case cost changed from \$45\.00 to \$48\.00/);

    // Reviewing again with the new price goes through, using TASK's price.
    const ok = await c.req('POST', '/api/orders', reviewed({
      lines: [{ productSupplierId: 501, cases: 2, units: 0, caseCost: 48, unitCost: 2.25 }],
    }));
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.data.totalExGst, 96);
  });

  test('a product made inactive in TASK since review stops the send', async () => {
    const c = await stack.signIn();
    stack.mock.data.products[1003].IsActive = false;
    stack.mock.requests.length = 0;
    const changes = await expectNothingSent(await c.req('POST', '/api/orders', reviewed()));
    assert.deepEqual(changes, [{ type: 'unavailable', productSupplierId: 503, message: 'Coriander is now inactive in TASK.' }]);
  });

  test('a product the supplier marked unavailable stops the send', async () => {
    const c = await stack.signIn();
    stack.mock.data.productCodes[1].find((p) => p.ProductSupplierID === 501).IsUnavailable = true;
    stack.mock.requests.length = 0;
    const changes = await expectNothingSent(await c.req('POST', '/api/orders', reviewed()));
    assert.equal(changes[0].type, 'unavailable');
    assert.match(changes[0].message, /Avocados is now marked unavailable/);
  });

  test('ordering a hidden product directly is refused', async () => {
    const c = await stack.signIn();
    stack.mock.requests.length = 0;
    const changes = await expectNothingSent(
      await c.req('POST', '/api/orders', order({ lines: [{ productSupplierId: 506, cases: 1 }] })),
    );
    assert.match(changes[0].message, /Jalapenos \(discontinued\) is now inactive in TASK/);
  });

  test('a changed supplier email stops the send', async () => {
    const c = await stack.signIn();
    stack.mock.data.suppliers.find((s) => s.SupplierID === 1).EmailAddress = 'accounts@produce.example';
    stack.mock.requests.length = 0;
    const changes = await expectNothingSent(await c.req('POST', '/api/orders', reviewed()));
    assert.deepEqual(changes.map((x) => x.type), ['supplier_email']);
    assert.match(changes[0].message, /accounts@produce\.example/);
  });

  test('a supplier made inactive since review stops the send', async () => {
    const c = await stack.signIn();
    stack.mock.data.suppliers.find((s) => s.SupplierID === 1).IsActive = false;
    stack.mock.requests.length = 0;
    const changes = await expectNothingSent(await c.req('POST', '/api/orders', reviewed()));
    assert.equal(changes[0].type, 'supplier_inactive');
  });

  test('only the ordered products are re-checked at send time', async () => {
    const c = await stack.signIn();
    stack.mock.requests.length = 0;
    const res = await c.req('POST', '/api/orders', reviewed());
    assert.equal(res.status, 201, res.text);
    const productCalls = stack.mock.requests.filter((r) => /^\/api\/v3\/products\/\d+$/.test(r.path));
    assert.deepEqual(productCalls.map((r) => r.path).sort(), ['/api/v3/products/1001', '/api/v3/products/1003']);
  });
});

describe('stock levels', () => {
  const stockOf = (res, code) => res.data.products.find((p) => p.code === code).stock;

  test('products carry live stock on hand, min/max and a suggested number of cases', async () => {
    const c = await stack.signIn();
    stack.mock.requests.length = 0;
    const res = await c.req('GET', '/api/suppliers/1/products?locationNo=11');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.stockStatus, { available: true });

    // Avocados: 15 on hand, min 40, max 100, 20 per case -> 85 short -> 5 cases
    assert.deepEqual(stockOf(res, 'AVO-20'), { onHand: 15, min: 40, max: 100, belowMin: true, suggestedCases: 5 });
    // Limes: 12 on hand, min 10, max 30, 5 per case -> 18 short -> 4 cases (not below min)
    assert.deepEqual(stockOf(res, 'LIME-5KG'), { onHand: 12, min: 10, max: 30, belowMin: false, suggestedCases: 4 });
    // Coriander: 30 on hand is above max 24 -> nothing to order
    assert.equal(stockOf(res, 'COR-12').suggestedCases, 0);

    const stockCalls = stack.mock.requests.filter((r) => r.path === '/api/v3/products/location/11/stock/products');
    assert.equal(stockCalls.length, 1);
    assert.deepEqual([...stockCalls[0].query.productIds].map(Number).sort(), [1001, 1002, 1003, 1004, 1005, 1006, 1007]);

    const beach = await c.req('GET', '/api/suppliers/1/products?locationNo=12');
    assert.deepEqual(stockOf(beach, 'AVO-20'), { onHand: 50, min: 40, max: 80, belowMin: false, suggestedCases: 2 });
  });

  test('no stock record or no max level means no suggestion', async () => {
    const c = await stack.signIn();
    const packaging = await c.req('GET', '/api/suppliers/2/products?locationNo=11');
    // Foil: below min but no max set in TASK
    assert.deepEqual(stockOf(packaging, 'FOIL-500'), { onHand: 200, min: 500, max: null, belowMin: true, suggestedCases: null });
    assert.equal(stockOf(packaging, 'NAP-W').suggestedCases, 3);

    const s = await startStack({ env: { REQUIRE_VENUE_COST: 'false' } });
    try {
      const c2 = await s.signIn();
      const res = await c2.req('GET', '/api/suppliers/1/products?locationNo=11');
      assert.equal(stockOf(res, 'ONR-10KG'), null); // onions have no stock record
    } finally {
      await s.close();
    }
  });

  test('stock levels are read live', async () => {
    const c = await stack.signIn();
    await c.req('GET', '/api/suppliers/1/products?locationNo=11');
    stack.mock.data.stock.find((s) => s.LocationNo === 11 && s.ProductId === 1001).Stock = 95;
    const res = await c.req('GET', '/api/suppliers/1/products?locationNo=11');
    assert.deepEqual(stockOf(res, 'AVO-20'), { onHand: 95, min: 40, max: 100, belowMin: false, suggestedCases: 1 });
  });

  test('if TASK cannot return stock, products still load and ordering still works', async () => {
    const c = await stack.signIn();
    stack.mock.failStock = 500;
    const res = await c.req('GET', '/api/suppliers/1/products?locationNo=11');
    assert.equal(res.status, 200);
    assert.equal(res.data.products.length, 3);
    assert.equal(res.data.stockStatus.available, false);
    assert.match(res.data.stockStatus.message, /Stock service unavailable/);
    assert.equal(stockOf(res, 'AVO-20'), null);

    stack.mock.failStock = 403;
    const denied = await c.req('GET', '/api/suppliers/1/products?locationNo=11');
    assert.match(denied.data.stockStatus.message, /not allowed to read stock levels/);

    const order = await c.req('POST', '/api/orders', {
      supplierId: 1,
      locationNo: 11,
      lines: [{ productSupplierId: 501, cases: 1, caseCost: 45, unitCost: 2.25 }],
    });
    assert.equal(order.status, 201, order.text);
  });

  test('a TASK session expiry on the stock call signs the clerk out', async () => {
    const c = await stack.signIn();
    stack.mock.failStock = 440;
    const res = await c.req('GET', '/api/suppliers/1/products?locationNo=11');
    assert.equal(res.status, 401);
    assert.equal(res.data.code, 'session_expired');
  });

  test('stock is not requested when sending and not included in the supplier email', async () => {
    const c = await stack.signIn();
    stack.mock.requests.length = 0;
    const res = await c.req('POST', '/api/orders', {
      supplierId: 1,
      locationNo: 11,
      lines: [{ productSupplierId: 501, cases: 5, caseCost: 45, unitCost: 2.25 }],
    });
    assert.equal(res.status, 201, res.text);
    assert.ok(!stack.mock.requests.some((r) => r.path.endsWith('/stock/products')));
    assert.doesNotMatch(stack.mailer.sent[0].text, /on hand|min|max/i);
  });
});

describe('idle timeout', () => {
  test('sessions end after the idle period', async () => {
    let clock = Date.now();
    const s = await startStack({ env: { SESSION_IDLE_MINUTES: '30' }, now: () => clock });
    try {
      const c = await s.signIn();
      clock += 29 * 60_000;
      assert.equal((await c.req('GET', '/api/me')).status, 200);
      clock += 31 * 60_000;
      assert.equal((await c.req('GET', '/api/me')).status, 401);
    } finally {
      await s.close();
    }
  });
});
