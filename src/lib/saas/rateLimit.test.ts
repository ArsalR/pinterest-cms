// src/lib/saas/rateLimit.test.ts
// Pure-logic tests for the window math (the DB path is exercised in Phase 10
// against mocked clients).

import { describe, it, expect } from "vitest"
import { windowId, windowExpiry, AUTH_LIMITS } from "./rateLimit"

describe("windowId", () => {
  it("is stable within a window and rolls over at the boundary", () => {
    const w = 300 // 5 min
    const t0 = Date.parse("2026-01-01T00:00:00Z")
    expect(windowId(t0, w)).toBe(windowId(t0 + 299_000, w))
    expect(windowId(t0, w)).not.toBe(windowId(t0 + 300_000, w))
  })
  it("embeds the window length so different rules never collide", () => {
    const t = Date.parse("2026-01-01T00:00:00Z")
    expect(windowId(t, 300)).not.toBe(windowId(t, 3600))
    expect(windowId(t, 300).startsWith("300:")).toBe(true)
  })
  it("zero-pads for lexicographic ordering", () => {
    const a = windowId(Date.parse("2026-01-01T00:00:00Z"), 60)
    const b = windowId(Date.parse("2030-01-01T00:00:00Z"), 60)
    expect(a < b).toBe(true)
  })
})

describe("windowExpiry", () => {
  it("is the end of the current window in SQLite format", () => {
    const t = Date.parse("2026-01-01T00:07:31Z")
    expect(windowExpiry(t, 300)).toBe("2026-01-01 00:10:00")
  })
})

describe("AUTH_LIMITS sanity", () => {
  it("every rule has a positive max and window", () => {
    for (const [name, rule] of Object.entries(AUTH_LIMITS)) {
      expect(rule.max, name).toBeGreaterThan(0)
      expect(rule.windowSecs, name).toBeGreaterThanOrEqual(60)
    }
  })
  it("per-email login limit is tighter than per-IP (targeted stuffing)", () => {
    expect(AUTH_LIMITS.loginEmail.max).toBeLessThanOrEqual(AUTH_LIMITS.loginIp.max)
  })
})
