// src/routes/api/saas/hooks.ts
// Rebuild bridge: the CMS backing site fires its normal webhooks
// (post.published / post.updated / post.deleted) at this endpoint, which
// verifies the HMAC signature and converts the event into a GitHub
// repository_dispatch so the customer's static site rebuilds.
//
// Machine-to-machine: authenticated by X-Webhook-Signature (sha256 HMAC of
// the raw body with the per-endpoint secret stored in the site's own DB —
// same scheme src/lib/webhooks.ts signs with), NOT by customer session.
// Same fall-through gating as the rest of the SaaS layer.

import { Hono } from "hono"
import type { AppEnv } from "../../../lib/types"
import { saasActive } from "../../../middleware/saasAuthMiddleware"
import { getMasterDb, getSiteDb } from "../../../lib/turso"
import { ensureMasterSchema } from "../../../lib/masterMigrate"
import { getConnection } from "../../../lib/saas/connections"
import { installationToken, repositoryDispatch } from "../../../lib/saas/github"

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))
  let hex = ""
  for (let i = 0; i < sig.length; i++) hex += sig[i].toString(16).padStart(2, "0")
  return hex
}

export const saasHooksRoutes = new Hono<AppEnv>()

saasHooksRoutes.post("/cms/:siteId", async (c, next) => {
  if (!saasActive(c)) return next()

  const siteId = c.req.param("siteId") ?? ""
  const rawBody = await c.req.text()
  const signature = c.req.header("x-webhook-signature") ?? ""

  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)

  const siteRow = await db.execute({
    sql: "SELECT * FROM customer_sites WHERE id = ? LIMIT 1",
    args: [siteId],
  })
  if (!siteRow.rows.length) return c.json({ error: "Unknown site", code: "not_found" }, 404)
  const site = siteRow.rows[0] as unknown as {
    customer_id: string; cms_site_id: string | null; repo_full_name: string | null; domain: string
  }

  // Load the endpoint secret from the CMS site's own DB and verify the HMAC.
  if (!site.cms_site_id) return c.json({ error: "Site has no content workspace", code: "not_found" }, 404)
  const master = await db.execute({
    sql: "SELECT turso_url, turso_token FROM sites WHERE id = ? LIMIT 1",
    args: [site.cms_site_id],
  })
  if (!master.rows.length) return c.json({ error: "Unknown workspace", code: "not_found" }, 404)
  const siteDb = getSiteDb(master.rows[0].turso_url as string, master.rows[0].turso_token as string)
  const hookUrl = `https://${c.env.SAAS_APP_HOSTNAME}/api/saas/hooks/cms/${siteId}`
  const endpoint = await siteDb.execute({
    sql: "SELECT secret FROM webhook_endpoints WHERE url = ? AND active = 1 LIMIT 1",
    args: [hookUrl],
  })
  if (!endpoint.rows.length) return c.json({ error: "No webhook registered", code: "not_found" }, 404)

  const expected = `sha256=${await hmacHex(endpoint.rows[0].secret as string, rawBody)}`
  // Constant-time-ish compare (equal-length hex strings).
  let mismatch = expected.length ^ signature.length
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ (signature.charCodeAt(i) || 0)
  if (mismatch !== 0) {
    return c.json({ error: "Bad signature", code: "auth_missing" }, 401)
  }

  // Fire the rebuild (best-effort; CMS webhook retries cover transient failures).
  if (!site.repo_full_name) return c.json({ error: "Site has no repository yet", code: "not_found" }, 404)
  const github = await getConnection(db, site.customer_id, "github")
  const installationId = Number((JSON.parse(github?.meta || "{}") as { installationId?: number }).installationId ?? 0)
  if (!installationId) return c.json({ error: "GitHub is not connected", code: "not_found" }, 404)

  let event = "content-updated"
  try {
    const parsed = JSON.parse(rawBody) as { event?: string }
    if (parsed.event) event = `content-${parsed.event.replace("post.", "")}`
  } catch {
    // keep default
  }

  try {
    const token = await installationToken(c.env, installationId)
    await repositoryDispatch(token, site.repo_full_name, "content-updated", { reason: event })
  } catch (err) {
    console.error("rebuild dispatch failed:", err instanceof Error ? err.message : err)
    return c.json({ error: "Rebuild dispatch failed — the CMS will retry", code: "internal_error" }, 502)
  }
  return c.json({ ok: true })
})
