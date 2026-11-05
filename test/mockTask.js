/**
 * A small in-memory fake of the TASK API endpoints this app uses.
 * Used by the automated tests and by `npm run dev:mock` for local demos. Not for production.
 */
import crypto from 'node:crypto';
import express from 'express';

export const MOCK_API_KEY = 'mock-api-key';
export const MOCK_PASSWORD = 'demo-password';

export function sampleData() {
  return {
    accounts: [
      {
        login: 'manager@example.com',
        loginType: 0,
        clerk: {
          UserId: 101,
          AuthNiceName: 'Sam Manager',
          Email: 'manager@example.com',
          IsAuthenticated: true,
          Locations: [11, 12],
          Venues: [1, 2],
          CanCreatePurchaseOrders: true,
          CanApprovePurchaseOrders: true,
          CanCreateInvoices: true,
          CanCommitInvoices: true,
        },
      },
      {
        login: 'crew@example.com',
        loginType: 0,
        clerk: {
          UserId: 102,
          AuthNiceName: 'Alex Crew',
          Email: 'crew@example.com',
          IsAuthenticated: true,
          Locations: [11],
          Venues: [1],
          CanCreatePurchaseOrders: true,
          CanApprovePurchaseOrders: false,
          CanCreateInvoices: true,
          CanCommitInvoices: false,
        },
      },
      {
        login: 'viewer@example.com',
        loginType: 0,
        clerk: {
          UserId: 103,
          AuthNiceName: 'Viewer Only',
          Email: 'viewer@example.com',
          IsAuthenticated: true,
          Locations: [11],
          CanCreatePurchaseOrders: false,
          CanApprovePurchaseOrders: false,
          CanCreateInvoices: false,
          CanCommitInvoices: false,
        },
      },
      {
        login: 'receiver@example.com',
        loginType: 0,
        clerk: {
          UserId: 104,
          AuthNiceName: 'Riley Receiver',
          Email: 'receiver@example.com',
          IsAuthenticated: true,
          Locations: [11],
          CanCreatePurchaseOrders: false,
          CanApprovePurchaseOrders: false,
          CanCreateInvoices: true,
          CanCommitInvoices: true,
        },
      },
      {
        login: 'buyer@example.com',
        loginType: 0,
        clerk: {
          UserId: 105,
          AuthNiceName: 'Bailey Buyer',
          Email: 'buyer@example.com',
          IsAuthenticated: true,
          Locations: [11],
          CanCreatePurchaseOrders: true,
          CanApprovePurchaseOrders: true,
          CanCreateInvoices: false,
          CanCommitInvoices: false,
        },
      },
    ],
    stockLocations: [
      { LocationNo: 11, LocationFriendlyName: 'Demo Store - City', LocationDescription: 'CITY', VenueNo: 1 },
      { LocationNo: 12, LocationFriendlyName: 'Demo Store - Beach', LocationDescription: 'BEACH', VenueNo: 2 },
      { LocationNo: 13, LocationFriendlyName: 'Demo Store - West', LocationDescription: 'WEST', VenueNo: 3 },
    ],
    suppliers: [
      { SupplierID: 1, SupplierName: 'Demo Fresh Produce', EmailAddress: 'orders@produce.example', IsActive: true },
      { SupplierID: 2, SupplierName: 'Demo Packaging', EmailAddress: 'sales@packaging.example', IsActive: true },
      { SupplierID: 3, SupplierName: 'Demo Dairy', EmailAddress: '', IsActive: true },
      { SupplierID: 4, SupplierName: 'Inactive Supplier', EmailAddress: 'old@inactive.example', IsActive: false },
    ],
    // GET /products/{id} records (ProductBusinessModel). 1006 is inactive; 1007 does not exist.
    products: Object.fromEntries(
      [
        [1001, 'Avocados'],
        [1002, 'Limes'],
        [1003, 'Coriander'],
        [1004, 'Red onions'],
        [1005, 'Roma tomatoes'],
        [1006, 'Jalapenos (discontinued)', false],
        [2001, 'Burrito foil sheets'],
        [2002, 'Takeaway bowls 750ml'],
        [2003, 'Napkins <white>'],
        [3001, 'Sour cream 2kg'],
        [3002, 'Shredded cheese 2kg'],
      ].map(([id, name, active = true]) => [
        id,
        { ProductId: id, PLU: id, ProductDescription: name, POSDisplay: name.toUpperCase(), IsActive: active },
      ]),
    ),
    productCodes: {
      1: [
        { ProductSupplierID: 501, SupplierID: 1, ProductID: 1001, SupplierProductCode: 'AVO-20', CaseQty: 20, CaseDescription: 'Tray of 20' },
        { ProductSupplierID: 502, SupplierID: 1, ProductID: 1002, SupplierProductCode: 'LIME-5KG', CaseQty: 5, CaseDescription: '5 kg box' },
        { ProductSupplierID: 503, SupplierID: 1, ProductID: 1003, SupplierProductCode: 'COR-12', CaseQty: 12, CaseDescription: '12 bunches' },
        { ProductSupplierID: 504, SupplierID: 1, ProductID: 1004, SupplierProductCode: 'ONR-10KG', CaseQty: 10, CaseDescription: '10 kg sack' },
        { ProductSupplierID: 505, SupplierID: 1, ProductID: 1005, SupplierProductCode: 'TOM-10KG', CaseQty: 10, CaseDescription: '10 kg box', IsUnavailable: true },
        { ProductSupplierID: 506, SupplierID: 1, ProductID: 1006, SupplierProductCode: 'JAL-2KG', CaseQty: 1, CaseDescription: '2 kg tub' },
        { ProductSupplierID: 507, SupplierID: 1, ProductID: 1007, SupplierProductCode: 'OLD-01', CaseQty: 1, CaseDescription: '' },
      ],
      2: [
        { ProductSupplierID: 601, SupplierID: 2, ProductID: 2001, SupplierProductCode: 'FOIL-500', CaseQty: 500, CaseDescription: 'Carton of 500' },
        { ProductSupplierID: 602, SupplierID: 2, ProductID: 2002, SupplierProductCode: 'BWL-750', CaseQty: 300, CaseDescription: 'Carton of 300' },
        { ProductSupplierID: 603, SupplierID: 2, ProductID: 2003, SupplierProductCode: 'NAP-W', CaseQty: 2000, CaseDescription: '' },
      ],
      3: [
        { ProductSupplierID: 701, SupplierID: 3, ProductID: 3001, SupplierProductCode: 'SC-2KG', CaseQty: 6, CaseDescription: '6 x 2 kg' },
        { ProductSupplierID: 702, SupplierID: 3, ProductID: 3002, SupplierProductCode: 'CH-2KG', CaseQty: 6, CaseDescription: '6 x 2 kg' },
      ],
    },
    venueCosts: [
      { ID: 1, VenueNo: 1, SupplierId: 1, SupplierProductCodeId: 501, ProductId: 1001, CaseCost: 45, UnitCost: 2.25 },
      { ID: 2, VenueNo: 1, SupplierId: 1, SupplierProductCodeId: 502, ProductId: 1002, CaseCost: 18.5, UnitCost: 3.7 },
      { ID: 3, VenueNo: 1, SupplierId: 1, SupplierProductCodeId: 503, ProductId: 1003, CaseCost: 15.6, UnitCost: 0 },
      { ID: 4, VenueNo: 2, SupplierId: 1, SupplierProductCodeId: 501, ProductId: 1001, CaseCost: 47, UnitCost: 2.35 },
      { ID: 8, VenueNo: 1, SupplierId: 1, SupplierProductCodeId: 506, ProductId: 1006, CaseCost: 22, UnitCost: 22 },
      { ID: 9, VenueNo: 1, SupplierId: 1, SupplierProductCodeId: 507, ProductId: 1007, CaseCost: 5, UnitCost: 5 },
      { ID: 10, VenueNo: 1, SupplierId: 2, SupplierProductCodeId: 603, ProductId: 2003, CaseCost: 40, UnitCost: 0.02 },
      { ID: 5, VenueNo: 1, SupplierId: 2, SupplierProductCodeId: 601, ProductId: 2001, CaseCost: 32, UnitCost: 0.064 },
      { ID: 6, VenueNo: 1, SupplierId: 2, SupplierProductCodeId: 602, ProductId: 2002, CaseCost: 96, UnitCost: 0.32 },
      { ID: 7, VenueNo: 1, SupplierId: 3, SupplierProductCodeId: 701, ProductId: 3001, CaseCost: 54, UnitCost: 9 },
    ],
    // Stock on hand and min/max per location (StockModel). 1004 has no record; 2001 has no max.
    stock: [
      [11, 1001, 15, 40, 100],
      [11, 1002, 12, 10, 30],
      [11, 1003, 30, 12, 24],
      [11, 2001, 200, 500, 0],
      [11, 2002, 900, 300, 1200],
      [11, 2003, 1000, 2000, 6000],
      [11, 3001, 4, 6, 18],
      [12, 1001, 50, 40, 80],
    ].map(([LocationNo, ProductId, Stock, MinStockLevel, MaxStockLevel], i) => ({
      StockId: i + 1,
      ProductId,
      LocationNo,
      Stock,
      MinStockLevel,
      MaxStockLevel,
      SpecialStockQuantity: 0,
      SpecialStockOnHand: 0,
      OnlineOrderingStock: 0,
      AverageCost: 0,
      LastCost: 0,
    })),
    templates: [
      { PurchaseOrderID: 9001, SupplierID: 1, StockLocationNo: 11, CustomerPO: 'Weekly produce', OrderStatus: 88 },
      { PurchaseOrderID: 9002, SupplierID: 1, StockLocationNo: 11, CustomerPO: 'Old template', OrderStatus: 66 },
      { PurchaseOrderID: 9003, SupplierID: 2, StockLocationNo: 11, Comments: 'Packaging top-up', OrderStatus: 88 },
    ],
    templateItems: {
      9001: [
        { PurchaseItemID: 1, PurchaseOrderID: 9001, ProductSupplierID: 501, ProductID: 1001, Cases: 3, Units: 0 },
        { PurchaseItemID: 2, PurchaseOrderID: 9001, ProductSupplierID: 502, ProductID: 1002, Cases: 2, Units: 1 },
        { PurchaseItemID: 3, PurchaseOrderID: 9001, ProductSupplierID: 999, ProductID: 9999, Cases: 1, Units: 0 },
      ],
      9003: [{ PurchaseItemID: 4, PurchaseOrderID: 9003, ProductSupplierID: 602, ProductID: 2002, Cases: 1, Units: 0 }],
    },
    // Existing purchase orders, so there is something to receive.
    purchaseOrders: [
      { PurchaseOrderID: 4001, SupplierID: 1, StockLocationNo: 11, OrderStatus: 1, ClerkID: 101, CustomerPO: 'Weekly produce', Created: '2026-11-03T22:00:00.000Z', DeliveryDate: '2026-11-06T00:00:00.000Z', Emailed: true },
      { PurchaseOrderID: 4002, SupplierID: 2, StockLocationNo: 11, OrderStatus: 10, ClerkID: 101, CustomerPO: 'Packaging top-up', Created: '2026-11-01T22:00:00.000Z', DeliveryDate: '2026-11-04T00:00:00.000Z', Emailed: true },
      { PurchaseOrderID: 4003, SupplierID: 1, StockLocationNo: 12, OrderStatus: 1, ClerkID: 101, Created: '2026-11-03T22:00:00.000Z' },
      { PurchaseOrderID: 4004, SupplierID: 1, StockLocationNo: 11, OrderStatus: 0, ClerkID: 102, Created: '2026-11-04T22:00:00.000Z' },
      { PurchaseOrderID: 4005, SupplierID: 1, StockLocationNo: 11, OrderStatus: 4, ClerkID: 101, Created: '2026-10-28T22:00:00.000Z' },
    ],
    purchaseOrderItems: {
      4001: [
        { PurchaseItemID: 9101, PurchaseOrderID: 4001, ProductID: 1001, ProductSupplierID: 501, Cases: 4, Units: 0, CaseQty: 20, TotalUnits: 80, ExGST: 45, UnitExGST: 2.25, ReceivedCases: 0, ReceivedUnits: 0 },
        { PurchaseItemID: 9102, PurchaseOrderID: 4001, ProductID: 1002, ProductSupplierID: 502, Cases: 2, Units: 1, CaseQty: 5, TotalUnits: 11, ExGST: 18.5, UnitExGST: 3.7, ReceivedCases: 0, ReceivedUnits: 0 },
        { PurchaseItemID: 9103, PurchaseOrderID: 4001, ProductID: 1003, ProductSupplierID: 503, Cases: 1, Units: 0, CaseQty: 12, TotalUnits: 12, ExGST: 15.6, UnitExGST: 1.3, ReceivedCases: 0, ReceivedUnits: 0 },
      ],
      4002: [
        { PurchaseItemID: 9201, PurchaseOrderID: 4002, ProductID: 2002, ProductSupplierID: 602, Cases: 2, Units: 0, CaseQty: 300, TotalUnits: 600, ExGST: 96, UnitExGST: 0.32, ReceivedCases: 1, ReceivedUnits: 0 },
      ],
      4003: [
        { PurchaseItemID: 9301, PurchaseOrderID: 4003, ProductID: 1001, ProductSupplierID: 501, Cases: 2, Units: 0, CaseQty: 20, TotalUnits: 40, ExGST: 47, UnitExGST: 2.35, ReceivedCases: 0, ReceivedUnits: 0 },
      ],
      4004: [
        { PurchaseItemID: 9401, PurchaseOrderID: 4004, ProductID: 1001, ProductSupplierID: 501, Cases: 1, Units: 0, CaseQty: 20, TotalUnits: 20, ExGST: 45, UnitExGST: 2.25, ReceivedCases: 0, ReceivedUnits: 0 },
      ],
      4005: [
        { PurchaseItemID: 9501, PurchaseOrderID: 4005, ProductID: 1001, ProductSupplierID: 501, Cases: 1, Units: 0, CaseQty: 20, TotalUnits: 20, ExGST: 45, UnitExGST: 2.25, ReceivedCases: 1, ReceivedUnits: 0 },
      ],
    },
  };
}

const clone = (v) => JSON.parse(JSON.stringify(v));

export function createMockTask({ apiKey = MOCK_API_KEY, password = MOCK_PASSWORD, data = sampleData() } = {}) {
  const state = {
    data,
    tokens: new Map(),
    purchaseOrders: new Map(),
    purchaseOrderItems: new Map(),
    nextPoId: 5001,
    nextItemId: 1,
    invoices: new Map(),
    invoiceItems: new Map(),
    nextInvoiceId: 7001,
    nextInvoiceItemId: 1,
    requests: [],
    // failure injection for tests
    failItemForProductId: null,
    failPurchaseOrderPut: false,
    failDelete: false,
    failStock: null, // HTTP status to return from the stock endpoint, e.g. 500 or 440
    failInvoiceItemForProductId: null,
    failInvoiceComplete: false,
    failInvoiceDelete: false,
    failPoItemPut: false,
    expireTokens: false,
  };

  /** Restores the sample data, seeded POs and failure switches (tokens are kept). */
  state.reset = () => {
    state.data = sampleData();
    state.purchaseOrders = new Map(clone(state.data.purchaseOrders).map((po) => [po.PurchaseOrderID, po]));
    state.purchaseOrderItems = new Map(
      Object.entries(clone(state.data.purchaseOrderItems)).map(([id, items]) => [Number(id), items]),
    );
    state.invoices = new Map();
    state.invoiceItems = new Map();
    Object.assign(state, {
      failItemForProductId: null,
      failPurchaseOrderPut: false,
      failDelete: false,
      failStock: null,
      failInvoiceItemForProductId: null,
      failInvoiceComplete: false,
      failInvoiceDelete: false,
      failPoItemPut: false,
      expireTokens: false,
    });
  };
  state.reset();
  if (data !== state.data) state.data = data;

  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    state.requests.push({
      method: req.method,
      path: req.path,
      query: { ...req.query },
      body: req.body,
      key: req.get('Key'),
      authorization: req.get('Authorization'),
    });
    if (req.get('Key') !== apiKey) return res.status(401).json({ Message: 'Invalid API key' });
    next();
  });

  const base = '/api/v3';

  app.post(`${base}/auth/clerk/login`, (req, res) => {
    const { Login, Password, LoginType } = req.body || {};
    const account = state.data.accounts.find((a) => a.login === Login && a.loginType === LoginType);
    if (!account || Password !== password) return res.status(401).json({ Message: 'Invalid login or password' });
    const token = crypto.randomUUID();
    state.tokens.set(token, account);
    res.status(201).json({ AccessToken: token, RefreshToken: crypto.randomUUID() });
  });

  app.use(base, (req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
    const account = m && state.tokens.get(m[1]);
    if (!account) return res.status(401).json({ Message: 'Authorization has been denied for this request.' });
    if (state.expireTokens) return res.status(440).json({ Message: 'Session expired' });
    req.account = account;
    next();
  });

  function paged(req, res, items) {
    const size = Number(req.query['pagingArgs.pageSize']) || 25;
    const pageNo = Number(req.query['pagingArgs.pageNo']) || 1;
    const start = (pageNo - 1) * size;
    res.json({ PageNo: pageNo, PageSize: size, Items: items.slice(start, start + size) });
  }

  app.get(`${base}/auth/clerk/currentUser`, (req, res) => res.json(req.account.clerk));
  app.get(`${base}/stock/stocklocations`, (req, res) => paged(req, res, state.data.stockLocations));
  app.get(`${base}/products/location/:locationNo/stock/products`, (req, res) => {
    if (state.failStock) return res.status(state.failStock).json({ Message: 'Stock service unavailable' });
    const locationNo = Number(req.params.locationNo);
    const raw = req.query.productIds;
    const ids = new Set((Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(Number));
    res.json(state.data.stock.filter((s) => s.LocationNo === locationNo && ids.has(s.ProductId)));
  });
  app.get(`${base}/products/:id`, (req, res) => {
    const product = state.data.products[Number(req.params.id)];
    if (!product) return res.status(404).json({ Message: 'Product not found' });
    res.json(product);
  });

  app.get(`${base}/supplier`, (req, res) => paged(req, res, state.data.suppliers));
  app.get(`${base}/supplier/:id`, (req, res) => {
    const s = state.data.suppliers.find((x) => x.SupplierID === Number(req.params.id));
    if (!s) return res.status(404).json({ Message: 'Supplier not found' });
    res.json(s);
  });
  app.get(`${base}/supplier/:id/productCodes`, (req, res) =>
    paged(req, res, state.data.productCodes[Number(req.params.id)] || []),
  );
  app.get(`${base}/supplier/:id/venueCosts`, (req, res) => {
    const venueNo = req.query.venueNo ? Number(req.query.venueNo) : null;
    paged(
      req,
      res,
      state.data.venueCosts.filter((c) => c.SupplierId === Number(req.params.id) && (venueNo === null || c.VenueNo === venueNo)),
    );
  });

  // templates must be registered before /purchaseOrder/:id
  app.get(`${base}/purchaseOrder/templates`, (req, res) => {
    const supplierId = req.query.supplierId ? Number(req.query.supplierId) : null;
    const loc = req.query.stockLocationNo ? Number(req.query.stockLocationNo) : null;
    paged(
      req,
      res,
      state.data.templates.filter(
        (t) => (supplierId === null || t.SupplierID === supplierId) && (loc === null || t.StockLocationNo === loc),
      ),
    );
  });
  app.get(`${base}/purchaseOrder/templates/:id/items`, (req, res) =>
    paged(req, res, state.data.templateItems[Number(req.params.id)] || []),
  );

  app.get(`${base}/purchaseOrder`, (req, res) => {
    const f = (k) => (req.query[k] === undefined ? null : Number(req.query[k]));
    const [supplierId, loc, status] = [f('supplierId'), f('stockLocationNo'), f('orderStatus')];
    paged(
      req,
      res,
      [...state.purchaseOrders.values()].filter(
        (po) =>
          (supplierId === null || po.SupplierID === supplierId) &&
          (loc === null || po.StockLocationNo === loc) &&
          (status === null || po.OrderStatus === status),
      ),
    );
  });
  app.put(`${base}/purchaseOrder/:id/items/:itemId`, (req, res) => {
    const items = state.purchaseOrderItems.get(Number(req.params.id));
    const i = items ? items.findIndex((x) => x.PurchaseItemID === Number(req.params.itemId)) : -1;
    if (i < 0) return res.status(404).json({ Message: 'Purchase order item not found' });
    if (state.failPoItemPut) return res.status(500).json({ Message: 'Could not update item' });
    items[i] = { ...req.body, PurchaseItemID: items[i].PurchaseItemID, PurchaseOrderID: Number(req.params.id) };
    res.json(true);
  });

  // --- invoices: completing an invoice books its stock in (as TASK's "Invoice" stock movement)
  app.get(`${base}/invoice`, (req, res) => {
    const supplierId = req.query.supplierId ? Number(req.query.supplierId) : null;
    const loc = req.query.locationNo ? Number(req.query.locationNo) : null;
    const ref = req.query.reference ? String(req.query.reference).toLowerCase() : null;
    paged(
      req,
      res,
      [...state.invoices.values()].filter(
        (inv) =>
          (supplierId === null || inv.SupplierId === supplierId) &&
          (loc === null || inv.LocationNo === loc) &&
          (ref === null || String(inv.Reference || '').toLowerCase().includes(ref)),
      ),
    );
  });
  app.post(`${base}/invoice`, (req, res) => {
    const id = state.nextInvoiceId++;
    const inv = { ...req.body, InvoiceId: id, ClerkId: req.account.clerk.UserId, IsComplete: false, ProcessedDate: null };
    state.invoices.set(id, inv);
    state.invoiceItems.set(id, []);
    res.json(inv);
  });
  app.get(`${base}/invoice/:id`, (req, res) => {
    const inv = state.invoices.get(Number(req.params.id));
    if (!inv) return res.status(404).json({ Message: 'Invoice not found' });
    res.json(inv);
  });
  app.put(`${base}/invoice/:id`, (req, res) => {
    const id = Number(req.params.id);
    const inv = state.invoices.get(id);
    if (!inv) return res.status(404).json({ Message: 'Invoice not found' });
    if (state.failInvoiceComplete && req.body?.IsComplete) return res.status(500).json({ Message: 'Invoice could not be processed' });
    const completing = !inv.IsComplete && req.body?.IsComplete === true;
    const updated = { ...inv, ...req.body, InvoiceId: id };
    if (completing) {
      updated.ProcessedDate = new Date().toISOString();
      for (const item of state.invoiceItems.get(id) || []) {
        let rec = state.data.stock.find((s) => s.LocationNo === inv.LocationNo && s.ProductId === item.ProductId);
        if (!rec) {
          rec = { StockId: state.data.stock.length + 1, ProductId: item.ProductId, LocationNo: inv.LocationNo, Stock: 0, MinStockLevel: 0, MaxStockLevel: 0 };
          state.data.stock.push(rec);
        }
        rec.Stock = Math.round((rec.Stock + item.TotalUnits) * 1000) / 1000;
      }
    }
    state.invoices.set(id, updated);
    res.json(true);
  });
  app.delete(`${base}/invoice/:id`, (req, res) => {
    if (state.failInvoiceDelete) return res.status(500).json({ Message: 'Delete failed' });
    state.invoices.delete(Number(req.params.id));
    state.invoiceItems.delete(Number(req.params.id));
    res.json(true);
  });
  app.get(`${base}/invoice/:id/items`, (req, res) => paged(req, res, state.invoiceItems.get(Number(req.params.id)) || []));
  app.post(`${base}/invoice/:id/items`, (req, res) => {
    const id = Number(req.params.id);
    const items = state.invoiceItems.get(id);
    if (!items) return res.status(404).json({ Message: 'Invoice not found' });
    if (state.failInvoiceItemForProductId !== null && req.body?.ProductId === state.failInvoiceItemForProductId) {
      return res.status(500).json({ Message: 'Product not valid for invoice' });
    }
    const b = req.body || {};
    const caseQty = b.CaseQty > 0 ? b.CaseQty : 1;
    const item = {
      ...b,
      InvoiceItemId: state.nextInvoiceItemId++,
      InvoiceId: id,
      TotalUnits: (b.CaseCount || 0) * caseQty + (b.UnitCount || 0),
      TotalEx: Math.round(((b.CaseCount || 0) * (b.Cost || 0) + (b.UnitCount || 0) * (b.UnitCost || 0)) * 100) / 100,
    };
    items.push(item);
    res.json(item);
  });

  app.post(`${base}/purchaseOrder`, (req, res) => {
    const id = state.nextPoId++;
    const po = { Emailed: false, Deleted: false, ...req.body, PurchaseOrderID: id };
    state.purchaseOrders.set(id, po);
    state.purchaseOrderItems.set(id, []);
    res.json(po);
  });
  app.get(`${base}/purchaseOrder/:id`, (req, res) => {
    const po = state.purchaseOrders.get(Number(req.params.id));
    if (!po) return res.status(404).json({ Message: 'Purchase order not found' });
    res.json(po);
  });
  app.put(`${base}/purchaseOrder/:id`, (req, res) => {
    const id = Number(req.params.id);
    if (!state.purchaseOrders.has(id)) return res.status(404).json({ Message: 'Purchase order not found' });
    if (state.failPurchaseOrderPut) return res.status(500).json({ Message: 'Database timeout' });
    state.purchaseOrders.set(id, { ...req.body, PurchaseOrderID: id });
    res.json(true);
  });
  app.delete(`${base}/purchaseOrder/:id`, (req, res) => {
    const id = Number(req.params.id);
    if (state.failDelete) return res.status(500).json({ Message: 'Delete failed' });
    state.purchaseOrders.delete(id);
    state.purchaseOrderItems.delete(id);
    res.json(true);
  });
  app.get(`${base}/purchaseOrder/:id/items`, (req, res) =>
    paged(req, res, state.purchaseOrderItems.get(Number(req.params.id)) || []),
  );
  app.post(`${base}/purchaseOrder/:id/items`, (req, res) => {
    const id = Number(req.params.id);
    const items = state.purchaseOrderItems.get(id);
    if (!items) return res.status(404).json({ Message: 'Purchase order not found' });
    if (state.failItemForProductId !== null && req.body?.ProductID === state.failItemForProductId) {
      return res.status(500).json({ Message: 'Product is not valid for this supplier' });
    }
    const item = { ...req.body, PurchaseItemID: state.nextItemId++, PurchaseOrderID: id };
    items.push(item);
    res.json(item);
  });

  app.use((req, res) => res.status(404).json({ Message: 'Not found in mock' }));

  return { app, state };
}
