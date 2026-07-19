# LAUNCH_CHECKLIST.md — the one list you execute top to bottom (FINAL, V1.4)

**This is the final go-live checklist. It supersedes every earlier version of
this file and every scattered launch note.** (OWNER_RUNBOOK.md stays as
reference detail; GITHUB_APP_SETUP.md and OAUTH_SETUP.md are linked where
needed.) Every step has: **Do** (exact commands/clicks) · **Unblocks** (why
it's here) · **Verify** (how you know it worked) · **Time** (realistic,
excluding third-party review queues).

Steps marked **[V1.3]** came from the specialist-profiles release; steps
marked **[V1.4]** are new with the Forms & Automation Engine.

Assumes: `arsal.app` is a Cloudflare zone you control; `wrangler` installed
and logged in (`npx wrangler login`); you're in the repo directory.

Strict dependency order — each step unblocks the ones after it. Don't reorder.

---

## 0. Accounts & Workers Paid plan — 20 min

**Do:** confirm you can sign in to: Cloudflare (with the `arsal.app` zone) and
**enable the Workers Paid plan** (locked decision — PBKDF2 + provisioning need
it), Turso, GitHub (org `ArsalR`), Resend, Stripe, Google Cloud, Pinterest
developers, Anthropic console.
**Unblocks:** everything below.
**Verify:** Cloudflare → Workers → Plan shows "Paid". Turso dashboard opens.
**Time:** 20 min.

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
**Unblocks:** provisioning (every customer site is generated from this
template); the preset covenant matrix in the template repo's Actions.
**Verify:** build + all three gates green locally; after first push, the
"Preset covenant matrix" check is green on the template repo's Actions tab.
**Note [V1.3]:** the audit already ran the deliberate gate-break drill and a
live Lighthouse pass (perf/SEO/BP 1.0) — the matrix CI keeps it honest.
**Note [V1.4]:** the V1.4 audit re-ran the worst-case build **with forms**
(`STUB_FORMS=3`): form pages render as pure static HTML, Turnstile is the one
allowed script and only on pages with an actual widget, and Lighthouse still
scored performance 1.0 on the form-bearing page. Nothing extra for you to do —
it's listed so you know it's covered.
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
`arsal.app`, then the SPF/DKIM rows above) — no review lag, but DNS can take
an hour.
**[V1.4] note:** `forms@arsal.app` (form acknowledgments, inbox replies,
newsletter confirmations, daily digests) sends through this same verified
domain — no extra records. Customers who want their **own** From-address
domain add it later from their dashboard (Forms → Sending domain wizard,
which walks them through THEIR DNS) — zero platform-side setup.
**Unblocks:** health check, all email, demo sites, per-site CMS hosts.
**Verify:** `dig +short arsal.app` → Cloudflare IPs; Resend shows "Verified";
after §6, `curl -s https://arsal.app/__health` → `{"ok":true,...}`.
**Time:** 30 min hands-on.

## 3. GitHub App — 45 min

**Do:** follow `GITHUB_APP_SETUP.md`. Callback/setup URL:
`https://arsal.app/app/connections/github/callback`. Permissions: Contents
R/W, Actions R/W, Administration R/W, Secrets R/W, Workflows R/W, Metadata R.
Convert the downloaded key PKCS#1 → PKCS#8 (command in the doc) before
storing. Set `GITHUB_APP_SLUG` in `wrangler.toml [vars]`.
**Unblocks:** customer repos, builds, deploys — the provisioning pipeline.
**Verify:** §6's Connections page shows "Connect GitHub" (not "temporarily
unavailable").
**Time:** 45 min.

## 4. Secrets — complete inventory — 30 min

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
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | `OAUTH_SETUP.md` (§12) |
| `PINTEREST_APP_ID` / `PINTEREST_APP_SECRET` | `OAUTH_SETUP.md` (§12) |

Non-secret `[vars]`: `SAAS_APP_HOSTNAME="arsal.app"`, `GITHUB_APP_SLUG`,
optionally `SAAS_PRICE_STARTER_CENTS` / `SAAS_PRICE_AGENCY_CENTS` /
`SAAS_TRIAL_DAYS`. **Leave `SAAS_MODE = ""` until §7.**

**[V1.4] — two flag decisions, no new secrets:**
- **Nothing new to add** for forms/inbox/newsletter/digests — they ride
  `RESEND_API_KEY`; ✨ submission intelligence uses each customer's own
  Anthropic key from their vault (no platform key, no platform bill).
- **`FEATURE_WEBHOOKS = "1"` in `[vars]` — recommended.** First-attempt
  form-webhook deliveries always fire, but the retry cron (+5 min/+30 min
  backoff for failures) is gated on this existing flag, which defaults OFF.
  Turn it on unless you have a reason not to. (Flags are git-managed —
  dashboard edits are clobbered on deploy; commit the change.)

**Unblocks:** deploys that boot; vault; email; billing.
**Verify:** `npx wrangler secret list` shows every name; the two JWT secrets
came from separate `openssl` runs; `grep FEATURE_WEBHOOKS wrangler.toml`
shows your chosen value.
**Time:** 30 min.

## 5. Stripe test mode — 30 min

**Do:**
1. Stripe (test mode) → Developers → API keys → secret key →
   `wrangler secret put PLATFORM_STRIPE_SECRET_KEY`.
2. Developers → Webhooks → Add endpoint
   `https://arsal.app/api/saas/billing-webhook`, events:
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`.
3. Signing secret → `wrangler secret put PLATFORM_STRIPE_WEBHOOK_SECRET`.
   (No products to create — prices are sent inline from `SAAS_PRICE_*_CENTS`.)
**Unblocks:** billing pages, trials → paid.
**Verify:** deferred to smoke item 7 (§8) — needs `SAAS_MODE` on.
**Time:** 30 min.

## 6. Deploy (SaaS still off) — 15 min

**Do:** `npx wrangler deploy` (or push to `main` — CI deploys).
**Unblocks:** health check, tenant regression before the flip.
**Verify:** `curl -s https://arsal.app/__health` → ok; an existing tenant CMS
site serves normally (SaaS layer inert with `SAAS_MODE=""`);
`curl -s https://<tenant>/api/public/v1/status` returns the usual shape.
**Time:** 15 min.

## 7. The flip — 10 min

**Pre-flight (all true?):** §4 secrets listed · health ok · tenant regression
ok (§6) · template cold build green (§1) · Stripe test webhook configured (§5).
**Do:** set `SAAS_MODE = "1"` in `wrangler.toml [vars]` → `npx wrangler deploy`.
**Rollback:** set `SAAS_MODE = ""` and redeploy — the SaaS layer (forms
included) goes fully inert; tenant behavior is byte-identical again; no data
migration.
**Time:** 10 min.

## 8. 10-item post-flip smoke test — 30 min

1. `curl https://arsal.app/` → marketing homepage (200).
2. `/privacy` and `/terms` render.
3. Sign up a test account → verification email arrives.
4. Verify email → land in the dashboard.
5. Connections shows GitHub + Cloudflare steps. **[V1.3]** when creating the
   Cloudflare token from the wizard's template, confirm it includes
   **Zone → Firewall Services → Edit** (powers edge bot protection; older
   tokens without it still work — the toggles explain what's missing).
6. Paste the Cloudflare token → verifies and stores.
7. `/app/billing` → "Choose Starter" opens Stripe Checkout → pay with
   `4242 4242 4242 4242` → plan activates within seconds; Stripe → Webhooks
   shows a 200 delivery (401 = wrong signing secret).
8. An existing **tenant** site still serves identically — spot-check one post
   + `/api/public/v1/status`.
9. Tenant `/api/public/v1/capabilities` lists the same endpoints as before
   the flip **plus** the additive ones — including **[V1.4]** `/v1/forms`
   (with `/v1/seo`, `/v1/seo-settings`, `/v1/local`, `/v1/authors`,
   `/v1/merchant`).
10. `curl -I https://arsal.app/app/login` → `X-Frame-Options: DENY`.

**Time:** 30 min.

## 9. Provision the four demo sites — 1–2 h

**Do:** signed in as a platform-owned account, **Add site** ×4 through the
real dashboard flow (DNS rows already exist from §2):

| Subdomain | Kind | Preset | Profiles seeded automatically |
|---|---|---|---|
| `demo-blog.arsal.app` | content | editorial | image |
| `demo-shop.arsal.app` | ecommerce | modern | ecommerce + image |
| `demo-local.arsal.app` | local-business | warm | local |
| `demo-folio.arsal.app` | portfolio | bold | — |

**[V1.3] extra demo checks:** on `demo-local` fill Business info (NAP+hours →
contact page + LocalBusiness schema); on `demo-shop` set Merchant shipping/
returns → `feed.xml` fills; on `demo-blog` toggle News → publish →
`/news-sitemap.xml` + IndexNow key file appear.

**[V1.4] the forms drill — do this on `demo-local` (it's the natural fit):**
1. Dashboard → the site → **Forms** → create from the **Contact** template
   (one click), leave the acknowledgment email ON.
2. The site rebuilds automatically; open
   `https://demo-local.arsal.app/forms/contact/` — a static page with the
   form and the Turnstile widget (view-source: the ONLY script on the page is
   Turnstile).
3. **Submit it yourself** with a real mailbox you control (Turnstile must be
   configured on the site — the submit hard-fails without it, by design).
4. Verify all four arrivals: you land back on the page with a success note ·
   the submission appears in **Inbox** (status "new", country set, no IP
   stored) · the **owner notification** email arrives · the **acknowledgment
   email** arrives at the submitting mailbox From `forms@arsal.app` with
   Reply-To your owner address.
5. Reply to it from the inbox — the reply lands in the same mailbox and the
   thread is stored under the submission.
6. Optional extras while you're here: point the form's **webhook** at a
   https://webhook.site URL and use **Test-fire** (delivery log shows
   `delivered`, signature header present); create a **Newsletter** form and
   confirm the double-opt-in email + confirm page work; connect your
   Anthropic key on the platform account and watch ✨ summary + lead score
   appear on the next submission.

**Verify:** all four demos live; the `/examples` gallery cards link to them;
the §9.[V1.4] drill passed end-to-end. **Re-run one demo genesis after every
platform deploy** — it's your fastest full-pipeline health check.
**Time:** 1–2 h.

## 10. Lighthouse on a live demo — 15 min

**Do:** `npx lighthouse https://demo-blog.arsal.app/ --preset=desktop --quiet`
(or PageSpeed Insights) on one demo per kind — include the page with the
embedded form on `demo-local` **[V1.4]**.
**Unblocks:** confidence that live ≈ audited (audit scored perf 1.0 including
the form-bearing page).
**Verify:** performance ≥ 0.9 on the live demos.
**Time:** 15 min.

## 11. Stripe live mode — 20 min

**Do:** repeat §5 with **live-mode** API key + a live-mode webhook endpoint
(same URL/events), overwrite both secrets, redeploy.
**Verify:** Stripe live dashboard shows the endpoint; a real card on your own
account activates a plan — **then refund yourself** (Stripe → Payments →
Refund). Keep the refund receipt; it's a go-live criterion below.
**Time:** 20 min.

## 12. OAuth submissions status — 15 min (weeks of queue)

**Do:** per `OAUTH_SETUP.md`, confirm the Google OAuth app is submitted (add
yourself as **test user** meanwhile) and Pinterest trial access requested.
GSC and Pinterest features stay "available soon" until their secrets are set —
**no launch dependency**.
**Verify:** Google console shows "Testing" with your account; Pinterest shows
trial granted.
**Time:** 15 min now; check weekly.

## 13. 48-hour watch

- `npx wrangler tail`: watch for `provision <id> <step> failed`, 500s on
  `/api/saas/*`, `seo rebuild dispatch failed`.
- Master `audit_log`: expect `connection.saved`, `site.provision_completed`,
  `billing.plan_updated`, `site.seo_profiles_changed`; **[V1.4]** also
  `site.inbox_viewed`, `site.inbox_replied`, `site.form_*`, and — counts
  only, never content — `site.intel_draft`, `site.inbox_digest_set`.
  Investigate any `*_failed` or `site.seo_safety_overridden`.
- Stripe → Webhooks: all deliveries 200.
- **[V1.4]** Forms sanity: each form's delivery log shows `delivered` (or
  retries clearing if `FEATURE_WEBHOOKS="1"`); no submission floods (the
  5/hr/IP + 100/hr/site limits + honeypot + Turnstile hold the line).
- Stuck provisioning: dashboard Retry resumes from the failed step (safe).

---

## ✅ "YOU ARE LIVE" — the measurable definition of done

All of these true, on the same day:

1. `curl -s https://arsal.app/__health` → `{"ok":true}` and the marketing
   home returns 200.
2. `npx wrangler secret list` contains the full §4 inventory.
3. The §8 smoke test is **10/10**.
4. **All four demo sites are serving** at their subdomains, green through
   their covenant gates, linked from `/examples`.
5. **[V1.4] One real form submission on a demo site has been acknowledged**:
   it's in the inbox AND the acknowledgment email arrived at the submitter's
   mailbox (§9 drill, steps 3–4).
6. **One paid test subscription completed and refunded** (§11): checkout →
   plan active → webhook 200 → refund issued.
7. An existing tenant site's public API responds identically to its
   pre-launch behavior (spot-check `/v1/status` + one post page).
8. Lighthouse ≥ 0.9 performance on a live demo.
9. The 48-hour watch (§13) has zero uninvestigated `*_failed` audit events.

When all nine hold: **you are live.** Everything after this list is growth
work (OAuth verifications clearing, Merchant Center approval, first
customers), not launch work.
