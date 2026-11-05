import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RULE,
  buildPoDocument,
  formatOrdered,
  formatRequired,
  pdfSafe,
  renderCsv,
  renderHtml,
  renderPdf,
  renderPurchaseOrderEmail,
  renderText,
} from '../src/poDocument.js';
import { MORCO_TEXT, morcoSample } from './fixtures/morco-po.js';

const hasPdftotext = (() => {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function pdfText(buffer) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'po-pdf-')), 'po.pdf');
  fs.writeFileSync(file, buffer);
  return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
}

describe('purchase order format', () => {
  test('the email body matches the Mad Mex sample exactly (MorCo Fresh VIC, Waurn Ponds, order 782296)', () => {
    const text = renderText(buildPoDocument(morcoSample()));
    assert.equal(text, MORCO_TEXT);
    assert.equal(RULE.length, 120);
  });

  test('dates: ordered time in the store time zone, required date at midnight', () => {
    assert.equal(formatOrdered('2026-11-04T23:19:57.000Z', 'Australia/Melbourne'), '5/11/2026 10:19:57 AM');
    assert.equal(formatOrdered('2026-11-05T14:05:09', 'Australia/Melbourne'), '5/11/2026 2:05:09 PM'); // TASK local time, no zone
    assert.equal(formatOrdered('2026-11-05T00:00:00', 'Australia/Melbourne'), '5/11/2026 12:00:00 AM');
    assert.equal(formatOrdered('2026-11-05T12:30:00', 'Australia/Melbourne'), '5/11/2026 12:30:00 PM');
    assert.equal(formatRequired('2026-11-07T00:00:00.000Z'), '7/11/2026 12:00:00 AM');
    assert.equal(formatRequired(null), '');
    assert.equal(formatOrdered('0001-01-01T00:00:00', 'Australia/Melbourne'), '');
  });

  test('supplier address, contact, units of measure, TASK tax and missing products', () => {
    const sample = morcoSample();
    const firstItem = sample.items.find((i) => i.PurchaseItemID === 1);
    sample.catalogue.all.get(firstItem.ProductSupplierID).uomSizeTypeId = 2;
    sample.catalogue.all.delete(sample.items.find((i) => i.PurchaseItemID === 2).ProductSupplierID);
    const doc = buildPoDocument({
      ...sample,
      po: { ...sample.po, Tax: 9.5, Comments: 'Back door\nBefore 9am' },
      supplier: { name: 'MorCo Fresh VIC', contact: 'Jo', addressLines: ['1 Market Rd', 'Unit 4'], state: 'VIC', postCode: '3214' },
      productNames: new Map([[2002, 'Capsicum Green (1kg)']]),
      uomNames: new Map([[2, 'kg']]),
    });
    assert.equal(doc.contact, 'Jo');
    assert.deepEqual(doc.supplierLines, ['MorCo Fresh VIC', '1 Market Rd', 'Unit 4', 'VIC, 3214']);
    assert.equal(doc.lines[0].uom, 'kg');
    assert.equal(doc.lines[1].description, 'Capsicum Green (1kg)'); // name from TASK even though it's no longer in the catalogue
    assert.equal(doc.lines[1].code, '');
    assert.equal(doc.tax, 9.5);
    assert.equal(doc.total, 484.05 - 9.0 + doc.lines[1].totalCost + 9.5);
    const text = renderText(doc);
    assert.match(text, /\nSupplier:\tShip To:\nMorCo Fresh VIC\t\nShop T980B[^\n]+\n1 Market Rd\t\nUnit 4\t\nVIC, 3214\t\nComments:\tBack door\nBefore 9am\n/);
  });

  test('HTML body has the same sections and escapes everything', () => {
    const sample = morcoSample();
    const doc = buildPoDocument({ ...sample, po: { ...sample.po, Comments: '<script>alert(1)</script>' }, accountNo: 'A&B' });
    const html = renderHtml(doc);
    assert.ok(!html.includes('<script>'));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /Account No:<\/td><td[^>]*>A&amp;B<\/td>/);
    for (const label of ['Purchase Order', 'Order No:', 'Ordered:', 'Required:', 'Contact:', 'Venue:', 'Supplier:', 'Ship To:', 'Comments:', 'SubTotal', 'Tax', 'TOTAL']) {
      assert.ok(html.includes(label), `HTML should include ${label}`);
    }
    assert.equal((html.match(/<hr /g) || []).length, 4);
    assert.match(html, /<td[^>]*>MM10047<\/td><td[^>]*>Lettuce Shredded \(2\.5kg\)<\/td><td[^>]*>8<\/td><td[^>]*>0<\/td><td[^>]*>20<\/td><td[^>]*><\/td><td[^>]*>\$14\.50<\/td><td[^>]*>\$5\.80<\/td><td[^>]*>\$116\.00<\/td>/);
  });

  test('CSV attachment follows the same layout', () => {
    const csv = renderCsv(buildPoDocument(morcoSample()));
    assert.ok(csv.startsWith('﻿Purchase Order\r\n'), 'UTF-8 BOM so Excel reads it correctly');
    const rows = csv.slice(1).split('\r\n');
    assert.deepEqual(rows.slice(0, 13), [
      'Purchase Order',
      '',
      'Order No:,782296',
      'Ordered:,5/11/2026 10:19:57 AM',
      'Required:,7/11/2026 12:00:00 AM',
      'Contact:,',
      'Venue:,Waurn Ponds',
      'Account No:,MADMEXWAUR',
      '',
      'Supplier:,Ship To:',
      'MorCo Fresh VIC,"Shop T980B, 173-179 Colac Road, Waurn Ponds Extension, Grovedale, VIC, 3216"',
      'VIC,',
      'Comments:,',
    ]);
    assert.equal(rows[14], 'Supplier Code,Product Description,Cases,Units,Total,UOM,Case Cost,Unit Cost,Total Cost');
    assert.equal(rows[15], 'MM10000,Avocado (10kg),2,0,20,,$61.00,$6.10,$122.00');
    assert.equal(rows[25], 'MM10016,Rice Sunrice Brown Med Grain (Ctn 3x5kg),1,0,15,,$32.50,$2.17,$32.50');
    assert.deepEqual(rows.slice(-4), ['SubTotal,$484.05', 'Tax,$0.00', 'TOTAL,$484.05', '']);
  });

  test('CSV quotes commas and quotes, and stops text being read as a spreadsheet formula', () => {
    const sample = morcoSample();
    const item = sample.items.find((i) => i.PurchaseItemID === 1);
    sample.catalogue.all.get(item.ProductSupplierID).name = '=HYPERLINK("x") "Big", ripe';
    const csv = renderCsv(buildPoDocument({ ...sample, po: { ...sample.po, Comments: '+61 400 000 000' } }));
    assert.match(csv, /\r\nMM10000,"'=HYPERLINK\(""x""\) ""Big"", ripe",2,/);
    assert.match(csv, /\r\nComments:,'\+61 400 000 000\r\n/);
  });

  test('PDF attachment has the same content', { skip: !hasPdftotext && 'pdftotext not installed' }, async () => {
    const pdf = await renderPdf(buildPoDocument(morcoSample()));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    const text = pdfText(pdf);
    for (const s of [
      'Purchase Order',
      'Order No:',
      '782296',
      '5/11/2026 10:19:57 AM',
      '7/11/2026 12:00:00 AM',
      'Waurn Ponds',
      'MADMEXWAUR',
      'MorCo Fresh VIC',
      'Shop T980B, 173-179 Colac Road',
      'Supplier',
      'Product Description',
      'Case Cost',
      'MM10047',
      'Lettuce Shredded (2.5kg)',
      '$116.00',
      'SubTotal',
      '$484.05',
      'Page 1 of 1',
    ]) {
      assert.ok(text.includes(s), `PDF should contain "${s}"`);
    }
  });

  test('long orders run over several PDF pages, repeating the column headings', { skip: !hasPdftotext && 'pdftotext not installed' }, async () => {
    const sample = morcoSample();
    const items = [];
    for (let i = 0; i < 6; i++) {
      for (const it of sample.items) items.push({ ...it, PurchaseItemID: it.PurchaseItemID + i * 100 });
    }
    const pdf = await renderPdf(buildPoDocument({ ...sample, items }));
    const text = pdfText(pdf);
    const pages = text.split('\f').filter((p) => p.trim());
    assert.ok(pages.length >= 2, `expected several pages, got ${pages.length}`);
    for (const page of pages.slice(0, -1)) assert.match(page, /Product Description/);
    assert.match(text, new RegExp(`Page ${pages.length} of ${pages.length}`));
    assert.match(text, /\$2,904\.30/); // 6 x $484.05
  });

  test('characters the PDF fonts cannot draw become "?"', () => {
    assert.equal(pdfSafe('Zoë Café – “quoted” 🌶 汉'), 'Zoë Café – “quoted” ? ?');
  });

  test('the email has a subject, both bodies, and the PDF + CSV attachments', async () => {
    const email = await renderPurchaseOrderEmail({ doc: buildPoDocument(morcoSample()), companyName: 'Mad Mex' });
    assert.equal(email.subject, 'Purchase Order 782296 - Mad Mex Waurn Ponds');
    assert.equal(email.text, MORCO_TEXT);
    assert.deepEqual(
      email.attachments.map((a) => a.filename),
      ['PurchaseOrder_782296.pdf', 'PurchaseOrder_782296.csv'],
    );
  });
});
