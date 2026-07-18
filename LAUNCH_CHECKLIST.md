# LAUNCH_CHECKLIST.md — the one list you execute top to bottom

This replaces the scattered notes (OWNER_RUNBOOK.md remains as reference detail;
GITHUB_APP_SETUP.md and OAUTH_SETUP.md are linked where needed). Every step has:
**Do** (exact commands/clicks) · **Unblocks** (why it's here) · **Verify** (how you
know it worked) · **Time** (realistic, excluding third-party review queues).

Steps marked **[V1.3]** were added by the specialist-profiles release.

Assumes: `arsal.app` is a Cloudflare zone you control; `wrangler` installed and
logged in (`npx wrangler login`); you're in the repo directory.

---

## 0. Accounts & plan — 20 min

**Do:** confirm you can sign in to: Cloudflare (with `arsal.app` zone),
**Workers Paid plan enabled** (locked decision — PBKDF2 + provisioning need it),
Turso, GitHub (org `ArsalR`), Resend, Stripe, Google Cloud, Pinterest developers,
Anthropic console.
**Unblocks:** everything below.
**Verify:** Cloudflare → Workers → Plan shows "Paid". Turso dashboard opens.
**Time:** 20 min (mostly password hunting).

## 1. Template repo — 30 min

**Do:**
1. Publish `site-template/` to `ArsalR/site-template`; in repo Settings enable
   **Template repository**.
2. Cold-build proof on your machine:
   ```
   git clone https://github.com/ArsalR/site-template && cd site-template
   npm install && npm run build
   npm run check:zero-js && npm run check:headers && node scripts/check-seo-files.mjs
   ```
**Unblocks:** provisioning (every customer site is generated from this template);
the preset covenant matrix (runs automatically in the template repo's Actions).
**Verify:** build + all three gates green locally; after first push, the
"Preset covenant matrix" check is green on the template repo's Actions tab
(6 presets × gates, against the stub CMS).
**Note [V1.3]:** the V1.3 audit already executed the deliberate gate-break drill
(script injection / dropped header / deleted robots.txt / over-budget script
selection — all blocked) and a **live Lighthouse run passed (perf/SEO/BP 1.0)**
on the worst-case all-profiles build. You don't need to repeat it; the matrix CI
keeps it honest.
**Time:** 30 min.

## 2. DNS — all records in one table — 30 min (+ propagation)

**Do:** on the `arsal.app` zone in Cloudflare:

| Record | Type | Name | Value / target | Proxied | Purpose |
|---|---|---|---|---|---|
| Apex route | Worker route | `arsal.app/*` | this Worker | — | SaaS dashboard + marketing |
| CMS wildcard route | Worker route | `*.cms.arsal.app/*` | this Worker | — | per-site CMS hostnames |
| CMS wildcard DNS | CNAME | `*.cms` | `arsal.app` | ✅ | resolves the wildcard |
| Resend SPF | TXT | `@` | value from Resend | — | email deliverability |
| Resend DKIM ×3 | CNAME | from Resend | from Resend | — | email signing |
| DMARC (optional) | TXT | `_dmarc` | `v=DMARC1; p=none;` | — | email policy |
| Demo: blog | CNAME | `demo-blog` | `arsal.app` | ✅ | demo/smoke site (§9) |
| Demo: shop | CNAME | `demo-shop` | `arsal.app` | ✅ | demo/smoke site |
| Demo: local | CNAME | `demo-local` | `arsal.app` | ✅ | demo/smoke site |
| Demo: portfolio | CNAME | `demo-folio` | `arsal.app` | ✅ | demo/smoke site |

Start the Resend domain verification NOW (resend.com → Domains → add
`arsal.app`, then the SPF/DKIM rows above) — it has no review lag but DNS can
take an hour.
**Unblocks:** health check, email, demo sites, per-site CMS hosts.
**Verify:** `dig +short arsal.app` → Cloudflare IPs; Resend shows "Verified";
after §6 deploy, `curl -s https://arsal.app/__health` → `{"ok":true,...}`.
**Time:** 30 min hands-on.

## 3. GitHub App — 45 min

**Do:** follow `GITHUB_APP_SETUP.md`. Callback/setup URL:
`https://arsal.app/app/connections/github/callback`. Permissions: Contents R/W,
Actions R/W, Administration R/W, Secrets R/W, Workflows R/W, Metadata R.
Convert the downloaded key: PKCS#1 → PKCS#8 (command in the setup doc) before
storing it. Set `GITHUB_APP_SLUG` in `wrangler.toml [vars]`.
**Unblocks:** customer repos, builds, deploys — the whole provisioning pipeline.
**Verify:** §6's Connections page shows "Connect GitHub" (not "temporarily
unavailable").
**Time:** 45 min.

## 4. Secrets — complete current inventory — 30 min

**Do:** for each, `npx wrangler secret put <NAME>`:

| Secret | Source |
|---|---|
| `JWT_SECRET` | `openssl rand -hex 32` (tenant admin sessions) |
| `SAAS_JWT_SECRET` | `openssl rand -hex 32` — **must differ from JWT_SECRET** |
| `VAULT_MASTER_KEY` | `openssl rand -hex 32` (credential vault root) |
| `TURSO_MASTER_URL` / `TURSO_MASTER_TOKEN` | Turso master DB |
| `TURSO_API_TOKEN` | Turso account API token (per-site DB provisioning) |
| `NETWORK_ADMIN_KEY` | `openssl rand -hex 32` |
| `RESEND_API_KEY` | Resend → API Keys (Sending access) |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | §3 |
| `PLATFORM_STRIPE_SECRET_KEY` | §5 (test mode first) |
| `PLATFORM_STRIPE_WEBHOOK_SECRET` | §5 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | `OAUTH_SETUP.md` (§11) |
| `PINTEREST_APP_ID` / `PINTEREST_APP_SECRET` | `OAUTH_SETUP.md` (§11) |

Non-secret `[vars]`: `SAAS_APP_HOSTNAME="arsal.app"`, `GITHUB_APP_SLUG`,
optionally `SAAS_PRICE_STARTER_CENTS` / `SAAS_PRICE_AGENCY_CENTS` /
`SAAS_TRIAL_DAYS`. **Leave `SAAS_MODE = ""` until §7.**

**[V1.3] Nothing new to add here** — by design:
- ✨ **AI assists** use each customer's own Anthropic key from their vault
  (no platform key, no platform bill).
- **IndexNow keys** are generated automatically per site on the first publish
  ping (News profile) and served at `/<key>.txt` by the template — zero setup.
- **Edge bot protection** uses each customer's own Cloudflare token — but see
  the **[V1.3] token permission** note in §8.

**Unblocks:** deploys that boot; vault; email; billing.
**Verify:** `npx wrangler secret list` shows every name; the two JWT secrets
were generated by separate `openssl` runs.
**Time:** 30 min.

## 5. Stripe test mode — 30 min

**Do:**
1. Stripe (test mode) → Developers → API keys → secret key →
   `wrangler secret put PLATFORM_STRIPE_SECRET_KEY`.
2. Developers → Webhooks → Add endpoint
   `https://arsal.app/api/saas/billing-webhook`, events:
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`.
3. Endpoint signing secret → `wrangler secret put PLATFORM_STRIPE_WEBHOOK_SECRET`.
   (No products to create — prices are sent inline from `SAAS_PRICE_*_CENTS`.)
**Unblocks:** billing pages, trials → paid.
**Verify:** deferred to smoke item 7 (§8) — needs `SAAS_MODE` on.
**Time:** 30 min.

## 6. Deploy (SaaS still off) — 15 min

**Do:** `npx wrangler deploy` (or push to `main` — CI deploys).
**Unblocks:** health check, tenant regression check before the flip.
**Verify:** `curl -s https://arsal.app/__health` → ok; an existing tenant CMS
site serves normally (SaaS layer is inert with `SAAS_MODE=""`);
`curl -s https://<tenant>/api/public/v1/status` returns the usual shape.
**Time:** 15 min.

## 7. The flip — 10 min

**Pre-flight (all true?):** §4 secrets listed · health ok · tenant regression
ok (§6) · template cold build green (§1) · Stripe test webhook configured (§5).
**Do:** set `SAAS_MODE = "1"` in `wrangler.toml [vars]` → `npx wrangler deploy`.
**Rollback:** set `SAAS_MODE = ""` and redeploy — the SaaS layer goes fully
inert; tenant behavior is byte-identical again; no data migration.
**Time:** 10 min.

## 8. 10-item post-flip smoke test — 30 min

1. `curl https://arsal.app/` → marketing homepage (200).
2. `/privacy` and `/terms` render.
3. Sign up a test account → verification email arrives.
4. Verify email → land in the dashboard.
5. Connections shows GitHub + Cloudflare steps.
   **[V1.3]** When creating your Cloudflare token from the wizard's template,
   confirm it includes the new **Zone → Firewall Services → Edit** permission —
   it powers the edge bot protection. (Existing tokens without it still work;
   the edge toggles will tell you exactly what's missing and how to fix it.)
6. Paste the Cloudflare token → verifies and stores.
7. `/app/billing` → "Choose Starter" opens Stripe Checkout → pay with
   `4242 4242 4242 4242` → plan activates within seconds; Stripe → Webhooks
   shows a 200 delivery (401 = wrong signing secret).
8. An existing **tenant** site still serves identically — spot-check one post
   + `/api/public/v1/status`.
9. Tenant `/api/public/v1/capabilities` lists the same endpoints as before the
   flip **plus** the additive V1.2/V1.3 ones (`/v1/seo`, `/v1/seo-settings`,
   `/v1/local`, `/v1/authors`, `/v1/merchant`).
10. `curl -I https://arsal.app/app/login` → `X-Frame-Options: DENY`.

**Time:** 30 min.

## 9. Provision the four demo sites (your permanent smoke test) — 1–2 h

**Do:** signed in as a platform-owned account, **Add site** ×4 through the real
dashboard flow (DNS rows already exist from §2):

| Subdomain | Kind | Preset | Profiles seeded automatically **[V1.3]** |
|---|---|---|---|
| `demo-blog.arsal.app` | content | editorial | image |
| `demo-shop.arsal.app` | ecommerce | modern | ecommerce + image |
| `demo-local.arsal.app` | local-business | warm | local |
| `demo-folio.arsal.app` | portfolio | bold | — |

**[V1.3] extra demo checks while you're here:**
- On `demo-local`: SEO → Business info → fill NAP + hours → confirm the contact
  page shows address/hours/map and the homepage schema carries LocalBusiness.
- On `demo-shop`: SEO → Merchant SEO → set shipping/returns → confirm
  `https://demo-shop.arsal.app/feed.xml` fills; **submit that URL in Google
  Merchant Center** when you're ready to list products.
- On `demo-blog`: toggle the News profile → publish a post → confirm
  `/news-sitemap.xml` exists and the sitemap index references it; the IndexNow
  key file appears at `/<key>.txt` automatically after the first publish.
- Optional: connect your own Anthropic key on the platform account → the ✨
  buttons appear in the cockpit (they're hidden without it — that's correct).
**Verify:** all four live at their subdomains; the `/examples` gallery cards
link to them. **Re-run one demo genesis after every platform deploy** — it's
your fastest full-pipeline health check.
**Time:** 1–2 h.

## 10. Lighthouse on a live demo — 15 min

**Do:** `npx lighthouse https://demo-blog.arsal.app/ --preset=desktop --quiet`
(or PageSpeed Insights in a browser) on one demo per kind.
**Unblocks:** confidence that live ≈ audited. The V1.3 audit already ran LHCI
against the worst-case build (perf/SEO/BP 1.0); this is the live confirmation.
**Verify:** performance ≥ 0.9 on the live demos.
**Time:** 15 min.

## 11. Stripe live mode — 20 min

**Do:** repeat §5 with **live-mode** API key + a live-mode webhook endpoint
(same URL/events), overwrite both secrets, redeploy.
**Verify:** Stripe live dashboard shows the endpoint; a real card on your own
account activates a plan (refund yourself after).
**Time:** 20 min.

## 12. OAuth submissions status — 15 min (weeks of queue)

**Do:** per `OAUTH_SETUP.md`, confirm Google OAuth app is submitted (add
yourself as **test user** meanwhile) and Pinterest trial access requested. GSC
and Pinterest features stay "available soon" in the UI until their secrets are
set — **no launch dependency**.
**[V1.3] note:** GSC also powers the Indexing page's coverage + deindex watch —
worth chasing, not worth blocking on.
**Verify:** Google console shows "Testing" with your account; Pinterest shows
trial granted.
**Time:** 15 min now; check weekly.

## 13. 48-hour watch

- `npx wrangler tail`: watch for `provision <id> <step> failed`, any 500s on
  `/api/saas/*`, and `seo rebuild dispatch failed` lines.
- Master `audit_log`: expect `connection.saved`, `site.provision_completed`,
  `billing.plan_updated`; investigate any `*_failed`.
  **[V1.3]** also expect `site.seo_profiles_changed`, `site.seo_assist_used`
  (counts only — no content), `site.edge_bots_changed`; investigate any
  `site.seo_safety_overridden` (someone typed the override phrase).
- Stripe → Webhooks: all deliveries 200.
- Stuck provisioning: dashboard Retry resumes from the failed step (safe).

---

## ✅ "You are live" — the measurable definition of done

All of these true, on the same day:

1. `curl -s https://arsal.app/__health` → `{"ok":true}` and the marketing home
   returns 200.
2. `npx wrangler secret list` contains the full §4 inventory.
3. A stranger can: sign up → verify email → connect GitHub + Cloudflare → pay
   (test or live) → **Add site** → have a live site on their domain — with no
   manual intervention from you.
4. All four demo sites are live, green through their covenant gates, and
   linked from `/examples`.
5. An existing tenant site's public API responds identically to its pre-launch
   behavior (spot-check `/v1/status` + one post page).
6. Stripe shows a 100% webhook delivery success rate for the day.
7. Lighthouse ≥ 0.9 performance on a live demo.
8. The 48-hour watch (§13) has produced zero uninvestigated `*_failed` audit
   events.

When all eight hold: **you are live.** Everything after this list is growth
work (OAuth verifications clearing, Merchant Center approval, first customers),
not launch work.
