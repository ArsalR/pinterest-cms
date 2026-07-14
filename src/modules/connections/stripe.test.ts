// src/modules/connections/stripe.test.ts
// Key-shape validation is pure and testable without network (the live
// /v1/account check is exercised in Phase 10 mocked tests).

import { describe, it, expect, vi, afterEach } from "vitest"
import { verifyStripeKey } from "./stripe"

afterEach(() => vi.unstubAllGlobals())

describe("verifyStripeKey shape guard", () => {
  it("rejects non-secret keys before any network call", async () => {
    for (const bad of ["", "pk_live_abcdefghijklmnop", "sk_live_short", "whatever", "rk_live_x"]) {
      const r = await verifyStripeKey(bad)
      expect(r.valid, bad).toBe(false)
      expect(r.problem).toMatch(/secret key|doesn't look/i)
    }
  })

  it("accepts a well-shaped test key and reports livemode=false on success", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ settings: { dashboard: { display_name: "Acme" } } }), { status: 200 })
    )
    const r = await verifyStripeKey("sk_test_" + "a".repeat(24))
    expect(r.valid).toBe(true)
    expect(r.livemode).toBe(false)
    expect(r.accountName).toBe("Acme")
  })

  it("maps a 401 to a plain-language error", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }))
    const r = await verifyStripeKey("sk_live_" + "b".repeat(24))
    expect(r.valid).toBe(false)
    expect(r.problem).toMatch(/rejected/i)
  })

  it("livemode=true for sk_live_ keys", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ livemode: true }), { status: 200 }))
    const r = await verifyStripeKey("sk_live_" + "c".repeat(24))
    expect(r.valid).toBe(true)
    expect(r.livemode).toBe(true)
  })
})
