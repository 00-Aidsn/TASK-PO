import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, formatDateOnly, renderPurchaseOrderEmail } from '../src/emailTemplate.js';
import { createSessionStore, parseCookies } from '../src/session.js';
import { createTaskClient, TaskApiError } from '../src/taskClient.js';
import { loadConfig } from '../src/config.js';
import { validateOrderInput, todayIn } from '../src/poService.js';
import { getStockLevels, mapLimit, suggestCases } from '../src/catalogue.js';

describe('email template', () => {
  const base = {
    companyName: 'Mad Mex',
    po: { PurchaseOrderID: 77, Created: '2026-11-05T01:00:00Z', DeliveryDate: '2026-11-10T00:00:00.000Z', Comments: '<script>alert(1)</script>' },
    supplier: { name: 'Demo & Sons', email: 'a@b.example' },
    location: { name: 'City <1>' },
    clerk: { name: 'Sam', email: 'sam@example.com' },
    lines: [
      { code: 'X<1>', name: 'Napkins <white>', pack: '', cases: 1, units: 2, caseCost: 10, lineExGst: 12, notes: '"quoted"' },
      { code: '', name: 'No cost', pack: '6 x 2 kg', cases: 1, units: 0, caseCost: null, lineExGst: null, notes: '' },
    ],
    showPrices: true,
    timeZone: 'Australia/Sydney',
  };

  test('escapes every value in the HTML', () => {
    const { html } = renderPurchaseOrderEmail(base);
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('Napkins &lt;white&gt;'));
    assert.ok(html.includes('Demo &amp; Sons'));
    assert.ok(html.includes('&quot;quoted&quot;'));
  });

  test('includes PO details, subtotal and a note about unpriced lines', () => {
    const { subject, text, html, subtotal, unpriced } = renderPurchaseOrderEmail(base);
    assert.equal(subject, 'Purchase Order #77 - Mad Mex City <1>');
    assert.equal(subtotal, 12);
    assert.equal(unpriced, 1);
    assert.match(text, /Requested delivery: Tue,? 10 Nov 2026/);
    assert.match(text, /Ordered by: Sam \(sam@example.com\)/);
    assert.match(html, /\$12\.00/);
    assert.match(html, /1 line\(s\) have no cost on file/);
  });

  test('can leave prices out', () => {
    const { html, text } = renderPurchaseOrderEmail({ ...base, showPrices: false });
    assert.doesNotMatch(html, /\$/);
    assert.doesNotMatch(text, /\$/);
  });

  test('helpers', () => {
    assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    assert.equal(formatDateOnly('0001-01-01T00:00:00'), '');
    assert.match(formatDateOnly('2026-11-10T00:00:00Z'), /^Tue,? 10 Nov 2026$/);
  });
});

describe('session store', () => {
  test('expires idle sessions and refreshes active ones', () => {
    let clock = 0;
    const store = createSessionStore({ idleMinutes: 10, now: () => clock });
    const id = store.create({ accessToken: 't' });
    clock = 9 * 60_000;
    assert.ok(store.get(id));
    clock = 18 * 60_000; // 9 minutes after last activity
    assert.ok(store.get(id));
    clock = 29 * 60_000;
    assert.equal(store.get(id), null);
    assert.equal(store.size, 0);
  });

  test('parses cookies', () => {
    assert.deepEqual(parseCookies('a=1; po_sid=abc%3D; b'), { a: '1', po_sid: 'abc=' });
    assert.deepEqual(parseCookies(undefined), {});
  });
});

describe('task client', () => {
  function fakeFetch(handler) {
    const calls = [];
    const fn = async (url, init) => {
      calls.push({ url: new URL(url), init });
      const { status = 200, body } = await handler(new URL(url), init, calls.length);
      return new Response(body === undefined ? '' : JSON.stringify(body), { status });
    };
    fn.calls = calls;
    return fn;
  }

  test('sends Key and Bearer headers and builds the query string', async () => {
    const fetchImpl = fakeFetch(() => ({ body: { ok: true } }));
    const task = createTaskClient({ baseUrl: 'https://task.example', apiKey: 'k', fetchImpl });
    await task.request('GET', '/supplier/5', { token: 'tok', query: { a: 1, b: undefined, c: '' } });
    const { url, init } = fetchImpl.calls[0];
    assert.equal(url.href, 'https://task.example/api/v3/supplier/5?a=1');
    assert.equal(init.headers.Key, 'k');
    assert.equal(init.headers.Authorization, 'Bearer tok');
  });

  test('maps TASK error statuses', async () => {
    for (const [status, kind] of [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [440, 'session_expired'],
      [406, 'rejected'],
      [500, 'server'],
    ]) {
      const task = createTaskClient({
        baseUrl: 'https://task.example',
        apiKey: 'k',
        fetchImpl: fakeFetch(() => ({ status, body: { Message: `boom ${status}` } })),
      });
      await assert.rejects(task.request('GET', '/x'), (err) => {
        assert.ok(err instanceof TaskApiError);
        assert.equal(err.kind, kind);
        assert.equal(err.message, `boom ${status}`);
        return true;
      });
    }
  });

  test('network failures become TaskApiError', async () => {
    const task = createTaskClient({
      baseUrl: 'https://task.example',
      apiKey: 'k',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await assert.rejects(task.request('GET', '/x'), (err) => err.kind === 'network');
  });

  test('reads all pages and stops if an endpoint ignores paging', async () => {
    const rows = [1, 2, 3, 4, 5].map((n) => ({ id: n }));
    const paged = fakeFetch((url) => {
      const size = Number(url.searchParams.get('pagingArgs.pageSize'));
      const no = Number(url.searchParams.get('pagingArgs.pageNo'));
      return { body: { PageNo: no, PageSize: size, Items: rows.slice((no - 1) * size, no * size) } };
    });
    const task = createTaskClient({ baseUrl: 'https://t.example', apiKey: 'k', pageSize: 2, fetchImpl: paged });
    assert.deepEqual(await task.getAllPages('/x'), rows);

    const stuck = fakeFetch(() => ({ body: { Items: [{ id: 1 }, { id: 2 }] } }));
    const task2 = createTaskClient({ baseUrl: 'https://t.example', apiKey: 'k', pageSize: 2, fetchImpl: stuck });
    assert.deepEqual(await task2.getAllPages('/x'), [{ id: 1 }, { id: 2 }]);
    assert.equal(stuck.calls.length, 2);
  });
});

describe('config', () => {
  test('requires an API key and SMTP settings in smtp mode', () => {
    assert.throws(() => loadConfig({}), /TASK_API_KEY is required/);
    assert.throws(() => loadConfig({ TASK_API_KEY: 'k', MAIL_MODE: 'smtp' }), /SMTP_HOST is required/);
    const cfg = loadConfig({ TASK_API_KEY: 'k', MAIL_CC: 'a@x.example, b@x.example' });
    assert.deepEqual(cfg.mail.cc, ['a@x.example', 'b@x.example']);
    assert.equal(cfg.task.baseUrl, 'https://madmexuatapi.xchangefusion.com');
  });
});

describe('order validation', () => {
  test('merges nothing, drops empty lines, rejects duplicates', () => {
    const today = todayIn('Australia/Sydney');
    const input = validateOrderInput(
      { supplierId: '1', locationNo: 2, lines: [{ productSupplierId: 5, cases: '2' }, { productSupplierId: 6 }] },
      { today },
    );
    assert.deepEqual(input.lines, [
      { productSupplierId: 5, cases: 2, units: 0, notes: '', expected: { caseCost: undefined, unitCost: undefined } },
    ]);
    assert.throws(
      () =>
        validateOrderInput(
          { supplierId: 1, locationNo: 2, lines: [{ productSupplierId: 5, cases: 1 }, { productSupplierId: 5, units: 1 }] },
          { today },
        ),
      /highlighted/,
    );
    assert.throws(() => validateOrderInput({ supplierId: 1, locationNo: 2, deliveryDate: '2026-02-30', lines: [{ productSupplierId: 5, cases: 1 }] }, { today }));
  });
});

describe('stock suggestions', () => {
  test('suggests whole cases up to the max level', () => {
    assert.equal(suggestCases({ onHand: 15, max: 100, caseQty: 20 }), 5); // 85 short
    assert.equal(suggestCases({ onHand: 60, max: 100, caseQty: 20 }), 2); // exactly 40 short
    assert.equal(suggestCases({ onHand: -10, max: 20, caseQty: 10 }), 3); // oversold stock
    assert.equal(suggestCases({ onHand: 0.7, max: 3, caseQty: 0.5 }), 5); // fractional case sizes
    assert.equal(suggestCases({ onHand: 4, max: 6, caseQty: 0 }), 2); // missing case size counts as 1
  });

  test('no suggestion without stock or a max; zero when at or above max', () => {
    assert.equal(suggestCases({ onHand: null, max: 100, caseQty: 20 }), null);
    assert.equal(suggestCases({ onHand: 10, max: null, caseQty: 20 }), null);
    assert.equal(suggestCases({ onHand: 100, max: 100, caseQty: 20 }), 0);
    assert.equal(suggestCases({ onHand: 120, max: 100, caseQty: 20 }), 0);
  });

  test('stock requests are split into chunks of 50 products', async () => {
    const calls = [];
    const task = {
      async getStockValues(token, locationNo, ids) {
        calls.push(ids.length);
        return ids.map((id) => ({ ProductId: id, LocationNo: locationNo, Stock: id, MinStockLevel: 0, MaxStockLevel: 10 }));
      },
    };
    const ids = Array.from({ length: 120 }, (_, i) => i + 1);
    const levels = await getStockLevels(task, { accessToken: 't' }, 11, [...ids, 5, 6]);
    assert.deepEqual(calls.sort((a, b) => b - a), [50, 50, 20]);
    assert.equal(levels.size, 120);
    assert.deepEqual(levels.get(7), { onHand: 7, min: null, max: 10 });
  });
});

describe('mapLimit', () => {
  test('keeps results in order and limits concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 10;
    });
    assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70]);
    assert.equal(peak, 3);
  });

  test('stops starting new work after a failure', async () => {
    const started = [];
    await assert.rejects(
      mapLimit([1, 2, 3, 4, 5, 6], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error('boom');
      }),
      /boom/,
    );
    assert.deepEqual(started, [1, 2]);
  });
});
