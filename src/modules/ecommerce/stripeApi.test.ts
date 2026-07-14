// src/modules/ecommerce/stripeApi.test.ts
// Security-critical: webhook signature verification + form encoding are pure
// and fully testable (WebCrypto is in node 20+). A real HMAC is computed to
// forge a valid signature, then the verifier is exercised on happy + attack paths.

import { describe, it, expect } from "vitest"
import { verifyStripeSignature, timingSafeEqualHex } from "./stripeApi"
import { stripeForm } from "../connections"

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)))
  let hex = ""
  for (let i = 0; i < mac.length; i++) hex += mac[i].toString(16).padStart(2, "0")
  return hex
}

const SECRET = "whsec_test_abc123"
const BODY = '{"type":"checkout.session.completed","id":"evt_1"}'

describe("verifyStripeSignature", () => {
  it("accepts a correctly-signed, fresh payload", async () => {
    const t = 1_760_000_000
    const sig = await sign(SECRET, `${t}.${BODY}`)
    const ok = await verifyStripeSignature(BODY, `t=${t},v1=${sig}`, SECRET, t)
    expect(ok).toBe(true)
  })

  it("accepts when multiple v1 signatures are present (one matches)", async () => {
    const t = 1_760_000_000
    const sig = await sign(SECRET, `${t}.${BODY}`)
    const ok = await verifyStripeSignature(BODY, `t=${t},v1=deadbeef,v1=${sig}`, SECRET, t)
    expect(ok).toBe(true)
  })

  it("rejects a tampered body", async () => {
    const t = 1_760_000_000
    const sig = await sign(SECRET, `${t}.${BODY}`)
    expect(await verifyStripeSignature(BODY + "x", `t=${t},v1=${sig}`, SECRET, t)).toBe(false)
  })

  it("rejects a wrong secret", async () => {
    const t = 1_760_000_000
    const sig = await sign("whsec_other", `${t}.${BODY}`)
    expect(await verifyStripeSignature(BODY, `t=${t},v1=${sig}`, SECRET, t)).toBe(false)
  })

  it("rejects a stale timestamp beyond tolerance (replay guard)", async () => {
    const t = 1_760_000_000
    const sig = await sign(SECRET, `${t}.${BODY}`)
    // verify 10 minutes later with the default 5-minute tolerance
    expect(await verifyStripeSignature(BODY, `t=${t},v1=${sig}`, SECRET, t + 600)).toBe(false)
  })

  it("rejects malformed / empty headers", async () => {
    expect(await verifyStripeSignature(BODY, "", SECRET)).toBe(false)
    expect(await verifyStripeSignature(BODY, "t=123", SECRET, 123)).toBe(false) // no v1
    expect(await verifyStripeSignature(BODY, "v1=abc", SECRET)).toBe(false) // no t
  })
})

describe("timingSafeEqualHex", () => {
  it("true only for identical strings", () => {
    expect(timingSafeEqualHex("abcd", "abcd")).toBe(true)
    expect(timingSafeEqualHex("abcd", "abce")).toBe(false)
    expect(timingSafeEqualHex("abcd", "abc")).toBe(false) // length mismatch
  })
})

describe("stripeForm (bracketed nested encoding)", () => {
  it("encodes nested objects and arrays the way Stripe expects (bracket keys percent-encoded)", () => {
    const s = stripeForm({
      mode: "payment",
      line_items: [{ quantity: 2, price_data: { currency: "usd", unit_amount: 1999 } }],
      metadata: { siteId: "s1" },
    })
    // Bracket keys are percent-encoded (%5B/%5D) — valid form encoding Stripe parses.
    expect(s).toContain("line_items%5B0%5D%5Bquantity%5D=2")
    // Decoded, the structure is the bracketed nesting Stripe expects.
    const decoded = decodeURIComponent(s)
    expect(decoded).toContain("mode=payment")
    expect(decoded).toContain("line_items[0][quantity]=2")
    expect(decoded).toContain("line_items[0][price_data][currency]=usd")
    expect(decoded).toContain("line_items[0][price_data][unit_amount]=1999")
    expect(decoded).toContain("metadata[siteId]=s1")
  })
  it("url-encodes values and skips null/undefined", () => {
    const s = stripeForm({ a: "x y&z", b: null, c: undefined, d: "ok" })
    expect(s).toContain("a=x%20y%26z")
    expect(s).not.toContain("b=")
    expect(s).not.toContain("c=")
    expect(s).toContain("d=ok")
  })
})
