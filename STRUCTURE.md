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
  analytics/        real-user Core Web Vitals + alerts + third-party script-cost + V1.5 first-party beacon ingest/rollups/Insights
  webhooks/         CMS rebuild bridge + contact-form relay
  app/              the SaaS HTTP surface: /app dashboard router + /api/saas router
  # ── added since the initial modularization (all follow the same barrel rules) ──
  design/           design tokens/presets + art-direction options (contrast-gated)
  seo/              the SEO suite: cockpit, profiles, settings, image/local/merchant SEO, script controls, optimization report (largest module)
  network/          network brain: GSC + AEO/GEO + content-decay radar (distinct from the CMS-core src/routes/network admin surface)
  forms/            Forms & Automation Engine: builder, submissions inbox, newsletter, automation hooks
  mail/             per-site Mailbox: inbound email receive + provider send (V1.5 M1)
  integrations/     scoped API keys + event webhooks + recipes + OpenAPI (V1.5 M2)
  importer/         WordPress (WXR) import → posts/pages/categories/media/redirects
  marketing/        public marketing pages (home/privacy/terms/examples)
  pinterest/        scheduled pin publishing (traffic engine)
  affiliate/        affiliate links + dead-link cron
  agency/           agency/multi-client mode: seats, monthly reports, client portal
  cloning/          site cloning
  billing/          platform billing + Stripe webhook (was a reserved slot; now live)
```

(27 modules total. `seo` is the largest; `mail`/`integrations`/`analytics`
carry the V1.5 business-platform work. All obey the same DAG + barrel rules —
`npm run lint:structure` is the source of truth for the actual graph.)

## Rules (enforced)

1. **No circular dependencies** anywhere in `src/` (`madge --circular`).
2. **Cross-module imports go through the public index barrel only.**
   From a file in module A: `import { x } from "../b"` ✅ — never
   `import { x } from "../b/internal"` ❌ (`check-module-boundaries.mjs`).
   Same-module (`./x`), CMS-core (`../../lib/x`), and `../../shared/x` imports
   are unrestricted.
3. **Dependency direction** (the graph is a DAG, verified by `madge` in CI):
   the backbone runs `shared → vault → customers → auth → connections →
   provisioning → sites → … → app` (feature modules like `seo`, `forms`,
   `mail`, `integrations`, `analytics` hang off it). The exact edges evolve as
   modules are added — the lint enforces acyclicity, not a fixed chain.
   `shared` never imports a module; `app` is the top (only the worker imports it).
   CMS core never imports a SaaS module (the shared `Customer` row type lives in
   `src/lib/types.ts` so the Hono context can reference it without inverting).
4. **Migrate incrementally, tests green each step, existing API byte-identical.**

## Adding a module

Create `src/modules/<name>/` with a service + routes + tests + a public
`index.ts` barrel, import siblings via their barrel only, and keep the graph a
DAG. `npm run lint:structure` (madge + `check-module-boundaries.mjs`) picks it
up automatically and is the enforced source of truth — this doc is a map, the
lint is the law.
