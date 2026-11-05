import { Router } from 'express';
import { requireClerk, requirePermission } from '../session.js';
import { findLocation, getCatalogue, getSupplierLive, getSuppliers, publicItem } from '../catalogue.js';
import { STATUS_LABELS, ValidationError, todayIn } from '../poService.js';
import {
  RECEIVABLE_STATUSES,
  ReceiptError,
  describePoItem,
  planReceipt,
  receiveDelivery,
  validateReceiptInput,
} from '../receiving.js';

const IDEMPOTENCY_MS = 30 * 60_000;

function id(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const dateOnly = (value) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ''));
  return m && Number(m[1].slice(0, 4)) > 1900 ? m[1] : null;
};

export function receivingRoutes({ task, config }) {
  const router = Router();
  router.use(
    '/receiving',
    requireClerk,
    requirePermission('canReceive', 'Your TASK account is not allowed to receive stock (create supplier invoices).'),
  );

  // Purchase orders at a location that can still be received, read live from TASK.
  router.get('/receiving/orders', async (req, res) => {
    const locationNo = id(req.query.locationNo);
    if (!locationNo) return res.status(400).json({ error: 'Choose a location.' });
    if (!(await findLocation(task, req.session, locationNo))) {
      return res.status(403).json({ error: 'You do not have access to that location.' });
    }
    const token = req.session.accessToken;
    const [lists, suppliers] = await Promise.all([
      Promise.all(RECEIVABLE_STATUSES.map((orderStatus) => task.getPurchaseOrders(token, { stockLocationNo: locationNo, orderStatus }))),
      getSuppliers(task, req.session),
    ]);
    const names = new Map(suppliers.map((s) => [s.id, s.name]));
    const seen = new Set();
    const orders = lists
      .flat()
      .filter((po) => po && Number.isInteger(po.PurchaseOrderID) && !po.Deleted)
      .filter((po) => Number(po.StockLocationNo) === locationNo && RECEIVABLE_STATUSES.includes(po.OrderStatus))
      .filter((po) => (seen.has(po.PurchaseOrderID) ? false : seen.add(po.PurchaseOrderID)))
      .map((po) => ({
        poId: po.PurchaseOrderID,
        supplierId: po.SupplierID,
        supplierName: names.get(po.SupplierID) || `Supplier #${po.SupplierID}`,
        status: po.OrderStatus,
        statusLabel: STATUS_LABELS[po.OrderStatus] ?? String(po.OrderStatus),
        created: dateOnly(po.Created),
        deliveryDate: dateOnly(po.DeliveryDate),
        customerPo: po.CustomerPO || '',
      }))
      .sort((a, b) => (a.deliveryDate || '9999').localeCompare(b.deliveryDate || '9999') || a.poId - b.poId);
    res.json({ orders });
  });

  // One purchase order's lines for receiving: ordered, already received and outstanding.
  router.get('/receiving/orders/:poId', async (req, res) => {
    const poId = id(req.params.poId);
    if (!poId) return res.status(400).json({ error: 'Unknown purchase order.' });
    const token = req.session.accessToken;
    const po = await task.getPurchaseOrder(token, poId);
    if (!po) return res.status(404).json({ error: `Purchase order #${poId} was not found in TASK.` });
    const location = await findLocation(task, req.session, Number(po.StockLocationNo));
    if (!location) return res.status(403).json({ error: 'You do not have access to that location.' });
    if (!RECEIVABLE_STATUSES.includes(po.OrderStatus)) {
      return res.status(409).json({
        code: 'po_not_receivable',
        error: `Purchase order #${poId} is "${STATUS_LABELS[po.OrderStatus] ?? po.OrderStatus}", so it can't be received.`,
      });
    }
    const [items, supplier] = await Promise.all([
      task.getPurchaseOrderItems(token, poId),
      getSupplierLive(task, req.session, Number(po.SupplierID)),
    ]);
    const catalogue = await getCatalogue(task, req.session, Number(po.SupplierID), location, {
      ...config.catalogue,
      requireVenueCost: false,
      onlyProductSupplierIds: new Set(items.map((i) => Number(i.ProductSupplierID))),
    });
    res.json({
      po: {
        poId,
        supplierId: Number(po.SupplierID),
        supplierName: supplier?.name || `Supplier #${po.SupplierID}`,
        supplierActive: Boolean(supplier?.active),
        locationNo: location.locationNo,
        locationName: location.name,
        status: po.OrderStatus,
        statusLabel: STATUS_LABELS[po.OrderStatus],
        created: dateOnly(po.Created),
        deliveryDate: dateOnly(po.DeliveryDate),
        customerPo: po.CustomerPO || '',
      },
      lines: items.map((i) => describePoItem(i, catalogue.all.get(Number(i.ProductSupplierID)))),
    });
  });

  // Products this supplier can deliver here (for items not on the PO, or deliveries with no PO).
  router.get('/receiving/products', async (req, res) => {
    const supplierId = id(req.query.supplierId);
    const locationNo = id(req.query.locationNo);
    if (!supplierId || !locationNo) return res.status(400).json({ error: 'Choose a supplier and a location.' });
    const location = await findLocation(task, req.session, locationNo);
    if (!location) return res.status(403).json({ error: 'You do not have access to that location.' });
    const supplier = await getSupplierLive(task, req.session, supplierId);
    if (!supplier || !supplier.active) {
      return res.status(409).json({
        code: 'supplier_inactive',
        error: `${supplier?.name || 'This supplier'} is not active in TASK.`,
      });
    }
    const catalogue = await getCatalogue(task, req.session, supplierId, location, { ...config.catalogue, requireVenueCost: false });
    res.json({ supplier: { id: supplier.id, name: supplier.name }, products: catalogue.items.map(publicItem) });
  });

  // Receive a delivery: supplier invoice in TASK (+ PO received quantities and status).
  router.post('/receiving', async (req, res) => {
    const session = req.session;
    const token = session.accessToken;
    const input = validateReceiptInput(req.body, { today: todayIn(config.displayTimeZone) });

    session.receipts ??= new Map();
    for (const [k, v] of session.receipts) if (Date.now() - v.at > IDEMPOTENCY_MS) session.receipts.delete(k);
    if (input.idempotencyKey && session.receipts.has(input.idempotencyKey)) {
      const previous = session.receipts.get(input.idempotencyKey);
      if (previous.pending) return res.status(409).json({ error: 'This delivery is already being received. Please wait.' });
      return res.json(previous.result);
    }
    if (session.receiving) return res.status(409).json({ error: 'Another delivery is being received. Please wait.' });

    const location = await findLocation(task, session, input.locationNo);
    if (!location) throw new ValidationError('You do not have access to that location.', { locationNo: 'Not allowed' });

    let po = null;
    let poItems = [];
    if (input.purchaseOrderId) {
      po = await task.getPurchaseOrder(token, input.purchaseOrderId);
      if (!po) throw new ValidationError(`Purchase order #${input.purchaseOrderId} was not found in TASK.`);
      if (Number(po.StockLocationNo) !== input.locationNo) {
        throw new ValidationError('This purchase order is for a different location.', { purchaseOrderId: 'Wrong location' });
      }
      if (Number(po.SupplierID) !== input.supplierId) {
        throw new ValidationError('This purchase order is for a different supplier.', { supplierId: 'Wrong supplier' });
      }
      if (!RECEIVABLE_STATUSES.includes(po.OrderStatus)) {
        throw new ReceiptError(
          `Purchase order #${po.PurchaseOrderID} is now "${STATUS_LABELS[po.OrderStatus] ?? po.OrderStatus}" in TASK, so it can't be received. It may already have been received.`,
          { status: 409, code: 'po_not_receivable' },
        );
      }
      poItems = await task.getPurchaseOrderItems(token, po.PurchaseOrderID);
    }

    const supplier = await getSupplierLive(task, session, input.supplierId);
    if (!supplier) throw new ValidationError('That supplier was not found in TASK.', { supplierId: 'Not found' });
    if (!po && !supplier.active) {
      throw new ValidationError(`${supplier.name} is not active in TASK.`, { supplierId: 'Inactive supplier' });
    }

    // The same supplier invoice must not be entered twice.
    const existing = await task.getInvoices(token, { supplierId: input.supplierId, reference: input.invoiceNumber });
    const duplicate = existing.find(
      (inv) =>
        String(inv?.Reference || '').trim().toLowerCase() === input.invoiceNumber.toLowerCase() &&
        (inv.SupplierId == null || Number(inv.SupplierId) === input.supplierId),
    );
    if (duplicate) {
      throw new ReceiptError(
        `Invoice ${input.invoiceNumber} from ${supplier.name} is already in TASK (invoice #${duplicate.InvoiceId}). Check that this delivery hasn't already been received.`,
        { status: 409, code: 'duplicate_invoice' },
      );
    }

    const catalogue = await getCatalogue(task, session, input.supplierId, location, {
      ...config.catalogue,
      requireVenueCost: false,
      onlyProductSupplierIds: new Set([
        ...input.lines.map((l) => l.productSupplierId),
        ...poItems.map((i) => Number(i.ProductSupplierID)),
      ]),
    });
    const plan = planReceipt({ input, po, poItems, catalogue });

    session.receiving = true;
    if (input.idempotencyKey) session.receipts.set(input.idempotencyKey, { pending: true, at: Date.now() });
    try {
      const result = {
        ...(await receiveDelivery({ task, session, input, plan, po })),
        supplier: { id: supplier.id, name: supplier.name },
        location: { locationNo: location.locationNo, name: location.name },
      };
      if (input.idempotencyKey) session.receipts.set(input.idempotencyKey, { pending: false, at: Date.now(), result });
      res.status(201).json(result);
    } catch (err) {
      if (input.idempotencyKey) session.receipts.delete(input.idempotencyKey);
      throw err;
    } finally {
      session.receiving = false;
    }
  });

  return router;
}
