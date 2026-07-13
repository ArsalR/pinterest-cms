// src/lib/saas/customers.test.ts
// Pure-logic tests only (vitest runs in plain Node — no Workers runtime).

import { describe, it, expect } from "vitest"
import { validateEmail, validatePassword, trialEnd, planGate, TRIAL_DAYS } from "./customers"

describe("validateEmail", () => {
  it("normalizes case and whitespace", () => {
    expect(validateEmail("  User@Example.COM ")).toBe("user@example.com")
  })
  it("rejects malformed addresses", () => {
    for (const bad of ["", "plain", "a@b", "a b@c.com", "a@b.c", "@x.com", "a@.com"]) {
      expect(validateEmail(bad)).toBeNull()
    }
  })
  it("rejects overlong addresses", () => {
    expect(validateEmail("a".repeat(250) + "@x.com")).toBeNull()
  })
})

describe("validatePassword", () => {
  it("requires at least 10 characters", () => {
    expect(validatePassword("short")).toMatch(/at least 10/)
    expect(validatePassword("longenough123")).toBeNull()
  })
  it("caps absurd lengths", () => {
    expect(validatePassword("x".repeat(201))).toMatch(/too long/)
  })
})

describe("trialEnd", () => {
  it("adds N days in SQLite UTC format", () => {
    const from = new Date("2026-01-01T00:00:00Z")
    expect(trialEnd(from, 14)).toBe("2026-01-15 00:00:00")
  })
  it("defaults to the trial length", () => {
    const from = new Date("2026-03-01T12:30:45Z")
    const expected = new Date(from.getTime() + TRIAL_DAYS * 86400_000)
      .toISOString().replace("T", " ").slice(0, 19)
    expect(trialEnd(from)).toBe(expected)
  })
})

describe("planGate (decision B: trial expiry = read-only, sites stay live)", () => {
  const now = "2026-06-15 00:00:00"
  it("active subscription is active regardless of trial date", () => {
    expect(planGate({ plan_status: "active", trial_ends_at: "2026-01-01 00:00:00" }, now)).toBe("active")
    expect(planGate({ plan_status: "active", trial_ends_at: null }, now)).toBe("active")
  })
  it("trialing before expiry is active", () => {
    expect(planGate({ plan_status: "trialing", trial_ends_at: "2026-06-16 00:00:00" }, now)).toBe("active")
  })
  it("trialing after expiry is read-only", () => {
    expect(planGate({ plan_status: "trialing", trial_ends_at: "2026-06-14 23:59:59" }, now)).toBe("read_only")
  })
  it("expired/canceled/unknown statuses are read-only", () => {
    for (const s of ["expired", "canceled", "past_due", ""]) {
      expect(planGate({ plan_status: s, trial_ends_at: null }, now)).toBe("read_only")
    }
  })
  it("trialing with no trial date is read-only (defensive)", () => {
    expect(planGate({ plan_status: "trialing", trial_ends_at: null }, now)).toBe("read_only")
  })
})
