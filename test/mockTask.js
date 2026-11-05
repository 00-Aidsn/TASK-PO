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
  };
}

export function createMockTask({ apiKey = MOCK_API_KEY, password = MOCK_PASSWORD, data = sampleData() } = {}) {
  const state = {
    data,
    tokens: new Map(),
    purchaseOrders: new Map(),
    purchaseOrderItems: new Map(),
    nextPoId: 5001,
    nextItemId: 1,
    requests: [],
    // failure injection for tests
    failItemForProductId: null,
    failPurchaseOrderPut: false,
    failDelete: false,
    expireTokens: false,
  };

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
