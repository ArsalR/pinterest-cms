# CLAUDE.md

Guidance for AI agents working in this repository. Read this before touching anything.

## What this is

A **multi-tenant, Pinterest-style CMS** serving many sites from a **single Cloudflare Worker**:

- **Runtime**: Cloudflare Workers, [Hono](https://hono.dev) v4 (`hono@^4.6`), TypeScript, ESM (`"type": "module"`).
- **Data**: Turso (libSQL/SQLite) — one **master DB** (hostname → per-site credentials) + one **isolated DB per site**. Client: `@libsql/client`.
- **Media**: one shared **R2 bucket** (`cms-media`), keys namespaced `uploads/{hostname}/…`, served via `R2_PUBLIC_URL`.
- **No frontend framework, no build step**: all HTML (admin + public site) is server-rendered template strings in `src/views/` and route files.

## Commands

```bash
npm run dev          # wrangler dev
npm run typecheck    # tsc --noEmit        — must pass before every commit
npm test             # vitest run          — must pass before every commit
npm run deploy       # wrangler deploy     (CI does this on push to main)
npm run tail         # wrangler tail
```

CI: `.github/workflows/deploy.yml` deploys on push to `main` (Node 22, needs repo secrets `CF_API_TOKEN`, `CF_ACCOUNT_ID`). There is no staging environment — main is production.

## Request flow (src/worker.ts)

```
request → /__health (before tenancy)
        → tenantMiddleware   Host header → master DB sites row → siteDb + settings in context
                             (NETWORK_ADMIN_HOSTNAME bypasses tenant lookup entirely)
        → /api/network/*     network admin (x-network-admin-key header) — provisioning
        → /api/public/*      REST API (Bearer cms_live_… keys, per-site)
        → /admin, /admin/    dashboard — mounted DIRECTLY on the main app (see gotcha #1)
        → /admin/*           admin sub-app (JWT cookie auth)
        → /*                 frontend catch-all (slug router, sitemap, RSS, robots)
```

Cron (`wrangler.toml [triggers]`): `*/5 * * * *` → scheduler (publish scheduled posts, run migrations, GC idempotency/rate-limit, retry webhooks) walking every active site; `0 4 * * *` → daily R2 GC.

## Databases

- **Master DB** (`TURSO_MASTER_URL`/`TOKEN` secrets): single `sites` table — `id, hostname, name, turso_url, turso_token, active, created_at`. Schema: `src/schemas/master.sql`.
- **Per-site DB**: `users`, `api_keys`, `api_logs`, `categories`, `posts`, `post_images`, `menu_items`, `media`, `settings` (key/value), `idempotency_cache`, `rate_limit_counters`, `webhook_endpoints`, `webhook_deliveries`, `redirects`, `products`, `orders` (ecommerce, additive/inert for content sites), `seo_settings` (SEO Control Center + V1.5 `analytics_enabled`/`analytics_key`, `pixel_consent`, `bing_verify`), `business_locations`, `authors`, `forms`/`form_submissions`, `scoped_api_keys` (V1.5 M2), plus `_migrations` (created lazily by the runner). Per-site migrations are v1–v20 in `src/lib/migrate.ts`.
- **Schema truth is TRIPLICATED** — the Worker never reads `.sql` files at runtime:
  1. `SITE_SCHEMA_STATEMENTS` in `src/lib/provision.ts` — applied to **new** sites at provisioning.
  2. `MIGRATIONS` array in `src/lib/migrate.ts` — forward-only, idempotent DDL applied to **existing** sites by the 5-minute cron (tracked in per-site `_migrations`).
  3. `src/schemas/site.sql` + `src/migrations/*.sql` — documentation only.
  A new per-site table/column must be added to **both TS copies** (and ideally the docs). The **master DB DOES have a forward-only migration runner** now (SaaS layer): `MASTER_MIGRATIONS` in `src/shared/masterMigrate.ts` (versioned, tracked table, `INSERT OR IGNORE`, run via `ensureMasterSchema`) — currently v1–v15. Add new master columns as a new additive migration entry there; `master.sql` remains the initial hand-applied baseline.
- **Tenant-config caching**: `resolveSite` caches the full `sites` row (incl. plaintext turso_token) in the Cache API — 60s positive / 30s negative TTL, per-colo. After changing a site row call `invalidateSiteConfig(hostname)`; expect up to 60s staleness on other PoPs. `loadSettings` caches per libsql `Client` in a WeakMap — this is per-request **only because `getSiteDb` creates a new client each request**; never memoize the client factories without untangling this.

## Auth (three separate systems)

1. **Admin UI**: email+password → PBKDF2 (see `src/lib/auth.ts`) → JWT in HttpOnly `cms_session` cookie (SameSite=Lax is the CSRF defense). Middleware: `src/middleware/authMiddleware.ts`; `/admin/login` is exempted via an exact-path Set.
2. **Public API**: `Authorization: Bearer cms_live_<hex>` — hashed at rest in per-site `api_keys`, `key_preview` (last 4) for lookup, JSON `permissions` array. Validation: `src/lib/apiAuth.ts`.
3. **Network admin**: single shared `NETWORK_ADMIN_KEY` secret via `x-network-admin-key` header. Only works on `NETWORK_ADMIN_HOSTNAME`.

`JWT_SECRET` must be set — code throws/redirects rather than falling back to a default.

## Public REST API (per site: `/api/public/v1/*`)

`GET /v1/status` · `GET /v1/capabilities` · `GET /v1/openapi.json` · `POST /v1/upload` (multipart, ≤20 files, ≤10MB, magic-byte validated) · `POST|PUT|DELETE /v1/posts[/:id]` · `POST /v1/posts/batch` · `GET /v1/posts[/:id]` · `GET|POST /v1/categories` · webhook CRUD · read-only config endpoints the static build consumes (`GET /v1/seo`, `/v1/seo-settings`, `/v1/local`, `/v1/authors`, `/v1/merchant`, `/v1/forms`, `/v1/products`). ~26 endpoints total — the live set is the `endpoints` array in `capabilities.ts` (kept in sync with the notFound `available` list). Bearer `cms_live_…` keys; V1.5 also accepts scoped `sk_site_…` keys (`src/lib/apiAuth.ts`).

Middleware order on the sub-app (deliberate): CORS → rate-limit → idempotency → per-handler auth. Rate limiting runs **before** auth (a 429 skips the PBKDF2 verify) and buckets on the Bearer token's last 4 chars. OPTIONS preflights short-circuit inside CORS and never reach later middleware. Auth is per-handler `validateApiKey(...)` — there is no auth middleware.

Contract features external automation depends on (a companion system publishes to this API — **do not change response shapes**):
- Typed error codes: 16-member union in `src/lib/errors.ts`, **pinned by `errors.test.ts` — add-only**, never rename/remove. `apiError()` also sets an `X-Error-Code` header.
- `Idempotency-Key` header → replay-safe POSTs (`src/lib/idempotency.ts`, only 2xx cached, 24h TTL, `Idempotency-Replayed: true` on replay).
- Fixed-window rate limit + `X-RateLimit-*` headers (`src/lib/rateLimit.ts`, `RATE_LIMIT_RPM` var). Its 429 body is hand-built JSON — leave it.
- Webhooks with `X-Webhook-Signature: sha256=<hmac>` HMAC, retries at +5min/+30min then dead-letter (`src/lib/webhooks.ts`).
- Feature-flag pattern: declare `FLAG = ""` in `wrangler.toml [vars]`, type as optional string in `CloudflareEnv`, consumer self-gates on `"1"`. Disabled endpoints return **404 `not_found`** (see `posts/batch`), not 403. Flags are git-managed — dashboard edits are clobbered on every deploy.
- Discovery lists are hand-maintained in TWO places: the `endpoints` array in `capabilities.ts` and the notFound `available` array in `routes/public/index.ts`. New endpoints must be appended to both.
- Browser-visible new headers must be whitelisted in `corsMiddleware.ts` (both Allow-Headers and Expose-Headers).

## Code structure (SaaS layer)

The `saas_mode` layer follows a **deploy-blocking structure covenant** — see `STRUCTURE.md`. CMS core stays in `src/lib`, `src/middleware`, `src/routes/{admin,frontend,public,network}`, `src/views` (frozen contract, not moved). SaaS code lives in `src/modules/<name>/` (each owns service + routes + tests + a public `index.ts` barrel) plus `src/shared/` (cross-module utilities). `npm run lint:structure` enforces no-circular-deps (`madge`) + barrel-only cross-module imports; it runs in CI (pr-checks + deploy). When adding SaaS code, put it in the right module and import siblings via their barrel (`../vault`, not `../vault/vault`).

## Conventions

- **Routing**: one file per admin page / API resource, exporting a `Hono` sub-app (`export const xAdminRoute = new Hono<AppEnv>()`), mounted in `worker.ts`.
- **Context**: `AppEnv` (`src/lib/types.ts`) carries `site`, `siteDb`, `hostname`, `settings`, `user` via `c.get(...)`. Env vars/secrets on `CloudflareEnv`.
- **SQL**: raw parameterized statements via `siteDb.execute({ sql, args })`. No ORM. IDs are `cuid()` strings (`src/lib/utils.ts`).
- **HTML**: template strings; always escape with `escapeHtml`/`escapeAttr` from `src/lib/utils.ts`.
- **Errors**: admin routes render HTML error pages; API routes return JSON `{ error, code }`. Global `app.onError` in worker.ts branches on `/admin` prefix.
- **Async side-effects** (cache purge, webhooks): `c.executionCtx.waitUntil(...)`, best-effort, never block the response.
- **Tests**: vitest, colocated `*.test.ts` next to the lib file. Pure-function tests only (no Workers runtime mocking).

## Gotchas (load-bearing — do not "clean up")

1. **Hono sub-app root paths**: `app.route("/admin", adminApp)` + `adminApp.get("/")` does NOT reliably match both `/admin` and `/admin/`. That's why `worker.ts` mounts the dashboard **twice directly on the main app** (`app.get("/admin", …)` and `app.get("/admin/", …)`) and login handlers are plain functions, not a sub-app. Keep this pattern for any new root-level mounts.
2. **Route registration order in worker.ts matters**: health → tenant → network → public API → admin → frontend catch-all. The frontend catch-all also defensively 404s `/admin*` and `/api/*`.
3. **Schema drift**: three copies of per-site DDL exist — `src/schemas/site.sql` (docs), `SITE_SCHEMA_STATEMENTS` in `provision.ts` (runtime for new sites), `src/lib/migrate.ts` + `src/migrations/*.sql` (upgrades for existing sites). A new table/column must be added to all relevant places.
4. **Free-plan CPU limit**: PBKDF2 (100k iterations) is CPU-heavy; `wrangler.toml` must NOT contain a `[limits]` block on the free plan (deploy fails). On paid, `cpu_ms` can be raised.
5. **Host header only**: tenant resolution deliberately ignores `X-Forwarded-Host` (spoofing). Don't re-add it.
6. **Frontend trailing-slash canonicalization**: public content URLs 301 to trailing-slash form; admin/API paths must never enter that logic. Inside `routes/frontend/index.ts` the reserved routes (sitemap/robots/feed/home) are registered before the `GET *` slug catch-all — new reserved paths go before it, and dotted paths (`/manifest.json`) are 404'd by the extension regex before redirects run.
7. **Idempotency**: only successful (2xx) responses are cached for replay; error responses must never be.
8. **Cron dispatch is an exact-string match** in `worker.ts scheduled()`: `event.cron === "0 4 * * *"` → R2 GC, **else → runScheduler**. Any new cron added to `wrangler.toml` MUST get its own explicit `===` branch or it silently runs the scheduler.
9. **`NETWORK_ADMIN_HOSTNAME` bypass sets only `hostname`** — `site`, `siteDb`, `settings` are undefined there. Any handler assuming `siteDb` will throw on that hostname. A new platform hostname should mirror this bypass pattern deliberately.
10. **`/__health` is registered before tenantMiddleware** — the pattern for any route that must answer on unregistered hostnames.
11. **Admin has no role checks and no CSRF tokens** — every logged-in user is a site superadmin; CSRF defense is solely SameSite=Lax. Never add state-changing GETs under `/admin`.
12. **CI runs typecheck + structure lint + vitest** — both `.github/workflows/deploy.yml` (push to main) and `pr-checks.yml` (the "Typecheck + tests" PR gate) run `npm run typecheck` + `npm run lint:structure` + `npm test`. vitest still runs in plain Node (no Workers pool), so new tests must be pure-logic — no `caches`, R2, or Hono context. (The customer *site-template* has its own separate deploy-blocking gates; see `site-template/.github/workflows/`.)
13. **Trust code over prose**: docs are kept close to the code but can still lag a release. When a doc and the code disagree, the code wins — and fix the doc.

## Contract stability

The public API (`/api/public/v1/*`), webhook payloads/signatures, and error-code vocabulary are **frozen contracts** consumed by external automation (Content-Network-OS, `automation/post_all_sites.py`). Any new work must be **additive** — new routes, new tables, new env-var flags — never modifications to existing response shapes, redirects, or status codes.
