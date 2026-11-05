/**
 * Each store's account number with each supplier (shown as "Account No" on purchase orders).
 * TASK doesn't hold these, so the administrator keeps them in the admin panel.
 * Saved to DATA_DIR/account-numbers.json; changes are recorded in the admin change history.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from './poService.js';

const key = (supplierId, locationNo) => `${supplierId}:${locationNo}`;

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

/** Minimal CSV reader (quotes, doubled quotes, commas and new lines inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const csvCell = (v) => {
  let text = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const CSV_HEADER = ['Supplier ID', 'Supplier', 'Store No', 'Store', 'Account No'];

/**
 * @param {object} o
 * @param {string|null} o.dataDir  null when the admin panel is off (then every account number is blank)
 * @param {(action:string, actor:object, details:object) => void} [o.audit]
 */
export function createAccountNumberStore({ dataDir = null, audit = () => {} } = {}) {
  const file = dataDir ? path.join(dataDir, 'account-numbers.json') : null;
  let entries = new Map();
  if (file && fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const e of raw.entries || []) entries.set(key(e.supplierId, e.locationNo), e);
  }

  function save() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const sorted = [...entries.values()].sort((a, b) => a.supplierId - b.supplierId || a.locationNo - b.locationNo);
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function requireEditable() {
    if (!file) throw new Error('Account numbers can only be managed when the admin panel is enabled.');
  }

  function validate({ supplierId, locationNo, accountNo }) {
    const fields = {};
    const s = positiveInt(supplierId);
    const l = positiveInt(locationNo);
    if (!s) fields.supplierId = 'Choose a supplier';
    if (!l) fields.locationNo = 'Choose a store';
    const a = cleanText(accountNo, 50);
    if (String(accountNo ?? '').trim().length > 50) fields.accountNo = 'Keep account numbers to 50 characters';
    if (Object.keys(fields).length) throw new ValidationError('Please fix the highlighted fields.', fields);
    return { supplierId: s, locationNo: l, accountNo: a };
  }

  /** Adds or changes one account number; a blank account number removes it. */
  function set(input, actor) {
    requireEditable();
    const { supplierId, locationNo, accountNo } = validate(input);
    const k = key(supplierId, locationNo);
    const before = entries.get(k);
    if (!accountNo) {
      if (!before) return { changed: false };
      entries.delete(k);
      save();
      audit('account_number_removed', actor, { supplierId, locationNo, supplierName: before.supplierName, locationName: before.locationName });
      return { changed: true, removed: true };
    }
    if (before && before.accountNo === accountNo) return { changed: false };
    const who = actor ? { name: actor.name || '', email: actor.email || '' } : null;
    entries.set(k, {
      supplierId,
      locationNo,
      accountNo,
      supplierName: cleanText(input.supplierName, 200) || before?.supplierName || '',
      locationName: cleanText(input.locationName, 200) || before?.locationName || '',
      updatedAt: new Date().toISOString(),
      updatedBy: who,
    });
    save();
    audit('account_number_set', actor, {
      supplierId,
      locationNo,
      supplierName: entries.get(k).supplierName,
      locationName: entries.get(k).locationName,
      accountNo: { from: before?.accountNo || '', to: accountNo },
    });
    return { changed: true };
  }

  /** CSV columns: Supplier ID, Supplier, Store No, Store, Account No (names are for reading only). */
  function exportCsv() {
    const rows = [CSV_HEADER, ...list().map((e) => [e.supplierId, e.supplierName, e.locationNo, e.locationName, e.accountNo])];
    return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
  }

  /**
   * Imports a CSV in the export format. Rows with a blank Account No remove that entry.
   * replace=true makes the CSV the whole list (entries not in it are removed).
   */
  function importCsv(text, { replace = false } = {}, actor) {
    requireEditable();
    const rows = parseCsv(text);
    if (!rows.length) throw new ValidationError('The CSV file is empty.');
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = (name) => header.indexOf(name.toLowerCase());
    const [cS, cSN, cL, cLN, cA] = ['Supplier ID', 'Supplier', 'Store No', 'Store', 'Account No'].map(col);
    if (cS < 0 || cL < 0 || cA < 0) {
      throw new ValidationError(`The CSV needs the columns: ${CSV_HEADER.join(', ')} (download the current list to see the format).`);
    }
    const errors = [];
    const next = new Map(replace ? [] : entries);
    const seen = new Set();
    rows.slice(1).forEach((r, i) => {
      const line = i + 2;
      const supplierId = positiveInt(r[cS]);
      const locationNo = positiveInt(r[cL]);
      const accountNo = cleanText(r[cA], 50).replace(/^'/, '');
      if (!supplierId || !locationNo) return errors.push(`Line ${line}: Supplier ID and Store No must be numbers.`);
      if (String(r[cA] ?? '').trim().length > 51) return errors.push(`Line ${line}: account number is longer than 50 characters.`);
      const k = key(supplierId, locationNo);
      if (seen.has(k)) return errors.push(`Line ${line}: supplier ${supplierId} and store ${locationNo} appear more than once.`);
      seen.add(k);
      if (!accountNo) {
        next.delete(k);
        return undefined;
      }
      const before = entries.get(k);
      next.set(k, {
        supplierId,
        locationNo,
        accountNo,
        supplierName: cleanText(cSN >= 0 ? r[cSN] : '', 200).replace(/^'/, '') || before?.supplierName || '',
        locationName: cleanText(cLN >= 0 ? r[cLN] : '', 200).replace(/^'/, '') || before?.locationName || '',
        updatedAt: before && before.accountNo === accountNo ? before.updatedAt : new Date().toISOString(),
        updatedBy: before && before.accountNo === accountNo ? before.updatedBy : actor ? { name: actor.name || '', email: actor.email || '' } : null,
      });
      return undefined;
    });
    if (errors.length) throw new ValidationError(`Nothing was imported. ${errors.slice(0, 10).join(' ')}`);
    const added = [...next.keys()].filter((k) => !entries.has(k)).length;
    const changed = [...next.keys()].filter((k) => entries.has(k) && entries.get(k).accountNo !== next.get(k).accountNo).length;
    const removed = [...entries.keys()].filter((k) => !next.has(k)).length;
    entries = next;
    save();
    audit('account_numbers_imported', actor, { added, changed, removed, replace });
    return { added, changed, removed, total: entries.size };
  }

  function list() {
    return [...entries.values()].sort(
      (a, b) =>
        (a.supplierName || '').localeCompare(b.supplierName || '') ||
        a.supplierId - b.supplierId ||
        (a.locationName || '').localeCompare(b.locationName || '') ||
        a.locationNo - b.locationNo,
    );
  }

  return {
    editable: Boolean(file),
    list,
    /** The account number for a supplier and store, or '' if none. */
    get: (supplierId, locationNo) => entries.get(key(Number(supplierId), Number(locationNo)))?.accountNo || '',
    set,
    exportCsv,
    importCsv,
  };
}
