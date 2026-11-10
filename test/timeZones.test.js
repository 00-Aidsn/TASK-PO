import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStoreTimeZone, timeZoneLookup, zonedTimeToInstant } from '../src/timeZones.js';
import { formatOrdered } from '../src/poDocument.js';
import { todayIn } from '../src/poService.js';
import { startStack } from './helpers.js';

const lookup = timeZoneLookup({
  'Australia/Sydney': 'AUS Eastern Standard Time',
  'Australia/Perth': 'W. Australia Standard Time',
});

describe("working out a store's time zone", () => {
  test('a standard name from TASK is used as it is', () => {
    assert.equal(resolveStoreTimeZone({ timeZoneId: 'Australia/Adelaide', state: 'VIC' }), 'Australia/Adelaide');
  });

  test("a Windows/.NET name is translated with TASK's own lookup, either way round", () => {
    assert.equal(resolveStoreTimeZone({ timeZoneId: 'W. Australia Standard Time', lookup }), 'Australia/Perth');
    const reversed = timeZoneLookup([{ Key: 'w. australia standard time', Value: 'Australia/Perth' }]);
    assert.equal(resolveStoreTimeZone({ timeZoneId: 'W. Australia Standard Time', lookup: reversed }), 'Australia/Perth');
  });

  test("without TASK's lookup, the built-in Australian names are used", () => {
    assert.equal(resolveStoreTimeZone({ timeZoneId: 'E. Australia Standard Time' }), 'Australia/Brisbane');
    assert.equal(resolveStoreTimeZone({ timeZoneId: 'cen. australia standard time' }), 'Australia/Adelaide');
    assert.equal(resolveStoreTimeZone({ timeZoneId: 'Tasmania Standard Time' }), 'Australia/Hobart');
  });

  test("with no usable TimeZoneId, the store's state decides, then the fallback", () => {
    assert.equal(resolveStoreTimeZone({ timeZoneId: '', state: 'qld' }), 'Australia/Brisbane');
    assert.equal(resolveStoreTimeZone({ timeZoneId: 'Not A Zone', state: 'WA' }), 'Australia/Perth');
    assert.equal(resolveStoreTimeZone({ timeZoneId: null, state: 'NT' }), 'Australia/Darwin');
    assert.equal(resolveStoreTimeZone({ timeZoneId: '', state: '', fallback: 'Australia/Sydney' }), 'Australia/Sydney');
    assert.equal(resolveStoreTimeZone({}), null);
  });
});

describe('PO "Ordered" time in the store\'s time zone', () => {
  const moment = '2026-11-04T23:19:57.000Z'; // 10:19:57 AM in Melbourne/Sydney (daylight saving)

  test('the same moment in each store', () => {
    assert.equal(formatOrdered(moment, 'Australia/Melbourne'), '5/11/2026 10:19:57 AM');
    assert.equal(formatOrdered(moment, 'Australia/Sydney'), '5/11/2026 10:19:57 AM');
    assert.equal(formatOrdered(moment, 'Australia/Adelaide'), '5/11/2026 9:49:57 AM');
    assert.equal(formatOrdered(moment, 'Australia/Brisbane'), '5/11/2026 9:19:57 AM'); // no daylight saving
    assert.equal(formatOrdered(moment, 'Australia/Darwin'), '5/11/2026 8:49:57 AM');
    assert.equal(formatOrdered(moment, 'Australia/Perth'), '5/11/2026 7:19:57 AM');
  });

  test("times TASK returns without a time zone are read as TASK's zone, then converted", () => {
    const noZone = '2026-11-05T10:19:57';
    assert.equal(formatOrdered(noZone, 'Australia/Perth', { taskTimeZone: 'Australia/Sydney' }), '5/11/2026 7:19:57 AM');
    assert.equal(formatOrdered(noZone, 'Australia/Melbourne', { taskTimeZone: 'Australia/Sydney' }), '5/11/2026 10:19:57 AM');
    assert.equal(formatOrdered(noZone, 'Australia/Perth', { taskTimeZone: 'UTC' }), '5/11/2026 6:19:57 PM');
    assert.equal(formatOrdered(noZone, 'Australia/Perth'), '5/11/2026 10:19:57 AM'); // no TASK zone given: as it is
    // Just after midnight in Sydney is still the previous evening in Perth
    assert.equal(formatOrdered('2026-11-06T00:30:00', 'Australia/Perth', { taskTimeZone: 'Australia/Sydney' }), '5/11/2026 9:30:00 PM');
  });

  test('daylight-saving changes come out right', () => {
    // Sydney clocks go back at 3:00 AM on 5 April 2026 (AEDT +11 -> AEST +10), forward at 2:00 AM on 4 October 2026
    assert.equal(zonedTimeToInstant({ year: 2026, month: 4, day: 5, hour: 12 }, 'Australia/Sydney').toISOString(), '2026-04-05T02:00:00.000Z');
    assert.equal(zonedTimeToInstant({ year: 2026, month: 4, day: 4, hour: 12 }, 'Australia/Sydney').toISOString(), '2026-04-04T01:00:00.000Z');
    assert.equal(zonedTimeToInstant({ year: 2026, month: 10, day: 4, hour: 12 }, 'Australia/Sydney').toISOString(), '2026-10-04T01:00:00.000Z');
    assert.equal(formatOrdered('2026-04-05T12:00:00', 'Australia/Perth', { taskTimeZone: 'Australia/Sydney' }), '5/4/2026 10:00:00 AM');
    assert.equal(formatOrdered('2026-04-04T12:00:00', 'Australia/Perth', { taskTimeZone: 'Australia/Sydney' }), '4/4/2026 9:00:00 AM');
  });
});

describe('"today" for date checks', () => {
  test('near midnight, Sydney and Perth are on different days', () => {
    const lateInPerth = new Date('2026-11-05T14:30:00Z'); // 1:30 AM 6 Nov in Sydney, 10:30 PM 5 Nov in Perth
    assert.equal(todayIn('Australia/Sydney', lateInPerth), '2026-11-06');
    assert.equal(todayIn('Australia/Perth', lateInPerth), '2026-11-05');
  });
});

describe('emailed POs use the store\'s time zone', () => {
  let s;
  before(async () => {
    s = await startStack();
  });
  after(async () => {
    await s.close();
  });

  test('a Perth store shows Perth time; a Melbourne store shows Melbourne time', async () => {
    const c = await s.signIn();
    const perth = await c.req('POST', '/api/orders', { supplierId: 1, locationNo: 12, lines: [{ productSupplierId: 501, cases: 1 }] });
    assert.equal(perth.status, 201, perth.text);
    const perthMail = s.mailer.sent.at(-1);
    const perthCreated = s.mock.purchaseOrders.get(perth.data.poId).Created;
    const ordered = /\nOrdered:\t([^\n]+)\n/.exec(perthMail.text)[1];
    assert.equal(ordered, formatOrdered(perthCreated, 'Australia/Perth'));
    assert.notEqual(ordered, formatOrdered(perthCreated, 'Australia/Sydney'));
    assert.match(perthMail.text, /5 Marine Parade, Cottesloe, WA, 6011/);

    const city = await c.req('POST', '/api/orders', { supplierId: 1, locationNo: 11, lines: [{ productSupplierId: 501, cases: 1 }] });
    assert.equal(city.status, 201, city.text);
    const cityCreated = s.mock.purchaseOrders.get(city.data.poId).Created;
    assert.match(s.mailer.sent.at(-1).text, new RegExp(`\\nOrdered:\\t${formatOrdered(cityCreated, 'Australia/Sydney').replace(/[/:]/g, '\\$&')}\\n`));
  });

  test("a store whose time zone can't be worked out uses DISPLAY_TIMEZONE", async () => {
    s.mock.data.terminalLocations.find((l) => l.LocationNo === 12).TimeZoneId = '';
    s.mock.data.terminalLocations.find((l) => l.LocationNo === 12).State = '';
    const c = await s.signIn(); // new session, so store details are read again
    const res = await c.req('POST', '/api/orders', { supplierId: 1, locationNo: 12, lines: [{ productSupplierId: 501, cases: 1 }] });
    assert.equal(res.status, 201, res.text);
    const created = s.mock.purchaseOrders.get(res.data.poId).Created;
    assert.match(s.mailer.sent.at(-1).text, new RegExp(`\\nOrdered:\\t${formatOrdered(created, 'Australia/Sydney').replace(/[/:]/g, '\\$&')}\\n`));
  });
});
