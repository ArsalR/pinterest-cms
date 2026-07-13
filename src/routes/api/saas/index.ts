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
