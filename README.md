# TASK Purchase Orders

A small web app for Mad Mex clerks to build a purchase order (PO) in **TASK** (XchangeFusion API v3) and send it to the supplier, then **receive the delivery** into stock when it arrives (see [Receiving deliveries](#receiving-deliveries)).

> **First draft.** Have IT/purchasing review this code and the supplier email wording before it is used in production. The email goes to external suppliers.

## What it does

1. **Sign-in:** the clerk signs in with their own TASK clerk login. That happens once per screen session. Every TASK call in that session is made as that clerk, and every PO is recorded against their `ClerkID`.
2. **Build an order:**
   - Choose the delivery location and the supplier.
   - Optionally start from an existing TASK PO template.
   - Enter cases and/or units for each product, plus delivery date, your reference, delivery instructions and comments.
3. **Review & send:** a confirmation dialog shows the recipient, lines and ex-GST total. On **Send**, the app:
   1. Creates the PO in TASK as *Incomplete* and adds the lines.
   2. Sets the final status:
      - Clerk **can approve POs** in TASK: status becomes **Approved**, and the PO is **emailed to the supplier's email address in TASK**, then marked `Emailed` in TASK.
      - Clerk **cannot approve**: status becomes **Awaiting approval**, and the PO is **not emailed**.
   3. If any line fails to save, deletes the PO so nothing half-built is left in TASK.
   4. If the email fails, keeps the PO and offers **Retry email**. Once a PO is marked as emailed, it can't be emailed again from the app.

Prices are never taken from the browser. Case and unit costs come from TASK supplier venue costs for the chosen location's venue.

## Live, active data only

Supplier, supplier product code, supplier venue cost and product data are read **live from TASK every time**. Nothing is cached. The only exception is the clerk's own location list, which is kept for 5 minutes.

**When a clerk picks a supplier and location**, the app reads:

| TASK endpoint | Used for |
|---|---|
| `GET /supplier/{id}` | supplier is active and not deleted; current email address |
| `GET /supplier/{id}/productCodes` | supplier code and case size; not marked unavailable; within its availability dates |
| `GET /supplier/{id}/venueCosts?venueNo=` | case and unit cost (ex GST) for the location's venue |
| `GET /products/{productId}?locationNo=` | product is active in TASK (`IsActive`); product name |

A product is offered only if all of these hold:
- the supplier is active
- the supplier product code is available
- the product is active in TASK
- the supplier has a cost for that venue (turn this off with `REQUIRE_VENUE_COST=false`)

The screen shows when the data was checked and how many supplier products were hidden, and why. **Refresh from TASK** re-reads everything and keeps the quantities that are still valid.

**When the clerk presses Send**, the app re-reads the supplier and the ordered products from TASK. It compares them with what the clerk reviewed:
- prices
- product and supplier status
- the supplier's email address

If anything changed, **nothing is created or sent**. The clerk sees what changed, the product list is refreshed, and they review again.

## How sign-in works

- The browser never sees the TASK API key or the clerk's TASK token. The server keeps both.
- The browser holds only an opaque `HttpOnly`, `SameSite=Strict` session cookie.
- A session ends when the clerk:
  - presses **Sign out**,
  - closes the browser,
  - is inactive for `SESSION_IDLE_MINUTES` (default 30), or
  - lets their TASK session expire (TASK returns 401/440).

  The clerk then signs in again. A draft order is kept if the same clerk signs back in.
- Passwords are used only for the TASK login call. They are never stored or logged.
- What a clerk can do depends on their TASK permissions:
  - **New order** needs "create purchase orders".
  - **Receive delivery** needs "create invoices", because TASK books deliveries in as supplier invoices.
  - Clerks with both permissions see both tabs. Clerks with neither are refused at sign-in.
- Repeated failed sign-ins are rate-limited per IP: 10 per 15 minutes.
- Sessions are held in memory, so restarting the server signs everyone out.

## Hosting

Run it on **Azure App Service** (Linux, Node 22, Australia East), behind **Cloudflare**. Use one always-on instance, with `DATA_DIR` on persistent storage and secrets in Azure Key Vault. Step-by-step guide: [docs/hosting-azure-cloudflare.md](docs/hosting-azure-cloudflare.md). It covers why not Cloudflare Workers, Azure and Key Vault set-up, GitHub deploys without stored passwords, Cloudflare DNS/TLS/WAF, and a first-deploy checklist.

- `GET /healthz` answers `{"status":"ok"}` for health checks.
- The app stops cleanly on `SIGTERM`.
- Deploys run from **Actions → Deploy to Azure App Service**, started by hand. The workflow runs all tests first.

## Setup

Requires Node.js 20 or later.

```bash
npm install
```

```bash
cp .env.example .env
```

Edit `.env`. At minimum, set `TASK_API_KEY`. For real emails, also set `MAIL_MODE=smtp` and the SMTP settings.

```bash
npm start
```

Open http://localhost:3000.

**Keep secrets out of chat and AI tools.** The TASK API key, SMTP password and clerk passwords belong only in `.env` (which git ignores) or your secret store. Under the Mad Mex AI policy they must never be pasted into an AI assistant.

### Try it without TASK (demo mode)

```bash
npm run dev:mock
```

This runs the app against an in-memory fake TASK API with demo data. Emails are written to `./outbox`, not sent. Sign in with login type **Email** and password `demo-password`:

| Login | Behaviour |
|---|---|
| `manager@example.com` | Orders (approved and emailed) and receives (invoices completed) |
| `crew@example.com` | Orders (saved as Awaiting approval) and receives (invoices left for a manager) |
| `receiver@example.com` | Receive only (invoices completed) |
| `buyer@example.com` | Order only |
| `viewer@example.com` | No PO or invoice permission: sign-in is refused |

Demo mode includes some open POs to receive. Completing a demo invoice adds its stock to on hand, so you can watch the order screen's stock figures change.

Demo mode also runs the **admin panel** at `/admin` with a fake Microsoft sign-in page. Pick "Alex Admin" to get in, or "Sam Staff" to see a refusal. The console prints a second fake TASK address and key you can switch to. The admin panel's **Central hub → TASK clerks** card works against a fake hub staff table, so you can try **Preview sync** and **Apply sync**.

## Stock on hand and suggested quantities

Each product row also shows the location's stock from TASK, read live at the same time as the product list:

- **On hand:** current stock, with the TASK **min** and **max** levels underneath, and a **Below min** badge when stock is under the minimum.
- **Suggested:** the whole number of cases needed to bring stock back up to the max level. Pressing it fills in that row's Cases; nothing is filled in automatically. It shows **At max** when no more is needed, and **—** when TASK has no stock record or no max level for the product.
- **Below minimum only:** a filter that lists just the products under their minimum.

Details:
- Stock already on open POs is **not** counted. Suggestions are based on stock on hand only.
- Stock is advisory. If TASK can't return stock levels, the products still load, the screen says "Stock levels unavailable", and POs can still be sent.
- Stock levels are not included in the supplier email, and are not re-checked when sending.

## Receiving deliveries

The **Receive delivery** tab books a delivery into TASK. TASK records stock deliveries as **supplier invoices** (stock movement type "Invoice").

1. **Choose the delivery.** Pick the store to see its purchase orders waiting to be received: Approved, Order packed, Order dispatched or Partially received. These are read live from TASK. For a delivery with no PO, choose the supplier instead.
2. **Check what arrived.** For a PO, quantities start as what is still to come. Clerks can:
   - change quantities for short or different deliveries. Short lines are flagged, and so are lines with more than ordered.
   - change a line's **case cost** when the invoice price differs from the PO. The PO price is shown next to it.
   - **add items that weren't ordered**, from the supplier's active products in TASK. Products without a venue cost can be added with the invoice cost.
   - for a short PO, choose whether to **close the PO** or leave it **Partially received** so the rest can be received later.
3. **Enter the supplier's invoice or docket number and date, then review.** The review lists shortages, cost changes and extra items, and says whether the stock will be booked in now.
4. **Receive.** The app:
   1. Creates the supplier invoice in TASK, linked to the PO, with one line per item received. Costs are ex GST.
   2. **Completes the invoice**, which books the stock in, if the clerk has TASK's "commit invoices" permission. Otherwise the invoice is saved for a manager to check and complete in TASK.
   3. Updates the PO lines' received cases and units, and sets the PO to **Stock received** or **Partially received**.

Safeguards:
- **Live checks:** the PO and products are re-read from TASK when receiving. A PO that has already been received, or one for a different store or supplier, is refused.
- **No duplicate invoices:** the same supplier invoice number can't be entered twice for the same supplier.
- **Rollback:** if TASK rejects an invoice line, the invoice is deleted and nothing is received.
- **Partial failures:** if completing the invoice or updating the PO fails, the receipt is kept and the clerk is told exactly what to finish in TASK.
- **Double submits:** pressing Receive twice, or a network retry, doesn't receive the delivery twice.

## Admin panel (Microsoft Entra sign-in)

`/admin` is a separate page for managing the TASK connection. Only approved administrators can open it, by signing in with their Mad Mex Microsoft account. From it you can:

- see the **TASK API address**, **environment name** and **API key** in use. Only the key's last 4 characters are ever shown.
- **test** the current connection, or a new address and key, against TASK (`GET /auth/currentApp`) without saving anything.
- **change** the address, key and environment name. A new address or key is saved only if TASK accepts it.
- see the **change history**: sign-ins, refused sign-ins, and every change, with who made it and when.

**How a change applies everywhere:**
- Every TASK call reads the current address and key, so a change applies at once to sign-in, ordering, stock levels and receiving.
- Every signed-in clerk is signed out, because their TASK sessions belong to the old connection. They sign in again against the new one.
- The clerk screen shows the environment name, such as **UAT**, next to the title.

### Security
- **Who gets in.** Microsoft sign-in uses OpenID Connect with PKCE, state and nonce checks, and only accepts tokens issued by your tenant for this app. The person must then be on the allow-list: `ADMIN_ALLOWED_OBJECT_IDS` (recommended, because object IDs never change) and/or `ADMIN_ALLOWED_USERS`. For a second layer, turn on **Assignment required** in Entra and assign only yourself (see below).
- **The key at rest.** The API key is encrypted with AES-256-GCM using `SETTINGS_ENCRYPTION_KEY`, in `DATA_DIR/settings.json`. The file and the history log are readable only by the app's user, and neither ever contains the key in plain text.
- **Approved servers only.** The address can only point to servers in `TASK_ALLOWED_HOSTS` (default `*.xchangefusion.com`), and must use https. IT sets this list outside the panel. This matters because the address decides where clerk passwords are sent.
- **Admin sessions.** They are separate from clerk sessions. The cookie is `HttpOnly` and `SameSite=Strict`. A session ends after 30 minutes idle or 8 hours in total, and changes from other websites are blocked. Signing out also signs you out of Microsoft.
- **Storage.** Settings are kept in `DATA_DIR`, which must be on persistent storage. If you run more than one copy of the app, the others only pick up a change when restarted.

### Setting up Entra (once, in the Microsoft Entra admin center)
1. **App registrations → New registration.**
   - Name: e.g. "TASK PO admin".
   - Supported account types: **this organizational directory only**.
   - Redirect URI: **Web**, `https://<this app's address>/admin/callback`.
2. **Overview:**
   - copy the **Application (client) ID** to `ENTRA_CLIENT_ID`;
   - copy the **Directory (tenant) ID** to `ENTRA_TENANT_ID`.
3. **Certificates & secrets → New client secret.** Put the secret's value in `ENTRA_CLIENT_SECRET` (in `.env` or your secret store; never in chat or email). Note when it expires.
4. **Enterprise applications** → the new app:
   - **Properties → Assignment required = Yes**;
   - **Users and groups** → add only the administrators.
5. In `.env`, set:
   - `PUBLIC_BASE_URL` to the app's https address;
   - `ADMIN_ALLOWED_USERS` to your user name;
   - `SETTINGS_ENCRYPTION_KEY` to the output of `openssl rand -base64 32`.

   Restart the app, sign in at `/admin`, then copy the **object ID** shown at the bottom of the panel into `ADMIN_ALLOWED_OBJECT_IDS` and restart again.

No API permissions are needed beyond the default sign-in (`openid profile email`).

## Central hub (Supabase) → TASK clerk sync

The central hub (Supabase) is the **master list of staff**. The sync keeps TASK clerks matching it. It runs automatically every `SYNC_INTERVAL_MINUTES` (default 15), and from **Sync now** in the admin panel. Clerk sign-in to the PO app is unchanged.

**Matching a hub user to a TASK clerk**, in this order:
1. **A saved link** from an earlier sync. Links are kept for each TASK server, because UAT and production have different clerk IDs.
2. **Email address.** This is the primary key once emails are in TASK.
3. **First and last name.** This is for the first sync, to bring emails into TASK. A name is only matched when exactly one TASK clerk has it; capitals, accents and punctuation are ignored. A name match is **only applied when you tick it** in the Sync now preview, and only for those exact pairs. The automatic sync never applies name matches.

**What it changes:**
- **Matched clerks:** first name, surname, email, mobile, payroll ID and active status only. An empty hub value never blanks a TASK field.
- **Deactivation:** only when the hub explicitly marks the person inactive. People missing from the hub are reported, not deactivated. TASK administrators and the sync's own account are never deactivated automatically.
- **New hub users:** created in TASK with `SYNC_NEW_CLERK_GROUP_ID`, the hub venue or `SYNC_NEW_CLERK_VENUE_NO`, the next free logon number (or the hub's), and **no password**. A manager sets the password in TASK.
- **Never changed in TASK:** password, date of birth, tax/social security number, pay rate, addresses, emergency contacts, groups and labour roles. TASK's update call replaces the whole clerk, so each clerk is re-read just before saving, only the synced fields are replaced, and the password field is never sent. Nothing is ever deleted.
- **The hub:** only read, never written to. Only the mapped columns are requested.

**Safeguards:**
- **Preview first:** Sync now shows a full preview (to create, update, deactivate, reactivate, name matches to tick, things needing attention, and TASK clerks not in the hub) before anything changes.
- **Large runs held:** the automatic sync holds back more than `SYNC_MAX_DEACTIVATIONS` deactivations or `SYNC_MAX_CREATIONS` new clerks in one run. You can apply them from Sync now after checking.
- **Empty hub:** if the hub returns no users, nothing is changed.
- **History:** every run is recorded with who ran it, which clerks and which fields changed. Values and HR details are not recorded.

### Setting up the hub side
- **A view with only the needed columns.** In Supabase, create a view of your staff table containing only id, first name, last name, email, active, and optionally mobile, payroll ID, venue number and clerk logon. Point `HUB_TABLE` at that view, so the app can't read anything else.
- **The key.** `HUB_SUPABASE_KEY` must be able to read that view. The `service_role` key works, but it can read and write everything in the project. If you use it, keep it in your secret store and treat it like a database password. A key limited to that view, through a dedicated database role, is safer; ask whoever manages the hub.
- **A sync clerk in TASK.** Create a TASK clerk for the sync (`SYNC_TASK_LOGIN` / `SYNC_TASK_PASSWORD`) with permission to view and edit clerks.

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `TASK_BASE_URL` | `https://madmexuatapi.xchangefusion.com` | TASK API host (UAT by default) |
| `TASK_API_KEY` | (required) | App API key, sent as the `Key` header |
| `TASK_LOGIN_TYPE` | `0` | Default login type on the form: 0 Email, 1 Clerk ID, 2 Clerk alpha name, 3 Clerk logon |
| `TASK_FIRST_PAGE_NO` | `1` | Number of the first page in TASK paging (check in UAT) |
| `TASK_PAGE_SIZE` | `100` | Page size for TASK list calls |
| `TASK_TIMEOUT_MS` | `20000` | Timeout for each TASK request |
| `PORT` | `3000` | Web server port |
| `SESSION_IDLE_MINUTES` | `30` | Idle minutes before sign-out |
| `COOKIE_SECURE` | true when `NODE_ENV=production` | Set `true` when served over HTTPS |
| `TRUST_PROXY` | (blank) | Number of proxies in front of the app (Azure + Cloudflare: `2`), so the sign-in rate limiter sees real clerk IPs |
| `CLOUDFLARE_ORIGIN_SECRET` | (blank) | When set, only requests with this `X-Origin-Verify` header (added by Cloudflare) are served; `/healthz` is exempt |
| `DISPLAY_TIMEZONE` | `Australia/Sydney` | Time zone for dates in the UI and emails |
| `COMPANY_NAME` | `Mad Mex` | Shown in the header and emails |
| `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` | (blank) | Turn on the admin panel. See [Admin panel](#admin-panel-microsoft-entra-sign-in) |
| `PUBLIC_BASE_URL` | (blank) | The app's https address (admin sign-in returns to `/admin/callback`) |
| `ADMIN_ALLOWED_OBJECT_IDS` / `ADMIN_ALLOWED_USERS` | (blank) | Who may open the admin panel |
| `ADMIN_SESSION_IDLE_MINUTES` / `ADMIN_SESSION_MAX_HOURS` | `30` / `8` | Admin session limits |
| `SETTINGS_ENCRYPTION_KEY` | (blank) | 32 random bytes (base64) that encrypt the saved API key |
| `DATA_DIR` | `data` | Saved settings and admin change history (persistent storage) |
| `TASK_ALLOWED_HOSTS` | `*.xchangefusion.com` | Servers the TASK address may point at (not editable in the panel) |
| `TASK_ENVIRONMENT_NAME` | from the URL | Environment name shown to clerks (editable in the panel) |
| `HUB_SUPABASE_URL` / `HUB_SUPABASE_KEY` | (blank) | Turn on the central hub sync. See [Central hub sync](#central-hub-supabase--task-clerk-sync) |
| `HUB_TABLE`, `HUB_SCHEMA`, `HUB_COL_*` | `public`, `id`, `first_name`, `last_name`, `email`, `is_active` | Hub table/view and column names |
| `SYNC_TASK_LOGIN_TYPE` / `SYNC_TASK_LOGIN` / `SYNC_TASK_PASSWORD` | (blank) | TASK clerk the sync signs in as |
| `SYNC_NEW_CLERK_GROUP_ID` / `SYNC_NEW_CLERK_VENUE_NO` | (blank) | Clerk group and home venue for new clerks |
| `SYNC_INTERVAL_MINUTES` | `15` | Automatic sync interval (0 = Sync now only) |
| `SYNC_MAX_DEACTIVATIONS` / `SYNC_MAX_CREATIONS` | `10` / `25` | Larger automatic runs are held for you to apply |
| `REQUIRE_VENUE_COST` | `true` | Only offer products that have a supplier cost for the location's venue |
| `PRODUCT_LOOKUP_CONCURRENCY` | `6` | Parallel `GET /products/{id}` calls when checking product status (1-20) |
| `MAIL_MODE` | `log` | `log` writes emails to `MAIL_OUTBOX_DIR`; `smtp` sends them |
| `MAIL_FROM` | (blank) | Sender address (required for `smtp`) |
| `MAIL_CC` | (blank) | Comma-separated copy addresses, e.g. a purchasing inbox |
| `MAIL_SHOW_PRICES` | `true` | Include costs and subtotal in the supplier email |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | (blank) / 587 / false / (blank) / (blank) | SMTP relay, from IT |

## TASK API endpoints used

All calls go to `{TASK_BASE_URL}/api/v3`. Every call sends the `Key` header. After sign-in, calls also send `Authorization: Bearer <AccessToken>`.

| Purpose | Endpoint |
|---|---|
| Clerk sign-in | `POST /auth/clerk/login` with `{ Login, Password, LoginType }` |
| Admin connection test (API key only) | `GET /auth/currentApp` |
| Clerk sync | `GET /clerks?clerkStatusFilter=2`, `GET /clerks/{id}`, `PUT /clerks`, `POST /clerks` |
| Central hub (Supabase REST) | `GET {HUB_SUPABASE_URL}/rest/v1/{HUB_TABLE}?select=<mapped columns>` |
| Clerk profile and permissions | `GET /auth/clerk/currentUser` |
| Locations (and their venue) | `GET /stock/stocklocations` |
| Suppliers (live, active only) | `GET /supplier`, `GET /supplier/{id}` |
| Supplier products and case sizes (live) | `GET /supplier/{id}/productCodes` |
| Supplier costs for a venue (live) | `GET /supplier/{id}/venueCosts?venueNo=` |
| Product status and name (live) | `GET /products/{productId}?locationNo=` |
| Stock on hand and min/max (live) | `GET /products/location/{locationNo}/stock/products?productIds=…` (50 products per call) |
| PO templates | `GET /purchaseOrder/templates`, `GET /purchaseOrder/templates/{id}/items` |
| Create / read / update / delete PO | `POST /purchaseOrder`, `GET`/`PUT`/`DELETE /purchaseOrder/{id}` |
| PO lines | `POST`/`GET /purchaseOrder/{id}/items`, `PUT /purchaseOrder/{id}/items/{itemId}` (received quantities) |
| POs to receive (live) | `GET /purchaseOrder?stockLocationNo=&orderStatus=` (statuses 1, 2, 3 and 10) |
| Supplier invoices (receiving) | `GET /invoice?supplierId=&reference=` (duplicate check), `POST /invoice`, `POST /invoice/{id}/items`, `GET`/`PUT /invoice/{id}` (complete), `DELETE /invoice/{id}` (rollback) |

Field names come from the TASK Swagger spec (`/swagger/docs/v3`).

## UAT checklist

Run these against UAT with `MAIL_MODE=log` before going live:

1. Sign in as a test clerk with each login type you plan to use.
2. Check the location and supplier lists. If items are missing or duplicated, try `TASK_FIRST_PAGE_NO=0`.
3. Send a PO, then open it in TASK and check:
   - supplier, location, `ClerkID`, status (Approved / Awaiting approval), delivery date and reference
   - each line's product, cases, units, `CaseQty`, `TotalUnits`, `ExGST` (case cost) and `UnitExGST` (unit cost)
   - whether TASK fills in GST and totals itself (`Subtotal`, `Tax`, `Total`, `IncGST`). This app sends **ex-GST** values only.
4. Confirm the supplier venue costs are ex GST, as the app assumes.
5. Confirm the live product checks:
   - Clerks' TASK accounts are allowed to call `GET /products/{id}`. If not, the product list shows a permission error.
   - `IsActive` on that call means "can be ordered" for your business.
   - The hidden-product counts make sense. If many products show "no supplier cost for this venue", either load venue costs in TASK or set `REQUIRE_VENUE_COST=false`.
   - The product list loads quickly enough for your largest supplier. It makes one product call per supplier product, `PRODUCT_LOOKUP_CONCURRENCY` at a time.
6. Confirm the stock figures:
   - Clerks are allowed to call the stock endpoint. It is tagged `[TaskApp]` in the TASK spec; if access is denied, the screen says stock levels are unavailable.
   - On hand matches what TASK shows for the store.
   - TASK stock is counted in the same units as PO **Units**, i.e. one case = `CaseQty` units. The suggested cases assume this.
   - Min and max levels are maintained in TASK for the products stores order.
7. Check the email in `./outbox`. Then switch to `MAIL_MODE=smtp` and send to an internal mailbox before sending to real suppliers.
8. Confirm the status rule suits your process. Only approvers' POs are emailed. Change this in `src/routes/orders.js` and `src/poService.js` if needed.
9. Confirm the admin panel:
   - Only you can sign in. Ask a colleague to try `/admin`: they should be refused, and the refusal should appear in the change history.
   - **Test current connection** succeeds with the UAT key, and a wrong key is refused.
   - Switching from UAT to production signs clerks out, and their next sign-in goes to production. Switch back afterwards.
10. Confirm the hub sync in UAT **before pointing it at production**. Use **Sync now** and read the preview each time:
   - **Passwords survive:** saving a clerk without `ClerkPassword` leaves their password unchanged. Check by signing in as an updated test clerk afterwards. **Do this first.**
   - **Other fields survive:** HR fields (date of birth, tax number, pay rate, address), groups and labour roles are unchanged after an update.
   - **New clerks work:** creating a clerk works with no password and the next logon number. If TASK needs a password or assigns logons itself, tell the developer.
   - **Deactivation behaves:** a deactivated clerk can't sign in to the POS, and reactivating restores access.
   - **The first sync:** check the name matches carefully before ticking them, and fix anything under "Needs attention".
11. Confirm receiving with a test PO, in this order:
   - **Booking stock in:** completing an invoice (`PUT /invoice/{id}` with `IsComplete: true`) adds the stock. Stock on hand should rise by the units received.
   - **No double counting:** TASK does **not** also update the PO's received quantities when an invoice linked to it (`PurchaseOrderNo`) is completed. The app updates the PO itself; if TASK does it too, the PO would be counted twice and the app's PO update should be removed.
   - **Invoice item fields:** `Cost` is the case cost ex GST, `UnitCost` the unit cost ex GST, and `CaseCount`/`UnitCount` the received quantities. Check the invoice total in TASK.
   - **GST:** the app does not send `TaxPercentage`. Check that TASK applies each product's GST rate on the invoice.
   - **Duplicate check:** `GET /invoice?reference=` finds an existing invoice number. The app also compares the number exactly, ignoring case.
   - **Permissions:** clerks with "create invoices" but not "commit invoices" can save an invoice, and a manager can then complete it in TASK.
   - **Statuses:** PO statuses `Stock received` (4) and `Partially received` (10) behave as expected in TASK reports.

## Development

```bash
npm test
```

The tests run against the fake TASK API in `test/mockTask.js`. They cover:
- sign-in and permissions
- session expiry and idle timeout
- live supplier and product checks: no caching, and hidden reasons
- send-time re-checks for price, product status, supplier status and supplier email
- stock levels, suggested cases, the 50-product chunking, and a stock failure not blocking orders
- admin panel: Entra sign-in (PKCE, state, nonce, replayed or forged callbacks, other users and other tenants refused, object-ID allow-list); key masking; connection tests; approved hosts only; saves that TASK rejects aren't stored; a change switching every TASK call to the new server and key and signing clerks out; encryption at rest and restart; change history without key material; changes from other websites blocked
- hub sync: preview changes nothing; matching by link, email, then name (approval-only, exact pairs); scheduled runs never apply name matches; only synced fields change and HR data and passwords are untouched; creation defaults; deactivation and reactivation; protected admins and the sync account; size limits held; an empty or unreachable hub changes nothing; TASK session renewal; links kept per TASK server; history without personal values
- hosting: `/healthz`, the Cloudflare-only origin header (including secret rotation), and `TRUST_PROXY` hop counts giving real clerk IPs to the rate limiter
- receiving: permissions; the open PO list; full, short and closed-short deliveries; invoices completed or left for a manager; cost changes; items not on the PO; deliveries with no PO; duplicate invoice numbers; rollback and partial failures; validation; double submits
- the full send flow, rollback, email retry and idempotency
- email escaping and the paging guard
- that the API key and tokens never appear in responses

```
src/
  server.js        start-up (reads .env)
  app.js           Express app, security headers, error handling
  config.js        environment settings and validation
  taskClient.js    TASK API client (Key + Bearer headers, paging, error mapping)
  session.js       in-memory sessions, cookie, idle timeout
  catalogue.js     locations; live suppliers, supplier products, venue costs, product status and stock; templates
  poService.js     order validation, PO creation with rollback, supplier email
  receiving.js     receipt validation, invoice + PO updates with rollback
  settings.js      live TASK URL/key/environment, encrypted at rest, change history
  admin/entra.js   Microsoft Entra ID sign-in (OpenID Connect) and the admin allow-list
  sync/            central hub (Supabase) reader and the hub -> TASK clerk sync
  emailTemplate.js supplier email (HTML + text)
  mailer.js        SMTP or log-to-outbox
  routes/          /api/login, /api/logout, /api/me, lookups, orders, receiving, admin
public/            browser UI (plain HTML/CSS/JS, no build step); admin.html + admin.js for /admin
test/              tests and fakes of the TASK API, Microsoft Entra and the Supabase hub
scripts/dev-mock.js demo mode
```
