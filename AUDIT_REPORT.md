# AUDIT_REPORT.md — SiteNetwork OS pre-launch adversarial audit

Auditor stance: hostile, evidence-only. Every claim below points to a file:line, a
command output, or an executed test. Where I could not verify something from inside
this environment (needs live credentials / a cold template build), it is marked
NOT-VERIFIED and pushed to the runbook — never "passed".

**Scope covered this session:** Part A (full), Part C (full), Part D (strong, 2 fixes +
IDOR guard), Parts B/E/F/G (partial — see each part and `AUDIT_STATE.md`).

---

## Verdict: **GO-WITH-CONDITIONS**

The core is sound: static floor green from a clean install, no circular deps, secrets
vault-encrypted with per-tenant derivation and tamper tests, byte-identical tenant
fall-through preserved, IDOR scoping consistent and now regression-tested, webhooks
signature-verified and replay-idempotent. Two real (MEDIUM) security gaps were found
and fixed in this PR. **No CRITICAL or HIGH confirmed.**

Conditions that must clear before flipping `SAAS_MODE` on (all owner-side, none are code):
1. Run the **cold template build + deliberate-break** verification (Part G) on the
   published `site-template` repo — confirm each covenant gate blocks deploy.
2. Execute the **full mocked lifecycle** once against a staging Worker (Part F).
3. Ensure `JWT_SECRET ≠ SAAS_JWT_SECRET` (now defended in code, but keep them distinct).
4. Complete the OWNER_RUNBOOK secret + DNS + Stripe steps and the post-flip smoke test.

---

## Findings

### FIXED IN THIS PR

**F1 — MEDIUM — Auth boundary: tenant admin accepted SaaS tokens (token confusion)**
- Evidence: `src/middleware/authMiddleware.ts` previously checked only `payload.sub`;
  admin tokens are minted without `aud` (`src/routes/admin/login.ts:77`) while every
  SaaS token carries one (`customers.ts:243`, oauth states, `agency/service.ts:106`).
- Impact: if an operator set `JWT_SECRET == SAAS_JWT_SECRET`, a customer's SaaS session
  JWT could be replayed as a `cms_session` cookie on any tenant site. The user-existence
  lookup normally blocks this (a customer `sub` isn't in the tenant `users` table), but
  the **fail-open DB-error path** (`authMiddleware.ts:53`) would trust the foreign token's
  `role:"admin"`. Blast radius: full tenant CMS takeover under that misconfiguration.
- Fix: reject any token carrying an `aud` claim, before the user lookup. Non-breaking
  (legit admin tokens have no aud). Regression: `authMiddleware.test.ts` (3 tests).

**F2 — MEDIUM — Dashboard had no security headers (clickjacking / missing CSP+HSTS)**
- Evidence: `grep` for `x-frame-options|content-security-policy|strict-transport` across
  `src/` returned nothing — the platform's own dashboard/admin/API responses set none.
  (Customer sites get them via the template `_headers`; the dashboard did not.)
- Impact: the authenticated, state-changing dashboard was framable → clickjacking, only
  partly mitigated by the SameSite=Lax session cookie.
- Fix: `saasSecurityHeaders` middleware on `saasAppRoutes` — `frame-ancestors 'none'`,
  X-Frame-Options DENY, nosniff, Referrer-Policy, HSTS, default-src 'self' CSP. **Scoped
  by `saasActive()`** so tenant fall-through responses stay byte-identical. Regression:
  `securityHeaders.test.ts` (incl. a byte-identical tenant-host assertion).

### GUARD ADDED (invariant was already correct)

**F3 — D5 IDOR scoping** — every dashboard site/seat loader scopes by `customer_id`
(grep table in Part D). Added `src/modules/network/idor.test.ts` proving customer B
cannot read customer A's site or delete A's seat, against a tenant-enforcing fake DB.

### NOT FIXED — proposed / owner-decision

**F4 — MEDIUM (owner-decision) — Admin auth fail-open on DB error.**
`authMiddleware.ts:53-55` trusts the JWT if the user-existence lookup throws (documented
as intentional availability tradeoff). With F1 fixed the token-confusion angle is closed,
but a fail-open admin check is still a posture choice. Changing it to fail-closed touches
frozen tenant behavior (a transient Turso blip would log admins out) — **needs owner
sign-off**; not changed unilaterally per fix policy.

**F5 — LOW — Dev-only dependency CVEs.** `npm audit` = 7 (5 high) in vite/ws/miniflare/
launch-editor. Confirmed dev-only/transitive (runtime deps = `@libsql/client @noble/*
hono`); none ship in the Worker bundle; the high ones are Windows-specific. `npm audit fix`
when convenient; not launch-blocking.

**F6 — LOW — SSRF surface is inert on Workers.** WP REST import, R2 media rehost, dead-link
checker, and the affiliate go-redirect all fetch customer-influenced URLs. Cloudflare
Workers have no VPC/metadata network, and the affiliate redirect validates the target host
against the site's own affiliate domains (open-redirect guard, `affiliate/service.ts`).
Practical risk LOW; revisit if ever ported off Workers.

**F7 — LOW — Root marketing/portal pages lack the new headers.** F2 covers `/app/*`
(the authenticated risk). The public `/`, `/privacy`, `/terms`, `/portal` root mounts are
non-state-changing; adding the same middleware there is a small follow-up.

**F8 — LOW — Affiliate click-count inflation.** The public `/api/saas/go/:siteId` counter
has no per-IP limit; clicks can be spammed to inflate a site's own affiliate totals
(cosmetic; no cross-tenant leak, no open redirect). Rate-limit if it matters.

---

## Part C — contract integrity (verified)
- Disabled endpoint returns **404 not_found**, not 403: `routes/public/v1/posts.ts:218`.
- Discovery-list parity enforced by test: `src/lib/audit.test.ts`.
- Cron dispatch: exactly two strings in `wrangler.toml` (`*/5`, `0 4`), each with an
  explicit branch in `worker.ts scheduled()`; SaaS crons ride existing branches gated on
  `SAAS_MODE` (gotcha #8 respected).
- Webhook replay idempotency: ecommerce order `INSERT OR IGNORE` on `UNIQUE(stripe_session_id)`
  (`ecommerce/routes.ts`); billing plan update is a `SET` (idempotent). Both verify the
  Stripe signature and reject missing/wrong/malformed (401/400).

## Part D — security (verified beyond the two fixes)
- SaaS session enforces `aud:"saas"` + separate secret (`customers.ts:252`). Cookie:
  HttpOnly + Secure + SameSite=Lax + 7d (`authPages.ts:125`).
- Vault: per-tenant HKDF derivation, versioned envelope, tamper-fails-closed, generic
  errors — covered by `vault/vault.test.ts` (14 assertions, pre-existing).
- SQL: no string-built queries — all `execute({sql, args})` parameterized (grep).
- Secret logging: static scan (`src/lib/audit.test.ts`) finds zero `console.*` lines
  interpolating a raw credential.
- Prompt key-scrub: `dispatchPrompt` refuses key-bearing prompts before any write/dispatch
  (`sites/security.test.ts`).

## Part E4 — free-tier limits (MEASURED)

Cloudflare free tier: **50 subrequests + 10ms CPU per invocation** (a `fetch`
handler and its `waitUntil` work share one budget; each Turso `execute` and each
external API call is one subrequest). Counts below are from the code.

**FINDING E4-A — HIGH (launch-blocking on free tier): provisioning exceeds the
per-invocation budget.** `runProvisioning` (`provisionSite.ts`) loops **all 11
steps in one `waitUntil` invocation**. Per-step it makes external calls (GitHub
repo/secret/dispatch, CF domain/turnstile/analytics, Turso) *plus* ~4 master-DB
subrequests for step tracking (`setStep`×2 + `getSite` + `getConnection`).
Measured totals for one full run:
- `cms_site` alone previously ran the ~40-statement site schema one-execute-at-a-
  time (~40 subrequests) + 2× PBKDF2(100k) (~10–16ms CPU) → **exceeded BOTH
  limits by itself**.
- Full run ≈ **~100 subrequests** (≈40 external + ≈44 master-tracking + schema),
  ≈2× 50-subrequest limit; CPU dominated by 2× PBKDF2 + 6× RSA (installation-token
  signing, once per GitHub step).
- **Mitigation landed:** schema now applies as **one `batch()`** (40→1
  subrequest, `provision.ts`, tested). This fixes the standalone network-admin
  `createSite` (used by the frozen CMS path) and removes the single worst spike.
- **Still required (NOT landed — owner-decision):** the *driver* must run **one
  step per invocation** so no single invocation exceeds ~15 subrequests. Two
  viable designs: (1) **self-continuation** — after each step, if more remain,
  `waitUntil(fetch(<self>/api/saas/_provision/:id?t=<signed>))` starts the next
  step in a fresh invocation (fast, free-tier-safe; adds 1 subrequest/step;
  needs a signed internal endpoint); (2) **cron-advance** — the */5 tick advances
  each in-progress site by one step (trivial, but ~55min to fully provision).
  Recommendation: self-continuation. **Or** move to Workers Paid ($5/mo →
  1000 subrequests, 30s CPU), which removes E4 entirely. This is the single
  decision that gates a free-tier launch.

**FINDING E4-B — MEDIUM (mitigated): background crons exceeded the budget.**
- Dead-link cron did **up to 40 sites × 150 link probes = ~3000 subrequests** in
  one daily invocation. **Fixed:** capped to 1 site × 40 probes per tick (weekly-
  throttled; remainder next tick).
- Monthly-report cron was **unbounded** (seats×sites × ~5 subrequests each).
  **Fixed:** capped to 6 sites per invocation (monthly-throttled).
- Note: R2 GC + dead-link + report all ride the **same daily `0 4 * * *`
  invocation** and share its 50-subrequest budget; the caps keep the sum safe
  (GC + 40 + ~30). If more background work is added, split it across cron strings.

**PBKDF2 CPU (E4-C — proposed):** `createSite` hashes the admin password AND the
API key with PBKDF2(100k). API keys are high-entropy (`cms_live_<32hex>`) and do
not need password-stretching — a single SHA-256 would be cryptographically
sufficient and ~free, halving `cms_site` CPU. Touches the frozen API-key verify
path (existing keys), so **owner-decision**, not changed here.
## Part G — template cold build (EXECUTED, PASS)
Cold-cloned the template, `npm install && npm run build` against a stub CMS:
- **G1** build succeeds; **G6** empty-site (`total:0`) builds a full valid site. Missing
  key / CMS-unreachable hard-fail is the documented design (`cms.ts:62`).
- **G2** gates BIND: on the clean dist all three pass (exit 0); each returns **exit 1**
  when deliberately broken — injected `<script>` (zero-js), dropped `X-Frame-Options`
  from `_headers` (headers), deleted `robots.txt` (seo) — then green again when restored.
- **G3** all 7 trust pages render with config values (the "placeholder" text is the sample
  `site.config.json` niche, literally "overwritten by provisioning").
- **G4** ecommerce kind builds; the ONLY client script in the built HTML is `/cart.js`
  (the scoped cart island); zero-js gate passes.
- **G5** `dist/404.html` present. Full SEO set emitted: 404, _headers, _redirects, robots,
  rss.xml, llms.txt, sitemap-index + sitemap-0, site.webmanifest, favicon.
- LHCI budget run not executed here (needs Chromium + preview server); budgets asserted
  statically in `src/lib/audit.test.ts` and wired deploy-blocking in `deploy.yml`.

## NOT-VERIFIED (do before launch — see runbook)
- Part B full line-by-line covenant matrix (spot-checked; locked decisions VERIFIED).
- Part E4 real subrequest/CPU measurement for worst-case provisioning + report cron.
- Part F single end-to-end lifecycle artifact log.
- Part G LHCI Lighthouse budget run (rest of G executed above).

---

## Appendix A — env var / secret inventory

| Var | Consumed in | Required when | If unset |
|---|---|---|---|
| TURSO_MASTER_URL / _TOKEN | lib/turso | always | master DB unreachable → 500s |
| TURSO_ORG / GROUP / API_TOKEN | provisioning | provisioning a CMS DB | that step fails, resumable |
| CF_API_TOKEN / ZONE_ID / ACCOUNT_ID | CMS core | tenant CMS ops | tenant features degrade |
| JWT_SECRET | admin auth | always | admin login refuses |
| NETWORK_ADMIN_KEY / _HOSTNAME | network admin | provisioning API | network API 500/inert |
| SESSION_COOKIE_NAME | admin auth | optional | defaults `cms_session` |
| SAAS_MODE | worker/auth | to enable SaaS | SaaS inert (default) |
| SAAS_APP_HOSTNAME | saas gating | SaaS on | SaaS inert |
| SAAS_JWT_SECRET | customer sessions | SaaS on | signup/login refuse |
| VAULT_MASTER_KEY | vault | SaaS connections | connect/provision fail-closed |
| RESEND_API_KEY | email | SaaS on | dev-log mode (no email sent) |
| GITHUB_APP_ID / _PRIVATE_KEY / _SLUG | connections | provisioning | GitHub connect "unavailable" |
| GOOGLE_CLIENT_ID / _SECRET | network (GSC) | Phase 7 live | GSC "available soon" |
| PINTEREST_APP_ID / _SECRET | pinterest | Phase 8 live | Pinterest "available soon" |
| PLATFORM_STRIPE_SECRET_KEY / _WEBHOOK_SECRET | billing | billing live | "billing opens soon" |
| SAAS_PRICE_STARTER_CENTS / _AGENCY_CENTS | billing | optional | default 2900 / 7900 |
| SAAS_TRIAL_DAYS | signup | optional | default 7 |
| SAAS_TEMPLATE_REPO / CMS_HOST_SUFFIX | provisioning | optional | default ArsalR/site-template, cms.arsal.app |
| SAAS_PBKDF2_ITERATIONS | customer hash | optional | default 100000 |
| FEATURE_* / GC_ENABLED / RATE_LIMIT_RPM | CMS core flags | optional | disabled / defaults |

All vars read in code are declared in `src/lib/types.ts` — no undocumented reads found.

## Appendix B — conformance spot-check (locked decisions)
| Decision | Status | Evidence |
|---|---|---|
| Trial expiry → read_only (sites stay live) | VERIFIED | `customers.ts:256 planGate` |
| Preview-then-approve default | VERIFIED | `sites/routes.ts` mode radio "preview" checked |
| Quality gate default-ON | VERIFIED | `quality-gate/gate.ts DEFAULT_GATE_CONFIG`; genesis→drafts prompt |
| Byte-identical fall-through | VERIFIED | all SaaS handlers `pub/prot` → `next()` when `!saasActive` |
| Customer-key-only inference | VERIFIED | Anthropic key sealed to repo secret; never spent server-side |
| $29 / $79 tiers, 7-day trial | VERIFIED | `billing/plans.ts` defaults 2900/7900; `TRIAL_DAYS=7` |
| No plaintext secrets | VERIFIED | vault tests + no-secret-logging scan |
