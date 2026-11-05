'use strict';

(() => {
  const $ = (id) => document.getElementById(id);

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'className') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const show = (node, visible) => {
    node.hidden = !visible;
  };
  function setMessage(node, message, tone) {
    node.textContent = message || '';
    if (tone !== undefined) node.className = `notice${tone ? ` ${tone}` : ''}`;
    show(node, Boolean(message));
  }
  const when = (iso) => (iso ? new Date(iso).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : '');

  let state = { admin: null, settings: null, activeClerkSessions: 0 };

  async function api(method, path, body) {
    const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(`/api/admin${path}`, opts);
    } catch {
      throw Object.assign(new Error('Could not reach the server.'), { status: 0 });
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (res.status === 401 && path !== '/me') {
      showSignedOut('Your admin session has ended. Please sign in again.');
    }
    if (!res.ok) throw Object.assign(new Error((data && data.error) || `Request failed (${res.status}).`), { status: res.status, data });
    return data;
  }

  // ---------------------------------------------------------------- signed in / out
  const SIGNIN_ERRORS = {
    expired: 'The sign-in took too long or was already used. Please try again.',
    not_allowed: "That Microsoft account isn't allowed into the admin panel.",
    signin_failed: "Microsoft sign-in didn't complete. Please try again.",
  };

  function showSignedOut(notice) {
    state.admin = null;
    show($('who'), false);
    show($('signed-in'), false);
    show($('signed-out'), true);
    setMessage($('signout-notice'), notice || '');
  }

  async function showSignedIn(admin) {
    state.admin = admin;
    $('who-name').textContent = admin.name || admin.email;
    show($('who'), true);
    show($('signed-out'), false);
    show($('signed-in'), true);
    $('admin-oid').textContent = `Signed in as ${admin.email}. Your Microsoft Entra object ID is ${admin.oid}. Add it to ADMIN_ALLOWED_OBJECT_IDS to tie admin access to your account permanently.`;
    await Promise.all([loadSettings(), loadAudit(), loadSyncStatus(), loadAccountNumbers()]);
  }

  // ---------------------------------------------------------------- settings
  async function loadSettings() {
    try {
      const data = await api('GET', '/settings');
      state.settings = data.settings;
      state.activeClerkSessions = data.activeClerkSessions;
      renderCurrent();
      $('env-name').value = data.settings.environmentName || '';
      $('base-url').value = data.settings.baseUrl || '';
      $('api-key').value = '';
      $('allowed-hosts').textContent = `Approved servers: ${data.settings.allowedHosts.join(', ')}. IT controls this list with TASK_ALLOWED_HOSTS.`;
    } catch (err) {
      if (err.status !== 401) setMessage($('form-error'), err.message);
    }
  }

  function renderCurrent() {
    const s = state.settings;
    const by = (who) => (who && (who.name || who.email) ? ` by ${who.name || who.email}` : '');
    const rows = [
      ['Environment', s.environmentName || 'Not named'],
      ['API address', s.baseUrl || 'Not set'],
      ['API key', s.apiKeyHint || 'Not set'],
      ['Set from', s.source === 'admin' ? 'This admin panel' : 'Server environment (.env)'],
      ['Last changed', s.updatedAt ? `${when(s.updatedAt)}${by(s.updatedBy)}` : ''],
      ['Key last changed', s.keyUpdatedAt ? `${when(s.keyUpdatedAt)}${by(s.keyUpdatedBy)}` : ''],
      ['Clerks signed in now', String(state.activeClerkSessions)],
    ].filter(([, v]) => v);
    $('current').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
    if (!s.configured) setMessage($('current-test'), 'TASK is not set up yet. Clerks cannot sign in until you save an address and key.', 'warn');
    else setMessage($('current-test'), '');
  }

  function testMessage(test) {
    return test.ok
      ? `Connected. TASK accepted the key at ${test.baseUrl}${test.appName ? ` (app: ${test.appName})` : ''}.`
      : `Not connected: ${test.message}`;
  }

  async function runTest(button, body, target) {
    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Testing…';
    setMessage($('form-error'), '');
    try {
      const { test } = await api('POST', '/settings/test', body);
      setMessage(target, testMessage(test), test.ok ? 'ok' : 'warn');
    } catch (err) {
      if (err.status !== 401) setMessage(target, err.message, 'warn');
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  function formValues() {
    return {
      baseUrl: $('base-url').value.trim(),
      environmentName: $('env-name').value.trim(),
      apiKey: $('api-key').value.trim(),
    };
  }

  $('test-current').addEventListener('click', (e) => runTest(e.currentTarget, {}, $('current-test')));
  $('test-new').addEventListener('click', (e) => {
    const v = formValues();
    runTest(e.currentTarget, { baseUrl: v.baseUrl, apiKey: v.apiKey || undefined }, $('form-result'));
  });
  $('show-key').addEventListener('change', (e) => {
    $('api-key').type = e.target.checked ? 'text' : 'password';
  });

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues();
    setMessage($('form-error'), '');
    setMessage($('form-result'), '');
    if (!v.baseUrl) {
      setMessage($('form-error'), 'Enter the TASK API address.');
      return;
    }
    const n = state.activeClerkSessions;
    const warning = n ? `\n\n${n} ${n === 1 ? 'clerk is' : 'clerks are'} signed in now and will be signed out if the address or key changes.` : '';
    if (!window.confirm(`Save these TASK connection settings?${warning}`)) return;

    const button = $('save');
    button.disabled = true;
    button.textContent = 'Testing and saving…';
    try {
      const result = await api('PUT', '/settings', {
        baseUrl: v.baseUrl,
        environmentName: v.environmentName,
        apiKey: v.apiKey || undefined,
      });
      if (!result.changed.length) {
        setMessage($('form-result'), 'Nothing changed.', '');
      } else {
        const names = { baseUrl: 'API address', apiKey: 'API key', environmentName: 'environment name' };
        const what = result.changed.map((c) => names[c] || c).join(', ');
        const out = result.signedOutClerks
          ? ` ${result.signedOutClerks} ${result.signedOutClerks === 1 ? 'clerk was' : 'clerks were'} signed out.`
          : '';
        setMessage($('form-result'), `Saved: ${what}. The whole app now uses the new settings.${out}`, 'ok');
      }
      $('api-key').value = '';
      $('show-key').checked = false;
      $('api-key').type = 'password';
      await Promise.all([loadSettings(), loadAudit()]);
    } catch (err) {
      if (err.status !== 401) setMessage($('form-error'), err.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Save changes';
    }
  });

  // ---------------------------------------------------------------- change history
  function describe(entry) {
    const d = entry.details || {};
    if (entry.action === 'admin_signed_in') return 'Signed in to the admin panel';
    if (entry.action === 'admin_sign_in_refused') return 'Sign-in refused: not on the admin allow-list';
    if (entry.action === 'account_number_set') {
      return `Account No for ${d.supplierName || `supplier ${d.supplierId}`} at ${d.locationName || `store ${d.locationNo}`}: ${d.accountNo?.from || '(none)'} → ${d.accountNo?.to}`;
    }
    if (entry.action === 'account_number_removed') {
      return `Account No removed for ${d.supplierName || `supplier ${d.supplierId}`} at ${d.locationName || `store ${d.locationNo}`}`;
    }
    if (entry.action === 'account_numbers_imported') {
      return `Account numbers imported${d.replace ? ' (replaced the list)' : ''}: ${d.added} added, ${d.changed} changed, ${d.removed} removed`;
    }
    if (entry.action === 'clerk_sync') {
      const sm = d.summary || {};
      const parts = [`${sm.done || 0} applied`];
      if (sm.failed) parts.push(`${sm.failed} failed`);
      if (sm.waiting) parts.push(`${sm.waiting} waiting for approval`);
      if (sm.held) parts.push(`${sm.held} held`);
      return `Clerk sync (${d.mode === 'scheduled' ? 'automatic' : 'Sync now'}): ${parts.join(', ')}`;
    }
    if (entry.action === 'clerk_sync_failed') return `Clerk sync (${d.mode === 'scheduled' ? 'automatic' : 'Sync now'}) failed: ${d.error}`;
    if (entry.action !== 'settings_updated') return entry.action;
    const parts = [];
    if (d.baseUrl) parts.push(`API address: ${d.baseUrl.from || '(none)'} → ${d.baseUrl.to}`);
    if (d.apiKey) parts.push(`API key: ${d.apiKey.from || '(none)'} → ${d.apiKey.to}`);
    if (d.environmentName) parts.push(`Environment: ${d.environmentName.from || '(none)'} → ${d.environmentName.to || '(none)'}`);
    if (d.signedOutClerks) parts.push(`${d.signedOutClerks} ${d.signedOutClerks === 1 ? 'clerk' : 'clerks'} signed out`);
    return parts.join('; ');
  }

  async function loadAudit() {
    try {
      const { entries } = await api('GET', '/audit');
      const body = $('audit');
      if (!entries.length) {
        body.replaceChildren(el('tr', {}, el('td', { colspan: '3', className: 'muted', text: 'No changes yet.' })));
        return;
      }
      body.replaceChildren(
        ...entries.map((e) =>
          el(
            'tr',
            {},
            el('td', { 'data-label': 'When', text: when(e.at) }),
            el('td', { 'data-label': 'Who', text: e.actor ? e.actor.name || e.actor.email || e.actor.oid : '' }),
            el('td', { 'data-label': 'What', text: describe(e) }),
          ),
        ),
      );
    } catch (err) {
      if (err.status !== 401) setMessage($('form-error'), err.message);
    }
  }
  $('refresh-audit').addEventListener('click', loadAudit);

  $('sign-out').addEventListener('click', async () => {
    let logoutUrl = null;
    try {
      ({ logoutUrl } = await api('POST', '/logout', {}));
    } catch {
      // signed out locally regardless
    }
    if (logoutUrl) window.location.assign(logoutUrl);
    else showSignedOut('You have signed out.');
  });

  // ---------------------------------------------------------------- supplier account numbers
  let acct = { entries: [], lists: null };

  function acctControls() {
    const { lists } = acct;
    const select = (id, options, placeholder) =>
      el('select', { id }, el('option', { value: '', text: placeholder }), options.map((o) => el('option', { value: String(o.value), text: o.label })));
    const number = (id, placeholder) => el('input', { id, type: 'number', min: '1', step: '1', inputmode: 'numeric', placeholder });
    $('acct-supplier-slot').replaceChildren(
      lists ? select('acct-supplier', lists.suppliers.map((s) => ({ value: s.id, label: s.name })), 'Choose a supplier…') : number('acct-supplier', 'TASK supplier ID'),
    );
    $('acct-store-slot').replaceChildren(
      lists ? select('acct-store', lists.stores.map((s) => ({ value: s.locationNo, label: s.name })), 'Choose a store…') : number('acct-store', 'TASK location number'),
    );
  }

  const supplierLabel = (e) => (e.supplierName ? `${e.supplierName} (#${e.supplierId})` : `Supplier #${e.supplierId}`);
  const storeLabel = (e) => (e.locationName ? `${e.locationName} (#${e.locationNo})` : `Store #${e.locationNo}`);

  function renderAcctTable() {
    const body = $('acct-body');
    if (!acct.entries.length) {
      body.replaceChildren(el('tr', {}, el('td', { colspan: '4', className: 'muted', text: 'No account numbers yet.' })));
      return;
    }
    body.replaceChildren(
      ...acct.entries.map((e) =>
        el(
          'tr',
          {},
          el('td', { 'data-label': 'Supplier', text: supplierLabel(e) }),
          el('td', { 'data-label': 'Store', text: storeLabel(e) }),
          el('td', { 'data-label': 'Account No', text: e.accountNo }),
          el(
            'td',
            { className: 'actions-cell' },
            el('button', { type: 'button', className: 'btn', text: 'Edit', 'data-edit': `${e.supplierId}:${e.locationNo}` }),
            ' ',
            el('button', { type: 'button', className: 'btn', text: 'Remove', 'data-remove': `${e.supplierId}:${e.locationNo}` }),
          ),
        ),
      ),
    );
  }

  async function loadAccountNumbers() {
    try {
      const data = await api('GET', '/account-numbers');
      show($('acct-card'), data.editable);
      acct = { entries: data.entries, lists: data.lists };
      $('acct-lists-note').textContent = data.listsMessage || '';
      acctControls();
      renderAcctTable();
    } catch (err) {
      if (err.status !== 401) show($('acct-card'), false);
    }
  }

  async function saveAccountNumber(body, doneMessage) {
    try {
      const result = await api('PUT', '/account-numbers', body);
      setMessage($('acct-message'), result.changed ? doneMessage : 'Nothing changed.', result.changed ? 'ok' : '');
      await Promise.all([loadAccountNumbers(), loadAudit()]);
      return true;
    } catch (err) {
      if (err.status !== 401) {
        const extra = err.data && err.data.fields ? ` ${Object.values(err.data.fields).join('. ')}.` : '';
        setMessage($('acct-message'), `${err.message}${extra}`, 'warn');
      }
      return false;
    }
  }

  $('acct-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const supplierId = Number($('acct-supplier').value);
    const locationNo = Number($('acct-store').value);
    const pick = (list, id, key) => (list || []).find((x) => x[key] === id)?.name || '';
    const ok = await saveAccountNumber(
      {
        supplierId,
        locationNo,
        accountNo: $('acct-number').value.trim(),
        supplierName: pick(acct.lists && acct.lists.suppliers, supplierId, 'id'),
        locationName: pick(acct.lists && acct.lists.stores, locationNo, 'locationNo'),
      },
      'Saved. New purchase orders for that supplier and store will show it.',
    );
    if (ok) $('acct-number').value = '';
  });

  $('acct-body').addEventListener('click', async (e) => {
    const edit = e.target.closest('button[data-edit]');
    const remove = e.target.closest('button[data-remove]');
    const id = (edit || remove)?.getAttribute(edit ? 'data-edit' : 'data-remove');
    if (!id) return;
    const [supplierId, locationNo] = id.split(':').map(Number);
    const entry = acct.entries.find((x) => x.supplierId === supplierId && x.locationNo === locationNo);
    if (edit) {
      $('acct-supplier').value = String(supplierId);
      $('acct-store').value = String(locationNo);
      $('acct-number').value = entry ? entry.accountNo : '';
      $('acct-number').focus();
      return;
    }
    if (!window.confirm(`Remove the account number for ${entry ? `${supplierLabel(entry)} at ${storeLabel(entry)}` : 'this supplier and store'}?`)) return;
    await saveAccountNumber({ supplierId, locationNo, accountNo: '' }, 'Removed.');
  });

  $('acct-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const replace = $('acct-replace').checked;
    if (replace && !window.confirm('Replace the whole account number list with this file? Rows not in the file will be removed.')) return;
    try {
      const result = await api('POST', '/account-numbers/import', { csv: await file.text(), replace });
      setMessage($('acct-message'), `Imported ${file.name}: ${result.added} added, ${result.changed} changed, ${result.removed} removed (${result.total} in the list).`, 'ok');
      await Promise.all([loadAccountNumbers(), loadAudit()]);
    } catch (err) {
      if (err.status !== 401) setMessage($('acct-message'), err.message, 'warn');
    }
  });

  // ---------------------------------------------------------------- central hub -> TASK clerk sync
  const FIELD_LABELS = {
    ClerkName: 'First name',
    ClerkSurname: 'Surname',
    Email: 'Email',
    MobilePhone: 'Mobile',
    PayrollIDNumber: 'Payroll ID',
  };
  let syncPlan = null;

  function changeList(changes) {
    const entries = Object.entries(changes || {});
    if (!entries.length) return el('span', { className: 'muted', text: 'No field changes' });
    return el(
      'ul',
      { className: 'change-list' },
      entries.map(([field, c]) => el('li', { text: `${FIELD_LABELS[field] || field}: ${c.from || '(blank)'} → ${c.to}` })),
    );
  }

  async function loadSyncStatus() {
    try {
      const st = await api('GET', '/sync');
      show($('sync-card'), Boolean(st.configured));
      if (!st.configured) return;
      const schedule = st.intervalMinutes ? `Runs automatically every ${st.intervalMinutes} minutes.` : 'Runs only when you press Sync now.';
      let last = 'No sync has run since the app started.';
      if (st.lastRun) {
        const how = st.lastRun.mode === 'scheduled' ? 'automatic' : 'Sync now';
        last = st.lastRun.error
          ? `Last sync (${how}, ${when(st.lastRun.finishedAt)}) failed: ${st.lastRun.error}`
          : `Last sync (${how}, ${when(st.lastRun.finishedAt)}): ${st.lastRun.summary.done} applied, ${st.lastRun.summary.failed} failed, ${st.lastRun.summary.waiting} waiting for approval, ${st.lastRun.summary.held} held.`;
      }
      $('sync-status').textContent = `Hub: ${st.hubTable} at ${st.hubHost}. ${schedule} ${last}`;
    } catch (err) {
      if (err.status !== 401) show($('sync-card'), false);
    }
  }

  async function busy(button, text, fn) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = text;
    try {
      await fn();
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  $('sync-check').addEventListener('click', (e) =>
    busy(e.currentTarget, 'Checking…', async () => {
      try {
        const { check } = await api('POST', '/sync/check', {});
        setMessage($('sync-message'), `Connected to the hub. Table "${check.table}" has the columns: ${check.columns.join(', ')}.`, 'ok');
      } catch (err) {
        if (err.status !== 401) setMessage($('sync-message'), err.message, 'warn');
      }
    }),
  );

  function section(title, note, headers, rows) {
    if (!rows.length) return null;
    return el(
      'div',
      { className: 'sync-section' },
      el('h3', { text: `${title} (${rows.length})` }),
      note ? el('p', { className: 'muted small', text: note }) : null,
      el(
        'div',
        { className: 'table-wrap' },
        el('table', { className: 'sync-table' }, el('thead', {}, el('tr', {}, headers.map((h) => el('th', { text: h })))), el('tbody', {}, rows)),
      ),
    );
  }

  function renderPlan(plan) {
    syncPlan = plan;
    const sm = plan.summary;
    $('sync-summary').replaceChildren(
      ...[
        ['Hub users', String(plan.hubCount)],
        ['TASK clerks', String(plan.taskCount)],
        ['To create', String(sm.create)],
        ['To update', String(sm.update)],
        ['To deactivate', String(sm.deactivate)],
        ['To reactivate', String(sm.reactivate)],
        ['Name matches to check', String(sm.needsApproval)],
        ['Need attention', String(sm.issues)],
      ].flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]),
    );

    const td = (text, extra = {}) => el('td', { text, ...extra });
    const clerkCell = (a) => td(`#${a.clerkId} ${a.taskName || ''}${a.taskEmail ? ` (${a.taskEmail})` : ''}`);
    const nameMatches = plan.actions.filter((a) => a.needsApproval);
    const others = plan.actions.filter((a) => !a.needsApproval);
    const of = (type) => others.filter((a) => a.type === type);

    $('sync-sections').replaceChildren(
      ...[
        section(
          'Name matches to check',
          'These were matched by first and last name only. Tick the ones that are the same person; only ticked ones are applied.',
          ['Apply', 'Hub person', 'TASK clerk', 'Changes'],
          nameMatches.map((a) =>
            el(
              'tr',
              {},
              el('td', { className: 'pick' }, el('input', { type: 'checkbox', 'data-hub': a.hubId, 'data-clerk': String(a.clerkId), 'aria-label': `Same person: ${a.name}` })),
              td(a.name),
              clerkCell(a),
              el('td', {}, changeList(a.changes)),
            ),
          ),
        ),
        section('New clerks to create', 'Created with the default clerk group and venue, and no password. A manager sets their TASK password.', ['Name', 'Details'], of('create').map((a) => el('tr', {}, td(a.name), el('td', {}, changeList(a.changes))))),
        section('To deactivate', 'Marked inactive in the hub.', ['Name', 'TASK clerk'], of('deactivate').map((a) => el('tr', {}, td(a.name), clerkCell(a)))),
        section('To reactivate', 'Active again in the hub.', ['Name', 'TASK clerk'], of('reactivate').map((a) => el('tr', {}, td(a.name), clerkCell(a)))),
        section('To update', null, ['Name', 'TASK clerk', 'Changes'], of('update').map((a) => el('tr', {}, td(a.name), clerkCell(a), el('td', {}, changeList(a.changes))))),
        section('To link (already the same)', null, ['Name', 'TASK clerk'], of('link').map((a) => el('tr', {}, td(a.name), clerkCell(a)))),
        section('Needs attention', 'Not changed. Fix these in the hub or TASK, then sync again.', ['Name', 'Why'], plan.issues.map((i) => el('tr', {}, td(i.name), td(i.message)))),
        section(
          'In TASK but not in the hub',
          'Active TASK clerks with no matching hub user. Reported only; nothing is changed.',
          ['TASK clerk', 'Email'],
          plan.notInHub.slice(0, 200).map((c) => el('tr', {}, td(`#${c.clerkId} ${c.name}`), td(c.email || ''))),
        ),
      ].filter(Boolean),
    );

    const over = [];
    if (sm.deactivate > plan.limits.maxDeactivations) over.push(`${sm.deactivate} deactivations (usual limit ${plan.limits.maxDeactivations})`);
    if (sm.create > plan.limits.maxCreations) over.push(`${sm.create} new clerks (usual limit ${plan.limits.maxCreations})`);
    $('sync-confirm-large').checked = false;
    $('sync-confirm-text').textContent = over.length ? `Yes, apply ${over.join(' and ')}. Without this tick they are held back.` : '';
    show($('sync-confirm-row'), over.length > 0);
    const nothing = plan.actions.length === 0;
    show($('sync-run'), !nothing);
    show($('sync-plan'), true);
    setMessage(
      $('sync-message'),
      nothing ? `Everything is in sync (checked ${when(plan.generatedAt)}).` : `Preview from ${when(plan.generatedAt)}. Nothing has been changed yet.`,
      nothing ? 'ok' : '',
    );
  }

  $('sync-preview').addEventListener('click', (e) =>
    busy(e.currentTarget, 'Reading the hub and TASK…', async () => {
      try {
        renderPlan((await api('POST', '/sync/preview', {})).plan);
      } catch (err) {
        if (err.status !== 401) {
          show($('sync-plan'), false);
          setMessage($('sync-message'), err.message, 'warn');
        }
      }
    }),
  );

  $('sync-run').addEventListener('click', (e) => {
    if (!syncPlan) return;
    const approvedNameLinks = [...document.querySelectorAll('#sync-sections input[data-hub]:checked')].map((box) => ({
      hubId: box.dataset.hub,
      clerkId: Number(box.dataset.clerk),
    }));
    const sm = syncPlan.summary;
    const n = (count, one, many) => count && `${count} ${count === 1 ? one : many}`;
    const lines = [
      n(sm.create, 'new clerk', 'new clerks'),
      n(sm.update, 'update', 'updates'),
      n(sm.deactivate, 'deactivation', 'deactivations'),
      n(sm.reactivate, 'reactivation', 'reactivations'),
      n(approvedNameLinks.length, 'approved name match', 'approved name matches'),
    ].filter(Boolean);
    if (!window.confirm(`Apply these changes to TASK clerks?\n\n${lines.join('\n')}\n\nThe hub and TASK are read again first, so the result can differ slightly from this preview.`)) return;
    busy(e.currentTarget, 'Applying…', async () => {
      try {
        const { report } = await api('POST', '/sync/run', { approvedNameLinks, confirmLargeChanges: $('sync-confirm-large').checked });
        const rs = report.summary;
        const failed = report.results.filter((r) => r.result === 'failed');
        let text = `Sync applied: ${rs.done} done, ${rs.failed} failed, ${rs.waiting} waiting for approval, ${rs.held} held.`;
        if (report.held.length) text += ` Held back: ${report.held.join('; ')}.`;
        if (failed.length) text += ` Failed: ${failed.map((f) => `${f.name} (${f.error})`).join('; ')}.`;
        show($('sync-plan'), false);
        setMessage($('sync-message'), text, failed.length || report.held.length ? 'warn' : 'ok');
        await Promise.all([loadSyncStatus(), loadAudit()]);
      } catch (err) {
        if (err.status !== 401) setMessage($('sync-message'), err.message, 'warn');
      }
    });
  });

  // ---------------------------------------------------------------- start
  async function init() {
    const params = new URLSearchParams(window.location.search);
    const error = params.get('error');
    if (error) {
      setMessage($('signin-error'), SIGNIN_ERRORS[error] || 'Sign-in failed. Please try again.');
      window.history.replaceState(null, '', '/admin');
    }
    try {
      const { admin } = await api('GET', '/me');
      await showSignedIn(admin);
    } catch {
      showSignedOut('');
    }
  }

  init();
})();
