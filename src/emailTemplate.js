/**
 * Small formatting helpers shared by the purchase order document (poDocument.js) and receiving.
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
