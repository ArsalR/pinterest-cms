// src/middleware/saasAuthMiddleware.ts
// Platform-customer session auth for /app/* and /api/saas/* on
// SAAS_APP_HOSTNAME. Follows the repo's per-handler auth idiom (like
// validateApiKey): handlers call requireCustomer() first and return early
// if it yields a Response.
//
// Differences from the tenant adminAuthMiddleware (deliberate):
// - separate cookie (saas_session) + separate secret (SAAS_JWT_SECRET),
// - FAIL-CLOSED on DB errors — the master DB is the platform's own
//   infrastructure; there is no fail-open rationale here.

import type { Context } from "hono"
import type { AppEnv } from "../lib/types"
import { parseCookies } from "../lib/cookies"
import { getMasterDb } from "../lib/turso"
import { ensureMasterSchema } from "../lib/masterMigrate"
import {
  SAAS_SESSION_COOKIE,
  verifyCustomerSession,
  findCustomerById,
  type Customer,
} from "../lib/saas/customers"

/** True when this request is the SaaS dashboard: flag on AND on the SaaS hostname. */
export function saasActive(c: Context<AppEnv>): boolean {
  const h = c.env.SAAS_APP_HOSTNAME?.toLowerCase()
  return c.env.SAAS_MODE === "1" && !!h && c.get("hostname") === h
}

function loginRedirect(currentUrl: string): Response {
  const url = new URL(currentUrl)
  const next = encodeURIComponent(url.pathname + url.search)
  return new Response(null, {
    status: 302,
    headers: { Location: `/app/login?next=${next}` },
  })
}

function apiError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: { "Content-Type": "application/json", "X-Error-Code": code },
  })
}

/**
 * Resolve the signed-in customer or produce the appropriate rejection.
 * mode "page" → 302 to /app/login; mode "api" → 401 JSON.
 * On success the customer is also placed on context (c.get("customer")).
 */
export async function requireCustomer(
  c: Context<AppEnv>,
  mode: "page" | "api" = "page"
): Promise<Customer | Response> {
  const reject = (why: string): Response =>
    mode === "page" ? loginRedirect(c.req.url) : apiError(401, "auth_missing", why)

  const secret = c.env.SAAS_JWT_SECRET
  if (!secret) {
    console.error("saasAuth: SAAS_JWT_SECRET is not set")
    return mode === "page"
      ? loginRedirect(c.req.url)
      : apiError(500, "internal_error", "Sign-in isn't available right now.")
  }

  const token = parseCookies(c.req.header("cookie"))[SAAS_SESSION_COOKIE]
  if (!token) return reject("You need to sign in first.")

  const session = await verifyCustomerSession(token, secret).catch(() => null)
  if (!session) return reject("Your session has expired — please sign in again.")

  // Fail-closed: any error loading the customer means no access.
  try {
    const master = getMasterDb(c.env)
    await ensureMasterSchema(master)
    const customer = await findCustomerById(master, session.sub)
    if (!customer) return reject("Your session has expired — please sign in again.")
    c.set("customer", customer)
    return customer
  } catch (err) {
    console.error("saasAuth: customer lookup failed:", err instanceof Error ? err.message : err)
    return mode === "page"
      ? loginRedirect(c.req.url)
      : apiError(500, "internal_error", "We hit a snag loading your account — please retry.")
  }
}
