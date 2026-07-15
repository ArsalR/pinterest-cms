# STRUCTURE.md — code structure covenant

Amendment 3 makes code structure a **deploy-blocking covenant**, like the
Performance and Security covenants. `npm run lint:structure` enforces it in CI
(`madge --circular` + `scripts/check-module-boundaries.mjs`); a violation fails
the build.

## Two zones

This is a Cloudflare Worker (Hono + Turso + R2). There is no Docker / K8s /
nginx / terraform to organize — the covenant is adapted to *this* stack.

### 1. CMS core (frozen contract) — stays where it is

The pre-SaaS multi-tenant CMS. Its public API, webhooks, and error codes are a
frozen contract (see CLAUDE.md). It is **not** reshuffled into modules — moving
it would risk the byte-identical guarantee for zero benefit.

```
src/lib/            auth, turso, utils, cookies, types, seo, r2, redirects, …  (CMS-core services)
src/middleware/     tenantMiddleware, authMiddleware, corsMiddleware
src/routes/         admin/  frontend/  public/  network/     (CMS HTTP surface)
src/views/          admin/  frontend/                        (CMS HTML)
src/worker.ts       entry point — wires CMS core + mounts the SaaS surface
```

### 2. SaaS layer (`saas_mode`) — modular

Everything added for the SaaS product. Each module owns its **service + routes
+ tests** and exposes a **public `index.ts` barrel**. Per-module *schema* is
documented in the module but applied by the shared migration runner (a single
linear master-migration history can't be split across modules without a merge
mechanism — the runner is deliberately shared infra).

```
src/shared/         masterMigrate · rateLimit · ui        (cross-module utilities; a leaf — depends on nothing in src/modules)
src/modules/
  vault/            AES-GCM per-tenant crypto + GitHub sealed boxes
  customers/        accounts, sessions, tokens, email, auth/dashboard pages
  auth/             SaaS customer session gate (requireCustomer, saasActive)
  connections/      BYO-infra credential storage + providers (github/cloudflare/anthropic) + wizard
  provisioning/     the idempotent, resumable site-provisioning pipeline
  sites/            prompt-to-build, genesis, rollback, site-management pages
  ecommerce/        Stripe Checkout + order webhook (store sites)
  quality-gate/     the publish quality gate — pure scoring engine (K2 moat)
  publishing/       gated publishing pipeline (gate → publish → rebuild) + drafts UI
  pseo/             programmatic-SEO factory: CSV + template → gated batch (K2)
  linking/          internal-linking engine: related-post scorer + orphan detection (K5)
  webhooks/         CMS rebuild bridge + contact-form relay
  app/              the SaaS HTTP surface: /app dashboard router + /api/saas router
```

## Rules (enforced)

1. **No circular dependencies** anywhere in `src/` (`madge --circular`).
2. **Cross-module imports go through the public index barrel only.**
   From a file in module A: `import { x } from "../b"` ✅ — never
   `import { x } from "../b/internal"` ❌ (`check-module-boundaries.mjs`).
   Same-module (`./x`), CMS-core (`../../lib/x`), and `../../shared/x` imports
   are unrestricted.
3. **Dependency direction** (the graph is a DAG, verified):
   `shared → vault → customers → auth → connections → provisioning → sites → webhooks → app`.
   `shared` never imports a module; `app` is the top (only the worker imports it).
   CMS core never imports a SaaS module (the shared `Customer` row type lives in
   `src/lib/types.ts` so the Hono context can reference it without inverting).
4. **Migrate incrementally, tests green each step, existing API byte-identical.**

## Reserved module slots (created when their phase lands)

`analytics` (Phase 6), `billing` (Phase 9). Add the directory + `index.ts` when
the code arrives; the lint picks it up automatically.
