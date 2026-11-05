/**
 * Reference data read from TASK with the signed-in clerk's token.
 *
 * Supplier, supplier product code, supplier venue cost and product data are read LIVE from TASK
 * on every request (never cached), so clerks only see what is active in TASK right now.
 * Only the clerk's location list (their access scope) is cached briefly per session.
 */
import { TaskApiError } from './taskClient.js';

const LOCATION_CACHE_MS = 5 * 60_000;

/** Why a supplier product is not offered. Shown to clerks as "hidden: n <reason>". */
export const HIDDEN_REASONS = Object.freeze({
  unavailable: 'marked unavailable for this supplier',
  inactive: 'inactive in TASK',
  missing: 'not found in TASK',
  noCost: 'no supplier cost for this venue',
});

const byName = (a, b) => a.name.localeCompare(b.name, 'en-AU', { sensitivity: 'base' });

function toNumber(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function isRealDate(value) {
  if (!value) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime()) && d.getUTCFullYear() > 1900;
}

const isNotFound = (err) => err instanceof TaskApiError && err.kind === 'not_found';

/** Runs fn over items with at most `limit` in flight. Stops starting new work after a failure. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------- locations
export async function getLocations(task, session) {
  const hit = session.locationsCache;
  if (hit && Date.now() - hit.at < LOCATION_CACHE_MS) return hit.value;
  const rows = await task.getStockLocations(session.accessToken);
  const allowed = new Set((session.clerk.locations || []).map(Number));
  const seen = new Set();
  const value = rows
    .filter((r) => r && Number.isInteger(r.LocationNo))
    .filter((r) => allowed.size === 0 || allowed.has(r.LocationNo))
    .filter((r) => (seen.has(r.LocationNo) ? false : seen.add(r.LocationNo)))
    .map((r) => ({
      locationNo: r.LocationNo,
      venueNo: Number.isInteger(r.VenueNo) ? r.VenueNo : null,
      name: String(r.LocationFriendlyName || r.LocationDescription || `Location ${r.LocationNo}`).trim(),
    }))
    .sort(byName);
  session.locationsCache = { at: Date.now(), value };
  return value;
}

export async function findLocation(task, session, locationNo) {
  const locations = await getLocations(task, session);
  return locations.find((l) => l.locationNo === locationNo) || null;
}

// ---------------------------------------------------------------- suppliers (live)
function toSupplier(s, fallbackId) {
  return {
    id: s.SupplierID ?? fallbackId,
    name: String(s.SupplierName || `Supplier ${s.SupplierID ?? fallbackId}`).trim(),
    email: String(s.EmailAddress || '').trim(),
    active: !s.Deleted && s.IsActive !== false,
  };
}

/** Active suppliers, read live from GET /supplier. */
export async function getSuppliers(task, session) {
  const rows = await task.getSuppliers(session.accessToken);
  return rows
    .filter((s) => s && Number.isInteger(s.SupplierID))
    .map((s) => toSupplier(s))
    .filter((s) => s.active)
    .map(({ id, name, email }) => ({ id, name, email }))
    .sort(byName);
}

/** One supplier, read live from GET /supplier/{id}. Returns null if TASK no longer has it. */
export async function getSupplierLive(task, session, supplierId) {
  try {
    const s = await task.getSupplier(session.accessToken, supplierId);
    return s ? toSupplier(s, supplierId) : null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------- products (live)
function productName(p) {
  return String(p.ProductDescription || p.POSDisplay || p.OnlineName || p.Name || '').trim();
}

/**
 * Live status of each product from GET /products/{productId}?locationNo=.
 * Returns Map<productId, { status: 'active' | 'inactive' | 'missing', name }>.
 */
export async function getProductStatuses(task, session, productIds, locationNo, concurrency = 6) {
  const ids = [...new Set(productIds.map(Number))];
  const rows = await mapLimit(ids, concurrency, async (id) => {
    try {
      const p = await task.getProduct(session.accessToken, id, locationNo);
      if (!p) return [id, { status: 'missing', name: '' }];
      return [id, { status: p.IsActive === true ? 'active' : 'inactive', name: productName(p) }];
    } catch (err) {
      if (isNotFound(err)) return [id, { status: 'missing', name: '' }];
      throw err;
    }
  });
  return new Map(rows);
}

/**
 * Products the supplier can supply to this location, built live from:
 *   GET /supplier/{id}/productCodes            supplier code, case size, availability
 *   GET /supplier/{id}/venueCosts?venueNo=     case and unit cost (ex GST) for the venue
 *   GET /products/{productId}?locationNo=      product active status and name
 *
 * Returns {
 *   items:   orderable products (sorted by name),
 *   byProductSupplierId: Map of orderable products,
 *   all:     Map of every supplier product checked, each with `hiddenReason` (null when orderable),
 *   hidden:  counts by reason,
 *   checkedAt: ISO time the data was read
 * }
 */
export async function getCatalogue(task, session, supplierId, location, options = {}) {
  const { requireVenueCost = true, productLookupConcurrency = 6, onlyProductSupplierIds = null } = options;
  const token = session.accessToken;
  const [codes, costs] = await Promise.all([
    task.getSupplierProductCodes(token, supplierId),
    location.venueNo !== null ? task.getSupplierVenueCosts(token, supplierId, location.venueNo) : [],
  ]);

  const costByCode = new Map();
  const costByProduct = new Map();
  for (const c of costs) {
    if (c.VenueNo != null && c.VenueNo !== location.venueNo) continue;
    if (c.SupplierId != null && c.SupplierId !== supplierId) continue;
    if (c.SupplierProductCodeId != null) costByCode.set(Number(c.SupplierProductCodeId), c);
    if (c.ProductId != null && !costByProduct.has(Number(c.ProductId))) costByProduct.set(Number(c.ProductId), c);
  }

  let candidates = codes.filter(
    (c) =>
      c &&
      Number.isInteger(c.ProductSupplierID) &&
      c.ProductID != null &&
      (c.SupplierID == null || c.SupplierID === supplierId),
  );
  if (onlyProductSupplierIds) candidates = candidates.filter((c) => onlyProductSupplierIds.has(c.ProductSupplierID));

  const statuses = await getProductStatuses(
    task,
    session,
    candidates.map((c) => c.ProductID),
    location.locationNo,
    productLookupConcurrency,
  );

  const now = Date.now();
  const all = new Map();
  const items = [];
  const hidden = { unavailable: 0, inactive: 0, missing: 0, noCost: 0 };

  for (const c of candidates) {
    const productId = Number(c.ProductID);
    const product = statuses.get(productId) || { status: 'missing', name: '' };
    const cost = costByCode.get(c.ProductSupplierID) || costByProduct.get(productId);
    const caseQty = toNumber(c.CaseQty) > 0 ? toNumber(c.CaseQty) : 1;
    let caseCost = toNumber(cost?.CaseCost);
    let unitCost = toNumber(cost?.UnitCost);
    if (!(caseCost > 0) && unitCost > 0) caseCost = round(unitCost * caseQty, 4);
    if (!(unitCost > 0) && caseCost > 0) unitCost = round(caseCost / caseQty, 4);
    if (!(caseCost > 0)) caseCost = null;
    if (!(unitCost > 0)) unitCost = null;

    const outsideWindow =
      (isRealDate(c.AvailableStartDate) && new Date(c.AvailableStartDate).getTime() > now) ||
      (isRealDate(c.AvailableEndDate) && new Date(c.AvailableEndDate).getTime() < now);

    let hiddenReason = null;
    if (c.IsUnavailable || outsideWindow) hiddenReason = 'unavailable';
    else if (product.status === 'missing') hiddenReason = 'missing';
    else if (product.status === 'inactive') hiddenReason = 'inactive';
    else if (requireVenueCost && caseCost === null) hiddenReason = 'noCost';

    const entry = {
      productSupplierId: c.ProductSupplierID,
      productId,
      code: String(c.SupplierProductCode || '').trim(),
      name: product.name || `Product ${productId}`,
      caseQty,
      caseDescription: String(c.CaseDescription || '').trim(),
      caseCost,
      unitCost,
      hiddenReason,
    };
    all.set(entry.productSupplierId, entry);
    if (hiddenReason) hidden[hiddenReason] += 1;
    else items.push(entry);
  }

  items.sort(byName);
  return {
    items,
    byProductSupplierId: new Map(items.map((i) => [i.productSupplierId, i])),
    all,
    hidden,
    checkedAt: new Date().toISOString(),
  };
}

/** Strips internal fields before sending catalogue items to the browser. */
export function publicItem({ hiddenReason, ...item }) {
  return item;
}

export async function getTemplates(task, session, supplierId, locationNo) {
  const rows = await task.getPurchaseOrderTemplates(session.accessToken, { supplierId, stockLocationNo: locationNo });
  return rows
    .filter((t) => t && Number.isInteger(t.PurchaseOrderID) && !t.Deleted && t.OrderStatus !== 66)
    .filter((t) => t.SupplierID == null || t.SupplierID === supplierId)
    .map((t) => ({
      id: t.PurchaseOrderID,
      name: String(t.CustomerPO || t.Comments || `Template #${t.PurchaseOrderID}`).trim().slice(0, 80),
    }))
    .sort(byName);
}
