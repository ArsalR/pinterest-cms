# PLAN.md — SaaS layer ("saas_mode") on pinterest-cms

> Phase 0 deliverable. Maps every phase to concrete files, tables, and routes in THIS codebase.
> **Nothing ships until PLAN.md is approved. Existing routes stay byte-identical; all new work is additive and gated behind `saas_mode`.**

---

## 0. How additivity is guaranteed (mechanics, verified against the code)

These are the exact seams the repo already exposes; every phase below builds only on these:

| Seam | Where | How we use it |
|---|---|---|
| Feature flag | `wrangler.toml [vars]` + `CloudflareEnv` (`src/lib/types.ts`) | `SAAS_MODE = ""` (off) → `"1"`; identical to `FEATURE_*` pattern. Off = zero behavior change. |
| New hostname bypass | `src/middleware/tenantMiddleware.ts` (mirrors `NETWORK_ADMIN_HOSTNAME`) | `SAAS_APP_HOSTNAME` — the customer dashboard lives on its own hostname, never colliding with tenant sites. |
| New top-level mounts | `src/worker.ts` between `/api/public` and `/admin` | `app.route("/app", saasDashboard)` + `app.route("/api/saas", saasApi)` — registered before the frontend catch-all. |
| Master-DB columns/tables | `sites` table + new tables | Requires a **new master migration runner** (none exists today) — additive component, Phase 1. |
| Per-site DDL | `SITE_SCHEMA_STATEMENTS` (provision.ts) + `MIGRATIONS` (migrate.ts) | Any per-site additions land in BOTH copies. |
| New cron | `wrangler.toml [triggers]` + explicit `event.cron === "…"` branch in `worker.ts scheduled()` | Uptime checks, usage rollups. The else-branch is owned by runScheduler — new crons get explicit branches. |
| Webhook → rebuild | `src/lib/webhooks.ts` (`post.published` etc.) | SaaS sites register a platform webhook endpoint that converts CMS events into GitHub `repository_dispatch` rebuilds. Zero changes to webhook code. |
| Capabilities | `src/routes/public/v1/capabilities.ts` | Advertise `saasMode` additively. |
| Error codes | `src/lib/errors.ts` + `errors.test.ts` | Add-only: `quota_exceeded`, `gate_failed`, `connection_invalid`, … |

Existing tenant sites (e.g. current live sites) are untouched: SaaS behavior applies only to sites created through the SaaS pipeline (marked in the master DB), and only when `SAAS_MODE=1`.

## 0.1 Content architecture (the one big decision everything hangs on — ASK ME #3)

**Recommended:** the CMS stays the content store; generated sites are static Astro repos that **build-time fetch** published content from the existing public API (`GET /v1/posts`, read-only key) and rebuild on publish via webhook → `repository_dispatch`. Rationale: reuses the frozen API + webhooks exactly as designed; the quality gate sits in the publish pipeline (platform side), not in the site; Claude edits design/layout in the repo while content flows through the CMS; WordPress import (K9) lands in the CMS unchanged.

Alternative (not recommended): content as markdown in the repo — simpler sites but forfeits the CMS, scheduling, quality gate, and the existing API contract.

---

## Proposed phase breakdown

> ⚠️ **ASK ME #1: your brief's phase list was cut off after Phase 0.** The breakdown below is my proposal, sized so each phase is one branch, independently shippable, typecheck+tests green. Confirm or replace it.

### Phase 1 — Control plane foundation (`phase-1-foundation`)

Goal: `SAAS_MODE` flag, customer accounts, dashboard shell, master-DB migrations. No external integrations yet.

New files:
- `src/lib/masterMigrate.ts` — idempotent master-DB migration runner (mirror of `migrate.ts`, tracked in master `_migrations`); invoked lazily from saas routes and/or a `scheduled()` branch. **Unblocks every later phase.**
- `src/lib/saas/customers.ts` — signup/login/session for platform customers (reuses `hashPassword`/`verifyPassword`/`signJwt` from `src/lib/auth.ts`; separate cookie `saas_session`, separate JWT audience claim).
- `src/middleware/saasAuthMiddleware.ts` — same shape as `adminAuthMiddleware`, fail-closed, exempt paths `/app/login`, `/app/signup`.
- `src/routes/saas/index.ts`, `src/routes/saas/authPages.ts`, `src/routes/saas/dashboard.ts` — server-rendered dashboard shell (template-string HTML, same conventions as `views/admin/Layout.ts`; new `src/views/saas/Layout.ts`).
- `src/routes/api/saas/index.ts` — JSON API skeleton (`/api/saas/v1/*`), cookie-authed, for dashboard fetch calls.

New master tables (via masterMigrate): `customers` (id, email, password, name, created_at), `customer_sessions` optional (JWT-only likely enough), `audit_log` (id, customer_id, action, target, meta, created_at), `jobs` (id, customer_id, kind, status, payload, result, created_at, updated_at — the async-work queue, modeled on `webhook_deliveries`).

Wiring in `worker.ts`: `SAAS_APP_HOSTNAME` bypass in tenantMiddleware; mount `/app` + `/api/saas` (both no-op 404 when `SAAS_MODE != "1"`).
Config: `SAAS_MODE=""`, `SAAS_APP_HOSTNAME=""` vars; `SAAS_JWT_SECRET` secret (separate from tenant `JWT_SECRET`).
Tests: masterMigrate idempotency (pure-logic), customer password/JWT round-trip, signup validation.
CI (additive): add `npm test` step to `deploy.yml`; new PR-check workflow (typecheck + test on PRs).

### Phase 2 — Credential vault + connection wizard (`phase-2-connections`)

Goal: customer connects their GitHub + Cloudflare (+ optional Anthropic key) once, guided.

New files:
- `src/lib/saas/vault.ts` — AES-256-GCM via WebCrypto; per-tenant key = HKDF(`VAULT_MASTER_KEY` secret, salt=customer_id). Never logged, never in error messages; every decrypt writes `audit_log`.
- `src/lib/saas/github.ts` — GitHub App client: RS256 App JWT (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` secrets) → installation tokens; repo-from-template, set Actions secrets, dispatch workflows, commits/rollback.
- `src/lib/saas/cloudflare.ts` — customer-token CF client: token verify (`GET /user/tokens/verify`), zones list, Workers deploys, custom domains, DNS, Web Analytics.
- `src/routes/saas/connections.ts` — wizard UI + callbacks (GitHub App install redirect → installation_id capture; CF token paste → live verify with scope check; Anthropic key paste → optional).

New master table: `connections` (id, customer_id, provider `github|cloudflare|anthropic|gsc|pinterest`, encrypted_payload, meta JSON, status, created_at, last_verified_at).
Tests: vault round-trip + tamper detection (pure WebCrypto, node-safe), GitHub App JWT shape, token-scope validation logic.

### Phase 3 — Site provisioning pipeline (`phase-3-provisioning`)

Goal: "Add site" → repo + Workers deployment + custom domain + CMS backing, fully automatic. **The template repo is a separate deliverable** (its own repo, not this codebase) containing: Astro zero-JS, trust pages (K1 set), security headers via `_headers`/worker config (CSP, HSTS, etc.), Lighthouse CI budget gate workflow (Perf ≥98, LCP <1.2s, CLS <0.02, TBT <50ms, weight <300KB, HTML <50KB — fail = deploy blocked), image pipeline (AVIF/WebP srcset, dims, lazy), font discipline, critical CSS, `llms.txt`, Article/FAQ schema, build-time fetch from CMS API.

New files in THIS repo:
- `src/lib/saas/provisionSite.ts` — orchestrator: create repo from template (customer's GitHub) → set repo secrets (their CF token, a freshly minted `cms_live_` read key, optional Anthropic key) → trigger first deploy → attach custom domain + DNS (their CF) → enable WAF/bot-fight → **reuse `createSite()` from `src/lib/provision.ts` unchanged** for the CMS backing → register webhook endpoint (per-site `webhook_endpoints`) pointing at the rebuild bridge. Steps recorded in `jobs` for resumability (createSite's no-rollback gotcha noted — the job log gives manual recovery).
- `src/routes/api/saas/sites.ts` — site CRUD + provisioning status (polls `jobs`).
- `src/routes/saas/sites.ts` — dashboard UI (wizard, per-site page).
- `src/routes/api/saas/hooks.ts` — **rebuild bridge**: receives CMS webhooks (verifies `X-Webhook-Signature`) → GitHub `repository_dispatch {event_type:"content-updated"}`; also receives GitHub webhooks (deploy status → `jobs`).
- `src/routes/api/saas/forms.ts` — K1 contact-form endpoint: `POST /api/saas/forms/:siteId` with Turnstile verify → email via MailChannels (free on Workers) to site owner.

New master table: `customer_sites` (id, customer_id, cms_site_id FK→sites.id, repo_full_name, cf_deployment_name, domain, status, template, created_at).
Master `sites` gains nothing — linkage lives in `customer_sites` (keeps `resolveSite`'s SELECT and its cached shape untouched).

### Phase 4 — Prompt-to-build + preview/rollback (K1 genesis, K12) (`phase-4-prompting`)

Goal: build/change sites by prompting Claude; preview URLs; one-click rollback. **Zero platform inference: Claude Code runs in the customer's GitHub Action using the customer's Anthropic key** (template repo carries the workflow; the platform only dispatches).

New files:
- `src/lib/saas/prompts.ts` — dispatch prompt as `repository_dispatch` payload (rate-limited per customer; audit-logged), track run via GitHub checks API into `jobs`.
- `src/routes/saas/builder.ts` — prompt UI, job timeline, before/after preview (template deploys previews as separate Workers versions/URLs), approve-to-merge flow (PR-based: Claude commits to a branch, preview deploys from branch, approve = merge).
- Rollback: `src/lib/saas/github.ts` gains `revertToCommit(repo, sha)` (revert commit → push → auto-deploy). UI in site page: pick any commit, one click.
- Genesis = Phase 3 provisioning + a genesis prompt template (niche, domain, owner details from wizard → 10 seed articles via CMS API, topical map, silo nav, filled-in trust pages).

### Phase 5 — Quality gate + programmatic SEO (K2) (`phase-5-quality-gate`)

Goal: nothing thin/duplicate publishes.

New files:
- `src/lib/saas/qualityGate.ts` — pure functions: unique-content ratio (shingling/Jaccard between pages), duplicate title/meta detection, thin-content threshold, required-unique-data check. Fully unit-testable in plain vitest (no Workers APIs) — the flagship test suite.
- `src/routes/api/saas/publish.ts` — SaaS publish pipeline: drafts enter via existing public API (unchanged), gate runs against the per-site DB, pass → publish (existing `PUT /v1/posts/:id` semantics), fail → gate report persisted to `jobs` + surfaced in dashboard with "ask Claude to fix".
- `src/routes/saas/pseo.ts` + `src/lib/saas/pseo.ts` — CSV upload → template → batch generation through the gate (reuses `POST /v1/posts/batch` internally where flag-enabled).
- Per-site DDL addition (both copies + migration 005): `gate_reports` (id, post_id, verdict, scores JSON, created_at) — or store in master `jobs`; decide at implementation, default master `jobs` (zero per-site DDL).

### Phase 6 — Network brain (K3) (`phase-6-network-brain`)

- `src/lib/saas/gsc.ts` — Google OAuth per site (needs `GOOGLE_CLIENT_ID/SECRET` secrets); sitemap submit, index status, query data, deindex/manual-action alerts. Tokens in `connections` (provider `gsc`).
- Uptime: new cron `*/5 * * * *` conflicts with scheduler string — instead new cron `2-57/5 * * * *` (own `===` branch) or gate inside a new explicit branch; pings each `customer_sites.domain` homepage, alerts on failure. Subrequest limits: 50/invocation free, 1000 paid → batch across ticks (ASK ME #6: paid plan assumed).
- 404 monitor + CWV: CF Web Analytics / GraphQL API via customer token (`src/lib/saas/cloudflare.ts`), one-click "add redirect" writes to the per-site `redirects` table (existing engine, no changes).
- Dashboard: `src/routes/saas/network.ts` — cross-site overview (traffic, CWV, cadence, uptime, 404s, decay flags).
- New master table: `site_metrics` (site_id, day, source, payload JSON) — rollup cache so dashboards don't hammer external APIs.

### Phase 7 — Content intelligence (K4 decay, K5 internal links, K8 AEO) (`phase-7-content-intel`)

- `src/lib/saas/decay.ts` — GSC rolling 28-day comparison → decay flags into `site_metrics`; "refresh" = prompt dispatch (Phase 4) whose output goes through the gate (Phase 5) and republishes via existing API (sets `dateModified` via existing `structured_data`/`updated_at` — no API changes).
- `src/lib/saas/linking.ts` — keyword-overlap related-post scoring against the per-site DB (embeddings optional later — ASK ME #8); suggestions UI; auto-insert mode edits content via existing `PUT /v1/posts/:id`; orphan detection (published post with zero inbound internal links) as a gate rule.
- AEO: checks live mostly in the template (llms.txt, schema, summary blocks); dashboard adds per-post AEO checklist in `src/lib/saas/aeo.ts` (pure functions, unit-tested).

### Phase 8 — Traffic + monetization (K7 Pinterest, K10 affiliate) (`phase-8-traffic`)

- `src/lib/saas/pinterest.ts` — customer Pinterest OAuth (`connections`), pin-image generation (template-based composite — likely satori/resvg-wasm or CF Images; decide at phase start), drip queue in `jobs`, publish-triggered.
- Affiliate: master tables `affiliate_links` (id, customer_id, slug, target, created_at) + `affiliate_clicks` (rollup). Cloaked redirects `/go/:slug` served per-site — new reserved route registered **before** the frontend catch-all in `worker.ts`, active only for SaaS-managed hostnames (checked via `customer_sites`), else falls through → byte-identical for non-SaaS sites. Weekly dead-link checker cron (own branch).

### Phase 9 — Import, cloning, agency (K9, K6, K11) + billing (`phase-9-scale`)

- `src/lib/saas/wpImport.ts` — WXR parse / WP REST crawl → posts via existing API, images → R2 via existing upload, redirect map → per-site `redirects` (301s, existing engine).
- Cloning: repo-from-existing-repo + re-theme/re-seed prompt (Phase 4 machinery) + new CMS site (Phase 3 machinery).
- Agency: `customer_seats` master table (customer_id, email, role, site_scope), white-label settings on `customers`, monthly report generation (cron + email).
- Billing (flat price): Stripe Checkout + webhook → `customers.plan_status`. **ASK ME #7: in scope? which phase?** Recommended here (last), everything before it works in "free beta" mode.

---

## Testing & CI strategy (all phases)

- Every phase: `npm run typecheck` + `npm test` green before merge; new lib code gets colocated pure-logic `*.test.ts` (vitest runs in plain Node — no Workers APIs in tests).
- Phase 1 adds `npm test` to `deploy.yml` + a PR-check workflow (typecheck + test) — currently CI runs typecheck only and only on push to main.
- Byte-identical guarantee per phase: with `SAAS_MODE` unset, a smoke checklist (existing routes: `/`, `/admin`, `/admin/login`, `/api/public/v1/status`, `/v1/posts` CRUD, sitemap/robots/feed) returns identical status codes + shapes. Automatable later; manual checklist in each phase PR description.

## Platform secrets added over time (all via `wrangler secret put`, no wrangler.toml changes)

`SAAS_JWT_SECRET`, `VAULT_MASTER_KEY` (P1/2), `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` (P2), `TURNSTILE_SECRET` (P3), `GOOGLE_CLIENT_ID/SECRET` (P6), `PINTEREST_APP_ID/SECRET` (P8), `STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET` (P9).

---

# ASK ME — decisions I need from you before Phase 1

1. **Phase list.** Your brief was cut off after Phase 0. Confirm my Phase 1–9 breakdown above, or paste your intended phases and I'll re-map.
2. **Control-plane data location.** Recommended: extend the existing **master Turso DB** with new SaaS tables via a new master migration runner (no new infra, one DB to operate). Alternative: a separate control-plane Turso DB (cleaner blast radius, more config). Which?
3. **Content architecture.** Confirm §0.1: CMS stays the content store; static sites build-time fetch via the existing public API and rebuild on publish webhooks. (The alternative — markdown-in-repo — abandons most of the CMS.)
4. **GitHub App.** The BYO-GitHub flow needs a platform GitHub App (you create it once in your GitHub org; I need its App ID + private key as Worker secrets, and its name for the install URL). OK to design around a GitHub App (recommended), vs. asking customers to paste a PAT (weaker, but zero setup for you)?
5. **Template framework + home.** Astro (zero-JS by default, islands when needed) as the site template — confirm. And the template repo lives in your GitHub org as a public template repo — name preference?
6. **Workers plan.** Uptime pings, image pipeline, and PBKDF2 auth all want the **paid** Workers plan ($5/mo) for the platform Worker (earlier this session we removed `cpu_ms` because the account was free-tier). Is the platform account going paid? (Customer sites are on THEIR accounts and are static — free tier is fine for them.)
7. **Billing scope.** Is Stripe billing part of this build (my Phase 9), later, or out of scope?
8. **Internal-linking engine.** Keyword-overlap scoring (zero cost, good enough to start — recommended) vs. embeddings (needs Workers AI or customer OpenAI/Anthropic key, better quality). Start with which?
9. **AI inference confirmation.** Claude runs exclusively in the **customer's** GitHub Actions with the **customer's** Anthropic key (platform pays zero inference; no key = prompting features disabled with an upsell to add one). Confirm this is the intended model — it's what "platform pays for zero AI inference" implies.
10. **SaaS dashboard hostname.** e.g. `app.<yourplatformdomain>` served by this same Worker via a `SAAS_APP_HOSTNAME` bypass (recommended, matches NETWORK_ADMIN_HOSTNAME pattern). What domain?

---

*Unrelated but pending from earlier: the `/admin/` 404 fix is merged to `main` but production deploy is still blocked — `CF_API_TOKEN`/`CF_ACCOUNT_ID` were added as GitHub **environment variables**; the workflow needs them as **repository secrets** (Settings → Secrets and variables → Actions → Secrets tab).*
