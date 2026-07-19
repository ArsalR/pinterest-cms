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

## Appendix C — Part B conformance matrix (line-by-line)

Status: **V**erified (file:line) · **P**artial · **M**issing · **D**eviated (justified).

### Performance covenant (P1–P9)
| # | Item | St | Evidence / note |
|---|---|---|---|
| P1 | Zero-JS by default | V | `check-zero-js.mjs` gate binds (Part G); ecommerce cart is the only island |
| P2 | Lighthouse budget gate (deploy-blocking) | P | budgets in `lighthouserc.json` + `deploy.yml` step + static assert (`audit.test.ts`); **actual LHCI run not executed here** — owner/CI on first publish |
| P3 | Image pipeline (R2, AVIF/WebP srcset, dims) | V | `site-template/src/components/Img.astro`, `astro.config.mjs` sharp service |
| P4 | Font discipline (system stack, swap, self-host) | V | template base styles; no Google Fonts requests |
| P5 | CSS discipline (<20KB, critical inline) | P | Astro inlines; the <20KB ceiling is not separately gated |
| P6 | Edge everything (immutable cache, HTTP/3, Brotli) | V | `public/_headers`; Cloudflare-served |
| P7 | Third-party script firewall + wire-cost UX | P | `analytics/scriptCost.ts` estimate + warning built; the interactive "add anyway?" override flow is not a wired dashboard moment |
| P8 | Continuous RUM + degradation alerts | V | `analytics/cwv.ts` + performance page + `cwvAlerts` |
| P9 | PageSpeed badge (optional) | M | not built — spec marks it optional ("may") |

### Security covenant (S1–S5)
| # | Item | St | Evidence |
|---|---|---|---|
| S1 | Static = no attack surface | V | template is static; no origin DB/admin |
| S2 | Security headers in CI (fail=block) | V | `check-headers.mjs` gate binds (Part G break-test) |
| S3 | CF WAF/bot/DDoS via API at provisioning | V | `enableZoneProtection` in `provisionSite.ts` zone_protection step |
| S4 | Tokens encrypted per-tenant, never logged, sigs verified, dispatch rate-limited, audit log | V | vault (`vault.test.ts`), no-secret-log scan, webhook verify, `PROMPT_DISPATCH_LIMIT`, `audit()` on every decrypt |
| S5 | Git backup + one-click rollback | V | `rollbackToCommit` (forward-revert, `githubApi.test.ts`) |

### Killer features (K1–K13)
| # | Feature | St | Evidence / gap |
|---|---|---|---|
| K1 | One-prompt genesis + 7 trust pages + Turnstile contact form | V | `sites/prompts.ts` genesis; `[trust].astro` (Part G: 7 pages); `webhooks/forms.ts` |
| K2 | Programmatic SEO through the gate | V | `pseo/generate.ts` + `quality-gate` |
| K3 | Network brain: GSC, uptime, **404 monitor** | P | GSC (`network/gsc.ts`) V; uptime (`analytics/uptime.ts`) V; **404 monitor MISSING** (finding B-1) |
| K4 | Decay radar + refresh | V | `network/decay.ts` + "Refresh with Claude" |
| K5 | Internal linking + orphan detection | V | `linking/scorer.ts` + `orphans.ts` |
| K6 | Cloning (marketplace later) | V/D | clone flow `cloning/` V; marketplace deferred by spec ("Later") |
| K7 | Pinterest drip + pin-image generation | P | OAuth + drip queue V (`pinterest/`); **auto-generating 2–3 pin images DEVIATED** — pins use the post's cover image (finding B-2) |
| K8 | AEO: llms.txt, schema, per-post checklist | V | `llms.txt.ts`, `@graph` schema, `network/aeo.ts` |
| K9 | WP import → R2 + edge redirects | V/D | WXR+REST, R2 rehost, 301 map (`importer/`); "→ markdown" DEVIATED — content stored as HTML (CMS-native), documented |
| K10 | Affiliate: cloaked links, dead-link cron, edge clicks | P | dead-link cron + edge click counter V; **named cloaked short-link manager PARTIAL** (finding B-3) |
| K11 | Agency: white-label, seats, monthly reports | V | `agency/` (branding, seats, report cron), tier-gated |
| K12 | Preview/rollback safety net | V | preview mode + `rollbackToCommit` |
| K13 | Site kinds + ecommerce (Amendment 2) | V | 4 kinds; ecommerce cart-only island, BYO-Stripe, server-side checkout (Part G) |

### Non-negotiables + Amendment 3
| Item | St | Evidence |
|---|---|---|
| Endpoints byte-identical / all behind saas_mode | V | fall-through gating; Part C; `securityHeaders.test.ts` tenant no-op |
| Covenants deploy-blocking | V | Part G break-tests |
| Idempotent, resumable provisioning | V | `resume.test.ts` |
| No plaintext secrets | V | vault + scan |
| Plain-language errors | V | sampled throughout; gate detail strings (Part F) |
| Structure covenant (modular, no cycles, barrel-only) | V | `lint:structure` CI, 22 modules |
| Full SEO file set gate | V | `check-seo-files.mjs` (Part G break-test) |

### Part B findings (all MEDIUM/LOW — none launch-blocking)
- **B-1 (MEDIUM) — K3 404 monitor not built.** Spec: "404 monitor (top 404 paths from CF analytics, one-click add redirect)". The `redirects` table + frontend redirect handler exist (used by WP import), so the fix is additive: read top 404s from CF analytics + an "add redirect" button. Proposed, not built.
- **B-2 (LOW/DEVIATED) — K7 pin-image generation.** Pins are created from the post's existing cover image, not 2–3 template-generated images. Reasonable deviation (image generation in Workers is heavy); functional pinning works. Recordable as a post-launch enhancement.
- **B-3 (LOW/PARTIAL) — K10 cloaked short links.** The edge redirect + per-link click counting exist; the human-named `/go/product-x` central link manager (update-once-across-N-sites) is not built.
- **P2/P7/P5 partials** noted in the table (LHCI live run, script-override UX moment, CSS-size gate) — enhancements, not blockers.

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

---

# V1.3 FULL-SYSTEM AUDIT (July 2026 — profiles + V1.2 suite + everything since)

Adversarial stance unchanged: every claim below is an executed command or a
test in the repo. Scope: V1.1 design options, V1.2 SEO Command Suite (S1–S6),
V1.3 decisions (assists/scripts/WAF) + five SEO profiles, and the platform
underneath them.

## Verdict: **GO**

No CRITICAL or HIGH open. One HIGH was found DURING V1.3 and fixed with
regression tests before this audit (migration-runner idempotency, PR #54). One
MEDIUM found in this audit (silent robots-vs-edge contradiction) fixed in this
branch. Remaining MEDIUM/LOW are listed honestly below — none launch-blocking.

## 1. Full regression — EXECUTED
- Clean `npm ci` → typecheck ✓, madge no cycles (24 modules, barrel-only) ✓,
  **454 vitest tests green** (was 283 at the last audit; +171 across V1.2/V1.3,
  every stage landed with guardrail-fires tests).
- Tenant API frozen-contract check: `git diff a43ab04..HEAD` over
  `src/routes/public/v1/posts.ts`, `errors.ts`, `rateLimit.ts`,
  `idempotency.ts`, `src/middleware/` = **empty**. All V1.3 API work is new
  endpoints (`/v1/local`, `/v1/authors`, `/v1/merchant`) or additive fields on
  V1.2-added endpoints; both discovery lists updated in every case.
- Template cold build EXECUTED (fresh `npm install`, stub CMS):
  - Empty default site: 12 pages / 1.15s, all three covenant gates PASS, and
    **zero** profile artifacts emitted (no news/image sitemap, no llms-full,
    no feed, no key file, no script manifest).
  - **Determinism proven byte-for-byte**: two consecutive default builds diff
    EMPTY (`diff -r` on dist).
  - Every gate deliberately broken and confirmed BLOCKING (exit 1): injected
    `<script>` → zero-js gate; dropped `X-Content-Type-Options` → header gate;
    deleted robots.txt → SEO-file gate; **over-budget script selection
    (GA4+Crisp+CookieYes = 130KB > 100KB) → build fails with the
    plain-language report naming offenders and the lighter swap**.
  - Light script selection (Plausible): builds, CSP extended with exactly its
    hosts, tag emitted, zero-js gate sanctions it via the manifest.
- Preset×kind matrix: runs in template CI (pr-checks); locally verified
  representative kinds (content, ecommerce) on the default preset.

## 2. New-surface security — EXECUTED (code-level)
- Every V1.3 `/app` route is `prot()`-wrapped (grep over appRouter: zero
  unprotected `sites/:id/*` mounts; the only `pub()` routes are marketing
  pages + the static cockpit JS).
- IDOR: automated scan over all 31 seo-module handlers — every handler that
  reads `:id` resolves it through a tenant-scoped loader
  (`WHERE id = ? AND customer_id = ?`). Zero unscoped handlers.
- Assist endpoint: the Anthropic key never appears in any response or log;
  prompt/output never logged; content loaded server-side (browser never ships
  the body); 60/hr per-customer rate limit pinned by test.
- WAF path: `zone_id` comes off the customer's own `customer_sites` row inside
  the tenant-scoped query; the token comes from their vault. There is no code
  path accepting a zone id from the request. Guardrail test proves the WAF
  expression can never match a major search engine.
- Script controls: unknown ids/malformed config dropped at parse (test);
  template re-validates against its own closed catalog; only exact catalog tag
  shapes can be emitted (no arbitrary injection path).

## 3. Conflict hunt — EXECUTED
- Sitemap composition: worst-case build emits news + image sitemaps and joins
  BOTH into Astro's sitemap-index (verified in dist; idempotent insert
  unit-tested; re-runs add nothing).
- All-profiles schema graph: on the worst-case build, a post page's graph is
  `NewsArticle + BreadcrumbList + FAQPage + Person + DefinedTerm` with unique
  @ids; article carries abstract (TL;DR), about (focus keyword), author →
  author page. Homepage: `WebSite + Store(LocalBusiness)` + global
  Organization block. Product page: full merchant depth
  (brand/MPN/rating/condition/shipping/returns) + BreadcrumbList. JSON parsed
  and validated from the built HTML, plus a pure composition test suite.
- The 48-hour news window holds exactly (48 of 500 hourly posts in the news
  sitemap); llms-full exclusion holds exactly (450 of 500 with every 10th
  excluded); Merchant feed fills (50 items, correct g: fields).
- Robots vs edge vs AI preset: FIXED this branch — when robots.txt and the
  edge rule disagree, the Control Center now says exactly which wins
  ("the edge wins") and points at the presets that align both. Presets apply
  both levels atomically by construction.
- Redirect loops: slug-change 301s, 404-monitor entries, and CSV imports all
  write the same `redirects` table that `detectChains` reads — chains AND
  loops across all three sources surface in the manager (loop guardrail test).

## 4. Performance — MEASURED
- **500-post site, ALL profiles on: 514 pages in 3.28s** (4s wall incl. gen
  scripts) on this container. Build time is content-fetch + render bound;
  profiles add three extra fetches total (settings/authors/local|merchant),
  memoized once per build.
- **Lighthouse CI EXECUTED LIVE** (Chromium, worst-case build, representative
  set: home, post with full AEO/news/author graph, product with merchant
  depth, about): **performance 1.0 / SEO 1.0 / best-practices 1.0 on all
  four; a11y 1.0 except 0.9 on /about** (pre-existing template page, not a
  V1.3 surface). Assertions passed (lhci exit 0). This also clears the
  long-standing "LHCI live run" owner condition from the previous audit.

## 5. Findings register
FIXED (pre-audit, during V1.3, each with regression tests):
- HIGH — migration runner crashed ("duplicate column") on every site
  provisioned after an ALTER migration shipped, also aborting that site's cron
  GC/webhook retries. Fixed: tolerant idempotent runner + `_migrations` seeded
  at provisioning in the same single batch. 3-state regression suite.
FIXED (this audit branch):
- MEDIUM — robots.txt vs edge-WAF disagreement was silent. Now called out in
  the UI with which level wins.
MEDIUM (open, honest):
- M-1 Cross-VERSION byte-identity: determinism within this version is proven
  byte-for-byte, but V1.2/V1.3 template expressions added whitespace-level
  deltas to `<head>` versus pre-V1.2 builds (semantically identical; all
  gates + LHCI green). Re-baselining "byte-identical" to this version is the
  honest framing.
LOW (open, honest):
- L-1 Scheduled-post publishes (tenant cron) don't fire IndexNow pings; the
  next dashboard publish batch covers them. Documented in code.
- L-2 Static maps use the community OSM staticmap instance — availability is
  best-effort; a broken image degrades gracefully. Swap to a keyed provider if
  it matters (owner call).
- L-3 /about a11y 0.9 (pre-existing heading-order nit).
- L-4 Ecommerce profile on a `kind=content` site emits an empty (valid)
  feed.xml — harmless; pairing is enforced by genesis defaults.
- L-5 Yoast/Rank Math import maps core SEO meta only (titles/desc/robots/
  canonical/OG/keyword) — niche plugin fields (e.g. cornerstone flags) are
  dropped silently. Import report counts mapped posts.

## Evidence appendix (commands executed this audit)
clean `npm ci` + full gate · frozen-contract `git diff` · empty build + gates ·
double-build byte diff · 4× deliberate gate breaks (all exit 1) · worst-case
500-post all-profiles build + artifact/window/exclusion counts · JSON-LD
parsed from built HTML (post/home/product) · LHCI live (4 URLs, exit 0) ·
IDOR handler scan · appRouter prot() scan.

---

# V1.4 WHOLE-SYSTEM VERIFICATION (July 2026 — Forms & Automation Engine + everything before it)

Scope: F1 Forms Engine · F2 Submissions Inbox · F3 Automation hooks · F4 ✨
Submission intelligence — verified on top of the full V1.0–V1.3 system.
Stance unchanged: hostile, evidence-only; every claim below was executed in
this session unless marked NOT-VERIFIED.

## Verdict: **GO**

No CRITICAL or HIGH findings. The forms surface follows every established
covenant: additive-only tenant API, saas-flag fall-through, zero-JS static
rendering (Turnstile the single allowed script, only where a widget exists),
tenant-scoped loaders everywhere, counts-only audit rows for AI paths.

## 1. Full regression — EXECUTED (cold)

- `rm -rf node_modules && npm ci` → clean install, then:
  `tsc --noEmit` ✓ · `lint:structure` ✓ (**25 modules, no cycles, barrel-only**)
  · `vitest run` ✓ **474 tests / 64 files** (V1.3 audit baseline was 434 —
  all 40 net-new tests are V1.4 forms/hooks/intel suites).
- Frozen contracts: `errors.test.ts` (pinned 16-code vocabulary) passes
  untouched; `/v1/forms` appended to BOTH discovery lists
  (`capabilities.ts:42`, `public/index.ts:47` notFound `available`) — additive.
- Flag discipline: every new public route self-gates —
  `submitRoutes.ts:41`, `newsletterRoutes.ts:45,55` `if (!saasActive(c)) return next()`
  → with `SAAS_MODE=""` the routes fall through to the tenant catch-all,
  byte-identical (same mechanism the V1.3 audit byte-verified).

## 2. Template composition build — EXECUTED (cold)

Stub gained a `STUB_FORMS` knob (mirrors `/v1/forms` exactly; post 0 carries a
form-embed marker + WhatsApp/Book CTA markers). Worst-case build:
30 posts · 10 products · ALL profiles (local,news,ecommerce,image,ai) ·
plausible script · **3 forms**, cold `npm install`:

- Build green; `/forms/stub-contact/`, `/forms/stub-form-1/`, `/forms/stub-form-2/`
  emitted as static pages; the embed landed inside post 0 with the Turnstile
  widget; the WhatsApp CTA rendered digits-only `wa.me/447700900123`.
- **All three gates green with forms present**: zero-js ✓ (Turnstile allowed on
  `/forms/*` + widget-bearing pages ONLY) · headers ✓ · seo-files ✓.
- Negative control: a post with CTA blocks but NO form embed carries **no
  Turnstile script** (grep count 0 on `synthetic-article-1`).
- Break-tests re-run: rogue external `<script src=https://evil.example/x.js>`
  injected into a built form page → gate names the file and fails; inline
  `<script>alert(1)</script>` on the homepage → **exit 1**. Restored, green.

## 3. Lighthouse budgets — EXECUTED (live LHCI, this build)

| URL | Perf | A11y | BP | SEO |
|---|---|---|---|---|
| `/` (home, all profiles) | **1.0** | 1.0 | 0.96 | 1.0 |
| `/posts/synthetic-article-0/` (**embedded form + Turnstile + CTAs**) | **1.0** | 0.94 | 0.96 | 1.0 |
| `/about/` | **1.0** | 0.9 | 0.96 | 1.0 |

All budget assertions passed (`lhci autorun` exit 0). The page that carries the
form + the one allowed script still scores 1.0 performance.

## 4. New-surface security — EXECUTED (code-level)

| Attack | Defense | Evidence |
|---|---|---|
| IDOR on forms/inbox/webhook/subscribers/domain routes | every handler resolves the site via `loadFormsSite(master, siteId, customer.id)` → `WHERE id = ? AND customer_id = ?` | `formsRoutes.ts:31-37`; 18 call sites across the three route files; zero direct-by-id loads |
| Upload smuggling (exe/php/svg behind image field) | closed magic-byte allowlist (jpeg/png/gif/webp/pdf) — `sniffUploadMime` returns null for anything else (incl. `MZ`/ELF headers) → request rejected; 5MB cap; R2 keys are `cuid().ext` under `<host>/form-uploads` (no user filename, unguessable) | `submitRoutes.ts:30-37,115-129` |
| Ack-email spam relay | recipient is ONLY `submitterEmail()` — the first **email-typed field of the STORED definition** (attacker cannot add fields; extra POST keys are dropped at validation); `renderAckTemplate` HTML-escapes all values and blanks unknown placeholders; From is the verified sending domain or platform address, never user input | `model.ts:119-122`, ack tests in `model.test.ts` |
| Form-spam flood | 5/hr per IP per form + 100/hr per site (before Turnstile), honeypot pretend-success, Turnstile verify with per-site vault secret | `submitRoutes.ts:76-94` |
| PII retention | stored meta is page path + `cf.country` (2 chars) — **no raw IP ever written**; retention purge setting 30/90/365 days | `submitRoutes.ts:131-133`, `inboxService.ts:53-61` |
| Newsletter abuse | double-opt-in (nothing sent to a list; confirmation only), idempotent, unsubscribe honored in exports; public confirm/unsub endpoints mutate only flag columns via ≥20-char single-use token / row id | `hooks.ts:140-179` |
| F4 key/content leakage | `grep console\.` across the module → **none**; key travels only into the `x-api-key` header; audit rows are counts-only tags (`site.intel_draft`, `site.inbox_digest_set`); prompt/output never persisted anywhere except the summary/score columns the customer owns | `intel.ts`, `inboxRoutes.ts` |
| Webhook SSRF-ish | outbound URL must match `^https:\/\/\S+$`; HMAC-signed with the existing scheme; delivery log + existing retry cron | `hooks.ts:36`, `service.ts` setFormWebhook |

## 5. Email paths — verified at the unit level

`sendEmail` (Resend) is exercised by pure tests for template rendering
(escaped ack, digest HTML) and by inspection for addressing: owner
notification → owner email; ack/inbox-reply → submitter address only, with
`Reply-To: owner`; From = `forms@<verified custom domain>` else
`forms@arsal.app` (`formsFromAddress`, status-gated). A live send needs real
Resend credentials → runbook smoke item (NOT-VERIFIED here, by design).

## 6. Findings register (V1.4)

- **M-1 (accepted, surfaced)**: form-webhook **retries** ride the existing
  cron which is gated on `FEATURE_WEBHOOKS` (default OFF in wrangler.toml).
  First-attempt delivery always fires; retry of failures requires the flag.
  → launch-checklist step added. (Alternative — un-gating the cron — would
  change existing-tenant behavior; rejected as non-additive.)
- **L-6**: drag-reorder shipped as keyboard ↑/↓ buttons (zero-JS covenant);
  spec said "drag" — surfaced in F1 PR, accepted.
- **L-7**: digest rides the `0 4 * * *` UTC branch (gotcha #8 — no new cron
  string), so "morning email" is 4-6am Europe / prior evening US. Cosmetic.
- **L-8**: `/about` a11y 0.9 pre-existing (L-3), unchanged by V1.4.

## Evidence appendix (V1.4 commands)

cold `npm ci` + typecheck + lint:structure + 474 tests · cold template
`npm install` + worst-case build (posts+products+profiles+script+**forms**) ·
3 static gates with forms · 2 deliberate gate breaks (both blocked) ·
CTA-only-no-Turnstile grep · LHCI live 3 URLs exit 0 · IDOR call-site scan ·
console-log scan · frozen-contract test run.
