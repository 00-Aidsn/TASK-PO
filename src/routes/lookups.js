import { Router } from 'express';
import { requireClerk } from '../session.js';
import { findLocation, getCatalogue, getLocations, getSuppliers, getTemplates } from '../catalogue.js';

function id(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function lookupRoutes({ task }) {
  const router = Router();
  router.use(requireClerk);

  router.get('/locations', async (req, res) => {
    res.json({ locations: await getLocations(task, req.session) });
  });

  router.get('/suppliers', async (req, res) => {
    res.json({ suppliers: await getSuppliers(task, req.session) });
  });

  router.get('/suppliers/:supplierId/products', async (req, res) => {
    const supplierId = id(req.params.supplierId);
    const locationNo = id(req.query.locationNo);
    if (!supplierId || !locationNo) return res.status(400).json({ error: 'Choose a supplier and a location.' });
    const location = await findLocation(task, req.session, locationNo);
    if (!location) return res.status(403).json({ error: 'You do not have access to that location.' });
    const catalogue = await getCatalogue(task, req.session, supplierId, location);
    res.json({ products: catalogue.items, venueNo: location.venueNo });
  });

  router.get('/templates', async (req, res) => {
    const supplierId = id(req.query.supplierId);
    const locationNo = id(req.query.locationNo);
    if (!supplierId || !locationNo) return res.status(400).json({ error: 'Choose a supplier and a location.' });
    if (!(await findLocation(task, req.session, locationNo))) {
      return res.status(403).json({ error: 'You do not have access to that location.' });
    }
    res.json({ templates: await getTemplates(task, req.session, supplierId, locationNo) });
  });

  router.get('/templates/:templateId/items', async (req, res) => {
    const templateId = id(req.params.templateId);
    if (!templateId) return res.status(400).json({ error: 'Choose a template.' });
    const items = await task.getPurchaseOrderTemplateItems(req.session.accessToken, templateId);
    res.json({
      items: items.map((i) => ({
        productSupplierId: i.ProductSupplierID ?? null,
        productId: i.ProductID ?? null,
        cases: Number(i.Cases) || 0,
        units: Number(i.Units) || 0,
        notes: i.Notes || '',
      })),
    });
  });

  return router;
}
