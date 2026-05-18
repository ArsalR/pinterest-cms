// src/worker.ts
// Hono entry point. Single Worker serving all sites.
//
// Request flow:
//   1. tenantMiddleware  — hostname → site config → siteDb (or NETWORK_ADMIN_HOSTNAME bypass)
//   2. Route to handler  — /api/network → /api/public → /admin → frontend (catch-all)
//   3. Auth middleware   — admin (JWT cookie) | network (header key) | public (Bearer API key)

import { Hono } from "hono"
import type { AppEnv, CloudflareEnv } from "./lib/types"

import { tenantMiddleware } from "./middleware/tenantMiddleware"
import { adminAuthMiddleware } from "./middleware/authMiddleware"
import { getMasterDb, getSiteDb } from "./lib/turso"

import { networkRoutes } from "./routes/network/sites"

import { publicApiRoutes } from "./routes/public"

import { loginGetHandler, loginPostHandler, logoutHandler } from "./routes/admin/login"
import { dashboardHandler } from "./routes/admin/dashboard"
import { postsAdminRoute } from "./routes/admin/posts"
import { pagesAdminRoute } from "./routes/admin/pages"
import { categoriesAdminRoute } from "./routes/admin/categories"
import { mediaAdminRoute } from "./routes/admin/media"
import { menusAdminRoute } from "./routes/admin/menus"
import { appearanceAdminRoute } from "./routes/admin/appearance"
import { seoAdminRoute } from "./routes/admin/seo"
import { permalinksAdminRoute } from "./routes/admin/permalinks"
import { apiKeysAdminRoute } from "./routes/admin/apiKeys"
import { settingsAdminRoute } from "./routes/admin/settings"
import { redirectsAdminRoute } from "./routes/admin/redirects"

import { frontendRoutes } from "./routes/frontend"

const app = new Hono<AppEnv>()

// ───────────────────────── Health check ─────────────────────────
// Hosted at /__health on every hostname; useful for monitoring + probes.
app.get("/__health", (c) => c.json({ ok: true, ts: new Date().toISOString() }))

// ───────────────────────── Tenant middleware ─────────────────────
// Resolves hostname to a site (or activates network-admin mode).
app.use("*", tenantMiddleware)

// ───────────────────────── Network admin ─────────────────────────
// /api/network/* — only reachable on NETWORK_ADMIN_HOSTNAME because the
// tenant middleware would otherwise have 404'd by now. Each route inside
// checks NETWORK_ADMIN_KEY header / query.
app.route("/api/network", networkRoutes)

// ───────────────────────── Public REST API ───────────────────────
// /api/public/v1/* — Bearer-authenticated, CORS-enabled (CORS is applied
// inside publicApiRoutes itself).
app.route("/api/public", publicApiRoutes)

// ───────────────────────── Admin ─────────────────────────────────
// Admin app — auth middleware applies to everything except /admin/login,
// which is handled internally by the middleware (it short-circuits on path).
const adminApp = new Hono<AppEnv>()
// CSRF is handled by the JWT cookie's SameSite=Lax attribute, which prevents
// browsers from attaching the cookie to cross-origin POST requests.
adminApp.use("*", adminAuthMiddleware)
// Login routes mounted directly (not via sub-app) to avoid Hono's root-path
// edge case — same pattern as dashboardHandler below.
adminApp.get("/login", loginGetHandler)
adminApp.post("/login", loginPostHandler)
adminApp.post("/login/logout", logoutHandler)
adminApp.get("/", dashboardHandler)               // direct mount avoids Hono sub-app root-path edge case
adminApp.route("/posts", postsAdminRoute)
adminApp.route("/pages", pagesAdminRoute)
adminApp.route("/categories", categoriesAdminRoute)
adminApp.route("/media", mediaAdminRoute)
adminApp.route("/menus", menusAdminRoute)
adminApp.route("/appearance", appearanceAdminRoute)
adminApp.route("/seo", seoAdminRoute)
adminApp.route("/permalinks", permalinksAdminRoute)
adminApp.route("/redirects", redirectsAdminRoute)
adminApp.route("/api-keys", apiKeysAdminRoute)
adminApp.route("/settings", settingsAdminRoute)
app.route("/admin", adminApp)

// ───────────────────────── Frontend (catch-all) ──────────────────
// Mounts /, /sitemap.xml, /robots.txt, /feed.xml, plus the slug router.
app.route("/", frontendRoutes)

// Fallback — should be unreachable; the frontend catch-all returns its own 404.
app.notFound((c) =>
  c.html(
    `<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head>
    <body style="font-family:sans-serif;text-align:center;padding:60px"><h1>404</h1><p>Page not found.</p></body></html>`,
    404
  )
)

// Last-resort error handler so a thrown error never crashes the request.
app.onError((err, c) => {
  console.error("Unhandled error:", err)
  return c.json({ error: "Internal server error", message: err.message }, 500)
})

// ───────────────────────── Cron: post scheduler ──────────────────
// Runs every 5 minutes (see wrangler.toml [triggers]).
// Walks every active site and publishes any posts whose scheduled_at has passed.
async function runScheduler(env: CloudflareEnv): Promise<void> {
  const master = getMasterDb(env)
  let sites: Array<{ turso_url: string; turso_token: string; hostname: string }>
  try {
    const r = await master.execute(
      "SELECT hostname, turso_url, turso_token FROM sites WHERE active = 1"
    )
    sites = r.rows as unknown as typeof sites
  } catch (err) {
    console.error("scheduler: failed to fetch sites from master DB:", err)
    return
  }

  for (const site of sites) {
    const db = getSiteDb(site.turso_url, site.turso_token)
    try {
      // Ensure column exists on sites provisioned before the scheduler was added.
      await db.execute("ALTER TABLE posts ADD COLUMN scheduled_at TEXT").catch(() => {})
      await db.execute({
        sql: `UPDATE posts
              SET published = 1,
                  published_at = scheduled_at,
                  updated_at   = datetime('now')
              WHERE published = 0
                AND scheduled_at IS NOT NULL
                AND scheduled_at <= datetime('now')`,
        args: [],
      })
    } catch (err) {
      console.error(`scheduler: error processing site ${site.hostname}:`, err)
    }
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: CloudflareEnv): Promise<void> {
    await runScheduler(env)
  },
}
