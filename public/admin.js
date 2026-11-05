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
    await Promise.all([loadSettings(), loadAudit()]);
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
