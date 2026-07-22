# GO_LIVE.md — the launchbook

**The single, current, correct path to take the platform live.** Execute top to
bottom; each step has **Do → Verify**. This supersedes scattered launch notes.
Deeper detail lives in `OWNER_RUNBOOK.md`, `GITHUB_APP_SETUP.md`,
`OAUTH_SETUP.md`; the exhaustive step list is `LAUNCH_CHECKLIST.md`. When a doc
and the code disagree, the code wins.

> **What you're launching:** a multi-tenant platform where customers sign up at
> `app.<yourdomain>`, connect *their own* GitHub + Cloudflare, and get an
> AI-built, covenant-guaranteed website (fast, secure, zero-JS, SEO-perfect)
> with a full business stack — store, forms, mailbox, analytics, ad pixels,
> sub-sites. One Cloudflare Worker serves every tenant.
>
> **Time to live:** ~2–3 focused hours (excluding third-party review queues:
> GitHub App is instant; Google/Pinterest OAuth verification is weeks and is
> **not** on the critical path — those features self-gate until approved).

---

## 0. Accounts & plan — 20 min

**Do:** confirm sign-in to **Cloudflare** (with the zone you'll use, e.g.
`arsal.app`) and **enable the Workers Paid plan**, plus **Turso**, **GitHub**
(the org that owns the template repo), and — optional, feature-gated —
**Resend/Brevo/SendGrid**, **Stripe**, **Google Cloud**, **Pinterest**,
**Anthropic**.

**Why Paid:** PBKDF2 auth + provisioning need the CPU. On the free plan
`wrangler.toml` must not carry a `[limits]` block — it doesn't, so don't add one.

**Verify:** Cloudflare → Workers → Plan shows **Paid**; Turso dashboard opens.

---

## 1. Clone, install, gates green — 10 min

```bash
git clone https://github.com/ArsalR/pinterest-cms && cd pinterest-cms
npm install
npm run typecheck        # clean
npm test                 # 565 passing
npm run lint:structure   # DAG + barrel gate OK
```

**Verify:** all three pass locally. (CI runs the same three on every push/PR.)

---

## 2. Master database — 10 min

The master DB maps hostname → per-site credentials and holds the SaaS tables.

**Do:**
```bash
turso db create pinterest-cms-master
turso db show pinterest-cms-master --url            # → TURSO_MASTER_URL
turso db tokens create pinterest-cms-master         # → TURSO_MASTER_TOKEN
turso db shell pinterest-cms-master < src/schemas/master.sql
```
The SaaS tables (customers, connections, provisioning, sub-sites, …) are then
created/upgraded automatically by the **master migration runner**
(`src/shared/masterMigrate.ts`, v1–v15) on first request — no manual step.

**Verify:** `turso db shell pinterest-cms-master ".tables"` shows `sites`.

---

## 3. `wrangler.toml` vars — 5 min

Edit `[vars]` (non-secret) for your network:

```toml
TURSO_ORG              = "<your-turso-org>"
NETWORK_ADMIN_HOSTNAME = "<your workers.dev or admin host>"
R2_PUBLIC_URL          = "https://<your-r2-public-host>"
# ── turn the SaaS platform ON ──
SAAS_MODE              = "1"
SAAS_APP_HOSTNAME      = "app.<yourdomain>"      # where customers sign up
GITHUB_APP_SLUG        = "<your-github-app-slug>" # from step 5
SAAS_TEMPLATE_REPO     = "ArsalR/site-template"   # the customer site template
SAAS_CMS_HOST_SUFFIX   = "cms.<yourdomain>"       # per-site CMS API hostnames
# ── optional: built-in analytics (V1.5 M3) ──
FEATURE_ANALYTICS      = "1"     # leave "" to keep analytics off platform-wide
```
The `ANALYTICS` Analytics-Engine binding and the R2 bucket are already declared
in `wrangler.toml` — no edit needed.

**Verify:** `SAAS_MODE = "1"` and `SAAS_APP_HOSTNAME` are set.

---

## 4. Secrets — 20 min

Set via `npx wrangler secret put <NAME>`. **Required to boot:**

| Secret | What it is |
|---|---|
| `TURSO_MASTER_URL` / `TURSO_MASTER_TOKEN` | master DB (step 2) |
| `TURSO_API_TOKEN` | Turso Platform API — provisions each new site's DB |
| `CF_API_TOKEN` / `CF_ACCOUNT_ID` / `CF_ZONE_ID` | Cloudflare API (deploy, DNS, cache purge, AE query) |
| `JWT_SECRET` | admin session signing (per-site CMS) |
| `NETWORK_ADMIN_KEY` | network-admin header key |
| `SAAS_JWT_SECRET` | customer session signing (separate from `JWT_SECRET`) |
| `VAULT_MASTER_KEY` | hex ≥32 bytes — HKDF root for the customer credential vault |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | platform GitHub App (step 5) |

**Feature-gated (set when you enable that feature — each self-gates if unset):**
`RESEND_API_KEY` (transactional email; dev-logs if absent) ·
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (Search Console — `OAUTH_SETUP.md`) ·
`PINTEREST_APP_ID`/`PINTEREST_APP_SECRET` (`OAUTH_SETUP.md`) ·
`PLATFORM_STRIPE_SECRET_KEY`/`PLATFORM_STRIPE_WEBHOOK_SECRET` (platform billing).

```bash
# generate strong secrets:
openssl rand -hex 32     # JWT_SECRET, SAAS_JWT_SECRET, NETWORK_ADMIN_KEY, VAULT_MASTER_KEY
```

**Verify:** `npx wrangler secret list` shows the 8 required names above.

---

## 5. GitHub App — 20 min

The platform installs a GitHub App into each customer's account to create + push
their site repo. Full walkthrough: **`GITHUB_APP_SETUP.md`**.

**Do (summary):** create a GitHub App → permissions: Contents (RW),
Administration (RW, to create repos), Workflows (RW) → generate a private key →
put `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` as secrets, and the app **slug**
into `GITHUB_APP_SLUG` (step 3). Set the callback to
`https://app.<yourdomain>/app/connections/github/callback`.

**Verify:** the App's public install page loads at
`https://github.com/apps/<your-github-app-slug>`.

---

## 6. R2 media bucket — 5 min

**Do:**
```bash
npx wrangler r2 bucket create cms-media          # name matches wrangler.toml
```
Enable public access (or a custom domain) and put that host in `R2_PUBLIC_URL`.

**Verify:** `R2_PUBLIC_URL` resolves; the binding name in `wrangler.toml` is
`R2_BUCKET` → bucket `cms-media`.

---

## 7. Deploy + DNS — 15 min

**Do:**
```bash
npm run deploy                    # wrangler deploy → CI also deploys on push to main
```
Then in Cloudflare, route the app hostname to the Worker:
- `app.<yourdomain>` → this Worker (Workers Routes / Custom Domain)
- `*.cms.<yourdomain>` (or your `SAAS_CMS_HOST_SUFFIX`) → this Worker (per-site
  CMS API hostnames are created during provisioning)

**Verify:**
```bash
curl -s https://app.<yourdomain>/__health      # → {"ok":true,"ts":...}
```
and `https://app.<yourdomain>/` returns the marketing home, `/app` the sign-in.

---

## 8. Smoke-test a real customer site — 30 min

This is the true "it works" test — drive the platform as a customer would.

**Do:**
1. `https://app.<yourdomain>/app/signup` → create a test customer account.
2. **Connections** → connect **GitHub** (install the App) and **Cloudflare**
   (paste an API token for a zone you control). Both go green.
3. **Sites → Add a site** → pick a domain on that zone, a kind, a niche →
   **Create**. Watch the provisioning timeline run to **active** (repo created,
   built through the covenant gates, deployed, domain attached — typically < 10
   min).
4. Open the live site; edit it by prompt from the dashboard.

**Verify:** the customer's site is live on its domain, scores well on
Lighthouse, ships **zero client JS**, and the SEO cockpit shows the per-page
**Optimization Report** green.

---

## 9. Turn on built-in analytics (optional, V1.5 M3) — 5 min

The **one** platform-level V1.5 toggle. Everything else is per-customer/in-app.

**Do:** confirm `FEATURE_ANALYTICS = "1"` (step 3) and the `ANALYTICS` dataset
binding (shipped in `wrangler.toml`), then `npm run deploy`. In a customer site:
**Insights → Turn analytics on**.

**Verify:** visit the published pages; within 24 h (after the nightly rollup on
the `0 4 * * *` cron) Insights shows page-views. Until then it reads
"collecting" — nothing breaks if you skip this.

---

## ✅ Definition of done — you are LIVE when all are true

1. `curl https://app.<yourdomain>/__health` → `{"ok":true}` and `/` returns 200.
2. `npx wrangler secret list` contains the 8 required secrets.
3. A test customer signed up, connected GitHub + Cloudflare, and provisioned a
   site that reached **active** and is live on its own domain.
4. That site: Lighthouse strong · **zero client JS** · security headers present
   · sitemap/robots/RSS served · Optimization Report green.
5. `npm run deploy` (or push to `main`) completes; `npx wrangler deployments
   list` shows the deploy.

---

## What needs zero owner action (per-customer, in-app)

- **Mailbox** — customer enables Cloudflare Email Routing + adds a provider key.
- **Integrations** — customers mint scoped `sk_site_…` keys + event webhooks;
  `/api/public/v1/openapi.json` is public.
- **Ad pixels** — paste a pixel ID in Site scripts; budget + consent gates are
  automatic; DuckDuckGo is covered by Bing.
- **Sub-sites** — "Add a subdomain/subdirectory site" reuses the customer's own
  zone (the only per-site infra is their DNS/route).
- **Always-optimized** — AEO baseline, IndexNow-on-publish and the per-page
  Optimization Report are on by default.

## If something's off

- **Provisioning stuck/failed:** open the site's timeline in the dashboard →
  **Retry** (the pipeline is idempotent + resumable). Most failures are a
  missing/short-scoped Cloudflare or GitHub token — re-connect and retry.
- **`/__health` 200 but `/app` blank:** `SAAS_MODE` isn't `"1"` or the request
  isn't on `SAAS_APP_HOSTNAME`. Fix the var, redeploy.
- **Emails not arriving:** `RESEND_API_KEY` unset → the platform logs emails
  instead of sending (dev mode). Set the secret to send for real.
- **Analytics empty:** `FEATURE_ANALYTICS` must be `"1"` **and** the customer
  must toggle analytics on; first data appears after the nightly rollup.
- **Watch logs:** `npm run tail`.
