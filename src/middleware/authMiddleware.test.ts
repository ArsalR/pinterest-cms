// src/middleware/authMiddleware.test.ts
// Final-audit regression (token-confusion / cross-system auth boundary):
// a SaaS session token (aud:"saas") must NEVER authenticate as a tenant CMS
// admin, even in the worst case where an operator reused the same value for
// JWT_SECRET and SAAS_JWT_SECRET (so the HMAC signature verifies). The reject
// must happen BEFORE the user-existence lookup, so the fail-open DB path can't
// launder a foreign token into admin.

import { describe, it, expect, vi } from "vitest"
import type { Next } from "hono"
import { adminAuthMiddleware } from "./authMiddleware"
import { signJwt } from "../lib/auth"
import { buildSetCookie } from "../lib/cookies"

const mkNext = () => vi.fn(async () => {}) as unknown as Next & ReturnType<typeof vi.fn>

const SECRET = "shared-secret-operator-reused-it"

function ctx(token: string, siteDbExecute: ReturnType<typeof vi.fn>) {
  const store: Record<string, unknown> = { siteDb: { execute: siteDbExecute } }
  return {
    req: {
      url: "https://tenant.example.com/admin/posts",
      header: (name: string) => (name.toLowerCase() === "cookie" ? buildSetCookie("cms_session", token).split(";")[0] : undefined),
    },
    env: { JWT_SECRET: SECRET, SESSION_COOKIE_NAME: "cms_session" },
    get: (k: string) => store[k],
    set: (k: string, v: unknown) => { store[k] = v },
  } as never
}

describe("tenant admin auth rejects foreign (SaaS) tokens", () => {
  it("rejects an aud:'saas' token even when the secret matches — before any DB lookup", async () => {
    const saasToken = await signJwt({ sub: "cust_123", email: "a@b.c", aud: "saas" }, SECRET)
    const execute = vi.fn(async () => ({ rows: [{ id: "cust_123", email: "a@b.c", role: "admin" }] }))
    const next = mkNext()
    const res = (await adminAuthMiddleware(ctx(saasToken, execute), next)) as Response

    expect(res.status).toBe(302)                         // redirected to login
    expect(res.headers.get("location")).toContain("/admin/login")
    expect(next).not.toHaveBeenCalled()                  // never reached the route
    expect(execute).not.toHaveBeenCalled()               // rejected before the (fail-open) user lookup
  })

  it("rejects any other SaaS aud (client-seat, oauth state) too", async () => {
    for (const aud of ["client-seat", "gsc-oauth", "gh-install"]) {
      const t = await signJwt({ sub: "x", aud }, SECRET)
      const next = mkNext()
      const res = (await adminAuthMiddleware(ctx(t, vi.fn()), next)) as Response
      expect(res.status).toBe(302)
      expect(next).not.toHaveBeenCalled()
    }
  })

  it("still admits a legitimate admin token (no aud) whose user exists", async () => {
    const adminToken = await signJwt({ sub: "user_1", email: "admin@site.com", role: "admin" }, SECRET)
    const execute = vi.fn(async () => ({ rows: [{ id: "user_1", email: "admin@site.com", role: "admin" }] }))
    const next = mkNext()
    const res = (await adminAuthMiddleware(ctx(adminToken, execute), next)) as Response

    expect(next).toHaveBeenCalled()
    expect(execute).toHaveBeenCalled() // reached the user-existence check
  })
})
