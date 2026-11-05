/**
 * Stock receiving.
 *
 * TASK books delivered stock in through supplier invoices (stock movement type "Invoice"):
 *   1. POST /invoice                       supplier, location, invoice number and date, linked PO number
 *   2. POST /invoice/{id}/items            one item per received product (cases, units, costs ex GST)
 *   3. PUT  /invoice/{id} IsComplete=true  only for clerks with TASK's "commit invoices" permission;
 *                                          otherwise the invoice is left for a manager to complete in TASK
 *   4. PUT  /purchaseOrder/{id}/items/...  ReceivedCases / ReceivedUnits on each PO line
 *      PUT  /purchaseOrder/{id}            status Stock received (4) or Partially received (10)
 * If adding an invoice item fails, the invoice is deleted so nothing half-entered is left behind.
 */
import { formatMoney } from './emailTemplate.js';
import { STATUS_LABELS, ValidationError } from './poService.js';

export const PO_STATUS = Object.freeze({
  Approved: 1,
  OrderPacked: 2,
  OrderDispatched: 3,
  StockReceived: 4,
  PartiallyReceived: 10,
});

/** PO statuses that can still be received against. */
export const RECEIVABLE_STATUSES = Object.freeze([
  PO_STATUS.Approved,
  PO_STATUS.OrderPacked,
  PO_STATUS.OrderDispatched,
  PO_STATUS.PartiallyReceived,
]);

export const INVOICE_TYPE_NORMAL = 0;

export class ReceiptError extends Error {
  constructor(message, { status = 502, code, invoiceId = null, rolledBack = false, cause } = {}) {
    super(message, { cause });
    this.name = 'ReceiptError';
    this.status = status;
    this.code = code;
    this.invoiceId = invoiceId;
    this.rolledBack = rolledBack;
  }
}

const LIMITS = { invoiceNumber: 50, comments: 1000, notes: 200, lines: 300, qty: 100000, cost: 1000000 };
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;
const num = (v) => {
  const n = Number(v);
  return v === null || v === '' || !Number.isFinite(n) ? 0 : n;
};

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function text(value, max, field, fields, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fields[field] = 'Required';
    return '';
  }
  if (typeof value !== 'string') {
    fields[field] = 'Must be text';
    return '';
  }
  const trimmed = value.replace(/\r\n/g, '\n').trim();
  if (required && !trimmed) fields[field] = 'Required';
  if (trimmed.length > max) fields[field] = `Keep this under ${max} characters`;
  return trimmed;
}

function quantity(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > LIMITS.qty) return NaN;
  return Math.round(n * 1000) / 1000;
}

/** Total units for a cases + units pair. */
export const totalUnits = (cases, units, caseQty) => Math.round((num(cases) * (caseQty > 0 ? caseQty : 1) + num(units)) * 1000) / 1000;

/** Validates the browser's receipt. */
export function validateReceiptInput(body, { today }) {
  const fields = {};
  if (!body || typeof body !== 'object') throw new ValidationError('The receipt is empty.');

  const purchaseOrderId = body.purchaseOrderId == null ? null : positiveInt(body.purchaseOrderId);
  if (body.purchaseOrderId != null && !purchaseOrderId) fields.purchaseOrderId = 'Unknown purchase order';
  const supplierId = positiveInt(body.supplierId);
  if (!supplierId) fields.supplierId = 'Choose a supplier';
  const locationNo = positiveInt(body.locationNo);
  if (!locationNo) fields.locationNo = 'Choose a location';

  const invoiceNumber = text(body.invoiceNumber, LIMITS.invoiceNumber, 'invoiceNumber', fields, { required: true });
  if (fields.invoiceNumber === 'Required') fields.invoiceNumber = "Enter the supplier's invoice or docket number";

  let invoiceDate = null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(body.invoiceDate || ''));
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!m || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== body.invoiceDate) {
    fields.invoiceDate = 'Enter the invoice date';
  } else if (body.invoiceDate > today) {
    fields.invoiceDate = 'The invoice date cannot be in the future';
  } else {
    invoiceDate = body.invoiceDate;
  }

  const comments = text(body.comments, LIMITS.comments, 'comments', fields);
  const closeShort = body.closeShort === true;

  const lines = [];
  if (!Array.isArray(body.lines) || !body.lines.length) {
    fields.lines = 'Add at least one product';
  } else if (body.lines.length > LIMITS.lines) {
    fields.lines = `A receipt can have at most ${LIMITS.lines} lines`;
  } else {
    const seenItems = new Set();
    const seenProducts = new Set();
    body.lines.forEach((raw, i) => {
      const purchaseItemId = raw?.purchaseItemId == null ? null : positiveInt(raw.purchaseItemId);
      // PO lines are identified by their PO line; extra items by their supplier product.
      const productSupplierId = raw?.productSupplierId == null ? null : positiveInt(raw.productSupplierId);
      const cases = quantity(raw?.cases);
      const units = quantity(raw?.units);
      const caseCost = Number(raw?.caseCost);
      if (
        (!purchaseItemId && !productSupplierId) ||
        (raw?.purchaseItemId != null && !purchaseItemId) ||
        (raw?.productSupplierId != null && !productSupplierId)
      ) {
        fields[`lines.${i}`] = 'Unknown product';
        return;
      }
      if (Number.isNaN(cases) || Number.isNaN(units)) {
        fields[`lines.${i}`] = 'Quantities must be numbers of 0 or more';
        return;
      }
      if (raw?.caseCost === undefined || raw?.caseCost === null || raw?.caseCost === '' || !Number.isFinite(caseCost) || caseCost < 0 || caseCost > LIMITS.cost) {
        fields[`lines.${i}`] = 'Enter the case cost (ex GST) from the invoice';
        return;
      }
      if (!purchaseItemId && cases === 0 && units === 0) return; // empty extra line
      if (purchaseItemId) {
        if (seenItems.has(purchaseItemId)) {
          fields[`lines.${i}`] = 'This PO line is on the receipt twice';
          return;
        }
        seenItems.add(purchaseItemId);
      }
      if (productSupplierId && seenProducts.has(productSupplierId)) {
        fields[`lines.${i}`] = 'This product is on the receipt twice. Change the quantity on the existing line instead.';
        return;
      }
      if (productSupplierId) seenProducts.add(productSupplierId);
      const notes = text(raw?.notes, LIMITS.notes, `lines.${i}.notes`, fields);
      lines.push({ purchaseItemId, productSupplierId, cases, units, caseCost: round4(caseCost), notes });
    });
    if (!fields.lines && !lines.some((l) => l.cases > 0 || l.units > 0)) {
      fields.lines = 'Enter the quantity received for at least one product';
    }
  }

  const idempotencyKey =
    typeof body.idempotencyKey === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.idempotencyKey) ? body.idempotencyKey : null;

  if (Object.keys(fields).length) throw new ValidationError('Please fix the highlighted fields.', fields);
  return { purchaseOrderId, supplierId, locationNo, invoiceNumber, invoiceDate, comments, closeShort, lines, idempotencyKey };
}

/** Receiving view of a PO line: ordered, already received and still outstanding. */
export function describePoItem(item, product) {
  const caseQty = product?.caseQty ?? (num(item.CaseQty) > 0 ? num(item.CaseQty) : 1);
  const orderedCases = num(item.Cases);
  const orderedUnits = num(item.Units);
  const receivedCases = num(item.ReceivedCases);
  const receivedUnits = num(item.ReceivedUnits);
  const orderedTotal = num(item.TotalUnits) > 0 ? num(item.TotalUnits) : totalUnits(orderedCases, orderedUnits, caseQty);
  const receivedTotal = totalUnits(receivedCases, receivedUnits, caseQty);
  const outstandingTotal = Math.max(0, Math.round((orderedTotal - receivedTotal) * 1000) / 1000);
  const outstandingCases = Math.floor(outstandingTotal / caseQty + 1e-9);
  const outstandingUnits = Math.round((outstandingTotal - outstandingCases * caseQty) * 1000) / 1000;
  const poCaseCost = num(item.ExGST) > 0 ? num(item.ExGST) : product?.caseCost ?? null;
  return {
    purchaseItemId: item.PurchaseItemID,
    productSupplierId: Number(item.ProductSupplierID) || null,
    productId: Number(item.ProductID),
    code: product?.code || '',
    name: product?.name || `Product ${item.ProductID}`,
    pack: product?.caseDescription || (caseQty > 1 ? `${caseQty} per case` : ''),
    caseQty,
    orderedCases,
    orderedUnits,
    receivedCases,
    receivedUnits,
    orderedTotal,
    receivedTotal,
    outstandingTotal,
    outstandingCases,
    outstandingUnits,
    poCaseCost,
    notes: item.Notes || '',
  };
}

/**
 * Works out the invoice items, cost changes and PO updates for a receipt.
 * Throws ValidationError for lines that don't belong to the PO or products that can't be received.
 */
export function planReceipt({ input, po, poItems = [], catalogue }) {
  const fields = {};
  const itemsById = new Map(poItems.map((i) => [i.PurchaseItemID, i]));
  const poProductSupplierIds = new Set(poItems.map((i) => Number(i.ProductSupplierID)));
  const lines = [];

  input.lines.forEach((line, i) => {
    let product = catalogue.all.get(line.productSupplierId);
    let poItem = null;
    let referenceCaseCost;
    if (line.purchaseItemId) {
      if (!po) {
        fields[`lines.${i}`] = 'There is no purchase order on this receipt';
        return;
      }
      poItem = itemsById.get(line.purchaseItemId);
      const poPsid = Number(poItem?.ProductSupplierID) || null;
      if (!poItem || (line.productSupplierId && poPsid && poPsid !== line.productSupplierId)) {
        fields[`lines.${i}`] = `This line is not on purchase order #${po.PurchaseOrderID}`;
        return;
      }
      product ??= poPsid ? catalogue.all.get(poPsid) : undefined;
      referenceCaseCost = describePoItem(poItem, product).poCaseCost;
    } else {
      // A product that was not ordered: it must still be supplied by this supplier and active in TASK.
      if (po && poProductSupplierIds.has(line.productSupplierId)) {
        fields[`lines.${i}`] = 'This product is already on the PO. Change the quantity on that line instead.';
        return;
      }
      if (!product) {
        fields[`lines.${i}`] = 'This product is not listed for this supplier in TASK';
        return;
      }
      if (product.hiddenReason && product.hiddenReason !== 'noCost') {
        fields[`lines.${i}`] = `${product.name} cannot be received: it is ${
          { unavailable: 'marked unavailable for this supplier', inactive: 'inactive in TASK', missing: 'not found in TASK' }[
            product.hiddenReason
          ]
        }`;
        return;
      }
      referenceCaseCost = product.caseCost ?? null;
    }

    const caseQty = product?.caseQty ?? (num(poItem?.CaseQty) > 0 ? num(poItem.CaseQty) : 1);
    const unitCost = round4(line.caseCost / caseQty);
    const qtyUnits = totalUnits(line.cases, line.units, caseQty);
    const costChanged = referenceCaseCost !== null && referenceCaseCost !== undefined && Math.abs(referenceCaseCost - line.caseCost) >= 0.005;
    lines.push({
      ...line,
      poItem,
      productId: product?.productId ?? Number(poItem?.ProductID),
      code: product?.code || '',
      name: product?.name || `Product ${poItem?.ProductID}`,
      caseQty,
      unitCost,
      totalUnits: qtyUnits,
      lineExGst: round2(line.cases * line.caseCost + line.units * unitCost),
      referenceCaseCost: referenceCaseCost ?? null,
      costChanged,
      unordered: !line.purchaseItemId,
    });
  });
  if (Object.keys(fields).length) throw new ValidationError('Some lines cannot be received.', fields);

  // PO line updates and the PO's new status.
  let poUpdates = [];
  let newPoStatus = null;
  const shortages = [];
  if (po) {
    const byItem = new Map(lines.filter((l) => l.poItem).map((l) => [l.purchaseItemId, l]));
    let allComplete = true;
    for (const item of poItems) {
      const product = catalogue.all.get(Number(item.ProductSupplierID));
      const view = describePoItem(item, product);
      const line = byItem.get(item.PurchaseItemID);
      const nowReceived = line ? line.totalUnits : 0;
      if (view.receivedTotal + nowReceived + 1e-9 < view.orderedTotal) {
        allComplete = false;
        const short = Math.round((view.orderedTotal - view.receivedTotal - nowReceived) * 1000) / 1000;
        const shortCases = Math.floor(short / view.caseQty + 1e-9);
        shortages.push({
          name: view.name,
          short,
          shortCases,
          shortUnits: Math.round((short - shortCases * view.caseQty) * 1000) / 1000,
        });
      }
      if (line && (line.cases > 0 || line.units > 0)) {
        poUpdates.push({
          item,
          receivedCases: Math.round((view.receivedCases + line.cases) * 1000) / 1000,
          receivedUnits: Math.round((view.receivedUnits + line.units) * 1000) / 1000,
        });
      }
    }
    newPoStatus = allComplete || input.closeShort ? PO_STATUS.StockReceived : PO_STATUS.PartiallyReceived;
  } else {
    poUpdates = [];
  }

  const invoiceLines = lines.filter((l) => l.cases > 0 || l.units > 0);
  return {
    lines,
    invoiceLines,
    poUpdates,
    newPoStatus,
    shortages,
    totalExGst: round2(invoiceLines.reduce((s, l) => s + l.lineExGst, 0)),
    costChanges: invoiceLines
      .filter((l) => l.costChanged)
      .map((l) => ({
        productSupplierId: l.productSupplierId,
        name: l.name,
        from: l.referenceCaseCost,
        to: l.caseCost,
        message: `${l.name}: case cost ${formatMoney(l.referenceCaseCost)} on ${l.unordered ? 'file' : 'the PO'}, ${formatMoney(l.caseCost)} on the invoice.`,
      })),
  };
}

export function buildInvoiceModel({ input, nowIso }) {
  const model = {
    SupplierId: input.supplierId,
    LocationNo: input.locationNo,
    InvoiceDate: `${input.invoiceDate}T00:00:00.000Z`,
    Reference: input.invoiceNumber,
    InvoiceType: INVOICE_TYPE_NORMAL,
  };
  if (input.purchaseOrderId) model.PurchaseOrderNo = input.purchaseOrderId;
  const comments = [input.comments, `Received via TASK PO app ${nowIso.slice(0, 10)}`].filter(Boolean).join('\n');
  model.Comments = comments;
  return model;
}

export function buildInvoiceItemModel(invoiceId, line, { hasPo = false } = {}) {
  const notes = [line.notes];
  if (line.costChanged) notes.push(`Case cost changed from ${formatMoney(line.referenceCaseCost)} (${line.unordered ? 'supplier cost' : 'PO'})`);
  if (hasPo && line.unordered) notes.push('Not on PO');
  const item = {
    InvoiceId: invoiceId,
    ProductId: line.productId,
    CaseQty: line.caseQty,
    CaseCount: line.cases,
    UnitCount: line.units,
    Cost: line.caseCost, // per case, ex GST
    UnitCost: line.unitCost, // per unit, ex GST
  };
  if (line.code) item.SupplierProductCode = line.code;
  const joined = notes.filter(Boolean).join('; ');
  if (joined) item.Notes = joined.slice(0, 250);
  return item;
}

/** Reads back an invoice and saves it with IsComplete = true, which books the stock in. */
async function completeInvoice(task, token, invoiceId) {
  const inv = (await task.getInvoice(token, invoiceId)) || {};
  const model = {
    InvoiceId: invoiceId,
    SupplierId: inv.SupplierId,
    LocationNo: inv.LocationNo,
    Reference: inv.Reference,
    InvoiceType: inv.InvoiceType ?? INVOICE_TYPE_NORMAL,
    ImportType: inv.ImportType,
    PurchaseOrderNo: inv.PurchaseOrderNo,
    Comments: inv.Comments,
    ExternalInvoiceId: inv.ExternalInvoiceId,
    InvoiceDiscountEx: inv.InvoiceDiscountEx,
    InvoiceMiscTotalEx: inv.InvoiceMiscTotalEx,
    Freight: inv.Freight,
    FreightAveraged: inv.FreightAveraged,
    IsExported: inv.IsExported,
    IsComplete: true,
  };
  for (const k of Object.keys(model)) if (model[k] === undefined || model[k] === null) delete model[k];
  model.IsComplete = true;
  await task.updateInvoice(token, invoiceId, model);
}

/** Runs the receipt against TASK. Returns a summary for the clerk, including any warnings. */
export async function receiveDelivery({ task, session, input, plan, po, now = () => new Date() }) {
  const token = session.accessToken;
  const clerk = session.clerk;
  const warnings = [];

  const created = await task.createInvoice(token, buildInvoiceModel({ input, nowIso: now().toISOString() }));
  const invoiceId = Number(created?.InvoiceId);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
    throw new ReceiptError('TASK did not return an invoice number. Check TASK before trying again.');
  }

  try {
    for (const line of plan.invoiceLines) {
      await task.addInvoiceItem(token, invoiceId, buildInvoiceItemModel(invoiceId, line, { hasPo: Boolean(po) }));
    }
  } catch (err) {
    let rolledBack = false;
    try {
      await task.deleteInvoice(token, invoiceId);
      rolledBack = true;
    } catch {
      // reported below
    }
    const reason = err?.message ? ` (${err.message})` : '';
    throw new ReceiptError(
      rolledBack
        ? `TASK could not save the delivery${reason}. Nothing was received. Please try again.`
        : `TASK could not finish invoice #${invoiceId}${reason}, and it could not be removed. Check invoice #${invoiceId} in TASK before trying again.`,
      { invoiceId, rolledBack, cause: err },
    );
  }

  let completed = false;
  if (clerk.canCommitInvoices) {
    try {
      await completeInvoice(task, token, invoiceId);
      completed = true;
    } catch (err) {
      warnings.push(
        `The invoice was saved but TASK could not complete it (${err.message}), so the stock is not booked in yet. A manager can complete invoice #${invoiceId} in TASK.`,
      );
    }
  }

  let poStatus = null;
  if (po) {
    try {
      for (const u of plan.poUpdates) {
        await task.updatePurchaseOrderItem(token, po.PurchaseOrderID, u.item.PurchaseItemID, {
          ...u.item,
          ReceivedCases: u.receivedCases,
          ReceivedUnits: u.receivedUnits,
        });
      }
      const latest = (await task.getPurchaseOrder(token, po.PurchaseOrderID)) || po;
      await task.updatePurchaseOrder(token, po.PurchaseOrderID, {
        ...latest,
        PurchaseOrderID: po.PurchaseOrderID,
        OrderStatus: plan.newPoStatus,
        LastChangedDate: now().toISOString(),
        LastChangedClerkID: clerk.id,
      });
      poStatus = plan.newPoStatus;
    } catch (err) {
      warnings.push(
        `Invoice #${invoiceId} was saved, but purchase order #${po.PurchaseOrderID} could not be updated (${err.message}). Update the PO's received quantities in TASK.`,
      );
    }
  }

  return {
    invoiceId,
    invoiceNumber: input.invoiceNumber,
    completed,
    invoiceStatusLabel: completed ? 'Completed: stock booked in' : 'Saved: waiting for a manager to complete it in TASK',
    poId: po ? po.PurchaseOrderID : null,
    poStatus,
    poStatusLabel: poStatus === null ? null : STATUS_LABELS[poStatus],
    lineCount: plan.invoiceLines.length,
    totalExGst: plan.totalExGst,
    costChanges: plan.costChanges,
    shortages: po ? plan.shortages : [],
    unorderedCount: plan.invoiceLines.filter((l) => l.unordered).length,
    warnings,
  };
}
