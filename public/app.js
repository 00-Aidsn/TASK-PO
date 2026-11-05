'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const moneyFmt = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
  const fmtMoney = (n) => (typeof n === 'number' && Number.isFinite(n) ? moneyFmt.format(n) : '—');
  const fmtQty = (n) => String(Math.round((Number(n) || 0) * 1000) / 1000);

  const state = {
    config: null,
    clerk: null,
    draftOwner: null,
    locations: [],
    suppliers: [],
    locationNo: null,
    supplierId: null,
    products: [],
    productsReady: false,
    hidden: null,
    checkedAt: null,
    stockStatus: null,
    qty: new Map(), // productSupplierId -> { cases, units }
    templates: [],
    loadSeq: 0,
    idempotencyKey: null,
    lastResult: null,
    sending: false,
  };

  // ---------------------------------------------------------------- helpers
  class ApiError extends Error {
    constructor(message, status, data) {
      super(message);
      this.status = status;
      this.data = data;
    }
  }

  async function api(method, path, body) {
    const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(`/api${path}`, opts);
    } catch {
      throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
    }
    let data = null;
    if (res.status !== 204) {
      try {
        data = await res.json();
      } catch {
        data = null;
      }
    }
    if (res.status === 401 && path !== '/login') {
      const expired = data && data.code === 'session_expired';
      onSignedOut(expired ? 'Your TASK session has ended. Sign in again to carry on. Your order has been kept.' : '');
      throw new ApiError((data && data.error) || 'Please sign in.', 401, data);
    }
    if (!res.ok) throw new ApiError((data && data.error) || `Request failed (${res.status}).`, res.status, data);
    return data;
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'className') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function show(node, visible) {
    node.hidden = !visible;
  }

  function setMessage(node, message) {
    node.textContent = message || '';
    show(node, Boolean(message));
  }

  function randomKey() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function todayLocal() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function formatDate(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    if (!m) return '';
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-AU', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  const HIDDEN_LABELS = {
    inactive: 'inactive in TASK',
    missing: 'not found in TASK',
    unavailable: 'marked unavailable for this supplier',
    noCost: 'with no supplier cost for this venue',
  };

  function formatTime(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }

  /** Shows a warning above the builder with an optional list of details. */
  function showBuilderNotice(title, items = []) {
    const node = $('builder-notice');
    if (!title) {
      node.replaceChildren();
      show(node, false);
      return;
    }
    node.replaceChildren(el('strong', { text: title }), items.length ? el('ul', {}, items.map((t) => el('li', { text: t }))) : null);
    show(node, true);
    node.scrollIntoView({ block: 'nearest' });
  }

  function fillSelect(select, options, placeholder) {
    select.replaceChildren(
      el('option', { value: '', text: placeholder }),
      ...options.map((o) => el('option', { value: String(o.value), text: o.label })),
    );
  }

  // ---------------------------------------------------------------- views
  function showView(name) {
    show($('signin-view'), name === 'signin');
    show($('builder-view'), name === 'builder');
    show($('result-view'), name === 'result');
    show($('order-bar'), name === 'builder');
    if (name === 'signin') setTimeout(() => ($('login').value ? $('password') : $('login')).focus(), 0);
  }

  function onSignedOut(message) {
    state.clerk = null;
    show($('who'), false);
    const dialog = $('review-dialog');
    if (dialog.open) dialog.close();
    setMessage($('signin-notice'), message);
    setMessage($('signin-error'), '');
    $('password').value = '';
    showView('signin');
  }

  function resetDraft() {
    state.locationNo = null;
    state.supplierId = null;
    state.locations = [];
    state.suppliers = [];
    state.products = [];
    state.productsReady = false;
    state.hidden = null;
    state.checkedAt = null;
    state.stockStatus = null;
    state.templates = [];
    state.qty.clear();
    state.lastResult = null;
    showBuilderNotice('');
    for (const id of ['delivery-date', 'customer-po', 'ship-to', 'comments', 'product-search']) $(id).value = '';
    $('only-ordered').checked = false;
    $('below-min').checked = false;
  }

  async function onSignedIn(clerk) {
    state.clerk = clerk;
    $('who-name').textContent = clerk.name;
    show($('who'), true);
    setMessage($('signin-notice'), '');
    const sameClerk = state.draftOwner === clerk.id && state.locations.length > 0;
    if (!sameClerk) {
      resetDraft();
      state.draftOwner = clerk.id;
    }
    if (state.lastResult && sameClerk) {
      showView('result');
      return;
    }
    showView('builder');
    if (!sameClerk) await loadReferenceData();
  }

  // ---------------------------------------------------------------- sign in
  async function init() {
    $('delivery-date').min = todayLocal();
    try {
      state.config = await api('GET', '/config');
    } catch (err) {
      setMessage($('signin-error'), err.message);
      showView('signin');
      return;
    }
    const { config } = state;
    $('company-name').textContent = config.companyName;
    document.title = `Purchase Orders - ${config.companyName}`;
    fillSelect(
      $('login-type'),
      config.loginTypes.map((t) => ({ value: t.value, label: t.label })),
      'Choose…',
    );
    $('login-type').value = String(config.defaultLoginType);
    $('session-hint').textContent =
      `You stay signed in until you sign out, close the browser, or are inactive for ${config.sessionIdleMinutes} minutes.`;

    try {
      const me = await api('GET', '/me');
      await onSignedIn(me.clerk);
    } catch {
      showView('signin');
    }
  }

  $('signin-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const login = $('login').value.trim();
    const password = $('password').value;
    if (!login || !password) {
      setMessage($('signin-error'), 'Enter your login and password.');
      return;
    }
    const button = $('signin-submit');
    button.disabled = true;
    button.textContent = 'Signing in…';
    setMessage($('signin-error'), '');
    try {
      const { clerk } = await api('POST', '/login', { login, password, loginType: Number($('login-type').value) });
      $('password').value = '';
      await onSignedIn(clerk);
    } catch (err) {
      setMessage($('signin-error'), err.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });

  $('sign-out').addEventListener('click', async () => {
    try {
      await api('POST', '/logout', {});
    } catch {
      // signed out locally regardless
    }
    resetDraft();
    state.draftOwner = null;
    onSignedOut('You have signed out.');
  });

  // ---------------------------------------------------------------- reference data
  async function loadReferenceData() {
    setMessage($('builder-error'), '');
    fillSelect($('location'), [], 'Loading…');
    fillSelect($('supplier'), [], 'Loading…');
    try {
      const [{ locations }, { suppliers }] = await Promise.all([api('GET', '/locations'), api('GET', '/suppliers')]);
      state.locations = locations;
      state.suppliers = suppliers;
    } catch (err) {
      if (err.status !== 401) setMessage($('builder-error'), err.message);
      return;
    }
    fillSelect(
      $('location'),
      state.locations.map((l) => ({ value: l.locationNo, label: l.name })),
      state.locations.length ? 'Choose a location…' : 'No locations available',
    );
    fillSelect(
      $('supplier'),
      state.suppliers.map((s) => ({ value: s.id, label: s.name })),
      state.suppliers.length ? 'Choose a supplier…' : 'No suppliers available',
    );
    if (state.locations.length === 1) {
      state.locationNo = state.locations[0].locationNo;
      $('location').value = String(state.locationNo);
    }
    renderSupplierEmail();
    renderBuilder();
  }

  function currentSupplier() {
    return state.suppliers.find((s) => s.id === state.supplierId) || null;
  }

  function currentLocation() {
    return state.locations.find((l) => l.locationNo === state.locationNo) || null;
  }

  function hasQuantities() {
    for (const q of state.qty.values()) if (q.cases > 0 || q.units > 0) return true;
    return false;
  }

  function onSelectionChange(select, key) {
    const next = select.value ? Number(select.value) : null;
    if (next === state[key]) return;
    if (hasQuantities() && !window.confirm('Changing this clears the quantities you have entered. Continue?')) {
      select.value = state[key] ? String(state[key]) : '';
      return;
    }
    state[key] = next;
    state.qty.clear();
    showBuilderNotice('');
    renderSupplierEmail();
    loadProducts();
  }

  $('location').addEventListener('change', (e) => onSelectionChange(e.target, 'locationNo'));
  $('supplier').addEventListener('change', (e) => onSelectionChange(e.target, 'supplierId'));

  function renderSupplierEmail() {
    const supplier = currentSupplier();
    const node = $('supplier-email');
    if (!supplier) return show(node, false);
    node.replaceChildren();
    if (state.clerk && !state.clerk.canApprove) {
      node.className = 'supplier-email';
      node.append('Your TASK account cannot approve purchase orders, so this PO will be saved in TASK for approval and not emailed.');
    } else if (supplier.email) {
      node.className = 'supplier-email';
      node.append('PO will be emailed to ', el('strong', { text: supplier.email }));
    } else {
      node.className = 'supplier-email warn';
      node.append('This supplier has no email address in TASK, so the PO cannot be emailed from here.');
    }
    show(node, true);
  }

  /**
   * Loads the supplier's products for the location, live from TASK.
   * With keepQuantities, quantities are kept for products that are still orderable;
   * returns the names of ordered products that were dropped.
   */
  async function loadProducts({ keepQuantities = false } = {}) {
    const seq = ++state.loadSeq;
    const previous = new Map(state.products.map((p) => [p.productSupplierId, p]));
    const keptQty = keepQuantities ? new Map(state.qty) : new Map();
    state.products = [];
    state.productsReady = false;
    state.hidden = null;
    state.checkedAt = null;
    state.stockStatus = null;
    state.templates = [];
    setMessage($('builder-error'), '');
    renderBuilder();
    if (!state.locationNo || !state.supplierId) return [];

    $('products-status').textContent = 'Checking products live with TASK…';
    $('refresh-products').disabled = true;
    const query = `supplierId=${state.supplierId}&locationNo=${state.locationNo}`;
    const productsReq = api('GET', `/suppliers/${state.supplierId}/products?locationNo=${state.locationNo}`);
    const templatesReq = api('GET', `/templates?${query}`).catch(() => ({ templates: [] }));
    const removed = [];
    try {
      const [live, { templates }] = await Promise.all([productsReq, templatesReq]);
      if (seq !== state.loadSeq) return [];
      state.products = live.products;
      state.hidden = live.hidden;
      state.checkedAt = live.checkedAt;
      state.stockStatus = live.stockStatus || null;
      state.templates = templates;
      state.productsReady = true;

      // Keep the supplier's name and email in step with TASK.
      const supplier = state.suppliers.find((s) => s.id === live.supplier.id);
      if (supplier) Object.assign(supplier, live.supplier);
      renderSupplierEmail();

      const orderable = new Set(live.products.map((p) => p.productSupplierId));
      state.qty = new Map();
      for (const [psid, q] of keptQty) {
        if (orderable.has(psid)) state.qty.set(psid, q);
        else removed.push(previous.get(psid)?.name || `Product ${psid}`);
      }
    } catch (err) {
      if (seq !== state.loadSeq) return [];
      state.qty = new Map();
      if (err.status !== 401) setMessage($('builder-error'), err.message);
    } finally {
      if (seq === state.loadSeq) $('refresh-products').disabled = false;
    }
    renderBuilder();
    return removed;
  }

  $('refresh-products').addEventListener('click', async () => {
    const removed = await loadProducts({ keepQuantities: true });
    if (removed.length) {
      showBuilderNotice(
        'These products are no longer available in TASK and were removed from the order:',
        removed,
      );
    }
  });

  // ---------------------------------------------------------------- products table
  function lineTotal(product, q) {
    if (!q || typeof product.caseCost !== 'number' || typeof product.unitCost !== 'number') return null;
    return Math.round((q.cases * product.caseCost + q.units * product.unitCost) * 100) / 100;
  }

  function packLabel(p) {
    return p.caseDescription || (p.caseQty > 1 ? `${fmtQty(p.caseQty)} per case` : 'Each');
  }

  function qtyInput(product, field) {
    const q = state.qty.get(product.productSupplierId);
    const label = `${field === 'cases' ? 'Cases' : 'Units'} of ${product.name}`;
    return el('input', {
      type: 'number',
      min: '0',
      step: 'any',
      inputmode: 'decimal',
      className: 'qty',
      'aria-label': label,
      value: q && q[field] ? fmtQty(q[field]) : '',
      dataset: { psid: String(product.productSupplierId), field },
    });
  }

  // ---- stock (advisory: from TASK stock on hand and min/max levels at this location)
  function stockCell(p) {
    const s = p.stock;
    if (!s || s.onHand === null) return el('span', { className: 'muted', text: '—' });
    const levels = [s.min !== null ? `min ${fmtQty(s.min)}` : '', s.max !== null ? `max ${fmtQty(s.max)}` : '']
      .filter(Boolean)
      .join(' · ');
    return [
      el('span', { className: 'on-hand', text: fmtQty(s.onHand) }),
      s.belowMin ? el('span', { className: 'badge', text: 'Below min' }) : null,
      levels ? el('span', { className: 'stock-levels', text: levels }) : null,
    ];
  }

  function suggestionCell(p) {
    const s = p.stock;
    if (!s || s.suggestedCases === null || s.suggestedCases === undefined) {
      return el('span', { className: 'muted', text: '—' });
    }
    if (s.suggestedCases === 0) return el('span', { className: 'muted', text: 'At max' });
    const n = s.suggestedCases;
    const label = `${n} ${n === 1 ? 'case' : 'cases'}`;
    return el('button', {
      type: 'button',
      className: 'btn btn-suggest',
      text: label,
      title: `Set cases to ${label} (brings stock up to the max level of ${fmtQty(s.max)})`,
      'aria-label': `Use suggested quantity for ${p.name}: ${label}`,
      dataset: { psid: String(p.productSupplierId), cases: String(n) },
    });
  }

  function renderBuilder() {
    const ready = Boolean(state.locationNo && state.supplierId);
    show($('products-card'), ready);
    show($('details-card'), ready && state.productsReady);

    // templates
    const hasTemplates = state.productsReady && state.templates.length > 0;
    show($('template-row'), hasTemplates);
    if (hasTemplates) {
      fillSelect(
        $('template'),
        state.templates.map((t) => ({ value: t.id, label: t.name })),
        'Choose a template…',
      );
    }
    renderProducts();
    renderOrderBar();
  }

  function renderProducts() {
    const body = $('products-body');
    if (!state.productsReady) {
      body.replaceChildren();
      return;
    }
    const term = $('product-search').value.trim().toLowerCase();
    const onlyOrdered = $('only-ordered').checked;
    const belowMinOnly = $('below-min').checked;
    const rows = state.products.filter((p) => {
      const q = state.qty.get(p.productSupplierId);
      if (onlyOrdered && !(q && (q.cases > 0 || q.units > 0))) return false;
      if (belowMinOnly && !(p.stock && p.stock.belowMin)) return false;
      if (!term) return true;
      return p.name.toLowerCase().includes(term) || p.code.toLowerCase().includes(term);
    });

    const status = $('products-status');
    if (!state.products.length) status.textContent = 'This supplier has no active products for this location in TASK.';
    else if (!rows.length) status.textContent = 'No products match.';
    else status.textContent = `${rows.length} of ${state.products.length} active products`;
    renderLiveStatus();

    body.replaceChildren(
      ...rows.map((p) => {
        const q = state.qty.get(p.productSupplierId);
        const ordered = q && (q.cases > 0 || q.units > 0);
        return el(
          'tr',
          { className: ordered ? 'ordered' : '', dataset: { psid: String(p.productSupplierId) } },
          el('td', { className: 'code', 'data-label': 'Code', text: p.code || '—' }),
          el('td', { className: 'name', 'data-label': 'Product', text: p.name }),
          el('td', { className: 'pack', 'data-label': 'Pack', text: packLabel(p) }),
          el('td', { className: 'num', 'data-label': 'Case cost', text: fmtMoney(p.caseCost) }),
          el('td', { className: 'num stock', 'data-label': 'On hand' }, stockCell(p)),
          el('td', { className: 'num', 'data-label': 'Suggested' }, suggestionCell(p)),
          el('td', { className: 'num', 'data-label': 'Cases' }, qtyInput(p, 'cases')),
          el('td', { className: 'num', 'data-label': 'Units' }, qtyInput(p, 'units')),
          el('td', { className: 'num line-total', 'data-label': 'Line ex GST', text: ordered ? fmtMoney(lineTotal(p, q)) : '' }),
        );
      }),
    );
  }

  function renderLiveStatus() {
    const node = $('products-live');
    if (!state.productsReady || !state.checkedAt) {
      node.textContent = '';
      return;
    }
    let text = `Checked live with TASK at ${formatTime(state.checkedAt)}.`;
    const parts = Object.entries(state.hidden || {})
      .filter(([, n]) => n > 0)
      .map(([reason, n]) => `${n} ${HIDDEN_LABELS[reason] || reason}`);
    if (parts.length) {
      const total = Object.values(state.hidden).reduce((a, b) => a + b, 0);
      text += ` ${total} supplier ${total === 1 ? 'product is' : 'products are'} not shown: ${parts.join('; ')}.`;
    }
    if (state.stockStatus && state.stockStatus.available === false) {
      text += ` Stock levels unavailable: ${state.stockStatus.message}.`;
    } else if (state.stockStatus) {
      text += ' Stock levels included.';
    }
    node.textContent = text;
  }

  // One click applies a suggestion: sets that row's Cases (Units are left as they are).
  $('products-body').addEventListener('click', (event) => {
    const button = event.target.closest('button.btn-suggest');
    if (!button) return;
    const input = button.closest('tr').querySelector('input.qty[data-field="cases"]');
    input.value = button.dataset.cases;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });

  $('products-body').addEventListener('input', (event) => {
    const input = event.target;
    if (!input.matches('input.qty')) return;
    const psid = Number(input.dataset.psid);
    const product = state.products.find((p) => p.productSupplierId === psid);
    if (!product) return;
    const value = input.value === '' ? 0 : Number(input.value);
    const valid = Number.isFinite(value) && value >= 0;
    input.classList.toggle('invalid', !valid);
    const q = state.qty.get(psid) || { cases: 0, units: 0 };
    q[input.dataset.field] = valid ? value : 0;
    if (q.cases > 0 || q.units > 0) state.qty.set(psid, q);
    else state.qty.delete(psid);

    const row = input.closest('tr');
    const ordered = state.qty.has(psid);
    row.classList.toggle('ordered', ordered);
    row.querySelector('.line-total').textContent = ordered ? fmtMoney(lineTotal(product, q)) : '';
    renderOrderBar();
  });

  $('product-search').addEventListener('input', renderProducts);
  $('only-ordered').addEventListener('change', renderProducts);
  $('below-min').addEventListener('change', renderProducts);

  function orderLines() {
    return state.products
      .filter((p) => state.qty.has(p.productSupplierId))
      .map((p) => {
        const q = state.qty.get(p.productSupplierId);
        return { product: p, cases: q.cases, units: q.units, total: lineTotal(p, q) };
      });
  }

  function renderOrderBar() {
    const lines = orderLines();
    const total = lines.reduce((sum, l) => sum + (l.total || 0), 0);
    $('order-lines').textContent = `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`;
    $('order-total').textContent = fmtMoney(total);
    $('review').disabled = lines.length === 0;
  }

  // ---------------------------------------------------------------- templates
  $('load-template').addEventListener('click', async () => {
    const templateId = Number($('template').value);
    if (!templateId) return;
    if (hasQuantities() && !window.confirm('Replace the quantities you have entered with this template?')) return;
    const button = $('load-template');
    button.disabled = true;
    setMessage($('builder-error'), '');
    try {
      const { items } = await api('GET', `/templates/${templateId}/items`);
      state.qty.clear();
      let loaded = 0;
      let skipped = 0;
      for (const item of items) {
        const product =
          state.products.find((p) => p.productSupplierId === item.productSupplierId) ||
          state.products.find((p) => p.productId === item.productId);
        if (!product || (item.cases <= 0 && item.units <= 0)) {
          skipped += product ? 0 : 1;
          continue;
        }
        state.qty.set(product.productSupplierId, { cases: Math.max(0, item.cases), units: Math.max(0, item.units) });
        loaded += 1;
      }
      $('only-ordered').checked = loaded > 0;
      renderProducts();
      renderOrderBar();
      $('products-status').textContent =
        `Loaded ${loaded} ${loaded === 1 ? 'line' : 'lines'} from the template.` +
        (skipped ? ` ${skipped} template ${skipped === 1 ? 'line is' : 'lines are'} not currently active for this supplier and ${skipped === 1 ? 'was' : 'were'} skipped.` : '');
    } catch (err) {
      if (err.status !== 401) setMessage($('builder-error'), err.message);
    } finally {
      button.disabled = false;
    }
  });

  // ---------------------------------------------------------------- review & send
  function summaryRows(node, rows) {
    node.replaceChildren(...rows.filter(([, v]) => v).flatMap(([k, v]) => [el('dt', { text: k }), el('dd', {}, v)]));
  }

  $('review').addEventListener('click', () => {
    const lines = orderLines();
    if (!lines.length) return;
    const deliveryDate = $('delivery-date').value;
    if (deliveryDate && deliveryDate < todayLocal()) {
      setMessage($('builder-error'), 'The delivery date cannot be in the past.');
      $('delivery-date').focus();
      return;
    }
    setMessage($('builder-error'), '');
    const supplier = currentSupplier();
    const location = currentLocation();
    const total = lines.reduce((sum, l) => sum + (l.total || 0), 0);
    const shipTo = $('ship-to').value.trim();

    summaryRows($('review-summary'), [
      ['Supplier', supplier.name],
      ['Email to', supplier.email || 'No email address in TASK'],
      ['Deliver to', shipTo ? `${location.name}, ${shipTo}` : location.name],
      ['Delivery date', formatDate(deliveryDate) || 'Not specified'],
      ['Our reference', $('customer-po').value.trim()],
      ['Ordered by', state.clerk.name],
      ['Total', `${fmtMoney(total)} ex GST`],
    ]);
    $('review-lines').replaceChildren(
      ...lines.map((l) =>
        el(
          'tr',
          {},
          el('td', {}, l.product.name, l.product.code ? el('span', { className: 'muted small', text: ` ${l.product.code}` }) : null),
          el('td', { className: 'num', text: fmtQty(l.cases) }),
          el('td', { className: 'num', text: fmtQty(l.units) }),
          el('td', { className: 'num', text: fmtMoney(l.total) }),
        ),
      ),
    );

    let note;
    if (!state.clerk.canApprove) {
      note = 'Your TASK account cannot approve purchase orders. This PO will be saved in TASK as "Awaiting approval" and will not be emailed to the supplier.';
    } else if (!supplier.email) {
      note = 'The PO will be created in TASK as "Approved", but it cannot be emailed because the supplier has no email address in TASK. Contact the supplier directly.';
    } else {
      note = `When you press Send, the PO is created in TASK as "Approved" and emailed to ${supplier.email}.`;
      if (state.config.mailMode === 'log') note += ' (Test mode: the email is saved on the server, not actually sent.)';
    }
    $('review-note').textContent = note;
    setMessage($('review-error'), '');
    state.idempotencyKey = randomKey();
    $('send').disabled = false;
    $('send').textContent = state.clerk.canApprove ? 'Send purchase order' : 'Save for approval';
    $('review-dialog').showModal();
  });

  $('send').addEventListener('click', async () => {
    if (state.sending) return;
    const lines = orderLines();
    const body = {
      supplierId: state.supplierId,
      locationNo: state.locationNo,
      deliveryDate: $('delivery-date').value || undefined,
      customerPo: $('customer-po').value.trim() || undefined,
      shipToAddress: $('ship-to').value.trim() || undefined,
      comments: $('comments').value.trim() || undefined,
      // What the clerk reviewed: the server re-checks these against live TASK data before sending.
      lines: lines.map((l) => ({
        productSupplierId: l.product.productSupplierId,
        cases: l.cases,
        units: l.units,
        caseCost: l.product.caseCost,
        unitCost: l.product.unitCost,
      })),
      expectedSupplierEmail: currentSupplier().email,
      idempotencyKey: state.idempotencyKey,
    };
    state.sending = true;
    const button = $('send');
    button.disabled = true;
    $('review-cancel').disabled = true;
    button.textContent = 'Sending…';
    setMessage($('review-error'), '');
    try {
      const result = await api('POST', '/orders', body);
      state.lastResult = result;
      showBuilderNotice('');
      $('review-dialog').close();
      renderResult(result);
      showView('result');
    } catch (err) {
      if (err.status === 409 && err.data && err.data.code === 'catalogue_changed') {
        $('review-dialog').close();
        showBuilderNotice(err.message, (err.data.changes || []).map((c) => c.message));
        const removed = await loadProducts({ keepQuantities: true });
        if (removed.length) {
          showBuilderNotice(err.message, [
            ...(err.data.changes || []).map((c) => c.message),
            `Removed from the order: ${removed.join(', ')}.`,
          ]);
        }
        return;
      }
      if (err.status !== 401) {
        let message = err.message;
        if (err.data && err.data.fields) {
          const extra = Object.values(err.data.fields).filter((v) => typeof v === 'string');
          if (extra.length) message += ` ${[...new Set(extra)].join('. ')}.`;
        }
        setMessage($('review-error'), message);
      }
      button.disabled = false;
      button.textContent = 'Try again';
    } finally {
      state.sending = false;
      $('review-cancel').disabled = false;
    }
  });

  // ---------------------------------------------------------------- result
  function renderResult(result) {
    const { email } = result;
    let title;
    if (result.status === 0) title = `PO #${result.poId} saved for approval`;
    else if (email.sent) title = `PO #${result.poId} sent to ${result.supplier.name}`;
    else title = `PO #${result.poId} created, not emailed`;
    $('result-title').textContent = title;
    $('result-card').className = `card result-card ${email.sent || result.status === 0 ? 'ok' : 'warn'}`;

    summaryRows($('result-summary'), [
      ['TASK PO number', `#${result.poId}`],
      ['Status in TASK', result.statusLabel],
      ['Supplier', result.supplier.name],
      ['Location', result.location.name],
      ['Lines', String(result.lineCount)],
      ['Total', `${fmtMoney(result.totalExGst)} ex GST`],
    ]);
    renderEmailNotice(email);
  }

  function renderEmailNotice(email) {
    const node = $('result-email');
    let text;
    if (email.sent) {
      text = `Emailed to ${email.to}${email.cc && email.cc.length ? ` (cc ${email.cc.join(', ')})` : ''}.`;
      if (email.warning) text += ` ${email.warning}`;
    } else {
      text = email.message || 'The email was not sent.';
    }
    node.textContent = text;
    node.className = `notice ${email.sent && !email.warning ? 'ok' : email.reason === 'awaiting_approval' ? '' : 'warn'}`;
    const canRetry = !email.sent && ['send_failed', 'session_expired'].includes(email.reason) && state.clerk && state.clerk.canApprove;
    show($('retry-email'), Boolean(canRetry));
  }

  $('retry-email').addEventListener('click', async () => {
    const result = state.lastResult;
    if (!result) return;
    const button = $('retry-email');
    button.disabled = true;
    button.textContent = 'Sending…';
    try {
      const { email } = await api('POST', `/orders/${result.poId}/email`, {});
      result.email = email;
    } catch (err) {
      if (err.status === 401) return;
      result.email = { ...result.email, sent: false, message: err.message };
    } finally {
      button.disabled = false;
      button.textContent = 'Retry email';
    }
    renderResult(result);
  });

  $('new-order').addEventListener('click', () => {
    state.lastResult = null;
    state.qty.clear();
    for (const id of ['delivery-date', 'customer-po', 'ship-to', 'comments', 'product-search']) $(id).value = '';
    $('only-ordered').checked = false;
    $('below-min').checked = false;
    if ($('template').options.length) $('template').value = '';
    showView('builder');
    renderBuilder();
    window.scrollTo(0, 0);
  });

  init();
})();
