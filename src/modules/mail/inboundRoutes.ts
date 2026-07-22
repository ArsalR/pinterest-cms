// src/modules/mail/inboundRoutes.ts
// Signed inbound callback (V1.5 M1). The customer's Email Worker (running in
// their own Cloudflare account) parses received mail and POSTs it here, signed
// with the per-site inbound secret using the SAME HMAC scheme as the content
// webhooks. Machine-to-machine — no customer session. saasActive fall-through
// keeps tenant hostnames byte-identical.

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import { saasActive } from "../auth"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared/masterMigrate"
import { storeInbound } from "./service"
import type { InboundMail } from "./model"

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))
  let hex = ""
  for (let i = 0; i < sig.length; i++) hex += sig[i].toString(16).padStart(2, "0")
  return hex
}

export const saasMailInboundRoutes = new Hono<AppEnv>()

saasMailInboundRoutes.post("/inbound/:siteId", async (c, next) => {
  if (!saasActive(c)) return next()

  const siteId = c.req.param("siteId") ?? ""
  const rawBody = await c.req.text()
  const signature = c.req.header("x-webhook-signature") ?? ""

  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  const row = await db.execute({
    sql: "SELECT cms_site_id, domain, canonical_host, mail_inbound_secret FROM customer_sites WHERE id = ? LIMIT 1",
    args: [siteId],
  })
  if (!row.rows.length) return c.json({ error: "Unknown site", code: "not_found" }, 404)
  const site = row.rows[0] as unknown as { cms_site_id: string | null; domain: string; canonical_host: string; mail_inbound_secret: string | null }
  if (!site.cms_site_id || !site.mail_inbound_secret) return c.json({ error: "Mailbox not enabled for this site", code: "not_found" }, 404)

  // Verify HMAC over the raw body (constant-time-ish compare of equal-length hex).
  const expected = `sha256=${await hmacHex(site.mail_inbound_secret, rawBody)}`
  let mismatch = expected.length ^ signature.length
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ (signature.charCodeAt(i) || 0)
  if (mismatch !== 0) return c.json({ error: "Bad signature", code: "auth_missing" }, 401)

  let mail: InboundMail
  try {
    mail = JSON.parse(rawBody) as InboundMail
  } catch {
    return c.json({ error: "Bad payload", code: "validation_invalid_value" }, 400)
  }
  if (!mail.from || !mail.to) return c.json({ error: "Missing envelope", code: "validation_required" }, 400)

  const host = site.canonical_host === "www" ? `www.${site.domain}` : site.domain
  const id = await storeInbound(db, c.env, site.cms_site_id, host, {
    from: String(mail.from), to: String(mail.to), subject: String(mail.subject ?? ""),
    text: String(mail.text ?? ""), html: String(mail.html ?? ""),
    messageId: String(mail.messageId ?? ""), inReplyTo: String(mail.inReplyTo ?? ""),
    references: Array.isArray(mail.references) ? mail.references.map(String) : [],
    spamVerdict: String(mail.spamVerdict ?? ""),
    attachments: Array.isArray(mail.attachments) ? mail.attachments : [],
  })
  return c.json({ ok: !!id, id })
})
