// src/modules/analytics/analytics.test.ts
// Pure logic: CWV ratings + degradation alerts, and third-party script cost.
// (The CF GraphQL fetch is best-effort I/O — Phase 10 mocked tests cover it.)

import { describe, it, expect } from "vitest"
import { rateLcp, rateCls, rateInp, cwvAlerts, type Cwv } from "./cwv"
import { estimateScriptCost, scriptCostWarning } from "./scriptCost"

describe("CWV ratings (Google p75 thresholds)", () => {
  it("LCP: ≤2.5s good, ≤4s needs-improvement, else poor", () => {
    expect(rateLcp(2000)).toBe("good")
    expect(rateLcp(3000)).toBe("needs-improvement")
    expect(rateLcp(5000)).toBe("poor")
  })
  it("CLS: ≤0.1 good, ≤0.25 ni, else poor", () => {
    expect(rateCls(0.05)).toBe("good")
    expect(rateCls(0.2)).toBe("needs-improvement")
    expect(rateCls(0.4)).toBe("poor")
  })
  it("INP: ≤200ms good, ≤500 ni, else poor", () => {
    expect(rateInp(150)).toBe("good")
    expect(rateInp(350)).toBe("needs-improvement")
    expect(rateInp(700)).toBe("poor")
  })
})

describe("cwvAlerts (P8 — alert when a vital is poor or degrades)", () => {
  const good: Cwv = { lcpMs: 1500, cls: 0.02, inpMs: 100 }
  it("no alerts when all vitals are good", () => {
    expect(cwvAlerts(good)).toEqual([])
  })
  it("alerts on a poor vital", () => {
    const a = cwvAlerts({ lcpMs: 5000, cls: 0.02, inpMs: 100 })
    expect(a).toHaveLength(1)
    expect(a[0].metric).toBe("LCP")
    expect(a[0].rating).toBe("poor")
  })
  it("alerts on degradation (good → needs-improvement) vs previous", () => {
    const a = cwvAlerts({ lcpMs: 3000, cls: 0.02, inpMs: 100 }, good)
    expect(a.some((x) => x.metric === "LCP" && x.rating === "needs-improvement")).toBe(true)
  })
  it("does not alert when a vital improves", () => {
    const a = cwvAlerts(good, { lcpMs: 3000, cls: 0.02, inpMs: 100 })
    expect(a).toEqual([])
  })
})

describe("estimateScriptCost (P7 third-party cost warning)", () => {
  it("bigger scripts cost more; render-blocking flagged", () => {
    const small = estimateScriptCost(5 * 1024, { defer: true })
    const big = estimateScriptCost(200 * 1024)
    expect(big.totalMs).toBeGreaterThan(small.totalMs)
    expect(big.renderBlocking).toBe(true)
    expect(small.renderBlocking).toBe(false)
  })
  it("verdict scales with cost", () => {
    expect(estimateScriptCost(1024, { async: true }).verdict).toBe("cheap")
    expect(estimateScriptCost(300 * 1024).verdict).toBe("heavy")
  })
  it("warning names the URL and the ms cost", () => {
    const w = scriptCostWarning("https://cdn.example/analytics.js", estimateScriptCost(120 * 1024))
    expect(w).toContain("https://cdn.example/analytics.js")
    expect(w).toMatch(/\d+ms/)
    expect(w).toMatch(/add anyway/i)
  })
})
