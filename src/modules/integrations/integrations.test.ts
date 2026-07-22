// Pure-logic tests for scoped integration keys (V1.5 M2): the scope catalog +
// the permitScope mapping that the public API enforces (incl. the guardrail
// that a read-only key is denied write).
import { describe, it, expect } from "vitest"
import { SCOPE_IDS, isScope } from "./keys"
import { permitScope } from "../../lib/apiAuth"
import { generateScopedKey } from "../../lib/auth"

describe("scope catalog", () => {
  it("validates known scope ids and rejects junk", () => {
    expect(isScope("read-posts")).toBe(true)
    expect(isScope("write-posts")).toBe(true)
    expect(isScope("delete-everything")).toBe(false)
    expect(SCOPE_IDS).toContain("read-analytics")
  })
})

describe("generateScopedKey", () => {
  it("mints an sk_site_ key distinct from cms_live_", () => {
    const k = generateScopedKey()
    expect(k.startsWith("sk_site_")).toBe(true)
    expect(k.length).toBeGreaterThan(50)
    expect(generateScopedKey()).not.toBe(k) // random
  })
})

describe("permitScope (public-API enforcement)", () => {
  it("exact scope always passes", () => {
    expect(permitScope("read-analytics", ["read-analytics"])).toBe(true)
    expect(permitScope("manage-redirects", ["manage-redirects"])).toBe(true)
  })
  it("coarse 'read' is satisfied by any read-* or write-*", () => {
    expect(permitScope("read", ["read-posts"])).toBe(true)
    expect(permitScope("read", ["write-posts"])).toBe(true) // write implies read
    expect(permitScope("read", ["manage-redirects"])).toBe(false)
  })
  it("GUARDRAIL: a read-only key is denied write", () => {
    expect(permitScope("write", ["read-posts", "read-forms", "read-analytics"])).toBe(false)
    expect(permitScope("write", ["write-posts"])).toBe(true)
  })
  it("empty scopes grant nothing", () => {
    expect(permitScope("read", [])).toBe(false)
    expect(permitScope("write", [])).toBe(false)
  })
})
