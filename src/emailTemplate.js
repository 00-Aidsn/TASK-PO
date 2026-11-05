/**
 * Supplier purchase order email (HTML + plain text).
 * Wording is a first draft: have purchasing review it before it is used with real suppliers.
 */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const money = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
export const formatMoney = (n) => (typeof n === 'number' && Number.isFinite(n) ? money.format(n) : '—');

const qty = (n) => (typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : '0');

/** Formats a TASK date-only value (e.g. DeliveryDate) without time-zone shifting. */
export function formatDateOnly(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m || Number(m[1]) < 1900) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
}

export function formatDateTime(value, timeZone) {
  const d = new Date(value || '');
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1900) return '';
  return new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(d);
}

/**
 * @param {object} p
 * @param {string} p.companyName
 * @param {object} p.po        TASK PurchaseOrderModel
 * @param {{name:string,email:string}} p.supplier
 * @param {{name:string}} p.location
 * @param {{name:string,email?:string}} p.clerk
 * @param {Array<{code,name,pack,cases,units,caseCost,lineExGst,notes}>} p.lines
 * @param {boolean} p.showPrices
 * @param {string} p.timeZone
 */
export function renderPurchaseOrderEmail({ companyName, po, supplier, location, clerk, lines, showPrices, timeZone }) {
  const poNo = po.PurchaseOrderID;
  const orderDate = formatDateTime(po.Created, timeZone) || formatDateTime(new Date().toISOString(), timeZone);
  const delivery = formatDateOnly(po.DeliveryDate);
  const pricedLines = lines.filter((l) => typeof l.lineExGst === 'number');
  const subtotal = pricedLines.reduce((sum, l) => sum + l.lineExGst, 0);
  const unpriced = lines.length - pricedLines.length;

  const subject = `Purchase Order #${poNo} - ${companyName} ${location.name}`.replace(/[\r\n]+/g, ' ');

  const details = [
    ['PO number', `#${poNo}`],
    ['Order date', orderDate],
    ['From', `${companyName} - ${location.name}`],
    ['Deliver to', po.ShipToAddress ? `${location.name}, ${po.ShipToAddress}` : location.name],
    ['Requested delivery', delivery],
    ['Our reference', po.CustomerPO || ''],
    ['Ordered by', clerk.email ? `${clerk.name} (${clerk.email})` : clerk.name],
  ].filter(([, v]) => v);

  // ---- plain text --------------------------------------------------------
  const textLines = [
    `Purchase Order #${poNo}`,
    '',
    `To: ${supplier.name}`,
    ...details.map(([k, v]) => `${k}: ${v}`),
    '',
    'Items:',
    ...lines.map((l) => {
      const parts = [`- ${l.code ? `[${l.code}] ` : ''}${l.name}`];
      if (l.pack) parts.push(`(${l.pack})`);
      parts.push(`- Cases: ${qty(l.cases)}, Units: ${qty(l.units)}`);
      if (showPrices) parts.push(typeof l.lineExGst === 'number' ? `- ${formatMoney(l.lineExGst)} ex GST` : '- no cost on file');
      if (l.notes) parts.push(`- Note: ${l.notes}`);
      return parts.join(' ');
    }),
  ];
  if (showPrices) {
    textLines.push('', `Subtotal (ex GST): ${formatMoney(subtotal)}`);
    if (unpriced) textLines.push(`(${unpriced} line(s) have no cost on file and are not included.)`);
  }
  if (po.Comments) textLines.push('', 'Comments:', po.Comments);
  textLines.push('', 'Please reply to this email to confirm the order or to let us know about any substitutions or shortages.', '', `${companyName}`);
  const text = textLines.join('\n');

  // ---- HTML --------------------------------------------------------------
  const th = 'text-align:left;padding:6px 8px;border-bottom:2px solid #333;font-size:13px;';
  const td = 'padding:6px 8px;border-bottom:1px solid #ddd;font-size:13px;vertical-align:top;';
  const num = 'text-align:right;white-space:nowrap;';

  const rows = lines
    .map(
      (l) => `<tr>
  <td style="${td}">${escapeHtml(l.code)}</td>
  <td style="${td}">${escapeHtml(l.name)}${l.notes ? `<br><span style="color:#555;font-size:12px;">Note: ${escapeHtml(l.notes)}</span>` : ''}</td>
  <td style="${td}">${escapeHtml(l.pack)}</td>
  <td style="${td}${num}">${escapeHtml(qty(l.cases))}</td>
  <td style="${td}${num}">${escapeHtml(qty(l.units))}</td>${
        showPrices
          ? `
  <td style="${td}${num}">${escapeHtml(formatMoney(l.caseCost))}</td>
  <td style="${td}${num}">${escapeHtml(formatMoney(l.lineExGst))}</td>`
          : ''
      }
</tr>`,
    )
    .join('\n');

  const html = `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f6f6f6;font-family:Arial,Helvetica,sans-serif;color:#111;">
<div style="max-width:760px;margin:0 auto;background:#fff;padding:24px;border:1px solid #ddd;">
  <h1 style="font-size:20px;margin:0 0 4px;">Purchase Order #${escapeHtml(poNo)}</h1>
  <p style="margin:0 0 16px;color:#444;">To: <strong>${escapeHtml(supplier.name)}</strong></p>
  <table role="presentation" style="border-collapse:collapse;margin-bottom:20px;">
${details.map(([k, v]) => `    <tr><td style="padding:2px 16px 2px 0;color:#555;font-size:13px;">${escapeHtml(k)}</td><td style="padding:2px 0;font-size:13px;">${escapeHtml(v)}</td></tr>`).join('\n')}
  </table>
  <table style="border-collapse:collapse;width:100%;">
    <thead><tr>
      <th style="${th}">Code</th><th style="${th}">Product</th><th style="${th}">Pack</th>
      <th style="${th}${num}">Cases</th><th style="${th}${num}">Units</th>${showPrices ? `
      <th style="${th}${num}">Case cost (ex GST)</th><th style="${th}${num}">Line total (ex GST)</th>` : ''}
    </tr></thead>
    <tbody>
${rows}
    </tbody>${
      showPrices
        ? `
    <tfoot><tr>
      <td colspan="6" style="padding:8px;text-align:right;font-weight:bold;font-size:13px;">Subtotal (ex GST)</td>
      <td style="padding:8px;text-align:right;font-weight:bold;font-size:13px;white-space:nowrap;">${escapeHtml(formatMoney(subtotal))}</td>
    </tr></tfoot>`
        : ''
    }
  </table>${
    showPrices && unpriced
      ? `
  <p style="font-size:12px;color:#555;">${escapeHtml(unpriced)} line(s) have no cost on file and are not included in the subtotal.</p>`
      : ''
  }${
    po.Comments
      ? `
  <h2 style="font-size:15px;margin:20px 0 4px;">Comments</h2>
  <p style="margin:0;white-space:pre-wrap;font-size:13px;">${escapeHtml(po.Comments)}</p>`
      : ''
  }
  <p style="margin:24px 0 0;font-size:13px;">Please reply to this email to confirm the order or to let us know about any substitutions or shortages.</p>
  <p style="margin:8px 0 0;font-size:13px;">${escapeHtml(companyName)}</p>
</div>
</body></html>`;

  return { subject, text, html, subtotal, unpriced };
}
