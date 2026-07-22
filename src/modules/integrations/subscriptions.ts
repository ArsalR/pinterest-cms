// src/modules/integrations/subscriptions.ts
// Site-wide event webhooks (V1.5 M2) — the n8n / GoHighLevel bridge. Subscribe
// a URL to business events (form.submitted, mail.received, order.created,
// post.published, site.deployed, analytics.daily); deliveries are HMAC-signed,
// retried, and logged — all on the EXISTING webhook_endpoints/webhook_deliveries
// machinery. Emission points call fireWebhooks() at each event source.

import type { Client } from "@libsql/client/web"
import { generateWebhookSecret, WEBHOOK_EVENTS, type WebhookEvent } from "../../lib/webhooks"
import { cuid } from "../../lib/utils"

export const SITE_EVENTS: WebhookEvent[] = [
  "form.submitted", "mail.received", "order.created", "post.published", "site.deployed", "analytics.daily",
]
export const EVENT_LABELS: Record<string, string> = {
  "form.submitted": "Form submitted", "mail.received": "Mail received", "order.created": "Order created",
  "post.published": "Post published", "post.created": "Post created", "post.updated": "Post updated",
  "post.deleted": "Post deleted", "site.deployed": "Site deployed", "analytics.daily": "Daily analytics digest",
}
export function isWebhookEvent(v: string): v is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(v)
}

export interface Subscription { id: string; url: string; secretPreview: string; events: string[]; createdAt: string }

function rowTo(row: Record<string, unknown>): Subscription {
  let events: string[] = []
  try { const p = JSON.parse(String(row.events ?? "[]")); events = Array.isArray(p) ? p.map(String) : [] } catch { /* ignore */ }
  return { id: String(row.id), url: String(row.url ?? ""), secretPreview: String(row.secret_preview ?? ""), events, createdAt: String(row.created_at ?? "") }
}

/** Subscriptions = webhook_endpoints NOT owned by a form (form:… synthetic ids
 *  belong to the per-form webhooks). We tag ours with id prefix "sub:". */
export async function listSubscriptions(siteDb: Client): Promise<Subscription[]> {
  const r = await siteDb.execute({ sql: "SELECT * FROM webhook_endpoints WHERE active = 1 AND id LIKE 'sub:%' ORDER BY created_at DESC LIMIT 100", args: [] }).catch(() => null)
  return (r?.rows ?? []).map((row) => rowTo(row as Record<string, unknown>))
}

export async function createSubscription(siteDb: Client, url: string, events: string[]): Promise<{ id: string; secret: string } | null> {
  const clean = events.filter(isWebhookEvent)
  if (!/^https:\/\/\S+$/.test(url) || !clean.length) return null
  const secret = generateWebhookSecret()
  const id = `sub:${cuid()}`
  try {
    await siteDb.execute({
      sql: "INSERT INTO webhook_endpoints (id, url, secret, secret_preview, events, active) VALUES (?, ?, ?, ?, ?, 1)",
      args: [id, url, secret, secret.slice(-4), JSON.stringify(clean)],
    })
    return { id, secret }
  } catch {
    return null
  }
}

export async function deleteSubscription(siteDb: Client, id: string): Promise<void> {
  if (!id.startsWith("sub:")) return
  await siteDb.execute({ sql: "UPDATE webhook_endpoints SET active = 0 WHERE id = ?", args: [id] }).catch(() => {})
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Fire a sample event to one subscription and log it (test-fire button). */
export async function testFireSubscription(siteDb: Client, id: string, hostname: string): Promise<{ ok: boolean; status: number | null }> {
  const r = await siteDb.execute({ sql: "SELECT url, secret FROM webhook_endpoints WHERE id = ? AND active = 1 LIMIT 1", args: [id] }).catch(() => null)
  if (!r?.rows.length) return { ok: false, status: null }
  const url = String(r.rows[0].url), secret = String(r.rows[0].secret)
  const payload = JSON.stringify({ event: "test.ping", site: hostname, timestamp: new Date().toISOString(), data: { message: "This is a test event from your site." } })
  let status: number | null = null, ok = false
  try {
    const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Webhook-Event": "test.ping", "X-Webhook-Signature": `sha256=${await hmacHex(secret, payload)}` }, body: payload })
    status = resp.status; ok = resp.ok
  } catch { ok = false }
  await siteDb.execute({
    sql: `INSERT INTO webhook_deliveries (id, endpoint_id, event, payload, attempt, status, response_status, delivered_at)
          VALUES (?, ?, 'test.ping', ?, 1, ?, ?, ?)`,
    args: [cuid(), id, payload, ok ? "delivered" : "failed", status, ok ? new Date().toISOString().replace("T", " ").slice(0, 19) : null],
  }).catch(() => {})
  return { ok, status }
}

export async function subscriptionLog(siteDb: Client, id: string, limit = 15): Promise<Array<{ at: string; event: string; status: string; httpStatus: number | null }>> {
  const r = await siteDb.execute({ sql: "SELECT created_at, event, status, response_status FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY created_at DESC LIMIT ?", args: [id, limit] }).catch(() => null)
  return (r?.rows ?? []).map((row) => ({ at: String(row.created_at ?? ""), event: String(row.event ?? ""), status: String(row.status ?? ""), httpStatus: row.response_status == null ? null : Number(row.response_status) }))
}
