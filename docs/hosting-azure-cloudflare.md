# Hosting: Azure App Service with Cloudflare in front

The PO app runs on **Azure App Service** (Linux, Node 22) in **Australia East**, behind **Cloudflare** (domain, HTTPS, firewall, rate limiting).

> These are first-draft steps for IT to review. Put every secret into **Azure Key Vault**, never into chat, email, tickets or GitHub.

## Why this set-up

The app is a long-running Node server. It:
- keeps sessions, sign-in attempts and the "one sync at a time" lock in **memory**;
- writes the encrypted TASK settings, admin change history and clerk links to a **`data` folder**;
- runs the hub sync on a **15-minute timer**;
- sends email over **SMTP**.

App Service runs all of that unchanged. It must be:
- **always on**, so the timer keeps running;
- **a single copy**, so sessions and the sync live in one place;
- set to keep `data` on **persistent storage**.

**Why not Cloudflare Workers or Containers on their own?** Workers keep nothing between requests and have no disk. Containers lose their disk on restart and sleep when idle. Either way the saved settings and sync links would be lost, everyone would be signed out at random, and the timer wouldn't fire. Running there needs a rebuild: Durable Objects/D1 for sessions and data, Cron Triggers for the sync, and a different email service. Cloudflare in front gives its security benefits without that.

```
Clerks / admin ──HTTPS──▶ Cloudflare (DNS, TLS, WAF, rate limits, adds X-Origin-Verify)
                              │
                              ▼
                 Azure App Service (Australia East, 1 instance, Always On)
                 Node 22 · /home/data (persistent) · secrets from Key Vault
                              │
            ┌─────────────────┼──────────────────┬───────────────┐
            ▼                 ▼                  ▼               ▼
        TASK API        Microsoft Entra     Supabase hub   Microsoft 365 SMTP
```

## 1. Azure resources

Use one web app for **UAT** (pointing at TASK UAT) and one for **production**. Each has its own settings and data folder. Deploy to UAT first.

The commands below are examples; the portal works too. Names such as `rg-task-po` are placeholders.

```bash
az group create --name rg-task-po --location australiaeast
```

```bash
az appservice plan create --name plan-task-po --resource-group rg-task-po --location australiaeast --is-linux --sku B1
```

```bash
az webapp create --name task-po-uat --resource-group rg-task-po --plan plan-task-po --runtime "NODE:22-lts"
```

```bash
az webapp config set --name task-po-uat --resource-group rg-task-po --always-on true --min-tls-version 1.2 --ftps-state Disabled --startup-file "npm start" --generic-configurations '{"healthCheckPath": "/healthz"}'
```

```bash
az webapp update --name task-po-uat --resource-group rg-task-po --https-only true
```

```bash
az webapp identity assign --name task-po-uat --resource-group rg-task-po
```

Then:
- **Scale out:** keep it at **1 instance**. Don't turn on autoscale.
- **Plan size:** B1 or B2 is plenty. P0v3 adds deployment slots, if you want them.

## 2. Secrets in Key Vault

```bash
az keyvault create --name kv-task-po --resource-group rg-task-po --location australiaeast --enable-rbac-authorization true
```

Give each web app's managed identity the **Key Vault Secrets User** role on the vault (portal: Key Vault → Access control (IAM) → Add role assignment).

Create these secrets in the vault through the portal, by the person who holds each value:

| Secret | Value |
|---|---|
| `task-api-key` | TASK API key for this environment |
| `entra-client-secret` | Entra app registration client secret |
| `settings-encryption-key` | `openssl rand -base64 32`; **never change it** after first use |
| `hub-supabase-key` | Supabase key that can read the hub view |
| `sync-task-password` | Password of the TASK sync clerk |
| `smtp-pass` | Password for the sending mailbox, when email is switched on |
| `cloudflare-origin-secret` | `openssl rand -hex 32`; the same value goes into Cloudflare (step 5) |

In the web app's **Environment variables**, reference them like this:

```
@Microsoft.KeyVault(VaultName=kv-task-po;SecretName=task-api-key)
```

## 3. App settings (web app → Environment variables)

| Setting | Value |
|---|---|
| `NODE_ENV` | `production` (secure cookies) |
| `PUBLIC_BASE_URL` | `https://po.<your domain>` (UAT: e.g. `https://po-uat.<your domain>`) |
| `TRUST_PROXY` | `2` (Cloudflare, then Azure's front end), so the sign-in rate limiter sees each clerk's real IP |
| `CLOUDFLARE_ORIGIN_SECRET` | Key Vault reference to `cloudflare-origin-secret` |
| `DATA_DIR` | `/home/data` (persistent; survives restarts and deploys) |
| `MAIL_OUTBOX_DIR` | `/home/data/outbox` (the app folder is read-only after a package deploy) |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `false` (the deploy package already includes `node_modules`) |
| `TASK_API_KEY`, `ENTRA_CLIENT_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `HUB_SUPABASE_KEY`, `SYNC_TASK_PASSWORD`, `SMTP_PASS` | Key Vault references |
| Everything else | as in `.env.example`: TASK, Entra, admin, hub sync, email |

Notes:
- **Email:** keep `MAIL_MODE=log` until purchasing has signed off the supplier email. Then use Microsoft 365: `SMTP_HOST=smtp.office365.com`, `SMTP_PORT=587`, and a mailbox with SMTP AUTH enabled.
- **Entra:** add `https://po.<your domain>/admin/callback` (and the UAT address) as **Web** redirect URIs on the app registration.
- **Allow-listed IPs:** if TASK (XchangeFusion) or Supabase only accept listed IPs, give them the web app's **Outbound IP addresses** (web app → Networking).

## 4. Deploying from GitHub

The workflow `.github/workflows/deploy-azure.yml` runs only when started from the **Actions** tab. It installs, runs all tests, packages, deploys and checks `/healthz`. It signs in to Azure with **GitHub OIDC**, so no Azure password is stored in GitHub.

Once:
1. **Create the deploy identity.** In Entra, create an app registration (or a user-assigned managed identity) for deploying. Give it the **Website Contributor** role on the two web apps only.
2. **Trust GitHub.** Under **Certificates & secrets → Federated credentials**, add a GitHub Actions credential:
   - organisation `00-Aidsn`, repository `TASK-PO`;
   - entity **Environment**, with values `uat` and `production` (one credential each).
3. **Set up the GitHub environments.** In GitHub → Settings → Environments, create `uat` and `production`. Add these **variables** to each (they are identifiers, not secrets):
   - `AZURE_CLIENT_ID`
   - `AZURE_TENANT_ID`
   - `AZURE_SUBSCRIPTION_ID`
   - `AZURE_WEBAPP_NAME`

   Give `production` **required reviewers**.

To deploy: **Actions → Deploy to Azure App Service → Run workflow**, then choose `uat` or `production`.

## 5. Cloudflare

For each hostname (`po` and, for UAT, `po-uat`):

1. **DNS:** add a CNAME `po` → `task-po-prod.azurewebsites.net`.
2. **Custom domain and certificate in Azure:**
   - Web app → Custom domains → Add. Azure asks for a TXT record `asuid.po`; add it in Cloudflare.
   - While Azure validates and issues the free managed certificate, set the `po` record to **DNS only** (grey cloud).
   - Once the certificate is bound, switch it back to **Proxied** (orange cloud).
3. **SSL/TLS:**
   - Mode **Full (strict)**.
   - Edge Certificates: **Always Use HTTPS** on, **Minimum TLS 1.2**.
4. **Origin header (Rules → Transform Rules → Modify Request Header):**
   - When the hostname equals `po.<your domain>`, **set** the header `X-Origin-Verify` to the `cloudflare-origin-secret` value.
   - The app refuses anything without it, except `/healthz`, so nobody can skip Cloudflare by using the `azurewebsites.net` address.
5. **Caching (Rules → Cache Rules):** when the hostname equals `po.<your domain>`, **Bypass cache**. It's a small internal app, and this avoids stale scripts after a deploy.
6. **Security → WAF:**
   - Managed rules: on.
   - **Rate limiting rule:** URI path is `/api/login` or `/admin/login`, e.g. 20 requests per minute per IP, then block for 10 minutes.
   - Optional custom rule: block requests where the country is not Australia, if stores never use it from overseas.
7. **Optional second lock on the admin panel:** in Zero Trust → Access → Applications, add a self-hosted application for `po.<your domain>/admin*`:
   - identity provider: Microsoft Entra ID;
   - policy: allow only the administrators' emails.

   Don't put Access on the whole app: clerks may not have Microsoft accounts.

## 6. First deploy checklist (UAT)

1. Run the workflow for `uat`.
2. Through Cloudflare, `https://po-uat.<your domain>/healthz` should return `{"status":"ok"}`.
3. Directly, `https://task-po-uat.azurewebsites.net/` should return **403** (that proves the origin header is working).
4. Sign in at `/admin` with Microsoft, then press **Test current connection**.
5. Sign in as a test clerk. Build and send a PO (email in log mode), then receive one.
6. In the admin panel, run **Preview sync**. Do the hub sync UAT checks in the README before applying.
7. **Restart** the web app. Check:
   - the admin settings and change history are still there;
   - clerks need to sign in again (expected);
   - the sync still runs on schedule (see "Last sync" in the admin panel).

## Day to day

- **Logs:** web app → Log stream, or App Service logs to a Log Analytics workspace.
- **Back up `/home/data`:** App Service **Backups** (Standard tier and up), or a scheduled copy. It holds the encrypted settings, the change history and the clerk links. Without `settings-encryption-key` the settings can't be read, so keep that secret backed up in Key Vault.
- **Rotating the Cloudflare origin secret without downtime:**
  1. Set `CLOUDFLARE_ORIGIN_SECRET` to `old,new` (comma-separated), then restart.
  2. Change the Cloudflare Transform Rule to `new`.
  3. Set the app to `new` only, then restart.
- **Entra client secret:** note its expiry date and rotate it before then.
- **Restarts:** App Service restarts and deploys sign everyone out (sessions live in memory). The app stops cleanly on `SIGTERM`: it finishes a running sync and open requests first, for up to 15 seconds.
