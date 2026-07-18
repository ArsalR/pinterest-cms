# AUDIT_STATE.md — final adversarial audit progress

Branch: `final-audit` (from `main` @ 9c56416). Resume by reading this file.

## Fixes landed (each with a regression test)
- `cb3e2bd` MEDIUM — tenant admin auth rejects `aud`-bearing (SaaS) tokens (token-confusion). Test: `src/middleware/authMiddleware.test.ts`.
- `26b83d8` MEDIUM — SaaS dashboard security headers (clickjacking/CSP/HSTS), saas-scoped so tenant byte-identical holds. Test: `src/modules/app/securityHeaders.test.ts`.
- `<idor>` guard — cross-tenant IDOR regression test. `src/modules/network/idor.test.ts`.

283→ tests green, typecheck clean, 22 modules no cycles.

## Parts status (honest)
- **A Static** — DONE. typecheck/madge/tests green from `npm ci`. No backup/orphan files. No real TODO/FIXME. npm audit = dev-only CVEs (vite/ws/miniflare/launch-editor; not in Worker bundle). Env inventory built (report appendix).
- **B Conformance** — DONE. Full line-by-line matrix (P1–P9, S1–S5, K1–K13, non-negotiables, Amendment 3) in AUDIT_REPORT.md Appendix C. 3 gaps found: B-1 K3 404-monitor MISSING (MEDIUM), B-2 K7 pin-image-generation DEVIATED (LOW), B-3 K10 cloaked-short-link manager PARTIAL (LOW); plus P2/P5/P7 partials. None launch-blocking.
- **C Contract** — VERIFIED: disabled endpoint → 404 (`posts.ts:218`); discovery-list parity test (`src/lib/audit.test.ts`); crons exact-match (2 strings); webhook idempotency (ecommerce `INSERT OR IGNORE`, billing SET). SAAS on/off both green (277 base).
- **D Security** — STRONG PASS w/ 2 fixes. auth boundary fixed; cookie flags OK; vault already covered; IDOR scoping proven; SQL parameterized (no string-built queries found); no-secret-logging scan clean; SSRF = Workers-sandbox LOW.
- **E Money/failure** — E4 MEASURED (report §Part E4). Provisioning driver exceeds free tier (~100 subreq/invocation) → HIGH E4-A, mitigation landed (schema batch) + driver rewrite proposed (owner-decision). Cron subrequest blowups fixed (dead-link, report). Billing idempotent. E1/E2 resume + replay covered by Phase-10 tests.
- **F E2E journey** — DONE. `src/modules/app/lifecycle.test.ts` drives the full lifecycle against REAL in-memory SQLite, external HTTP stubbed. 9 steps, artifact log emitted.
- **G Template cold build** — DONE (executed). Cold `npm install && npm run build` succeeds; empty-site (stub CMS `total:0`) builds a full valid site; full SEO set emitted (404/_headers/robots/rss/llms.txt/sitemap/manifest + 7 trust pages). All 3 gates PASS on clean dist AND each returns exit 1 when deliberately broken (injected `<script>`, dropped header, deleted robots.txt) then green when restored. Ecommerce kind builds; `/cart.js` is the ONLY client island; zero-js gate passes. Missing-key / CMS-unreachable hard-fail is the documented design ("a silent empty site is worse than a red build", `cms.ts:62`). LHCI budget run NOT executed (needs Chromium+preview server); budgets asserted static in `src/lib/audit.test.ts`.

## AUDIT COMPLETE
All parts A–H executed. Fixes landed across PRs #39/#41/#42 (2 security MEDIUMs +
IDOR guard + free-tier E4 fixes + paid-tier crypto/uptime). Verdict: GO-WITH-CONDITIONS
→ conditions now largely cleared (paid tier chosen, template gates verified, lifecycle
harness green). Residual owner tasks: OWNER_RUNBOOK launch sequence; optional B-1/B-2/B-3
enhancements; LHCI live run on first template publish.

## Remaining enhancements (non-blocking)
1. Part B: line-by-line covenant matrix (spot-checked; locked decisions all VERIFIED).
2. Part E4: real subrequest/CPU count for worst-case provisioning step + report cron.
3. Part F: build a mocked full-lifecycle integration test.
4. Part G LHCI: run the Lighthouse budget assertions with Chromium (rest of G done).

---

# V1.3 PROGRESS CHECKPOINT (SEO profiles → audit → launch checklist)

Say "continue" and resume from the Work-remaining list below. Branch series
`seo-profiles-*`; every stage = own branch from latest main, full gate
(typecheck + lint:structure + vitest) before PR, merge when CI green.

## Decisions resolved by owner (V1.3 prompt)
1. AI assists: WIRED via customer vault key (PR #55). 60/hr limit, no content
   logging, hidden without key.
2. Script controls: vetted defer-only catalog (PR #56). 100KB budget gate,
   deploy-blocking in gen-redirects.mjs.
3. Edge bot protection: customer CF token WAF (PR #57). Named managed rule,
   non-clobbering, Firewall Services permission surfaced exactly.

## Job 1 stages landed
- #54 foundation: profiles registry/kind-defaults/hub toggles + migration 008
  + MIGRATION-RUNNER IDEMPOTENCY FIX (HIGH bug: fresh sites crashed at
  ALTER-migrations every cron; fixed via tolerant runner + _migrations seed).
- #55 assists · #56 scripts (migration 009) · #57 edge WAF.
- seo-profiles-local (THIS PR): migration 010 business_locations; pure
  local.ts builders (LocalBusiness JSON-LD per Google docs — name+address/
  areaServed required, honest-ratings guardrail); /v1/local; dashboard
  /app/sites/:id/local; template homepage/contact/locations pages.

## Work remaining
- P2 news (branch seo-profiles-news): news sitemap 48h + NewsArticle +
  authors table/pages (E-E-A-T) + IndexNow on publish + GSC resubmit hook.
- P3 ecommerce (seo-profiles-ecommerce): Merchant-depth Product schema
  (brand/GTIN/MPN/condition/shipping/returns cols on products), feed.xml at
  build, category SEO + BreadcrumbList, faceted noindex.
- P4 image (seo-profiles-image): image sitemap, EXIF/GPS strip on upload
  (uploadToR2 path), ImageObject license/creator, captions surfaced.
- P5 AEO/AI (seo-profiles-aeo): content blocks (TLDR/definition/QA/stat) with
  schema, llms-full.txt + per-page llms exclude, about/mentions entity schema,
  per-engine crawler presets (robots+WAF together via setAiBotWafRule), AI
  checklist in content.ts rules.
- Cross-profile: sitemap-index composition test (news+image children),
  schema-graph merge without duplicate @ids (worst case: all profiles on).
- Job 2 (branch v13-audit): FINAL_AUDIT_PROMPT.md rules; regression incl.
  byte-identical build check (NOTE: whitespace-level head deltas from added
  template expressions need honest verification), new-route security sweep
  (assists/WAF/scripts/profiles/local), conflict hunt (robots vs edge vs AI
  preset precedence — UI must say which wins), perf worst-case page, update
  AUDIT_REPORT.md.
- Job 3: LAUNCH_CHECKLIST.md consolidating OWNER_RUNBOOK + V1.3 additions
  (WAF token permission, IndexNow key, Merchant feed submission, assists).


---

# V1.3 JOB 2 — AUDIT COMPLETE (see AUDIT_REPORT.md "V1.3 FULL-SYSTEM AUDIT")

Verdict GO. 454 tests green from clean install; frozen contract diff empty;
determinism byte-proven; all 4 covenant gates verified blocking (incl. the new
script-budget gate); worst-case 500-post all-profiles build 3.3s/514 pages;
LHCI live run EXECUTED and passing (perf/SEO/BP 1.0) — clears the old owner
condition. Fixed this branch: robots-vs-edge silent contradiction (UI now says
which wins) + composition test suite + audit-grade stub knobs. Open: M-1
byte-identity re-baseline note, L-1..L-5 (see report).

Remaining: Job 3 — LAUNCH_CHECKLIST.md (docs PR).
