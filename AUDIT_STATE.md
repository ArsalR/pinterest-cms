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
