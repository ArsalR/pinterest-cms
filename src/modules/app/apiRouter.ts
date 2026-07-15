// src/modules/app/apiRouter.ts
// JSON API for the dashboard's fetch calls (/api/saas/v1/*), cookie-authed.
// Same fall-through gating contract as routes/saas/index.ts: when saas_mode
// is off or the hostname isn't the SaaS dashboard, every handler defers via
// next() so existing behavior (frontend catch-all's /api/* 404) is untouched.

import { Hono } from "hono"
import type { Context, MiddlewareHandler } from "hono"
import type { AppEnv } from "../../lib/types"
import { saasActive, requireCustomer } from "../auth"
import { planGate, type Customer } from "../customers"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared/masterMigrate"
import { listConnections, getConnectionSecret } from "../connections"
import { listCfZones } from "../connections"
import { resolveAndCountClick } from "../affiliate"

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

// GET /api/saas/go/:siteId?u=<target> — PUBLIC edge click counter (K10).
// No auth (visitors on customer sites click these). Counts the click and 302s
// to the target — but ONLY if the target host is one of the site's affiliate
// domains (open-redirect guard inside resolveAndCountClick). Gated on saas
// hostname like everything else, so it's invisible on tenant hosts.
saasApiRoutes.get("/go/:siteId", async (c, next) => {
  if (!saasActive(c)) return next()
  const siteId = c.req.param("siteId")
  const target = c.req.query("u") ?? ""
  const master = getMasterDb(c.env)
  await ensureMasterSchema(master)
  const day = new Date().toISOString().slice(0, 10)
  const dest = await resolveAndCountClick(master, siteId, target, day).catch(() => null)
  // On a guard failure, bounce to the site root rather than an arbitrary URL.
  return c.redirect(dest ?? "/", 302)
})
