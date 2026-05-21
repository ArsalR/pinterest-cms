// src/routes/public/v1/webhooks.ts
// Webhook endpoint management — requires X-Network-Admin-Key header.
// Secrets are generated server-side, returned once on creation, never re-served.

import { Hono } from "hono"
import type { AppEnv } from "../../../lib/types"
import { apiError } from "../../../lib/errors"
import { generateWebhookSecret, WEBHOOK_EVENTS } from "../../../lib/webhooks"
import { cuid } from "../../../lib/utils"

export const webhookRoutes = new Hono<AppEnv>()

function checkAuth(c: { env: AppEnv["Bindings"]; req: { header: (k: string) => string | undefined } }): boolean {
  const expected = c.env.NETWORK_ADMIN_KEY
  if (!expected) return false
  return c.req.header("x-network-admin-key") === expected
}

// ── GET /v1/webhooks — list all endpoints (no secrets) ──
webhookRoutes.get("/", async (c) => {
  if (!checkAuth(c)) return apiError(c, 401, "auth_missing", "X-Network-Admin-Key required")

  const siteDb = c.get("siteDb")
  const rows = await siteDb.execute(
    "SELECT id, url, secret_preview, events, active, created_at FROM webhook_endpoints ORDER BY created_at DESC"
  )

  return c.json({
    success: true,
    endpoints: rows.rows.map((r) => ({
      id: r.id,
      url: r.url,
      secretPreview: r.secret_preview,
      events: parseEvents(r.events as string),
      active: (r.active as number) === 1,
      createdAt: r.created_at,
    })),
  })
})

// ── POST /v1/webhooks — create endpoint; secret shown once ──
webhookRoutes.post("/", async (c) => {
  if (!checkAuth(c)) return apiError(c, 401, "auth_missing", "X-Network-Admin-Key required")

  let body: { url?: string; events?: string[] }
  try {
    body = await c.req.json()
  } catch {
    return apiError(c, 400, "validation_invalid_value", "Invalid JSON body")
  }

  const url = (body.url ?? "").trim()
  if (!url) return apiError(c, 400, "validation_required_field", "url is required", { field: "url" })
  if (!url.startsWith("https://")) {
    return apiError(c, 400, "validation_invalid_value", "url must use HTTPS", { field: "url" })
  }

  const events: string[] = Array.isArray(body.events)
    ? body.events.filter((e) => (WEBHOOK_EVENTS as readonly string[]).includes(e))
    : [...WEBHOOK_EVENTS]

  if (!events.length) {
    return apiError(c, 400, "validation_invalid_value", "events must contain at least one valid event")
  }

  const secret = generateWebhookSecret()
  const secretPreview = secret.slice(-4)
  const id = cuid()
  const siteDb = c.get("siteDb")

  await siteDb.execute({
    sql: `INSERT INTO webhook_endpoints (id, url, secret, secret_preview, events)
          VALUES (?, ?, ?, ?, ?)`,
    args: [id, url, secret, secretPreview, JSON.stringify(events)],
  })

  return c.json({
    success: true,
    endpoint: {
      id,
      url,
      secret, // ONE-TIME — not returned by any other endpoint
      secretPreview,
      events,
      active: true,
      createdAt: new Date().toISOString(),
    },
  }, 201)
})

// ── PUT /v1/webhooks/:id — update url / events / active ──
webhookRoutes.put("/:id", async (c) => {
  if (!checkAuth(c)) return apiError(c, 401, "auth_missing", "X-Network-Admin-Key required")

  const id = c.req.param("id")
  const siteDb = c.get("siteDb")

  const existing = await siteDb.execute({
    sql: "SELECT id FROM webhook_endpoints WHERE id = ? LIMIT 1",
    args: [id],
  })
  if (!existing.rows.length) return apiError(c, 404, "not_found", "Webhook endpoint not found", { id })

  let body: { url?: string; events?: string[]; active?: boolean }
  try {
    body = await c.req.json()
  } catch {
    return apiError(c, 400, "validation_invalid_value", "Invalid JSON body")
  }

  const updates: string[] = []
  const args: Array<string | number> = []

  if (body.url !== undefined) {
    const url = body.url.trim()
    if (!url.startsWith("https://")) {
      return apiError(c, 400, "validation_invalid_value", "url must use HTTPS", { field: "url" })
    }
    updates.push("url = ?"); args.push(url)
  }
  if (Array.isArray(body.events)) {
    const filtered = body.events.filter((e) => (WEBHOOK_EVENTS as readonly string[]).includes(e))
    if (!filtered.length) {
      return apiError(c, 400, "validation_invalid_value", "events must contain at least one valid event")
    }
    updates.push("events = ?"); args.push(JSON.stringify(filtered))
  }
  if (body.active !== undefined) {
    updates.push("active = ?"); args.push(body.active ? 1 : 0)
  }

  if (!updates.length) return apiError(c, 400, "validation_required_field", "No fields to update")

  args.push(id)
  await siteDb.execute({ sql: `UPDATE webhook_endpoints SET ${updates.join(", ")} WHERE id = ?`, args })

  return c.json({ success: true })
})

// ── DELETE /v1/webhooks/:id — remove endpoint (cascades deliveries) ──
webhookRoutes.delete("/:id", async (c) => {
  if (!checkAuth(c)) return apiError(c, 401, "auth_missing", "X-Network-Admin-Key required")

  const id = c.req.param("id")
  const siteDb = c.get("siteDb")

  const existing = await siteDb.execute({
    sql: "SELECT id FROM webhook_endpoints WHERE id = ? LIMIT 1",
    args: [id],
  })
  if (!existing.rows.length) return apiError(c, 404, "not_found", "Webhook endpoint not found", { id })

  await siteDb.execute({ sql: "DELETE FROM webhook_endpoints WHERE id = ?", args: [id] })

  return c.json({ success: true, deleted: id })
})

// ── GET /v1/webhooks/:id/deliveries — delivery log ──
webhookRoutes.get("/:id/deliveries", async (c) => {
  if (!checkAuth(c)) return apiError(c, 401, "auth_missing", "X-Network-Admin-Key required")

  const id = c.req.param("id")
  const siteDb = c.get("siteDb")
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "50", 10) || 50))

  const rows = await siteDb.execute({
    sql: `SELECT id, event, attempt, status, response_status, next_retry_at, delivered_at, created_at
          FROM webhook_deliveries
          WHERE endpoint_id = ?
          ORDER BY created_at DESC
          LIMIT ?`,
    args: [id, limit],
  })

  return c.json({
    success: true,
    deliveries: rows.rows.map((r) => ({
      id: r.id,
      event: r.event,
      attempt: r.attempt,
      status: r.status,
      responseStatus: r.response_status ?? null,
      nextRetryAt: r.next_retry_at ?? null,
      deliveredAt: r.delivered_at ?? null,
      createdAt: r.created_at,
    })),
  })
})

function parseEvents(raw: string): string[] {
  try { return JSON.parse(raw) as string[] } catch { return [] }
}
