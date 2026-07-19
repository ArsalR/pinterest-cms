// src/modules/forms/newsletterRoutes.ts
// PUBLIC newsletter endpoints (V1.4 F3): double-opt-in confirmation +
// unsubscribe. Both are plain GET links from emails; both render tiny branded
// pages and are safe to hit repeatedly (idempotent).

import { Hono } from "hono"
import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { saasActive } from "../auth"
import { getMasterDb, getSiteDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared/masterMigrate"
import { escapeHtml } from "../../lib/utils"
import { confirmSubscriber, unsubscribe } from "./hooks"

export const newsletterRoutes = new Hono<AppEnv>()

function page(title: string, body: string, backUrl?: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;background:#fafafa;color:#111;min-height:100vh;display:grid;place-items:center;margin:0;padding:24px}.card{max-width:420px;text-align:center}p{color:#525252}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${body}</p>${backUrl ? `<p><a href="${backUrl}">← Back to the site</a></p>` : ""}</div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  )
}

async function siteDbForSite(c: Context<AppEnv>, siteId: string) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  const siteRow = await db.execute({
    sql: "SELECT cms_site_id, domain, canonical_host FROM customer_sites WHERE id = ? LIMIT 1",
    args: [siteId],
  })
  if (!siteRow.rows.length) return null
  const site = siteRow.rows[0] as unknown as { cms_site_id: string | null; domain: string; canonical_host: string }
  if (!site.cms_site_id) return null
  const reg = await db.execute({ sql: "SELECT turso_url, turso_token FROM sites WHERE id = ? LIMIT 1", args: [site.cms_site_id] })
  if (!reg.rows.length) return null
  return {
    siteDb: getSiteDb(String(reg.rows[0].turso_url), String(reg.rows[0].turso_token)),
    host: site.canonical_host === "www" ? `www.${site.domain}` : site.domain,
  }
}

newsletterRoutes.get("/:siteId/confirm", async (c, next) => {
  if (!saasActive(c)) return next()
  const ctx = await siteDbForSite(c, c.req.param("siteId") ?? "")
  if (!ctx) return page("Unknown site", "This confirmation link isn't valid.")
  const ok = await confirmSubscriber(ctx.siteDb, c.req.query("t") ?? "")
  return ok
    ? page("You're subscribed ✓", "Thanks — your subscription is confirmed.", `https://${ctx.host}/`)
    : page("Link expired", "This confirmation link was already used or has expired. Subscribe again from the site.", `https://${ctx.host}/`)
})

newsletterRoutes.get("/:siteId/unsubscribe", async (c, next) => {
  if (!saasActive(c)) return next()
  const ctx = await siteDbForSite(c, c.req.param("siteId") ?? "")
  if (!ctx) return page("Unknown site", "This link isn't valid.")
  const ok = await unsubscribe(ctx.siteDb, c.req.query("id") ?? "")
  return ok
    ? page("Unsubscribed", "You won't receive further emails from this site.", `https://${ctx.host}/`)
    : page("Already done", "This address is already unsubscribed (or the link is invalid).", `https://${ctx.host}/`)
})
