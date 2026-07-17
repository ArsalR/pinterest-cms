# OWNER_RUNBOOK.md — everything to do outside code, in order

Written for a semi-technical owner. Each step ends with **Verify**. Do them top to
bottom. Nothing here is optional before flipping `SAAS_MODE` on.

Assumes: `arsal.app` is a Cloudflare zone you control, `wrangler` is installed and
logged in (`npx wrangler login`), and you're in the repo directory.

---

## 1. Secrets (run each; paste the value when prompted)

Each command: `npx wrangler secret put <NAME>`.

| Secret | Where the value comes from |
|---|---|
| `JWT_SECRET` | `openssl rand -hex 32` — tenant admin sessions |
| `SAAS_JWT_SECRET` | `openssl rand -hex 32` — **MUST be different from JWT_SECRET** |
| `VAULT_MASTER_KEY` | `openssl rand -hex 32` (≥32 bytes) — credential vault root |
| `TURSO_MASTER_URL` / `TURSO_MASTER_TOKEN` | Turso master DB (turso.tech) |
| `TURSO_API_TOKEN` | Turso account API token (for provisioning per-site DBs) |
| `NETWORK_ADMIN_KEY` | `openssl rand -hex 32` |
| `RESEND_API_KEY` | Resend → API Keys (Sending access only) — see §3 |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | GitHub App — see §4 (`GITHUB_APP_SETUP.md`) |
| `PLATFORM_STRIPE_SECRET_KEY` | Stripe → Developers → API keys (secret key) — see §5 |
| `PLATFORM_STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret — see §5 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth — `OAUTH_SETUP.md` |
| `PINTEREST_APP_ID` / `PINTEREST_APP_SECRET` | Pinterest developer app — `OAUTH_SETUP.md` |

Non-secret vars go in `wrangler.toml [vars]`: `SAAS_APP_HOSTNAME = "arsal.app"`,
`GITHUB_APP_SLUG`, optionally `SAAS_PRICE_STARTER_CENTS`, `SAAS_PRICE_AGENCY_CENTS`,
`SAAS_TRIAL_DAYS`. Leave `SAAS_MODE = ""` until §8.

**Verify:** `npx wrangler secret list` shows every name above. `JWT_SECRET` and
`SAAS_JWT_SECRET` were generated separately (re-run the two `openssl` commands if unsure —
never paste the same value into both; the code now rejects cross-use, but keep them
distinct anyway).

## 2. Route DNS + Worker

1. In Cloudflare, add a Worker route so `arsal.app/*` **and** `*.cms.arsal.app/*` hit this
   Worker (`SAAS_CMS_HOST_SUFFIX` defaults to `cms.arsal.app`).
2. Add a DNS record for `*.cms.arsal.app` (proxied) pointing at the Worker.

**Verify:** `dig +short arsal.app` resolves to Cloudflare; after deploy,
`curl -s https://arsal.app/__health` returns `{"ok":true,...}`.

## 3. Resend (email) — do FIRST, no review lag

1. resend.com → Domains → add `arsal.app`.
2. Add the SPF (TXT), 3× DKIM (CNAME), optional DMARC records on the `arsal.app` zone.
3. Wait for "Verified", create a Sending-access API key, `wrangler secret put RESEND_API_KEY`.

**Verify:** `dig +short TXT arsal.app` shows the SPF include; Resend dashboard shows the
domain "Verified". Until set, email runs in dev-log mode (no mail sent) — safe but no
verification/reset emails.

## 4. GitHub App

Follow `GITHUB_APP_SETUP.md`. Current callback/setup URL:
`https://arsal.app/app/connections/github/callback`. Permissions: Contents R/W, Actions
R/W, Administration R/W, Secrets R/W, Workflows R/W, Metadata R. Convert the downloaded
PKCS#1 key to PKCS#8 before `wrangler secret put GITHUB_APP_PRIVATE_KEY`. Set
`GITHUB_APP_SLUG` in `[vars]`.

**Verify:** the Connections page shows "Connect GitHub" (not "temporarily unavailable")
once `SAAS_MODE` is on.

## 5. Stripe (platform billing)

1. Stripe → Developers → API keys → copy the **secret key** →
   `wrangler secret put PLATFORM_STRIPE_SECRET_KEY`. (Start in **test mode**.)
2. Developers → Webhooks → Add endpoint:
   - URL: `https://arsal.app/api/saas/billing-webhook`
   - Events: `checkout.session.completed`, `customer.subscription.updated`,
     `customer.subscription.deleted`
3. Copy that endpoint's **Signing secret** → `wrangler secret put PLATFORM_STRIPE_WEBHOOK_SECRET`.
4. No products/prices to create — the code sends inline recurring prices from
   `SAAS_PRICE_*_CENTS` (defaults $29 / $79).
5. **Test → live switch:** repeat 1–3 with live-mode keys/endpoint before real customers.

**Verify (test mode):** on `/app/billing`, "Choose Starter" opens Stripe Checkout; pay with
`4242 4242 4242 4242`; within seconds the page shows the active plan (webhook applied it).
Stripe → Webhooks shows a 200 delivery. If it shows 401, the signing secret is wrong.

## 6. Template repo

Publish the `site-template/` directory to `ArsalR/site-template`; in its GitHub settings
enable **Template repository**.

**Verify (Part G — do this before launch):**
```
git clone https://github.com/ArsalR/site-template && cd site-template
npm install && npm run build          # succeeds with only site.config.json
npm run check:zero-js && npm run check:headers && node scripts/check-seo-files.mjs && npm run lhci
```
Then deliberately break one gate (add a `<script>` to a page, drop a header from
`public/_headers`, delete `sitemap` generation) and confirm the matching CI step FAILS.

**Every preset is covenant-checked automatically.** The template ships a
`.github/workflows/preset-matrix.yml` that builds the site once per design preset
(modern / editorial / bold / calm / warm / tech) against a stub CMS and runs the
zero-JS + security-header + SEO gates on each. Nothing to do — just confirm the
"Preset covenant matrix" check is green on the template repo's Actions tab after
you publish it. Adding a new preset later requires adding it to that matrix (the
platform's `design.test.ts` enforces this).

## 6b. Four demo sites (also your permanent end-to-end smoke test)

Once `SAAS_MODE` is on and provisioning works (§8), create **four** demo sites
through the **real dashboard flow** — one per kind, each on a different preset —
on platform-owned subdomains. These are what the public `/examples` gallery links
to, and they double as your standing smoke test.

| Subdomain | Kind | Preset |
|---|---|---|
| `demo-blog.arsal.app` | Blog / content | editorial |
| `demo-shop.arsal.app` | Online store | modern |
| `demo-local.arsal.app` | Local business | warm |
| `demo-folio.arsal.app` | Portfolio | bold |

1. Add each subdomain as a zone/route on the platform's own Cloudflare account.
2. In the dashboard (signed in as a platform-owned account), **Add site** → pick the
   kind, preset, and a layout for each; let genesis run.

**Verify:** each demo builds green through its covenant gates and is live at its
subdomain; the four gallery cards on `https://arsal.app/examples` link to working
demos. **Re-run this after any platform deploy** — re-genesis one demo and confirm
it still goes live cleanly; that's the fastest full-pipeline health check you have.

## 7. OAuth verification status (Google / Pinterest)

Start both submissions now (weeks of review). Add yourself as a Google **test user** so
Phase-7 dev isn't blocked. GSC/Pinterest stay "available soon" in the UI until their
secrets are set — no launch dependency.

**Verify:** Google Cloud console shows the app in "Testing" with your account as a test
user; Pinterest shows "Trial access" granted.

## 8. Launch sequence — flipping `SAAS_MODE` on

**Pre-flight checklist (all must be true):**
- [ ] §1 secrets all listed; `JWT_SECRET ≠ SAAS_JWT_SECRET`.
- [ ] `curl https://arsal.app/__health` → ok.
- [ ] A tenant CMS site still serves normally (SaaS is inert today — confirm no regression).
- [ ] Part G cold-build + break test passed (§6).
- [ ] Stripe test-mode checkout end-to-end worked (§5).

**The flip:** in `wrangler.toml [vars]` set `SAAS_MODE = "1"` and `SAAS_APP_HOSTNAME =
"arsal.app"`, then `npx wrangler deploy`.

**10-item post-flip smoke test:**
1. `curl https://arsal.app/` → marketing homepage (200).
2. `/privacy` and `/terms` render.
3. Sign up a test account → verification email arrives (or dev-log if Resend unset).
4. Verify email → land in dashboard.
5. Connections page shows GitHub/Cloudflare steps.
6. Add a Cloudflare token → it verifies and stores.
7. `/app/billing` shows both tiers; test checkout activates the plan.
8. A **tenant** CMS site (existing) still serves byte-identically — spot-check one public
   post + `/api/public/v1/status` returns the same shape as before.
9. `/api/public/v1/capabilities` on a tenant still lists the same endpoints.
10. Dashboard responses carry `X-Frame-Options: DENY` (`curl -I https://arsal.app/app/login`).

**Rollback switch:** if anything smells wrong, set `SAAS_MODE = ""` and redeploy — the SaaS
layer goes fully inert and tenant behavior is byte-identical again. No data migration needed.

## 9. First-real-customer watch (first 48h)
- **Cloudflare Workers logs** (`npx wrangler tail`): watch for `provision <id> <step> failed`
  and any 500s on `/api/saas/*`.
- **Audit log** (master DB `audit_log`): confirm `connection.saved`, `site.provision_completed`,
  `billing.plan_updated` appear for the customer; investigate any `connection.verify_failed`
  or `site.provision_failed`.
- **Stripe → Webhooks**: all deliveries 200. A 401 = signing-secret mismatch (re-do §5.3).
- **Provisioning**: if a site sticks in "provisioning", the dashboard's Retry re-runs from the
  failed step (resume is safe — tested). Check the step's plain-language error first.
