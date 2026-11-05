/**
 * Thin wrapper around the TASK API v3 (XchangeFusion).
 *
 * Every request carries the app's API key in the `Key` header. Calls made on behalf of a
 * signed-in clerk also carry `Authorization: Bearer <AccessToken>` from POST /auth/clerk/login.
 */

export class TaskApiError extends Error {
  constructor(message, { status, kind, details, cause } = {}) {
    super(message, { cause });
    this.name = 'TaskApiError';
    this.status = status;
    this.kind = kind;
    this.details = details;
  }
}

function kindFor(status) {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 440) return 'session_expired';
  if (status === 400 || status === 406 || status === 409 || status === 422) return 'rejected';
  if (status >= 500) return 'server';
  return 'other';
}

const DEFAULT_MESSAGES = {
  401: 'TASK did not accept the sign-in or session',
  403: 'TASK denied access to this action',
  404: 'TASK could not find the requested record',
  406: 'TASK rejected the request',
  440: 'TASK session expired',
};

function extractMessage(data) {
  if (!data) return '';
  if (typeof data === 'string') return data.slice(0, 300);
  for (const key of ['Message', 'message', 'ErrorMessage', 'error_description', 'ExceptionMessage', 'error', 'title']) {
    if (typeof data[key] === 'string' && data[key].trim()) return data[key].slice(0, 300);
  }
  if (Array.isArray(data.Errors) && data.Errors.length) return String(data.Errors[0]).slice(0, 300);
  return '';
}

export function createTaskClient({ baseUrl, apiKey, timeoutMs = 20000, pageSize = 100, firstPageNo = 1, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('TASK API key is required');

  async function request(method, path, { token, query, body } = {}) {
    const url = new URL(`/api/v3${path}`, baseUrl);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
      else url.searchParams.set(k, String(v));
    }
    const headers = { Key: apiKey, Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetchImpl(url, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new TaskApiError(timedOut ? 'TASK API did not respond in time' : 'Could not reach the TASK API', {
        status: 502,
        kind: 'network',
        cause: err,
      });
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const message = extractMessage(data) || DEFAULT_MESSAGES[res.status] || `TASK API returned HTTP ${res.status}`;
      throw new TaskApiError(message, { status: res.status, kind: kindFor(res.status), details: data });
    }
    return data;
  }

  /** Reads every page of a paginated TASK list ({ PageNo, PageSize, Items }). */
  async function getAllPages(path, { token, query, maxPages = 50 } = {}) {
    const all = [];
    let previousFirst = null;
    for (let i = 0; i < maxPages; i++) {
      const pageNo = firstPageNo + i;
      const page = await request('GET', path, {
        token,
        query: { ...query, 'pagingArgs.pageSize': pageSize, 'pagingArgs.pageNo': pageNo },
      });
      const items = Array.isArray(page?.Items) ? page.Items : Array.isArray(page) ? page : [];
      if (!items.length) break;
      // Guard against an endpoint that ignores paging and returns the same page forever.
      const first = JSON.stringify(items[0]);
      if (first === previousFirst) break;
      previousFirst = first;
      all.push(...items);
      if (items.length < pageSize || Array.isArray(page)) break;
    }
    return all;
  }

  return {
    request,
    getAllPages,

    // --- Auth -------------------------------------------------------------
    loginClerk: ({ login, password, loginType }) =>
      request('POST', '/auth/clerk/login', { body: { Login: login, Password: password, LoginType: loginType } }),
    currentClerk: (token) => request('GET', '/auth/clerk/currentUser', { token }),

    // --- Reference data ---------------------------------------------------
    getStockLocations: (token) => getAllPages('/stock/stocklocations', { token }),

    // --- Products ---------------------------------------------------------
    /** Product record (ProductBusinessModel): IsActive, ProductDescription, POSDisplay, ... */
    getProduct: (token, productId, locationNo) =>
      request('GET', `/products/${encodeURIComponent(productId)}`, { token, query: { locationNo } }),
    /** Stock on hand and min/max levels (StockModel[]) for a list of products at a location. */
    getStockValues: (token, locationNo, productIds) =>
      request('GET', `/products/location/${encodeURIComponent(locationNo)}/stock/products`, {
        token,
        query: { productIds },
      }),

    // --- Suppliers --------------------------------------------------------
    getSuppliers: (token) => getAllPages('/supplier', { token }),
    getSupplier: (token, supplierId) => request('GET', `/supplier/${encodeURIComponent(supplierId)}`, { token }),
    getSupplierProductCodes: (token, supplierId) =>
      getAllPages(`/supplier/${encodeURIComponent(supplierId)}/productCodes`, { token }),
    getSupplierVenueCosts: (token, supplierId, venueNo) =>
      getAllPages(`/supplier/${encodeURIComponent(supplierId)}/venueCosts`, { token, query: { venueNo } }),

    // --- Purchase order templates -----------------------------------------
    getPurchaseOrderTemplates: (token, { supplierId, stockLocationNo } = {}) =>
      getAllPages('/purchaseOrder/templates', { token, query: { supplierId, stockLocationNo } }),
    getPurchaseOrderTemplateItems: (token, templateId) =>
      getAllPages(`/purchaseOrder/templates/${encodeURIComponent(templateId)}/items`, { token }),

    // --- Purchase orders --------------------------------------------------
    createPurchaseOrder: (token, model) => request('POST', '/purchaseOrder', { token, body: model }),
    getPurchaseOrder: (token, id) => request('GET', `/purchaseOrder/${encodeURIComponent(id)}`, { token }),
    updatePurchaseOrder: (token, id, model) =>
      request('PUT', `/purchaseOrder/${encodeURIComponent(id)}`, { token, body: model }),
    deletePurchaseOrder: (token, id) => request('DELETE', `/purchaseOrder/${encodeURIComponent(id)}`, { token }),
    getPurchaseOrderItems: (token, id) => getAllPages(`/purchaseOrder/${encodeURIComponent(id)}/items`, { token }),
    addPurchaseOrderItem: (token, id, item) =>
      request('POST', `/purchaseOrder/${encodeURIComponent(id)}/items`, { token, body: item }),
  };
}
