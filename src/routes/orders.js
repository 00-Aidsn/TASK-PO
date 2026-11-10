import { Router } from 'express';
import { requireClerk, requirePermission } from '../session.js';
import { TaskApiError } from '../taskClient.js';
import { findLocation, getCatalogue, getStoreDetails, getStoreTimeZone, getSupplierLive } from '../catalogue.js';
import {
  CatalogueChangedError,
  ORDER_STATUS,
  STATUS_LABELS,
  ValidationError,
  createPurchaseOrder,
  emailPurchaseOrder,
  findCatalogueChanges,
  priceLines,
  todayIn,
  validateOrderInput,
} from '../poService.js';

const IDEMPOTENCY_MS = 30 * 60_000;

export function orderRoutes({ task, mailer, config, accountNumbers = null }) {
  const router = Router();
  router.use('/orders', requireClerk, requirePermission('canOrder', 'Your TASK account is not allowed to create purchase orders.'));

  const isSessionError = (err) => err instanceof TaskApiError && ['unauthorized', 'session_expired'].includes(err.kind);

  async function sendEmail(session, { poId, supplier, location, catalogue }, { rethrowSessionErrors = false } = {}) {
    if (!supplier.email) {
      return { sent: false, reason: 'no_supplier_email', message: `${supplier.name} has no email address in TASK.` };
    }
    try {
      return await emailPurchaseOrder({ task, session, mailer, config, poId, supplier, location, catalogue, accountNumbers });
    } catch (err) {
      if (rethrowSessionErrors && isSessionError(err)) throw err;
      console.error(`[orders] email for PO #${poId} failed: ${err.message}`);
      if (isSessionError(err)) {
        return {
          sent: false,
          reason: 'session_expired',
          message: 'Your TASK session ended before the email was sent. Sign in again, then use Retry email.',
        };
      }
      return { sent: false, reason: 'send_failed', message: `The email could not be sent: ${err.message}` };
    }
  }

  router.post('/orders', async (req, res) => {
    const session = req.session;
    // "Today" is the store's today (it matters for stores in other time zones late in the day).
    const requested = Number(req.body?.locationNo);
    const storeZone =
      Number.isInteger(requested) && requested > 0
        ? await getStoreTimeZone(task, session, requested, config.displayTimeZone)
        : config.displayTimeZone;
    const input = validateOrderInput(req.body, { today: todayIn(storeZone) });

    // A repeated click or network retry with the same key gets the first result back.
    session.orders ??= new Map();
    for (const [k, v] of session.orders) if (Date.now() - v.at > IDEMPOTENCY_MS) session.orders.delete(k);
    if (input.idempotencyKey && session.orders.has(input.idempotencyKey)) {
      const previous = session.orders.get(input.idempotencyKey);
      if (previous.pending) return res.status(409).json({ error: 'This order is already being sent. Please wait.' });
      return res.json(previous.result);
    }
    if (session.sending) return res.status(409).json({ error: 'Another order is being sent. Please wait.' });

    const location = await findLocation(task, session, input.locationNo);
    if (!location) throw new ValidationError('You do not have access to that location.', { locationNo: 'Not allowed' });

    // Re-read everything live from TASK and make sure it still matches what the clerk reviewed.
    const supplier = await getSupplierLive(task, session, input.supplierId);
    if (!supplier || !supplier.active) {
      throw new CatalogueChangedError([
        { type: 'supplier_inactive', message: `${supplier?.name || 'The supplier'} is no longer active in TASK.` },
      ]);
    }
    const catalogue = await getCatalogue(task, session, input.supplierId, location, {
      ...config.catalogue,
      onlyProductSupplierIds: new Set(input.lines.map((l) => l.productSupplierId)),
    });
    const changes = findCatalogueChanges({
      lines: input.lines,
      catalogue,
      supplier,
      expectedSupplierEmail: input.expectedSupplierEmail,
    });
    if (changes.length) throw new CatalogueChangedError(changes);
    const pricedLines = priceLines(input.lines, catalogue);
    // "Ship To" on the PO is the store's address in TASK (as when TASK creates a PO itself).
    input.storeAddress = (await getStoreDetails(task, session, location.locationNo))?.address || '';

    session.sending = true;
    if (input.idempotencyKey) session.orders.set(input.idempotencyKey, { pending: true, at: Date.now() });
    try {
      const created = await createPurchaseOrder({ task, token: session.accessToken, clerk: session.clerk, input, pricedLines });
      const email = session.clerk.canApprove
        ? await sendEmail(session, { poId: created.poId, supplier, location, catalogue })
        : { sent: false, reason: 'awaiting_approval', message: 'Saved in TASK as Awaiting approval. It has not been emailed.' };

      const result = {
        poId: created.poId,
        status: created.status,
        statusLabel: created.statusLabel,
        supplier: { id: supplier.id, name: supplier.name, email: supplier.email },
        location: { locationNo: location.locationNo, name: location.name },
        lineCount: pricedLines.length,
        totalExGst: Math.round(pricedLines.reduce((s, l) => s + (l.lineExGst || 0), 0) * 100) / 100,
        email,
      };
      if (input.idempotencyKey) session.orders.set(input.idempotencyKey, { pending: false, at: Date.now(), result });
      res.status(201).json(result);
    } catch (err) {
      if (input.idempotencyKey) session.orders.delete(input.idempotencyKey);
      throw err;
    } finally {
      session.sending = false;
    }
  });

  router.post('/orders/:poId/email', async (req, res) => {
    const session = req.session;
    const poId = Number(req.params.poId);
    if (!Number.isInteger(poId) || poId <= 0) return res.status(400).json({ error: 'Unknown purchase order.' });
    if (!session.clerk.canApprove) {
      return res.status(403).json({ error: 'Only clerks who can approve purchase orders can email them to suppliers.' });
    }

    const po = await task.getPurchaseOrder(session.accessToken, poId);
    if (!po) return res.status(404).json({ error: `Purchase order #${poId} was not found in TASK.` });
    if (po.OrderStatus !== ORDER_STATUS.Approved) {
      return res.status(409).json({
        error: `Purchase order #${poId} is "${STATUS_LABELS[po.OrderStatus] ?? po.OrderStatus}", so it can't be emailed from here.`,
      });
    }
    if (po.Emailed) {
      return res.status(409).json({ error: `Purchase order #${poId} has already been emailed to the supplier.` });
    }
    const location = await findLocation(task, session, Number(po.StockLocationNo));
    if (!location) return res.status(403).json({ error: 'You do not have access to that location.' });
    const supplier = await getSupplierLive(task, session, Number(po.SupplierID));
    if (!supplier || !supplier.active) return res.status(409).json({ error: 'That supplier is no longer active in TASK.' });

    // Email lines are built from live TASK data inside emailPurchaseOrder.
    const email = await sendEmail(session, { poId, supplier, location }, { rethrowSessionErrors: true });
    res.status(email.sent ? 200 : 502).json({ poId, email });
  });

  return router;
}
