// src/lib/webhooks.ts
// Webhook delivery, retry, and signing utilities.
//
// Events: post.created | post.updated | post.deleted | post.published
// Delivery is fire-and-forget (ctx.waitUntil in request path, direct await in cron).
// Retry schedule: attempt 1 immediate → attempt 2 at +5 min → attempt 3 at +30 min → dead.
// Disabled by default — enable with FEATURE_WEBHOOKS=1.

import type { Client } from "@libsql/client/web"
import { cuid } from "./utils"

export const WEBHOOK_EVENTS = [
  "post.created",
  "post.updated",
  "post.deleted",
  "post.published",
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

// Minutes to wait before each retry attempt.
const RETRY_DELAYS_MIN = [5, 30] // attempt 2 → +5 min, attempt 3 → +30 min

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** Generate a secure webhook signing secret (shown once). */
export function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return `whs_${hex}`
}

interface WebhookEndpoint {
  id: string
  url: string
  secret: string
  events: string
  active: number
}

/** Attempt delivery to a single endpoint. Updates the delivery row in place. */
async function attemptDelivery(
  db: Client,
  deliveryId: string,
  endpoint: WebhookEndpoint,
  event: string,
  payloadJson: string,
  attempt: number
): Promise<void> {
  const signature = await hmacHex(endpoint.secret, payloadJson)
  let responseStatus: number | null = null
  let responseBody: string | null = null
  let succeeded = false

  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Event": event,
        "X-Webhook-Signature": `sha256=${signature}`,
        "X-Webhook-Delivery": deliveryId,
        "User-Agent": "pinterest-cms-webhook/1.0",
      },
      body: payloadJson,
      signal: AbortSignal.timeout(10_000),
    })
    responseStatus = res.status
    responseBody = (await res.text().catch(() => "")).slice(0, 1024)
    succeeded = res.ok
  } catch (err) {
    responseBody = err instanceof Error ? err.message : String(err)
  }

  const maxAttempts = RETRY_DELAYS_MIN.length + 1 // 3

  if (succeeded) {
    await db.execute({
      sql: `UPDATE webhook_deliveries
            SET status = 'delivered', response_status = ?, response_body = ?,
                attempt = ?, delivered_at = datetime('now'), next_retry_at = NULL
            WHERE id = ?`,
      args: [responseStatus, responseBody, attempt, deliveryId],
    })
  } else if (attempt >= maxAttempts) {
    await db.execute({
      sql: `UPDATE webhook_deliveries
            SET status = 'dead', response_status = ?, response_body = ?, attempt = ?
            WHERE id = ?`,
      args: [responseStatus, responseBody, attempt, deliveryId],
    })
  } else {
    const delayMin = RETRY_DELAYS_MIN[attempt - 1] ?? 5
    await db.execute({
      sql: `UPDATE webhook_deliveries
            SET status = 'failed', response_status = ?, response_body = ?,
                attempt = ?, next_retry_at = datetime('now', ? || ' minutes')
            WHERE id = ?`,
      args: [responseStatus, responseBody, attempt, String(delayMin), deliveryId],
    })
  }
}

/**
 * Fire webhooks for an event across all active, matching endpoints.
 * Inserts delivery rows first, then attempts delivery for each.
 * Call from ctx.waitUntil() in the request path; await directly in cron.
 */
export async function fireWebhooks(
  db: Client,
  featureFlag: string | undefined,
  hostname: string,
  event: WebhookEvent,
  data: Record<string, unknown>
): Promise<void> {
  if (!featureFlag || featureFlag === "0" || featureFlag === "false") return

  const endpoints = await db
    .execute({
      sql: `SELECT id, url, secret, events, active FROM webhook_endpoints WHERE active = 1`,
      args: [],
    })
    .catch(() => null)

  if (!endpoints?.rows.length) return

  const payloadJson = JSON.stringify({
    event,
    site: hostname,
    timestamp: new Date().toISOString(),
    data,
  })

  for (const row of endpoints.rows) {
    const ep = row as unknown as WebhookEndpoint
    let subscribedEvents: string[]
    try {
      subscribedEvents = JSON.parse(ep.events) as string[]
    } catch {
      subscribedEvents = []
    }
    if (!subscribedEvents.includes(event)) continue

    const deliveryId = cuid()
    try {
      await db.execute({
        sql: `INSERT INTO webhook_deliveries (id, endpoint_id, event, payload, attempt, status)
              VALUES (?, ?, ?, ?, 1, 'pending')`,
        args: [deliveryId, ep.id, event, payloadJson],
      })
      await attemptDelivery(db, deliveryId, ep, event, payloadJson, 1)
    } catch (err) {
      console.error(`webhooks: delivery ${deliveryId} error:`, err)
    }
  }
}

/**
 * Retry failed deliveries whose next_retry_at has elapsed.
 * Call from the per-site cron loop.
 */
export async function retryWebhooks(
  db: Client,
  featureFlag: string | undefined
): Promise<void> {
  if (!featureFlag || featureFlag === "0" || featureFlag === "false") return

  const due = await db
    .execute({
      sql: `SELECT d.id, d.attempt, d.payload, d.event,
                   e.id AS ep_id, e.url, e.secret, e.events, e.active
            FROM webhook_deliveries d
            JOIN webhook_endpoints e ON e.id = d.endpoint_id
            WHERE (
              (d.status = 'failed' AND d.next_retry_at IS NOT NULL AND d.next_retry_at <= datetime('now'))
              OR
              (d.status = 'pending' AND d.created_at <= datetime('now', '-10 minutes'))
            )
            LIMIT 50`,
      args: [],
    })
    .catch(() => null)

  if (!due?.rows.length) return

  for (const row of due.rows) {
    const deliveryId = row.id as string
    const attempt = (row.attempt as number) + 1
    const ep: WebhookEndpoint = {
      id: row.ep_id as string,
      url: row.url as string,
      secret: row.secret as string,
      events: row.events as string,
      active: row.active as number,
    }
    try {
      await attemptDelivery(db, deliveryId, ep, row.event as string, row.payload as string, attempt)
    } catch (err) {
      console.error(`webhooks: retry ${deliveryId} error:`, err)
    }
  }
}
