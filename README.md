# TASK Purchase Orders

A small web app for Mad Mex clerks to build a purchase order (PO) in **TASK** (XchangeFusion API v3) and send it to the supplier.

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
- Clerks without the TASK permission `CanCreatePurchaseOrders` are refused at sign-in.
- Repeated failed sign-ins are rate-limited per IP: 10 per 15 minutes.
- Sessions are held in memory, so restarting the server signs everyone out.

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
| `manager@example.com` | Can create and approve: POs are approved and emailed |
| `crew@example.com` | Can create only: POs are saved as Awaiting approval |
| `viewer@example.com` | No PO permission: sign-in is refused |

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
| `TRUST_PROXY` | (blank) | Set if behind a reverse proxy, e.g. `1` |
| `DISPLAY_TIMEZONE` | `Australia/Sydney` | Time zone for dates in the UI and emails |
| `COMPANY_NAME` | `Mad Mex` | Shown in the header and emails |
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
| Clerk profile and permissions | `GET /auth/clerk/currentUser` |
| Locations (and their venue) | `GET /stock/stocklocations` |
| Product names | `GET /lookup/products` |
| Suppliers | `GET /supplier`, `GET /supplier/{id}` |
| Supplier products and case sizes | `GET /supplier/{id}/productCodes` |
| Supplier costs for a venue | `GET /supplier/{id}/venueCosts?venueNo=` |
| PO templates | `GET /purchaseOrder/templates`, `GET /purchaseOrder/templates/{id}/items` |
| Create / read / update / delete PO | `POST /purchaseOrder`, `GET`/`PUT`/`DELETE /purchaseOrder/{id}` |
| PO lines | `POST`/`GET /purchaseOrder/{id}/items` |

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
5. Check the email in `./outbox`. Then switch to `MAIL_MODE=smtp` and send to an internal mailbox before sending to real suppliers.
6. Confirm the status rule suits your process. Only approvers' POs are emailed. Change this in `src/routes/orders.js` and `src/poService.js` if needed.

## Development

```bash
npm test
```

The tests run against the fake TASK API in `test/mockTask.js`. They cover:
- sign-in and permissions
- session expiry and idle timeout
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
  catalogue.js     locations, suppliers, product catalogue and costs, templates
  poService.js     order validation, PO creation with rollback, supplier email
  emailTemplate.js supplier email (HTML + text)
  mailer.js        SMTP or log-to-outbox
  routes/          /api/login, /api/logout, /api/me, lookups, orders
public/            browser UI (plain HTML/CSS/JS, no build step)
test/              tests and the fake TASK API
scripts/dev-mock.js demo mode
```
