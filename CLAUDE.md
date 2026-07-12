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
- **Per-site DB**: `users`, `api_keys`, `api_logs`, `categories`, `posts`, `post_images`, `menu_items`, `media`, `settings` (key/value), `idempotency_cache`, `rate_limit_counters`, `webhook_endpoints`, `webhook_deliveries`, `redirects`. Schema: `src/schemas/site.sql` (docs) — but the **provisioning source of truth is the inlined `SITE_SCHEMA_STATEMENTS` array in `src/lib/provision.ts`**. Keep both in sync when adding tables.
- **Migrations**: `src/migrations/*.sql` are documentation; the runtime applies forward-only migrations via `src/lib/migrate.ts` on the 5-minute cron (per site, tracked in-DB). New columns on existing sites go through migrate.ts, not site.sql.

## Auth (three separate systems)

1. **Admin UI**: email+password → PBKDF2 (see `src/lib/auth.ts`) → JWT in HttpOnly `cms_session` cookie (SameSite=Lax is the CSRF defense). Middleware: `src/middleware/authMiddleware.ts`; `/admin/login` is exempted via an exact-path Set.
2. **Public API**: `Authorization: Bearer cms_live_<hex>` — hashed at rest in per-site `api_keys`, `key_preview` (last 4) for lookup, JSON `permissions` array. Validation: `src/lib/apiAuth.ts`.
3. **Network admin**: single shared `NETWORK_ADMIN_KEY` secret via `x-network-admin-key` header. Only works on `NETWORK_ADMIN_HOSTNAME`.

`JWT_SECRET` must be set — code throws/redirects rather than falling back to a default.

## Public REST API (per site: `/api/public/v1/*`)

`GET /v1/status` · `GET /v1/capabilities` · `POST /v1/upload` (multipart, ≤20 files, ≤10MB, magic-byte validated) · `POST|PUT|DELETE /v1/posts[/:id]` · `POST /v1/posts/batch` · `GET /v1/posts[/:id]` · `GET|POST /v1/categories` · webhook CRUD.

Contract features external automation depends on (a companion system publishes to this API — **do not change response shapes**):
- Typed error codes: `slug_conflict`, `rate_limited`, `auth_*`, `validation_*` (`src/lib/errors.ts`).
- `Idempotency-Key` header → replay-safe POSTs (`src/lib/idempotency.ts`, only 2xx cached, 24h TTL).
- Fixed-window rate limit + `X-RateLimit-*` headers (`src/lib/rateLimit.ts`, `RATE_LIMIT_RPM` var).
- Webhooks with `X-CMS-Signature` HMAC, retry with backoff, dead-letter (`src/lib/webhooks.ts`).
- Feature flags via env vars: `FEATURE_IDEMPOTENCY`, `FEATURE_WEBHOOKS`, `FEATURE_RATE_LIMIT`, `FEATURE_BATCH_POSTS`, `GC_ENABLED` (empty string = on/off semantics — check `src/lib/types.ts` usage before assuming).

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
6. **Frontend trailing-slash canonicalization**: public content URLs 301 to trailing-slash form; admin/API paths must never enter that logic.
7. **Idempotency**: only successful (2xx) responses are cached for replay; error responses must never be.

## Contract stability

The public API (`/api/public/v1/*`), webhook payloads/signatures, and error-code vocabulary are **frozen contracts** consumed by external automation (Content-Network-OS, `automation/post_all_sites.py`). Any new work must be **additive** — new routes, new tables, new env-var flags — never modifications to existing response shapes, redirects, or status codes.
