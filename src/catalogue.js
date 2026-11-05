/**
 * Reference data loaded from TASK with the signed-in clerk's token, cached briefly per session.
 */

const CACHE_MS = 5 * 60_000;

async function cached(session, key, loader) {
  session.cache ??= new Map();
  const hit = session.cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await loader();
  session.cache.set(key, { at: Date.now(), value });
  return value;
}

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

/** Converts a TASK lookup dictionary ({ "12": "Name" } or [{Key, Value}]) into a Map<number, string>. */
export function dictionaryToMap(dict) {
  const map = new Map();
  if (Array.isArray(dict)) {
    for (const row of dict) {
      const id = toNumber(row?.Key ?? row?.key ?? row?.Id ?? row?.id);
      const name = row?.Value ?? row?.value ?? row?.Name ?? row?.name;
      if (id !== null && name) map.set(id, String(name));
    }
  } else if (dict && typeof dict === 'object') {
    for (const [k, v] of Object.entries(dict)) {
      const id = toNumber(k);
      if (id !== null && v) map.set(id, String(v));
    }
  }
  return map;
}

export async function getLocations(task, session) {
  return cached(session, 'locations', async () => {
    const rows = await task.getStockLocations(session.accessToken);
    const allowed = new Set((session.clerk.locations || []).map(Number));
    const seen = new Set();
    return rows
      .filter((r) => r && Number.isInteger(r.LocationNo))
      .filter((r) => allowed.size === 0 || allowed.has(r.LocationNo))
      .filter((r) => (seen.has(r.LocationNo) ? false : seen.add(r.LocationNo)))
      .map((r) => ({
        locationNo: r.LocationNo,
        venueNo: Number.isInteger(r.VenueNo) ? r.VenueNo : null,
        name: String(r.LocationFriendlyName || r.LocationDescription || `Location ${r.LocationNo}`).trim(),
      }))
      .sort(byName);
  });
}

export async function findLocation(task, session, locationNo) {
  const locations = await getLocations(task, session);
  return locations.find((l) => l.locationNo === locationNo) || null;
}

export async function getSuppliers(task, session) {
  return cached(session, 'suppliers', async () => {
    const rows = await task.getSuppliers(session.accessToken);
    return rows
      .filter((s) => s && Number.isInteger(s.SupplierID) && s.IsActive !== false && !s.Deleted)
      .map((s) => ({
        id: s.SupplierID,
        name: String(s.SupplierName || `Supplier ${s.SupplierID}`).trim(),
        email: String(s.EmailAddress || '').trim(),
      }))
      .sort(byName);
  });
}

/** Supplier record straight from TASK (not cached), so the email address is current when sending. */
export async function getSupplierForSend(task, session, supplierId) {
  const s = await task.getSupplier(session.accessToken, supplierId);
  if (!s || s.Deleted || s.IsActive === false) return null;
  return {
    id: s.SupplierID ?? supplierId,
    name: String(s.SupplierName || `Supplier ${supplierId}`).trim(),
    email: String(s.EmailAddress || '').trim(),
  };
}

export async function getProductNames(task, session) {
  return cached(session, 'productNames', async () =>
    dictionaryToMap(await task.getProductNames(session.accessToken)),
  );
}

/**
 * Products this supplier can supply, with case sizes and the venue's costs (ex GST).
 * Returns { items: [...], byProductSupplierId: Map }.
 */
export async function getCatalogue(task, session, supplierId, location) {
  return cached(session, `catalogue:${supplierId}:${location.locationNo}`, async () => {
    const token = session.accessToken;
    const [codes, costs, names] = await Promise.all([
      task.getSupplierProductCodes(token, supplierId),
      location.venueNo !== null ? task.getSupplierVenueCosts(token, supplierId, location.venueNo) : [],
      getProductNames(task, session),
    ]);

    const costByCode = new Map();
    const costByProduct = new Map();
    for (const c of costs) {
      if (location.venueNo !== null && c.VenueNo !== undefined && c.VenueNo !== location.venueNo) continue;
      if (c.SupplierProductCodeId != null) costByCode.set(Number(c.SupplierProductCodeId), c);
      if (c.ProductId != null && !costByProduct.has(Number(c.ProductId))) costByProduct.set(Number(c.ProductId), c);
    }

    const now = Date.now();
    const items = codes
      .filter((c) => c && Number.isInteger(c.ProductSupplierID) && c.ProductID != null)
      .filter((c) => !c.IsUnavailable)
      .filter((c) => !isRealDate(c.AvailableStartDate) || new Date(c.AvailableStartDate).getTime() <= now)
      .filter((c) => !isRealDate(c.AvailableEndDate) || new Date(c.AvailableEndDate).getTime() >= now)
      .map((c) => {
        const productId = Number(c.ProductID);
        const cost = costByCode.get(c.ProductSupplierID) || costByProduct.get(productId);
        const caseQty = toNumber(c.CaseQty) > 0 ? toNumber(c.CaseQty) : 1;
        let caseCost = toNumber(cost?.CaseCost);
        let unitCost = toNumber(cost?.UnitCost);
        if (!caseCost && unitCost) caseCost = round(unitCost * caseQty, 4);
        if (!unitCost && caseCost) unitCost = round(caseCost / caseQty, 4);
        return {
          productSupplierId: c.ProductSupplierID,
          productId,
          code: String(c.SupplierProductCode || '').trim(),
          name: names.get(productId) || `Product ${productId}`,
          caseQty,
          caseDescription: String(c.CaseDescription || '').trim(),
          caseCost: caseCost ?? null,
          unitCost: unitCost ?? null,
        };
      })
      .sort(byName);

    return { items, byProductSupplierId: new Map(items.map((i) => [i.productSupplierId, i])) };
  });
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
