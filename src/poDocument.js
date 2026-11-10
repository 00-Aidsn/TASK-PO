/**
 * The supplier purchase order, in the Mad Mex format:
 *
 *   Purchase Order
 *   Order No / Ordered / Required / Contact / Venue / Account No
 *   ____
 *   Supplier: | Ship To:   (supplier name, address, state | store address)
 *   Comments:
 *   ____
 *   Supplier Code | Product Description | Cases | Units | Total | UOM | Case Cost | Unit Cost | Total Cost
 *   ____
 *   SubTotal / Tax / TOTAL
 *   ____
 *
 * buildPoDocument() turns TASK data into one document model; renderText / renderHtml / renderCsv /
 * renderPdf all draw that same model, so the email body and both attachments always agree.
 */
import PDFDocument from 'pdfkit';
import { escapeHtml } from './emailTemplate.js';
import { wallClock, zonedTimeToInstant } from './timeZones.js';

export const RULE = '_'.repeat(120);
export const LINE_COLUMNS = ['Supplier Code', 'Product Description', 'Cases', 'Units', 'Total', 'UOM', 'Case Cost', 'Unit Cost', 'Total Cost'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
};
const pad2 = (n) => String(n).padStart(2, '0');

const moneyFormat = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** $61.00 */
export const money = (n) => moneyFormat.format(round2(n));
/** 2, 0, 20, 2.5 */
export const qty = (n) => String(Math.round((Number(n) || 0) * 1000) / 1000);

/** d/M/yyyy h:mm:ss AM, e.g. 5/11/2026 10:19:57 AM */
function clock(y, mo, d, h, mi, s) {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${d}/${mo}/${y} ${h12}:${pad2(mi)}:${pad2(s)} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * When the order was placed, in the store's time zone (d/M/yyyy h:mm:ss AM).
 * Times with "Z" or an offset are converted directly. TASK may return times without a time zone; those
 * are read as TASK's own time zone (TASK_TIME_ZONE) and then converted to the store's.
 * Without a taskTimeZone, such times are shown as they are.
 */
export function formatOrdered(value, timeZone, { taskTimeZone } = {}) {
  const text = String(value || '').trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(text);
  if (local) {
    if (Number(local[1]) < 1900) return '';
    const wall = { year: +local[1], month: +local[2], day: +local[3], hour: +local[4], minute: +local[5], second: +(local[6] || 0) };
    if (!taskTimeZone || taskTimeZone === timeZone) return clock(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second);
    const w = wallClock(zonedTimeToInstant(wall, taskTimeZone), timeZone);
    return clock(w.year, w.month, w.day, w.hour, w.minute, w.second);
  }
  const d = new Date(text);
  if (!text || Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1900) return '';
  const w = wallClock(d, timeZone);
  return clock(w.year, w.month, w.day, w.hour, w.minute, w.second);
}

/** The requested delivery day, at midnight: 7/11/2026 12:00:00 AM */
export function formatRequired(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m || Number(m[1]) < 1900) return '';
  return clock(+m[1], +m[2], +m[3], 0, 0, 0);
}

/** "Shop T980B, 173-179 Colac Road, Waurn Ponds Extension, Grovedale, VIC, 3216" */
export function joinAddress(parts) {
  return parts
    .map((p) => String(p ?? '').trim())
    .filter((p) => p && p !== '0')
    .join(', ');
}

/**
 * @param {object} p
 * @param {object} p.po            TASK PurchaseOrderModel (PurchaseOrderID, Created, DeliveryDate, Comments, ShipToAddress, Tax)
 * @param {Array}  p.items         TASK PurchaseOrderItemModel rows
 * @param {object} p.supplier      { name, contact, addressLines[], state, postCode }
 * @param {string} p.venueName     the store's name, e.g. Waurn Ponds
 * @param {string} p.shipTo        the store's delivery address
 * @param {string} p.accountNo     the store's account number with this supplier
 * @param {object} p.catalogue     live catalogue (all: Map productSupplierId -> { code, name, caseQty, caseCost, unitCost, uomSizeTypeId })
 * @param {Map}    [p.productNames] productId -> name, for lines no longer in the catalogue
 * @param {Map}    [p.uomNames]     TASK size type id -> name
 * @param {string} p.timeZone      the store's time zone, e.g. Australia/Perth
 * @param {string} [p.taskTimeZone] the time zone TASK means when it returns a time without one
 */
export function buildPoDocument({
  po,
  items,
  supplier,
  venueName,
  shipTo,
  accountNo,
  catalogue,
  productNames = new Map(),
  uomNames = new Map(),
  timeZone,
  taskTimeZone,
}) {
  const lines = [...items]
    .sort((a, b) => (Number(a.PurchaseItemID) || 0) - (Number(b.PurchaseItemID) || 0))
    .map((item) => {
      const product = catalogue?.all?.get(Number(item.ProductSupplierID));
      const caseQty = num(product?.caseQty) > 0 ? num(product.caseQty) : num(item.CaseQty) > 0 ? num(item.CaseQty) : 1;
      const cases = num(item.Cases) ?? 0;
      const units = num(item.Units) ?? 0;
      const total = num(item.TotalUnits) > 0 ? num(item.TotalUnits) : cases * caseQty + units;
      const caseCost = num(product?.caseCost) ?? num(item.ExGST) ?? 0;
      const unitCost = num(product?.unitCost) ?? num(item.UnitExGST) ?? caseCost / caseQty;
      return {
        code: product?.code || '',
        description: product?.name || productNames.get(Number(item.ProductID)) || `Product ${item.ProductID}`,
        cases,
        units,
        total,
        uom: uomNames.get(Number(product?.uomSizeTypeId)) || '',
        caseCost,
        unitCost,
        totalCost: round2(cases * caseCost + units * unitCost),
      };
    });
  const subtotal = round2(lines.reduce((s, l) => s + l.totalCost, 0));
  const tax = num(po.Tax) > 0 ? round2(po.Tax) : 0; // TASK's own tax figure for the PO
  return {
    orderNo: String(po.PurchaseOrderID),
    ordered: formatOrdered(po.Created, timeZone, { taskTimeZone }),
    required: formatRequired(po.DeliveryDate),
    contact: supplier.contact || '',
    venue: venueName || '',
    accountNo: accountNo || '',
    supplierLines: [supplier.name, ...(supplier.addressLines || []), joinAddress([supplier.state, supplier.postCode])].filter(Boolean),
    shipTo: shipTo || po.ShipToAddress || '',
    comments: String(po.Comments || '').trim(),
    lines,
    subtotal,
    tax,
    total: round2(subtotal + tax),
  };
}

const lineCells = (l) => [l.code, l.description, qty(l.cases), qty(l.units), qty(l.total), l.uom, money(l.caseCost), money(l.unitCost), money(l.totalCost)];
const headerRows = (doc) => [
  ['Order No:', doc.orderNo],
  ['Ordered:', doc.ordered],
  ['Required:', doc.required],
  ['Contact:', doc.contact],
  ['Venue:', doc.venue],
  ['Account No:', doc.accountNo],
];
const totalRows = (doc) => [
  ['SubTotal', money(doc.subtotal)],
  ['Tax', money(doc.tax)],
  ['TOTAL', money(doc.total)],
];

// ---------------------------------------------------------------- email body (plain text)
export function renderText(doc) {
  const [supplierName = '', ...supplierRest] = doc.supplierLines;
  const out = [
    'Purchase Order',
    '',
    ...headerRows(doc).map(([k, v]) => `${k}\t${v}`),
    '',
    RULE,
    'Supplier:\tShip To:',
    `${supplierName}\t`,
    doc.shipTo,
    ...supplierRest.map((l) => `${l}\t`),
    `Comments:\t${doc.comments}`,
    RULE,
    LINE_COLUMNS.join('\t| '),
    ...doc.lines.map((l) => lineCells(l).join('\t| ')),
    RULE,
    ...totalRows(doc).map(([k, v]) => `${k}\t${v}`),
    RULE,
  ];
  return out.join('\n');
}

// ---------------------------------------------------------------- email body (HTML)
export function renderHtml(doc) {
  const e = escapeHtml;
  const cell = 'padding:2px 24px 2px 0;font-size:13px;vertical-align:top;';
  const hr = '<hr style="border:0;border-top:1px solid #000;margin:10px 0;">';
  const th = 'padding:4px 6px;font-size:12px;border-bottom:1px solid #000;text-align:left;white-space:nowrap;';
  const td = 'padding:3px 6px;font-size:12px;vertical-align:top;';
  const right = 'text-align:right;white-space:nowrap;';
  const numericCol = (i) => i >= 2 && i !== 5; // Cases, Units, Total, costs
  const [supplierName = '', ...supplierRest] = doc.supplierLines;
  const supplierRows = [[supplierName, doc.shipTo], ...supplierRest.map((l) => [l, ''])];
  return `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><title>Purchase Order ${e(doc.orderNo)}</title></head>
<body style="margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff;">
<h2 style="font-size:18px;margin:0 0 12px;">Purchase Order</h2>
<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
${headerRows(doc).map(([k, v]) => `<tr><td style="${cell}">${e(k)}</td><td style="${cell}">${e(v)}</td></tr>`).join('\n')}
</table>
${hr}
<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;">
<tr><td style="${cell}width:50%;">Supplier:</td><td style="${cell}">Ship To:</td></tr>
${supplierRows.map(([l, r]) => `<tr><td style="${cell}">${e(l)}</td><td style="${cell}">${e(r)}</td></tr>`).join('\n')}
</table>
<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:6px;">
<tr><td style="${cell}">Comments:</td><td style="${cell}white-space:pre-wrap;">${e(doc.comments)}</td></tr>
</table>
${hr}
<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;">
<thead><tr>${LINE_COLUMNS.map((c, i) => `<th style="${th}${numericCol(i) ? right : ''}">${e(c)}</th>`).join('')}</tr></thead>
<tbody>
${doc.lines.map((l) => `<tr>${lineCells(l).map((v, i) => `<td style="${td}${numericCol(i) ? right : ''}">${e(v)}</td>`).join('')}</tr>`).join('\n')}
</tbody>
</table>
${hr}
<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
${totalRows(doc)
  .map(([k, v]) => {
    const bold = k === 'TOTAL' ? 'font-weight:bold;' : '';
    return `<tr><td style="${cell}${bold}">${e(k)}</td><td style="${cell}${bold}${right}">${e(v)}</td></tr>`;
  })
  .join('\n')}
</table>
${hr}
</body></html>`;
}

// ---------------------------------------------------------------- CSV attachment (same layout)
/** Text that a spreadsheet would treat as a formula is prefixed with ' so it shows as text. */
function csvSafe(value) {
  const text = String(value ?? '');
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}
function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function renderCsv(doc) {
  const [supplierName = '', ...supplierRest] = doc.supplierLines;
  const rows = [
    ['Purchase Order'],
    [],
    ...headerRows(doc).map(([k, v]) => [k, csvSafe(v)]),
    [],
    ['Supplier:', 'Ship To:'],
    [csvSafe(supplierName), csvSafe(doc.shipTo)],
    ...supplierRest.map((l) => [csvSafe(l), '']),
    ['Comments:', csvSafe(doc.comments)],
    [],
    LINE_COLUMNS,
    ...doc.lines.map((l) => lineCells(l).map((v, i) => (i < 2 || i === 5 ? csvSafe(v) : v))),
    [],
    ...totalRows(doc),
  ];
  // UTF-8 byte order mark so Excel shows accents correctly; CRLF line endings.
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------- PDF attachment (same layout)
/** The built-in PDF fonts only cover Western European characters; anything else becomes "?". */
export function pdfSafe(value) {
  return String(value ?? '').replace(/[^\x20-\x7E\xA0-\xFF‘’“”–—…•€\n]/gu, '?');
}

export function renderPdf(doc, { compress = true } = {}) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'A4',
      margin: 36,
      compress,
      bufferPages: true,
      info: { Title: `Purchase Order ${doc.orderNo}`, Subject: 'Purchase Order' },
    });
    const chunks = [];
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const left = pdf.page.margins.left;
    const width = pdf.page.width - pdf.page.margins.left - pdf.page.margins.right;
    const bottom = () => pdf.page.height - pdf.page.margins.bottom - 20;
    const t = (s) => pdfSafe(s);
    const rule = () => {
      pdf.moveDown(0.4);
      pdf.moveTo(left, pdf.y).lineTo(left + width, pdf.y).lineWidth(0.75).strokeColor('#000').stroke();
      pdf.moveDown(0.6);
    };
    const keyValue = (k, v, { bold = false, labelWidth = 80, x = left, valueWidth = width - 80, align = 'left' } = {}) => {
      const y = pdf.y;
      pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).text(t(k), x, y, { width: labelWidth });
      const h1 = pdf.y - y;
      pdf.text(t(v), x + labelWidth, y, { width: valueWidth, align });
      pdf.y = y + Math.max(h1, pdf.y - y);
      pdf.x = left;
    };

    // Title and order details
    pdf.font('Helvetica-Bold').fontSize(16).text('Purchase Order', left, pdf.y);
    pdf.moveDown(0.6);
    for (const [k, v] of headerRows(doc)) keyValue(k, v);
    pdf.moveDown(0.4);
    rule();

    // Supplier | Ship To
    const half = width / 2;
    const [supplierName = '', ...supplierRest] = doc.supplierLines;
    let y = pdf.y;
    pdf.font('Helvetica').fontSize(10);
    pdf.text('Supplier:', left, y, { width: half - 12 });
    pdf.text('Ship To:', left + half, y, { width: half });
    y = pdf.y + 2;
    pdf.text(t([supplierName, ...supplierRest].join('\n')), left, y, { width: half - 12 });
    const leftEnd = pdf.y;
    pdf.text(t(doc.shipTo), left + half, y, { width: half });
    pdf.y = Math.max(leftEnd, pdf.y);
    pdf.x = left;
    pdf.moveDown(0.5);
    keyValue('Comments:', doc.comments);
    rule();

    // Lines
    const widths = [66, 142, 38, 38, 40, 36, 55, 52, 56];
    const scale = width / widths.reduce((a, b) => a + b, 0);
    const cols = widths.map((w) => w * scale);
    const numeric = (i) => i >= 2 && i !== 5;
    const drawRow = (cells, { bold = false } = {}) => {
      pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
      const heights = cells.map((c, i) => pdf.heightOfString(t(c), { width: cols[i] - 6 }));
      const h = Math.max(...heights) + 4;
      if (pdf.y + h > bottom()) {
        pdf.addPage();
        drawRow(LINE_COLUMNS, { bold: true }); // repeat the heading on each page
        pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
      }
      const rowY = pdf.y;
      let x = left;
      cells.forEach((c, i) => {
        pdf.text(t(c), x + 3, rowY + 2, { width: cols[i] - 6, align: numeric(i) ? 'right' : 'left', lineBreak: true });
        x += cols[i];
      });
      pdf.y = rowY + h;
      if (bold) pdf.moveTo(left, pdf.y).lineTo(left + width, pdf.y).lineWidth(0.5).stroke();
      pdf.x = left;
    };
    drawRow(LINE_COLUMNS, { bold: true });
    for (const l of doc.lines) drawRow(lineCells(l));
    if (pdf.y + 90 > bottom()) pdf.addPage();
    rule();

    // Totals
    const totalsX = left + width - 200;
    for (const [k, v] of totalRows(doc)) {
      keyValue(k, v, { bold: k === 'TOTAL', x: totalsX, labelWidth: 100, valueWidth: 100, align: 'right' });
    }
    rule();

    // Page numbers
    const range = pdf.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      pdf.switchToPage(i);
      pdf.font('Helvetica').fontSize(8).fillColor('#444');
      pdf.text(`Purchase Order ${t(doc.orderNo)}  ·  Page ${i + 1} of ${range.count}`, left, pdf.page.height - pdf.page.margins.bottom - 10, {
        width,
        align: 'right',
        lineBreak: false,
      });
      pdf.fillColor('#000');
    }
    pdf.end();
  });
}

/** Everything the supplier email needs: subject, both bodies, and the PDF + CSV attachments. */
export async function renderPurchaseOrderEmail({ doc, companyName }) {
  const pdf = await renderPdf(doc);
  return {
    subject: `Purchase Order ${doc.orderNo} - ${companyName} ${doc.venue}`.replace(/[\r\n]+/g, ' ').trim(),
    text: renderText(doc),
    html: renderHtml(doc),
    attachments: [
      { filename: `PurchaseOrder_${doc.orderNo}.pdf`, content: pdf, contentType: 'application/pdf' },
      { filename: `PurchaseOrder_${doc.orderNo}.csv`, content: Buffer.from(renderCsv(doc), 'utf8'), contentType: 'text/csv; charset=utf-8' },
    ],
  };
}
