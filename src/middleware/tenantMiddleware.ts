// src/middleware/tenantMiddleware.ts
// Resolves hostname → site config → injects siteDb + site into Hono context.

import type { MiddlewareHandler } from "hono"
import { resolveSite, getSiteDb } from "../lib/turso"
import { loadSettings } from "../lib/defaults"
import type { AppEnv } from "../lib/types"

export const tenantMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Extract hostname (strip port).
  const rawHost = c.req.header("host") ?? c.req.header("x-forwarded-host") ?? ""
  const hostname = rawHost.replace(/:\d+$/, "").toLowerCase()

  // Network admin panel — bypass tenant lookup.
  if (hostname && hostname === c.env.NETWORK_ADMIN_HOSTNAME?.toLowerCase()) {
    c.set("hostname", hostname)
    return next()
  }

  if (!hostname) {
    return c.html(siteNotFoundHtml("No host header"), 400)
  }

  const site = await resolveSite(c.env, hostname)
  if (!site) {
    return c.html(siteNotFoundHtml(hostname), 404)
  }

  const siteDb = getSiteDb(site.turso_url, site.turso_token)
  const settings = await loadSettings(siteDb)
  c.set("site", site)
  c.set("siteDb", siteDb)
  c.set("hostname", hostname)
  c.set("settings", settings)

  return next()
}

function siteNotFoundHtml(hostname: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Site not found</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0a0a0a; color: #fafafa;
         min-height: 100vh; display: grid; place-items: center; margin: 0; padding: 24px; }
  .card { max-width: 480px; text-align: center; }
  h1 { font-size: 64px; margin: 0 0 8px; letter-spacing: -2px; }
  p { color: #a3a3a3; margin: 4px 0; }
  code { background: #171717; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
</style></head>
<body><div class="card">
  <h1>404</h1>
  <p>No site is registered for <code>${hostname.replace(/[<>&]/g, "")}</code>.</p>
  <p>If you're the operator, register this hostname in the network admin.</p>
</div></body></html>`
}
