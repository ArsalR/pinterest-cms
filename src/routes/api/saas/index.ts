// src/routes/api/saas/index.ts
// JSON API for the dashboard's fetch calls (/api/saas/v1/*), cookie-authed.
// Same fall-through gating contract as routes/saas/index.ts: when saas_mode
// is off or the hostname isn't the SaaS dashboard, every handler defers via
// next() so existing behavior (frontend catch-all's /api/* 404) is untouched.

import { Hono } from "hono"
import type { Context, MiddlewareHandler } from "hono"
import type { AppEnv } from "../../../lib/types"
import { saasActive, requireCustomer } from "../../../middleware/saasAuthMiddleware"
import { planGate, type Customer } from "../../../lib/saas/customers"
import { getMasterDb } from "../../../lib/turso"
import { ensureMasterSchema } from "../../../lib/masterMigrate"
import { listConnections, getConnectionSecret } from "../../../lib/saas/connections"
import { listCfZones } from "../../../lib/saas/cloudflare"

type ApiHandler = (c: Context<AppEnv>, customer: Customer) => Promise<Response>

function api(handler: ApiHandler): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!saasActive(c)) return next()
    const customer = await requireCustomer(c, "api")
    if (customer instanceof Response) return customer
    return handler(c, customer)
  }
}

function nowSqlite(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}

export const saasApiRoutes = new Hono<AppEnv>()

// GET /api/saas/v1/me — session probe for the dashboard shell.
saasApiRoutes.get(
  "/v1/me",
  api(async (c, customer) => {
    return c.json({
      id: customer.id,
      email: customer.email,
      name: customer.name,
      plan: customer.plan,
      planStatus: customer.plan_status,
      trialEndsAt: customer.trial_ends_at,
      emailVerified: customer.email_verified === 1,
      gate: planGate(customer, nowSqlite()),
    })
  })
)

// GET /api/saas/v1/connections — render-safe connection list (no secrets).
saasApiRoutes.get(
  "/v1/connections",
  api(async (c, customer) => {
    const db = getMasterDb(c.env)
    await ensureMasterSchema(db)
    return c.json({ connections: await listConnections(db, customer.id) })
  })
)

// GET /api/saas/v1/cloudflare/zones — live zone statuses; polled by the
// wizard's domain step every 15s until all zones are active.
saasApiRoutes.get(
  "/v1/cloudflare/zones",
  api(async (c, customer) => {
    const db = getMasterDb(c.env)
    await ensureMasterSchema(db)
    let token: string | null = null
    try {
      token = await getConnectionSecret(db, c.env, customer.id, "cloudflare", "zone-poll")
    } catch (err) {
      console.error("zone-poll: decrypt failed:", err instanceof Error ? err.message : err)
    }
    if (!token) {
      return c.json({ error: "Connect Cloudflare first.", code: "not_found" }, 404, { "X-Error-Code": "not_found" })
    }
    const zones = await listCfZones(token)
    if (zones === null) {
      return c.json(
        { error: "Couldn't reach Cloudflare just now — will retry.", code: "internal_error" },
        502,
        { "X-Error-Code": "internal_error" }
      )
    }
    return c.json({ zones: zones.map((z) => ({ id: z.id, name: z.name, status: z.status, paused: z.paused })) })
  })
)
