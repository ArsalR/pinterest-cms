// src/middleware/authMiddleware.ts
// Admin session auth (JWT in HttpOnly cookie).
// Used for /admin/* routes. Login route itself is exempt.

import type { MiddlewareHandler } from "hono"
import { verifyJwt } from "../lib/auth"
import { parseCookies } from "../lib/cookies"
import type { AppEnv } from "../lib/types"

const PUBLIC_ADMIN_PATHS = new Set(["/admin/login", "/admin/login/"])

export const adminAuthMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = new URL(c.req.url).pathname
  if (PUBLIC_ADMIN_PATHS.has(path)) {
    return next()
  }

  const cookies = parseCookies(c.req.header("cookie"))
  const token = cookies[c.env.SESSION_COOKIE_NAME ?? "cms_session"]
  if (!token) {
    return redirectToLogin(c.req.url)
  }
  if (!c.env.JWT_SECRET) {
    console.error("authMiddleware: JWT_SECRET env var is not set")
    return redirectToLogin(c.req.url)
  }
  let payload: Awaited<ReturnType<typeof verifyJwt>>
  try {
    payload = await verifyJwt(token, c.env.JWT_SECRET)
  } catch (err) {
    console.error("authMiddleware: JWT verify threw:", err)
    return redirectToLogin(c.req.url)
  }
  if (!payload || !payload.sub) {
    return redirectToLogin(c.req.url)
  }
  // Token-confusion defense: admin session tokens are minted WITHOUT an `aud`
  // claim (routes/admin/login.ts). SaaS tokens all carry `aud` (saas session,
  // OAuth state, client-seat). Reject any aud-bearing token here so that even
  // if an operator misconfigures JWT_SECRET === SAAS_JWT_SECRET, a customer's
  // SaaS token can never be replayed as a tenant-admin cookie (which would
  // otherwise slip through on the fail-open DB path below).
  if (payload.aud !== undefined) {
    return redirectToLogin(c.req.url)
  }

  // Verify user still exists. On DB error, trust the valid JWT so a transient
  // connectivity failure doesn't lock the user out (fail-open on infra errors,
  // fail-closed on bad credentials).
  const siteDb = c.get("siteDb")
  let userData = { id: payload.sub, email: payload.email ?? "", role: payload.role ?? "admin" }
  try {
    const userRow = await siteDb.execute({
      sql: "SELECT id, email, role FROM users WHERE id = ? LIMIT 1",
      args: [payload.sub],
    })
    if (!userRow.rows.length) {
      return redirectToLogin(c.req.url)
    }
    const u = userRow.rows[0]
    userData = { id: u.id as string, email: u.email as string, role: u.role as string }
  } catch (err) {
    console.error("authMiddleware: DB lookup failed, trusting JWT:", err)
  }
  c.set("user", userData)

  return next()
}

function redirectToLogin(currentUrl: string): Response {
  const url = new URL(currentUrl)
  const next = encodeURIComponent(url.pathname + url.search)
  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/login?next=${next}` },
  })
}

/** Network admin auth — header-based (single shared key). */
export const networkAuthMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expected = c.env.NETWORK_ADMIN_KEY
  if (!expected) return c.json({ error: "NETWORK_ADMIN_KEY not configured" }, 500)
  const got = c.req.header("x-network-admin-key")
  if (got !== expected) return c.json({ error: "Unauthorized" }, 401)
  return next()
}
