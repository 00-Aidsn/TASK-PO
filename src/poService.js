import { formatMoney } from './emailTemplate.js';
import { HIDDEN_REASONS, getCatalogue, getProductStatuses, getStoreDetails, getUomNames } from './catalogue.js';
import { buildPoDocument, renderPurchaseOrderEmail } from './poDocument.js';

export const ORDER_STATUS = Object.freeze({
  AwaitingApproval: 0,
  Approved: 1,
  Incomplete: 7,
});

export const STATUS_LABELS = Object.freeze({
  0: 'Awaiting approval',
  1: 'Approved',
  2: 'Order packed',
  3: 'Order dispatched',
  4: 'Stock received',
  5: 'Declined',
  6: 'Deleted',
  7: 'Incomplete',
  8: 'Converted',
  9: 'Cancelled',
  10: 'Partially received',
  66: 'Template deleted',
  88: 'Template',
  99: 'Generated',
});

export class ValidationError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

/** Live TASK data no longer matches what the clerk reviewed; nothing has been created. */
export class CatalogueChangedError extends Error {
  constructor(changes) {
    super('Some details changed in TASK since you loaded this supplier. Nothing was sent. Check the order and review it again.');
    this.name = 'CatalogueChangedError';
    this.changes = changes;
  }
}

export class OrderError extends Error {
  constructor(message, { poId = null, rolledBack = false, cause } = {}) {
    super(message, { cause });
    this.name = 'OrderError';
    this.poId = poId;
    this.rolledBack = rolledBack;
  }
}

const LIMITS = { customerPo: 50, comments: 1000, deliveryInstructions: 300, notes: 200, lines: 300, qty: 100000 };

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function text(value, max, field, fields) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    fields[field] = 'Must be text';
    return '';
  }
  const trimmed = value.replace(/\r\n/g, '\n').trim();
  if (trimmed.length > max) fields[field] = `Keep this under ${max} characters`;
  return trimmed;
}

/** An expected cost sent by the browser (what the clerk reviewed). undefined = not supplied. */
function expectedCost(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

function quantity(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > LIMITS.qty) return NaN;
  return Math.round(n * 1000) / 1000;
}

/** Today's date (YYYY-MM-DD) in the given time zone. */
export function todayIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Validates the browser's order request. Prices are never taken from the browser. */
export function validateOrderInput(body, { today }) {
  const fields = {};
  if (!body || typeof body !== 'object') throw new ValidationError('The order is empty.');

  const supplierId = positiveInt(body.supplierId);
  if (!supplierId) fields.supplierId = 'Choose a supplier';
  const locationNo = positiveInt(body.locationNo);
  if (!locationNo) fields.locationNo = 'Choose a location';

  let deliveryDate = null;
  if (body.deliveryDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(body.deliveryDate));
    const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (!m || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== body.deliveryDate) {
      fields.deliveryDate = 'Enter a valid date';
    } else if (body.deliveryDate < today) {
      fields.deliveryDate = 'Delivery date cannot be in the past';
    } else {
      deliveryDate = body.deliveryDate;
    }
  }

  const customerPo = text(body.customerPo, LIMITS.customerPo, 'customerPo', fields);
  const comments = text(body.comments, LIMITS.comments, 'comments', fields);
  // Delivery instructions go into the PO comments; "Ship To" is the store's address from TASK.
  const deliveryInstructions = text(
    body.deliveryInstructions ?? body.shipToAddress,
    LIMITS.deliveryInstructions,
    'deliveryInstructions',
    fields,
  );

  const lines = [];
  if (!Array.isArray(body.lines)) {
    fields.lines = 'Add at least one product';
  } else if (body.lines.length > LIMITS.lines) {
    fields.lines = `An order can have at most ${LIMITS.lines} lines`;
  } else {
    const seen = new Set();
    body.lines.forEach((raw, i) => {
      const productSupplierId = positiveInt(raw?.productSupplierId);
      const cases = quantity(raw?.cases);
      const units = quantity(raw?.units);
      const caseCost = expectedCost(raw?.caseCost);
      const unitCost = expectedCost(raw?.unitCost);
      if (!productSupplierId) {
        fields[`lines.${i}`] = 'Unknown product';
        return;
      }
      if (Number.isNaN(cases) || Number.isNaN(units)) {
        fields[`lines.${i}`] = 'Quantities must be numbers of 0 or more';
        return;
      }
      if (Number.isNaN(caseCost) || Number.isNaN(unitCost)) {
        fields[`lines.${i}`] = 'Costs must be numbers';
        return;
      }
      if (cases === 0 && units === 0) return; // ignore empty lines
      if (seen.has(productSupplierId)) {
        fields[`lines.${i}`] = 'This product is on the order twice';
        return;
      }
      seen.add(productSupplierId);
      const notes = text(raw?.notes, LIMITS.notes, `lines.${i}.notes`, fields);
      lines.push({ productSupplierId, cases, units, notes, expected: { caseCost, unitCost } });
    });
    if (!lines.length && !fields.lines) fields.lines = 'Enter a quantity for at least one product';
  }

  let expectedSupplierEmail;
  if (body.expectedSupplierEmail !== undefined && body.expectedSupplierEmail !== null) {
    if (typeof body.expectedSupplierEmail !== 'string' || body.expectedSupplierEmail.length > 320) {
      fields.expectedSupplierEmail = 'Not valid';
    } else {
      expectedSupplierEmail = body.expectedSupplierEmail.trim();
    }
  }

  const idempotencyKey =
    typeof body.idempotencyKey === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.idempotencyKey) ? body.idempotencyKey : null;

  if (Object.keys(fields).length) {
    throw new ValidationError('Please fix the highlighted fields.', fields);
  }
  return { supplierId, locationNo, deliveryDate, customerPo, comments, deliveryInstructions, lines, expectedSupplierEmail, idempotencyKey };
}

const round2 = (n) => Math.round(n * 100) / 100;

function sameCost(expected, live) {
  if (expected === undefined) return true; // the caller did not say what it expected
  if (expected === null || live === null || live === undefined) return expected === null && (live === null || live === undefined);
  return Math.abs(expected - live) < 0.005;
}

/**
 * Compares what the clerk reviewed with live TASK data. Returns a list of changes
 * ({ type, productSupplierId?, message }); empty when everything still matches.
 */
export function findCatalogueChanges({ lines, catalogue, supplier, expectedSupplierEmail }) {
  const changes = [];
  if (expectedSupplierEmail !== undefined && expectedSupplierEmail.toLowerCase() !== supplier.email.toLowerCase()) {
    changes.push({
      type: 'supplier_email',
      message: supplier.email
        ? `${supplier.name}'s email address in TASK is now ${supplier.email}.`
        : `${supplier.name} no longer has an email address in TASK.`,
    });
  }
  for (const line of lines) {
    const entry = catalogue.all.get(line.productSupplierId);
    if (!entry) {
      changes.push({
        type: 'removed',
        productSupplierId: line.productSupplierId,
        message: `A product on the order (supplier product ${line.productSupplierId}) is no longer listed for ${supplier.name}.`,
      });
      continue;
    }
    if (entry.hiddenReason) {
      changes.push({
        type: 'unavailable',
        productSupplierId: line.productSupplierId,
        message: `${entry.name} is now ${HIDDEN_REASONS[entry.hiddenReason]}.`,
      });
      continue;
    }
    const { caseCost, unitCost } = line.expected || {};
    if (!sameCost(caseCost, entry.caseCost) || !sameCost(unitCost, entry.unitCost)) {
      const caseChanged = !sameCost(caseCost, entry.caseCost);
      changes.push({
        type: 'price',
        productSupplierId: line.productSupplierId,
        message: caseChanged
          ? `${entry.name}: case cost changed from ${formatMoney(caseCost)} to ${formatMoney(entry.caseCost)}.`
          : `${entry.name}: unit cost changed from ${formatMoney(unitCost)} to ${formatMoney(entry.unitCost)}.`,
      });
    }
  }
  return changes;
}

/** Attaches catalogue data (case size, costs) to each line. Throws if a product isn't in the catalogue. */
export function priceLines(lines, catalogue) {
  const fields = {};
  const priced = lines.map((line, i) => {
    const product = catalogue.byProductSupplierId.get(line.productSupplierId);
    if (!product) {
      fields[`lines.${i}`] = 'This product is no longer available from the supplier';
      return null;
    }
    const totalUnits = Math.round((line.cases * product.caseQty + line.units) * 1000) / 1000;
    const hasCost = typeof product.caseCost === 'number' && typeof product.unitCost === 'number';
    const lineExGst = hasCost ? round2(line.cases * product.caseCost + line.units * product.unitCost) : null;
    return { ...line, product, totalUnits, lineExGst };
  });
  if (Object.keys(fields).length) throw new ValidationError('Some products are no longer available. Refresh the product list.', fields);
  return priced;
}

export function buildPurchaseOrderModel({ input, clerk, nowIso }) {
  const model = {
    SupplierID: input.supplierId,
    StockLocationNo: input.locationNo,
    ClerkID: clerk.id,
    OrderStatus: ORDER_STATUS.Incomplete,
    Created: nowIso,
    LastChangedDate: nowIso,
    LastChangedClerkID: clerk.id,
    Emailed: false,
  };
  if (input.customerPo) model.CustomerPO = input.customerPo;
  const comments = [input.comments, input.deliveryInstructions ? `Delivery instructions: ${input.deliveryInstructions}` : '']
    .filter(Boolean)
    .join('\n');
  if (comments) model.Comments = comments;
  if (input.storeAddress) model.ShipToAddress = input.storeAddress; // the store's address from TASK
  if (input.deliveryDate) model.DeliveryDate = `${input.deliveryDate}T00:00:00.000Z`;
  return model;
}

export function buildItemModel(purchaseOrderId, line) {
  const { product } = line;
  const item = {
    PurchaseOrderID: purchaseOrderId,
    ProductID: product.productId,
    ProductSupplierID: product.productSupplierId,
    Cases: line.cases,
    Units: line.units,
    CaseQty: product.caseQty,
    TotalUnits: line.totalUnits,
  };
  // Costs are ex GST, taken from TASK supplier venue costs. ExGST = cost per case.
  if (typeof product.caseCost === 'number') item.ExGST = product.caseCost;
  if (typeof product.unitCost === 'number') item.UnitExGST = product.unitCost;
  if (line.notes) item.Notes = line.notes;
  return item;
}

/**
 * Creates the PO in TASK as Incomplete, adds its lines, then sets the final status.
 * If anything fails before the final status is set, the PO is deleted so no half-built PO is left.
 */
export async function createPurchaseOrder({ task, token, clerk, input, pricedLines, now = () => new Date() }) {
  const header = buildPurchaseOrderModel({ input, clerk, nowIso: now().toISOString() });
  const created = await task.createPurchaseOrder(token, header);
  const poId = Number(created?.PurchaseOrderID);
  if (!Number.isInteger(poId) || poId <= 0) {
    throw new OrderError('TASK did not return a purchase order number. Check TASK before trying again.');
  }

  const finalStatus = clerk.canApprove ? ORDER_STATUS.Approved : ORDER_STATUS.AwaitingApproval;
  try {
    for (const line of pricedLines) {
      await task.addPurchaseOrderItem(token, poId, buildItemModel(poId, line));
    }
    const current = (await task.getPurchaseOrder(token, poId)) || {};
    const finalModel = {
      ...header,
      ...current,
      PurchaseOrderID: poId,
      OrderStatus: finalStatus,
      LastChangedDate: now().toISOString(),
      LastChangedClerkID: clerk.id,
    };
    if (clerk.canApprove) finalModel.ApprovedByClerkID = clerk.id;
    await task.updatePurchaseOrder(token, poId, finalModel);
  } catch (err) {
    let rolledBack = false;
    try {
      await task.deletePurchaseOrder(token, poId);
      rolledBack = true;
    } catch {
      // fall through: report that PO #poId may be left incomplete
    }
    const reason = err?.message ? ` (${err.message})` : '';
    throw new OrderError(
      rolledBack
        ? `TASK could not save the purchase order${reason}. Nothing was sent. Please try again.`
        : `TASK could not finish purchase order #${poId}${reason}, and it could not be removed. Check PO #${poId} in TASK before trying again.`,
      { poId, rolledBack, cause: err },
    );
  }
  return { poId, status: finalStatus, statusLabel: STATUS_LABELS[finalStatus] };
}

/**
 * Emails an approved PO to the supplier in the Mad Mex purchase order format (see poDocument.js),
 * with the same purchase order attached as a PDF and a CSV, then marks it as emailed in TASK.
 * Everything on it is read back from TASK, so the email shows what TASK actually holds.
 * Returns { sent, to, cc, markedInTask, warning? }.
 */
export async function emailPurchaseOrder({
  task,
  session,
  mailer,
  config,
  poId,
  supplier,
  location,
  catalogue,
  accountNumbers,
  now = () => new Date(),
}) {
  const token = session.accessToken;
  const clerk = session.clerk;
  const [po, items, store, uomNames] = await Promise.all([
    task.getPurchaseOrder(token, poId),
    task.getPurchaseOrderItems(token, poId),
    getStoreDetails(task, session, location.locationNo),
    getUomNames(task, session),
  ]);
  if (!po) throw new OrderError(`TASK could not find purchase order #${poId}.`, { poId });
  if (!items.length) throw new OrderError(`Purchase order #${poId} has no lines in TASK, so it was not emailed.`, { poId });

  // Supplier codes, case sizes, names and units come live from TASK.
  catalogue ??= await getCatalogue(task, session, supplier.id, location, {
    ...config.catalogue,
    requireVenueCost: false,
    onlyProductSupplierIds: new Set(items.map((i) => Number(i.ProductSupplierID))),
  });
  const unknown = items.filter((i) => !catalogue.all.has(Number(i.ProductSupplierID))).map((i) => i.ProductID);
  const productNames = new Map();
  if (unknown.length) {
    const statuses = await getProductStatuses(task, session, unknown, location.locationNo, config.catalogue.productLookupConcurrency);
    for (const [id, p] of statuses) if (p.name) productNames.set(id, p.name);
  }

  const doc = buildPoDocument({
    po: { ...po, PurchaseOrderID: poId },
    items,
    supplier,
    venueName: store?.name || location.name,
    shipTo: po.ShipToAddress || store?.address || '',
    accountNo: accountNumbers?.get(supplier.id, location.locationNo) || '',
    catalogue,
    productNames,
    uomNames,
    timeZone: config.displayTimeZone,
  });
  const email = await renderPurchaseOrderEmail({ doc, companyName: config.companyName });

  const to = supplier.email;
  const cc = config.mail.cc;
  await mailer.send({
    to,
    cc: cc.length ? cc : undefined,
    replyTo: clerk.email || undefined,
    subject: email.subject,
    text: email.text,
    html: email.html,
    attachments: email.attachments,
  });

  // The email has gone; recording it in TASK is best-effort and must not trigger a resend.
  try {
    const latest = (await task.getPurchaseOrder(token, poId)) || po;
    await task.updatePurchaseOrder(token, poId, {
      ...latest,
      PurchaseOrderID: poId,
      Emailed: true,
      EmailedDate: now().toISOString(),
      LastChangedDate: now().toISOString(),
      LastChangedClerkID: clerk.id,
    });
    return { sent: true, to, cc, markedInTask: true };
  } catch (err) {
    return {
      sent: true,
      to,
      cc,
      markedInTask: false,
      warning: `The email was sent, but TASK could not record it (${err.message}). Do not resend.`,
    };
  }
}
