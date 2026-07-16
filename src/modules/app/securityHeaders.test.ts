// src/modules/app/securityHeaders.test.ts
// Final-audit regression (D9): the dashboard sets anti-clickjacking + hardening
// headers, but ONLY on the SaaS host — a tenant-host request that falls through
// must stay byte-identical (no added headers).

import { describe, it, expect, vi } from "vitest"
import type { Next } from "hono"
import { saasSecurityHeaders } from "./appRouter"

function ctx(opts: { saasMode?: string; hostname?: string }) {
  return {
    env: { SAAS_MODE: opts.saasMode, SAAS_APP_HOSTNAME: "arsal.app" },
    get: (k: string) => (k === "hostname" ? opts.hostname : undefined),
    res: new Response("<html>dashboard</html>", { headers: { "Content-Type": "text/html" } }),
  } as never
}

const passthrough = () => (async () => {}) as unknown as Next

describe("saasSecurityHeaders", () => {
  it("adds frame-ancestors/CSP/nosniff/HSTS on the SaaS host", async () => {
    const c = ctx({ saasMode: "1", hostname: "arsal.app" })
    await saasSecurityHeaders(c, passthrough())
    const h = (c as unknown as { res: Response }).res.headers
    expect(h.get("X-Frame-Options")).toBe("DENY")
    expect(h.get("Content-Security-Policy")).toContain("frame-ancestors 'none'")
    expect(h.get("X-Content-Type-Options")).toBe("nosniff")
    expect(h.get("Strict-Transport-Security")).toContain("max-age=")
  })

  it("adds NOTHING on a tenant host (byte-identical fall-through)", async () => {
    const c = ctx({ saasMode: "1", hostname: "customer-site.com" }) // not the saas host
    await saasSecurityHeaders(c, passthrough())
    const h = (c as unknown as { res: Response }).res.headers
    expect(h.get("X-Frame-Options")).toBeNull()
    expect(h.get("Content-Security-Policy")).toBeNull()
  })

  it("adds nothing when SAAS_MODE is off", async () => {
    const c = ctx({ saasMode: "", hostname: "arsal.app" })
    await saasSecurityHeaders(c, passthrough())
    expect((c as unknown as { res: Response }).res.headers.get("X-Frame-Options")).toBeNull()
  })
})
