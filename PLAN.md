# PLAN.md — SaaS layer ("saas_mode") on pinterest-cms

> Phase 0 deliverable, **revision 3** — line-by-line verified against `SAAS_BUILD_PROMPT.md` (commit 985e4b3): every covenant item (P1–P9, S1–S5), every K-feature (K1–K12), all 10 spec phases, the spec's 8 ASK ME items, and the 5 non-negotiables. Gaps found in rev 2 are listed in "Verification pass (rev 3)" below and folded into the phases.
> **Nothing ships until this revision is approved. Existing routes stay byte-identical; all new work is additive and gated behind `saas_mode`.**

## Cross-cutting non-negotiables (spec §Non-negotiables — apply to every phase)

- Existing endpoints byte-identical; all new behavior behind `saas_mode`.
- Both covenants deploy-blocking, not advisory (§0.2).
- **Idempotent, resumable provisioning. No plaintext secrets anywhere** — note: the pre-existing CMS stores `sites.turso_token` and webhook secrets in plaintext (frozen behavior we may not touch); the rule binds every NEW secret the SaaS layer stores: vault-encrypted, never logged, never in error messages.
- **Quality gate ON by default** — this product must never be why a customer's network gets hit by a spam update.
- **Plain-language errors everywhere** — the user is semi-technical, not DevOps. Every SaaS-facing error message is written for them (no raw API errors, no stack traces); a UX rule enforced in review on every phase.

## Decisions locked (PLAN review)

1. Phase 1–9 structure approved **as structure**; every phase absorbs the spec content mapped below. Covenants are **deploy-blocking, not advisory**.
2. Control plane: **extend the existing master Turso DB**; master migration runner is the first Phase 1 item.
3. Content architecture confirmed: CMS is the content store; sites build-time fetch via the existing public API; publish webhook → `repository_dispatch` rebuild.
4. GitHub App confirmed; exact one-time creation steps (permissions, callback URLs, where to paste App ID/private key) are a Phase 2 kickoff deliverable.
5. Template: **Astro**, repo **`ArsalR/site-template`**.
6. **Cloudflare stays FREE TIER for now**: crypto parameters config-driven and tuned to fit the 10ms CPU budget (upgrade strengthens without data migration); uptime checks deferred/reduced until paid.
7. Billing: Stripe stays in Phase 9.
8. Internal linking: keyword-overlap first, behind a scorer **interface seam** so embeddings can replace it without touching callers.
9. AI inference: Claude runs **only** in the customer's GitHub Actions with the customer's own Anthropic key; the platform never proxies inference or carries usage by default.
10. SaaS dashboard hostname: **`arsal.app`** (`SAAS_APP_HOSTNAME`); `www.arsal.app` → apex 301.

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

## 0.1 Content architecture (CONFIRMED — decision #3)

The CMS stays the content store; generated sites are static Astro repos that **build-time fetch** published content from the existing public API (`GET /v1/posts`, read-only key) and rebuild on publish via webhook → `repository_dispatch`. Rationale: reuses the frozen API + webhooks exactly as designed; the quality gate sits in the publish pipeline (platform side), not in the site; Claude edits design/layout in the repo while content flows through the CMS; WordPress import (K9) lands in the CMS unchanged.

## 0.2 Covenant enforcement map (deploy-blocking, not advisory)

Both covenants are enforced by pipeline rules — a violating build **cannot deploy**. Enforcement lives in two places: the `ArsalR/site-template` CI (travels with every customer repo) and platform provisioning code (this repo).

**Performance Covenant** (template CI unless noted):
| # | Rule | Enforced where |
|---|---|---|
| P1 | Zero-JS by default (Astro islands only when needed) | Template architecture + CI assertion: no `<script>` in built post pages unless island-annotated |
| P2 | Lighthouse CI budgets: Perf ≥ 98, LCP < 1.2s, CLS < 0.02, TBT < 50ms, page < 300KB, HTML < 50KB — **fail = deploy blocked**. Runs against a **representative page set** (homepage + one post + one programmatic page + heaviest template), not every page — a 500-page site still deploys in minutes | Template CI (lighthouse-ci step gates the deploy job); plain-language report + "ask Claude to fix" dispatch button in dashboard (Phase 4 `jobs` integration) |
| P3 | Image pipeline: AVIF/WebP `srcset`, explicit dims (zero CLS), lazy below fold, LCP priority hints | Template build (Astro image integration reading CMS media URLs → R2) |
| P4 | Font discipline: system stack default; custom fonts auto-subset, `font-display: swap`, self-hosted, preloaded; **no Google Fonts requests** | Template + CI check: no fonts.googleapis.com in built output |
| P5 | CSS: critical inlined, total < 20KB, unused stripped | Template build + CI budget |
| P6 | Edge: immutable cache headers + hashed filenames, HTML `stale-while-revalidate`, Early Hints 103, HTTP/3, Brotli | Template Workers static-assets config + platform provisioning (zone settings via customer CF token, Phase 3) |
| P7 | Third-party script firewall: CF Web Analytics default; any other third-party script requires explicit override, **must load via Workers proxy or `defer`**, + shows wire-cost in dashboard ("~180ms — add anyway?") | Template CI (allowlist of external origins in built HTML; unknown origin = fail; allowed scripts injected proxied/deferred only) + dashboard override UX (Phase 4/6) |
| P8 | Continuous RUM: CWV from real visitors per site, degradation alerts + "ask Claude to diagnose" | Platform (Phase 6, CF Web Analytics API via customer token) |
| P9 | Optional live "PageSpeed 100" footer badge → public PSI link | Template component, off by default, toggle in dashboard |

**Security Covenant**:
| # | Rule | Enforced where |
|---|---|---|
| S1 | Static = no attack surface (no PHP/plugins/admin/origin DB) | Template architecture (§0.1) — structurally guaranteed |
| S2 | Security headers baked in + **verified in CI (fail = blocked)**: strict CSP, HSTS preload, X-Content-Type-Options, Referrer-Policy, Permissions-Policy; target A+ securityheaders.com | Template `_headers`/worker config + CI header-assertion step against the built output |
| S3 | Cloudflare in front: free WAF rules, bot fight mode, DDoS — enabled during provisioning | Platform Phase 3 (`provisionSite.ts` via customer CF token) |
| S4 | Platform hygiene: tokens encrypted at rest (per-tenant derivation), never logged/never in errors, App private key in Workers secrets, webhook signatures verified, prompt-dispatch rate-limited, audit log of every credential use | Platform Phases 1–4 (`vault.ts`, `audit_log`, `prompts.ts` caps) |
| S5 | Git as backup: every version in customer's repo; **one-click rollback** of the whole site to any prior state, in seconds | Platform Phase 4 (`revertToCommit`) — headline feature |

Additional locked rule: **`workers.dev` is disabled on production sites** — provisioning (Phase 3) turns off the workers.dev route/subdomain preview for the deployment via the customer's CF API; sites are reachable only on their custom domain.

---

## Proposed phase breakdown

> ⚠️ **ASK ME #1: your brief's phase list was cut off after Phase 0.** The breakdown below is my proposal, sized so each phase is one branch, independently shippable, typecheck+tests green. Confirm or replace it.

### Phase 1 — Control plane foundation (`phase-1-foundation`)

Goal: `SAAS_MODE` flag, customer accounts, dashboard shell, master-DB migrations. No external integrations yet. **First item: the master migration runner (approved).** Dashboard hostname is `arsal.app`; the tenantMiddleware bypass also matches `www.arsal.app` and 301s it to the apex.

Spec additions absorbed (spec Phase 1): **email verification and password reset** flows for customer accounts (token tables in master DB; delivery blocked on the transactional-email provider decision — OPEN ASK ME A below). Spec's "orgs → sites model": deferred as a thin seam — `customers` is the org for now, `customer_seats` (Phase 9 agency mode) adds members later; `customer_sites.customer_id` is the org key from day one so no remodel is needed (flagged as OPEN ASK ME F if you want first-class orgs earlier). Stripe stays in Phase 9 per decision #7 (overrides spec Phase 1 placement).

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

Goal: customer connects their GitHub + Cloudflare (+ optional Anthropic key) once, guided. **The wizard is a first-class UX deliverable — it decides conversion** (spec Phase 2): every step validates live before advancing with plain-language errors; steps are **skippable and resumable** (wizard state persisted per customer); the CF step **shows the exact API-token template** to create and verifies it live; the domain step is a **zone picker with nameserver instructions + live verification polling**; the wizard also asks **which of apex/`www` is canonical per site** (the other 301s — feeds Phase 3 DNS); optional steps for Anthropic key, Pinterest OAuth, and GSC OAuth (both OAuth integrations land in Phases 7–8, but the wizard slots exist from the start).

New files:
- `src/lib/saas/vault.ts` — AES-256-GCM via WebCrypto; per-tenant key = HKDF(`VAULT_MASTER_KEY` secret, salt=customer_id). Never logged, never in error messages; every decrypt writes `audit_log`. **Free-tier constraint (decision #6): all KDF parameters are config-driven** (`VAULT_KDF_PARAMS` var or versioned envelope header) and tuned to fit the 10ms CPU budget — HKDF itself is one HMAC pass (cheap, safe on free tier; the 100k-iteration PBKDF2 cost lives only in interactive login, unchanged). Each ciphertext embeds an envelope version + its own params, so raising parameters after a paid upgrade re-encrypts lazily on next write — **no data migration**.
- **Phase 2 kickoff deliverable (decision #4)**: exact one-time GitHub App creation walkthrough — app name, homepage/callback/setup URLs on `arsal.app`, webhook URL + secret, required permissions (repo contents RW, actions RW, secrets RW, administration RW for repo-from-template, webhooks RW), and where to paste App ID + private key (`wrangler secret put GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY`).
- `src/lib/saas/github.ts` — GitHub App client: RS256 App JWT (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` secrets) → installation tokens; repo-from-template, set Actions secrets, dispatch workflows, commits/rollback.
- `src/lib/saas/cloudflare.ts` — customer-token CF client: token verify (`GET /user/tokens/verify`), zones list, Workers deploys, custom domains, DNS, Web Analytics.
- `src/routes/saas/connections.ts` — wizard UI + callbacks (GitHub App install redirect → installation_id capture; CF token paste → live verify with scope check; Anthropic key paste → optional).

New master table: `connections` (id, customer_id, provider `github|cloudflare|anthropic|gsc|pinterest`, encrypted_payload, meta JSON, status, created_at, last_verified_at).
Tests: vault round-trip + tamper detection (pure WebCrypto, node-safe), GitHub App JWT shape, token-scope validation logic.

### Phase 3 — Site provisioning pipeline (`phase-3-provisioning`)

Goal: "Add site" → repo + Workers deployment + custom domain + CMS backing, fully automatic. **The template repo is a separate deliverable: `ArsalR/site-template`** (decision #5), carrying the full covenant enforcement from §0.2: Astro zero-JS, security headers + CI verification (S2), Lighthouse CI budget gate (P2 — fail = deploy blocked), image pipeline (P3), font discipline (P4), critical CSS (P5), third-party script firewall allowlist check (P7), `llms.txt` + Article/FAQ/HowTo schema + quotable summary blocks (K8), optional PageSpeed badge (P9), build-time fetch from CMS API, **and the trust-page set generated site-specifically, never lorem ipsum** (K1): About Us, Contact Us, Privacy Policy, Terms of Service, Affiliate/Advertising Disclosure, Cookie Policy, Editorial Policy — filled with site name/niche/owner details from the wizard, dated, footer-linked.

Provisioning must also (locked in review + spec Phase 3): **disable the workers.dev route/subdomain** on production deployments — a live workers.dev duplicate is an SEO duplicate-content bug, not just hygiene; handle **apex AND `www`** (canonical chosen in the wizard, the other 301s); enable WAF free rules + bot fight mode (S3); and **create a per-site Turnstile widget (site key + secret) on the customer's CF account via API** for the contact form (spec Phase 6 — replaces rev 2's single platform `TURNSTILE_SECRET`). **Attach-only mode** (spec architecture constraint): customers already on Cloudflare Pages get their existing site attached for monitoring/content without re-provisioning — no migration forced. Genesis target: **live on their domain in under 10 minutes** (the demo that sells).

**Resumability (spec non-negotiable):** provisioning is idempotent and resumable via a dedicated **`provisioning_runs` master table** (run id, site, step, status, error, retry-from-failure) — upgraded from rev 2's generic `jobs` rows; `jobs` remains for other async work.

**Deploy mechanism (OPEN ASK ME E):** the spec says wire the repo to a **Workers Builds** project (CF's git-integrated build service), but Workers Builds auto-deploys on push and cannot be blocked by the template's Lighthouse/security CI gate — the covenant would become advisory. Recommended instead: deploy from the template's GitHub Action (wrangler with the customer's CF token as a repo secret) **after** the gates pass, which makes "budget fail = deploy blocked" literally true. Needs your call.

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

**Cost guardrails on Claude-in-Actions (locked in review — enforced, not advisory):**
- **15-minute `timeout-minutes`** on the Claude workflow job (template side).
- **Per-site concurrency group** (`concurrency: site-${repo}` in the template workflow) — one Claude run per site at a time; new dispatches **queue, not parallel**.
- **Hourly dispatch cap per site** (platform side, `prompts.ts`): counted in `jobs`, exceeded → new error code `quota_exceeded` + dashboard message; every dispatch audit-logged.
- **Visible run cost** (spec Phase 4): dashboard shows "this run used ~X minutes" per run (from the Actions API) — customers never get surprise GitHub/API bills.

**Claude workflow guardrails in the template (spec Phase 4):** no force-push permitted; a **protected content directory** Claude may not modify; PR/preview mode available. Dispatch via **`workflow_dispatch`** (spec) with typed inputs — `repository_dispatch` reserved for the content-rebuild bridge (Phase 3). Status streamed to the dashboard as **queued → running → committed → building → deployed**.

New files:
- `src/lib/saas/prompts.ts` — dispatch prompt via `workflow_dispatch` (enforces the hourly cap; audit-logged), track run via GitHub checks/Actions API into `jobs` (status stream + minutes used).
- `src/routes/saas/builder.ts` — prompt UI, live status timeline, **diff summary + live link on completion**, before/after preview (template deploys previews as separate Workers versions/URLs), approve-to-merge flow (PR-based: Claude commits to a branch, preview deploys from branch, approve = merge). Default mode — direct-to-live vs preview-then-approve — is **OPEN ASK ME C**.
- Rollback: `src/lib/saas/github.ts` gains `revertToCommit(repo, sha)` (revert commit → push → auto-deploy). UI in site page: pick any commit, one click.
- Genesis = Phase 3 provisioning + a genesis prompt template (niche, domain, owner details from wizard → 10 seed articles via CMS API, topical map, silo nav, filled-in trust pages).

### Phase 5 — Quality gate + programmatic SEO (K2) (`phase-5-quality-gate`)

Goal: nothing thin/duplicate publishes. **The gate is ON by default for every SaaS-managed site** (locked in review) — per-site opt-out is an explicit, audit-logged dashboard action, not a default. Non-SaaS CMS sites are untouched (gate never runs for them).

New files:
- `src/lib/saas/qualityGate.ts` — pure functions: **word count** + thin-content threshold, **title/meta presence + duplicate-title/meta detection**, unique-content ratio between pages (shingling/Jaccard), required-unique-data check for programmatic batches. Gate results **visible in the UI** per post (spec Phase 5). Fully unit-testable in plain vitest (no Workers APIs) — the flagship test suite.
- `src/routes/api/saas/publish.ts` — SaaS publish pipeline: drafts enter via existing public API (unchanged), gate runs against the per-site DB, pass → publish (existing `PUT /v1/posts/:id` semantics), fail → gate report persisted to `jobs` + surfaced in dashboard with "ask Claude to fix".
- `src/routes/saas/pseo.ts` + `src/lib/saas/pseo.ts` — CSV upload → template → batch generation through the gate (reuses `POST /v1/posts/batch` internally where flag-enabled).
- Per-site DDL addition (both copies + migration 005): `gate_reports` (id, post_id, verdict, scores JSON, created_at) — or store in master `jobs`; decide at implementation, default master `jobs` (zero per-site DDL).

### Phase 6 — Network brain (K3) (`phase-6-network-brain`)

- `src/lib/saas/gsc.ts` — Google OAuth per site (needs `GOOGLE_CLIENT_ID/SECRET` secrets); sitemap submit, index status, query data, deindex/manual-action alerts. Tokens in `connections` (provider `gsc`).
- Uptime (decision #6 — **free tier for now**): checks are **deferred at launch, then shipped at reduced cadence** — every 30 min (`13,43 * * * *`, own `===` branch), batched ≤40 pings/invocation to stay inside the 50-subrequest free limit; cadence is a config var (`UPTIME_INTERVAL`) so the paid upgrade drops it to 5 min with no code change. Noted as a launch limitation in the dashboard.
- 404 monitor + CWV: CF Web Analytics / GraphQL API via customer token (`src/lib/saas/cloudflare.ts`), one-click "add redirect" writes to the per-site `redirects` table (existing engine, no changes).
- Dashboard: `src/routes/saas/network.ts` — cross-site overview (traffic, CWV, cadence, uptime, 404s, decay flags).
- New master table: `site_metrics` (site_id, day, source, payload JSON) — rollup cache so dashboards don't hammer external APIs.

### Phase 7 — Content intelligence (K4 decay, K5 internal links, K8 AEO) (`phase-7-content-intel`)

- `src/lib/saas/decay.ts` — GSC rolling 28-day comparison → decay flags into `site_metrics`; "refresh" = prompt dispatch (Phase 4) whose output goes through the gate (Phase 5) and republishes via existing API (sets `dateModified` via existing `structured_data`/`updated_at` — no API changes).
- `src/lib/saas/linking.ts` — related-post scoring behind a **`RelatednessScorer` interface** (decision #8): `score(postA, postB): number` + `related(post, corpus, k)`. Ships with `KeywordOverlapScorer`; an `EmbeddingScorer` can replace it later **without touching callers**. Suggestions UI; auto-insert mode edits content via existing `PUT /v1/posts/:id`; orphan detection (published post with zero inbound internal links) as a gate rule.
- AEO: checks live mostly in the template (llms.txt, schema, summary blocks); dashboard adds per-post AEO checklist in `src/lib/saas/aeo.ts` (pure functions, unit-tested).

### Phase 8 — Traffic + monetization (K7 Pinterest, K10 affiliate) (`phase-8-traffic`)

- `src/lib/saas/pinterest.ts` — customer Pinterest OAuth (`connections`), pin-image generation (template-based composite — likely satori/resvg-wasm or CF Images; decide at phase start), drip queue in `jobs`, publish-triggered.
- Affiliate: master tables `affiliate_links` (id, customer_id, slug, target, created_at) + `affiliate_clicks` (rollup). Cloaked redirects `/go/:slug` served per-site — new reserved route registered **before** the frontend catch-all in `worker.ts`, active only for SaaS-managed hostnames (checked via `customer_sites`), else falls through → byte-identical for non-SaaS sites. Weekly dead-link checker cron (own branch).

### Phase 9 — Import, cloning, agency (K9, K6, K11) + billing (`phase-9-scale`)

- `src/lib/saas/wpImport.ts` — WXR parse / WP REST crawl → posts via existing API, images → R2 via existing upload, redirect map → per-site `redirects` (301s, existing engine), **zero 404s on the same domain**. (Deliberate deviation from spec's "posts converted to markdown": per confirmed decision #3 the CMS is the content store, so imports become CMS posts — same outcome, consistent architecture.)
- Cloning: repo-from-existing-repo + re-theme/re-seed prompt (Phase 4 machinery) + new CMS site (Phase 3 machinery).
- Agency: `customer_seats` master table (customer_id, email, role, site_scope), white-label settings on `customers`, monthly report generation (cron + email).
- Billing (flat `unlimited_sites` plan, decision #7): Stripe Checkout + webhook → `customers.plan_status`. Price, trial length, and whether agency mode is a higher tier: **OPEN ASK ME B**.

### Phase 10 — Audit (`phase-10-audit`) — **do not skip** (spec Phase 10; was missing from rev 2)

- **Full existing-API regression pass**: every pre-SaaS route exercised with `SAAS_MODE` on AND off; responses byte-identical to a pre-Phase-1 baseline (recorded fixtures).
- **Provisioning dry-run + failure-resume tests** for every `provisioning_runs` step against **mocked GitHub/CF APIs** (pure-logic mocks — vitest runs in plain Node).
- **Performance covenant self-test**: `ArsalR/site-template` must pass its own budgets from a cold clone (CI job in the template repo).
- **Security review**: credential encryption (vault envelopes), no token logging anywhere (grep-audit + code review), webhook signature verification, rate limits + dispatch caps, Action guardrails (no force-push, protected content dir).
- Run `/security-review` on the final branch.

---

## Testing & CI strategy (all phases)

- Every phase: `npm run typecheck` + `npm test` green before merge; new lib code gets colocated pure-logic `*.test.ts` (vitest runs in plain Node — no Workers APIs in tests).
- Phase 1 adds `npm test` to `deploy.yml` + a PR-check workflow (typecheck + test) — currently CI runs typecheck only and only on push to main.
- Byte-identical guarantee per phase: with `SAAS_MODE` unset, a smoke checklist (existing routes: `/`, `/admin`, `/admin/login`, `/api/public/v1/status`, `/v1/posts` CRUD, sitemap/robots/feed) returns identical status codes + shapes. Automatable later; manual checklist in each phase PR description.

## Platform secrets added over time (all via `wrangler secret put`, no wrangler.toml changes)

`SAAS_JWT_SECRET`, `VAULT_MASTER_KEY` (P1/2), `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` (P2), `TURNSTILE_SECRET` (P3), `GOOGLE_CLIENT_ID/SECRET` (P6), `PINTEREST_APP_ID/SECRET` (P8), `STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET` (P9).

---

# Verification pass (rev 3) — line-by-line against SAAS_BUILD_PROMPT.md @985e4b3

Checked: P1–P9 ✓ (P2 and P7 amended, see below), S1–S5 ✓, K1–K12 ✓ (K9 carries one approved deviation), spec Phases 0–10 ✓ (spec's phase content re-mapped onto the approved 1–9 structure + new Phase 10), 5 non-negotiables ✓ (now a cross-cutting section at the top), spec's 8 ASK ME items → 3 resolved by your review, **6 still open (A–F below)**.

## What rev 2 was still missing (found in this pass, now folded in)

1. **Phase 10 — Audit. Missing entirely.** Regression baseline, provisioning failure-resume tests vs mocked APIs, template self-test from cold clone, security review, `/security-review`. Added as its own phase.
2. **Email verification + password reset** for customer accounts (spec Phase 1). Added to Phase 1; delivery blocked on the email-provider decision (A).
3. **Wizard UX requirements** (spec Phase 2): live per-step validation, skippable/resumable state, exact CF-token template shown, zone picker + nameserver instructions + live verification polling. Rev 2 had "wizard UI + callbacks" only. Added to Phase 2.
4. **Per-site apex/`www` canonical choice** asked in the wizard, other 301s (spec Phase 3). Rev 2 only handled www for `arsal.app` itself. Added to Phases 2 & 3.
5. **`provisioning_runs` table** with per-step status + retry-from-failure (spec Phase 3). Rev 2 used generic `jobs` rows. Upgraded to a dedicated table; resumable provisioning is a non-negotiable.
6. **Attach-only mode for existing Cloudflare Pages customers** (spec architecture constraint). Missing from rev 2. Added to Phase 3.
7. **Per-site Turnstile keys created on the customer's CF account during provisioning** (spec Phase 6). Rev 2 assumed one platform-level `TURNSTILE_SECRET`. Corrected in Phase 3.
8. **Claude workflow guardrails**: no force-push, protected content directory, PR/preview mode; **`workflow_dispatch`** (not `repository_dispatch`) for prompts; status streaming (queued→…→deployed); **"this run used ~X minutes"** cost line (spec Phase 4). Rev 2 had only the three cost caps. Added to Phase 4.
9. **Lighthouse representative page set** (homepage + post + programmatic page + heaviest template) so large sites deploy in minutes (spec Phase 6). Amended P2 in §0.2.
10. **Third-party scripts must load via Workers proxy or `defer`** (spec covenant P7). Amended P7 in §0.2.
11. **Gate checks "word count" and "visible in UI"** named explicitly (spec Phase 5). Amended Phase 5.
12. **HowTo schema** alongside Article/FAQ (K8). Folded into template scope.
13. **"Live in under 10 minutes"** genesis target (K1) + orgs→sites seam (spec Phase 1, deferred with a no-remodel path). Noted in Phases 1 & 3.
14. **Plain-language errors + no-plaintext-secrets** elevated from scattered mentions to cross-cutting non-negotiables at the top of this file.
15. **Workers Builds vs Action-gated deploy conflict** (spec Phase 3 vs covenant enforcement) — surfaced as decision E rather than silently picking one.

K9 deviation (flagged, believed approved): spec says imports convert to markdown; per confirmed decision #3 (CMS is the content store) imports become CMS posts instead. Same zero-404 outcome.

## ASK ME A–F — RESOLVED (rev 3 approval)

- **A. Email: Resend**, sending from `arsal.app` (SPF/DKIM DNS records go in the provisioning docs). Platform-wide: verification, reset, contact-form delivery, alerts.
- **B. Billing: $29/mo flat, unlimited sites; 14-day trial, no card required; no agency tier at launch** — `customers.plan` field is the tier seam (no migration to add tiers later). **Trial expiry behavior**: sites stay live (customer's own infra — never taken down); dashboard goes read-only; publishing and prompt-edits pause until subscribed.
- **C. Prompt-edit default: preview-then-approve**; per-site setting flips to direct-to-live.
- **D. OAuth apps: platform-owned** under the owner's accounts; creation + verification checklist delivered as `OAUTH_SETUP.md` (verification lead time runs in parallel with Phases 1–6).
- **E. SPEC AMENDMENT (approved): deploy is Action-gated `wrangler deploy`, NOT Workers Builds auto-deploy.** Workers Builds deploys on push and cannot be blocked by CI gates; the Action deploys only after Lighthouse + security-header gates pass, making "budget fail = deploy blocked" literally true. Supersedes spec Phase 3's "Workers Builds" wording.
- **F. Orgs: customers-as-org seam** confirmed (`customer_seats` joins in Phase 9; `customer_sites.customer_id` is the org key from day one).

Also resolved earlier: Anthropic auth = customer API key as repo secret (subscription-OAuth variant possible later), Astro, `ArsalR/site-template`, embeddings deferred behind the scorer seam.

**rev 3 APPROVED including the K9 deviation (imports → CMS posts). Phase 1 is a go.**

## Spec amendments 2 & 3 — recorded post-hoc (Phase 4 merge review)

**Provenance note (honest record):** these two amendments were referenced at the Phase-4 merge review as if previously communicated, but they appear in no prior message, no PLAN revision, and no commit of `SAAS_BUILD_PROMPT.md` (single commit, 985e4b3 — verified). They are recorded here from the review's summary; **please push the full amendment text into SAAS_BUILD_PROMPT.md** so a line-by-line verification can confirm nothing below is under-specified.

**Amendment 2 — site kinds + ecommerce (K13):** per-site `kind` (content | ecommerce | …) in the content model; a wizard **Stripe step** for ecommerce sites; **kind-aware genesis** (prompt + template behavior branch on kind). *Was slotted for Phase 3; shipped without it — Phase 3 predates this record.*

**Amendment 3 — structure covenant:** modular platform layout with a written `STRUCTURE.md`; **circular-dependency lint** in platform CI; a **deploy-blocking SEO-file-set CI check on generated sites** (robots.txt, sitemap, llms.txt present in every build).

**Full amendment text is now in SAAS_BUILD_PROMPT.md (appended verbatim at the Phase-4 merge review).**

**Catch-up schedule (approved: docs + partial gate now, full code in Phase 4.5 before Phase 5):**
- **Shipped in PR #25:** this record + a first SEO-file gate (6 files) + robots.txt generation + preview cleanup + guardrail tests.
- **Phase 4.5 (`phase-4.5-structure-ecommerce`, BEFORE Phase 5) — line-by-line coverage of both amendments:**

  *Amendment 3 first (structure pass, so Phase 5 lands in the new layout):*
  1. `STRUCTURE.md`: module map + the rules (each module owns routes + service + schema + tests; `src/shared/` for cross-module utilities; cross-module imports ONLY via a module's public `index.ts`).
  2. Target platform layout `src/modules/{auth,customers,vault,provisioning,sites,publishing,quality-gate,ecommerce,webhooks,billing,analytics}/` — **incremental migration, tests green each step, existing API byte-identical** (pre-SaaS CMS code migrates last or stays put; the frozen-contract surface is not reshuffled for cosmetics).
  3. **Circular-dep lint in CI** (madge over src/, fails pr-checks on any cycle) + public-index import rule check.
  4. **Full SEO-file gate on generated sites** — the shipped 6-file gate (index.html, robots.txt, sitemap-index.xml, llms.txt, _headers, _redirects) is extended to the amendment's complete list. **Gate-diff, honestly noted — missing today:** RSS feed (template doesn't generate one yet), canonical-tag verification (tags exist in Base.astro; gate doesn't check them), OG + Twitter meta (**template gap — Base.astro currently emits neither**), JSON-LD verification (emitted; unchecked), favicon set + manifest (**template gap — none shipped**), custom 404 page (**template gap — `not_found_handling` expects a 404.html no page generates**). Phase 4.5 adds the missing template features AND extends `check-seo-files.mjs` to verify all of: sitemap, robots, RSS, llms.txt, canonical, OG/Twitter, JSON-LD, favicons+manifest, 404, redirects. Missing any = deploy blocked.
  5. Generated-repo professionalism: `src/content/`, `src/components/`, `src/layouts/`, `src/pages/`, `public/`, clean naming, zero dead code, per-repo README.

  *Amendment 2 (site kinds + K13):*
  6. **Launch kinds: content/blog, ecommerce, local-business, portfolio/services** — shared core (both covenants, seven trust pages, full SEO set), kind-specific layout/content model; `customer_sites.kind` master migration (default 'content', existing rows unaffected); **genesis asks the kind first** (wizard field feeds kind-aware genesis prompts).
  7. **Ecommerce, static-first:** products as a CMS content collection (price, images, variants, stock flag — additive per-site schema, public API untouched); product + category pages statically generated with **Product/Offer JSON-LD, clean URLs, OG images**; **cart is the ONLY JavaScript island** (explicit, deliberate exception to the zero-JS gate, scoped like the Turnstile allowance); **Stripe Checkout on the customer's own Stripe account** (BYO-Stripe wizard step, key vault-encrypted — distinct from Phase-9 platform billing); a small Workers endpoint creates checkout sessions server-side (**price math never client-side**); a webhook records orders back to the CMS (**per-site orders table**).
  8. **Launch scope: digital + simple physical goods only** — no inventory sync, no tax engine, no multi-currency (flagged post-launch).
- **Phase 5 addendum:** the quality gate hooks the SaaS publish path — **genesis seed articles route through the gate like any other publish** (genesis switches to draft-then-gated-publish once the gate exists; launch-day sites are never exempt).

## Spec-gap list — what PLAN v1 was missing (now absorbed)

Found by reconciling v1 against the spec content now available:

1. **Covenants were under-specified as CI gates.** v1 had the Lighthouse budget gate but did not enumerate: the zero-JS CI assertion (P1), the no-Google-Fonts check (P4), the CSS budget (P5), the **third-party script firewall with wire-cost UX** (P7 — entirely missing from v1), RUM/CWV degradation alerts with "ask Claude to diagnose" (P8), the optional PageSpeed badge (P9), and the **security-header CI verification** (S2 — v1 baked headers into the template but didn't gate deploys on them). Now all in §0.2 with enforcement locations.
2. **Cost guardrails on Claude-in-Actions** — entirely missing from v1: 15-min job timeout, per-site concurrency group, hourly dispatch cap with `quota_exceeded`. Now in Phase 4.
3. **`workers.dev` disabled on production sites** — missing from v1's provisioning step list. Now in Phase 3.
4. **Quality gate ON by default** — v1 described the gate but not its default posture. Now explicit in Phase 5 (default-on, audit-logged opt-out).
5. **Trust pages under-enumerated** — v1 said "trust-page set (K1)"; the spec requires the specific seven pages, filled with wizard details (never lorem ipsum), dated, footer-linked. Now enumerated in Phase 3.
6. **Edge/protocol settings** (Early Hints 103, HTTP/3, Brotli, immutable + SWR cache headers) — v1 mentioned none. Now P6 in §0.2, wired into Phase 3 provisioning.
7. **AEO quotable summary blocks** — v1 had llms.txt + schema but not the summary-block requirement. Folded into the template scope (Phase 3) and the AEO checklist (Phase 7).
8. **Free-tier consequences** (decision #6) — v1 assumed paid: crypto params now config-driven with versioned envelopes (Phase 2), uptime deferred/30-min cadence with config-driven upgrade path (Phase 6).

---

*Unrelated but pending from earlier: the `/admin/` 404 fix is merged to `main` but production deploy is still blocked — `CF_API_TOKEN`/`CF_ACCOUNT_ID` were added as GitHub **environment variables**; the workflow needs them as **repository secrets** (Settings → Secrets and variables → Actions → Secrets tab).*
