// src/lib/saas/prompts.test.ts
// Pure-logic tests: status mapping, cost line, genesis prompt content,
// dispatch cap shape. (Dispatch/API paths hit GitHub — Phase 10 mocked tests.)

import { describe, it, expect } from "vitest"
import { runPhase, runMinutes, genesisPrompt, PROMPT_DISPATCH_LIMIT } from "./prompts"

describe("runPhase (queued → running → committed → building → deployed)", () => {
  it("maps the full happy path", () => {
    expect(runPhase({ status: "queued", conclusion: null }, null)).toBe("queued")
    expect(runPhase({ status: "in_progress", conclusion: null }, null)).toBe("running")
    expect(runPhase({ status: "completed", conclusion: "success" }, null)).toBe("committed")
    expect(runPhase({ status: "completed", conclusion: "success" }, { status: "in_progress", conclusion: null })).toBe("building")
    expect(runPhase({ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "success" })).toBe("deployed")
  })
  it("failure states", () => {
    expect(runPhase({ status: "completed", conclusion: "failure" }, null)).toBe("failed")
    expect(runPhase({ status: "completed", conclusion: "cancelled" }, null)).toBe("failed")
    // A covenant-gate failure in the deploy run reads as failed, not deployed.
    expect(runPhase({ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" })).toBe("failed")
  })
  it("no run found yet", () => {
    expect(runPhase(null, null)).toBe("unknown")
  })
})

describe("runMinutes — the visible cost line", () => {
  it("rounds to whole minutes, minimum 1", () => {
    expect(runMinutes({ runStartedAt: "2026-07-13T10:00:00Z", updatedAt: "2026-07-13T10:07:20Z" })).toBe("~7 min")
    expect(runMinutes({ runStartedAt: "2026-07-13T10:00:00Z", updatedAt: "2026-07-13T10:00:10Z" })).toBe("~1 min")
  })
  it("null when timing is missing or nonsensical", () => {
    expect(runMinutes(null)).toBeNull()
    expect(runMinutes({ runStartedAt: null, updatedAt: "2026-07-13T10:00:00Z" })).toBeNull()
    expect(runMinutes({ runStartedAt: "2026-07-13T11:00:00Z", updatedAt: "2026-07-13T10:00:00Z" })).toBeNull()
  })
})

describe("genesisPrompt (K1)", () => {
  const p = genesisPrompt("BrewCraft", "home espresso gear")
  it("carries the name, niche, topical-map structure, and article count", () => {
    expect(p).toContain("BrewCraft")
    expect(p).toContain("home espresso gear")
    expect(p).toContain("10")
    expect(p).toMatch(/pillar/i)
    expect(p).toMatch(/CMS API/)
  })
  it("re-states the guardrails (protected files, zero JS)", () => {
    expect(p).toMatch(/protected files/i)
    expect(p).toMatch(/client-side JavaScript/i)
  })
})

describe("PROMPT_DISPATCH_LIMIT (cost guardrail — locked in review)", () => {
  it("caps dispatches per site per hour", () => {
    expect(PROMPT_DISPATCH_LIMIT.windowSecs).toBe(3600)
    expect(PROMPT_DISPATCH_LIMIT.max).toBeGreaterThan(0)
    expect(PROMPT_DISPATCH_LIMIT.max).toBeLessThanOrEqual(10)
  })
})
