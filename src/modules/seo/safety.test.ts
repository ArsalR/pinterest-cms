// src/modules/seo/safety.test.ts — safety rail #2 guardrail suite.
import { describe, it, expect } from "vitest"
import {
  checkSeoSafety,
  noindexTransitionGate,
  NOINDEX_RATIO_LIMIT,
  SEO_SAFETY_OVERRIDE_PHRASE,
} from "./safety"

describe("checkSeoSafety", () => {
  it("passes when nothing is deindexed", () => {
    const r = checkSeoSafety({ totalPublished: 10, noindexCount: 0 })
    expect(r.passed).toBe(true)
    expect(r.blocked).toBe(false)
    expect(r.reasons).toHaveLength(0)
    expect(r.noindexRatio).toBe(0)
  })

  it("passes at the limit but not beyond it", () => {
    // exactly 30% is allowed; the gate fires only when it EXCEEDS the limit.
    const atLimit = checkSeoSafety({ totalPublished: 10, noindexCount: 3 })
    expect(atLimit.passed).toBe(true)
    expect(atLimit.blocked).toBe(false)
  })

  // GUARDRAIL FIRES (safety rail #5): a deploy that would deindex the majority
  // of published pages must be blocked without an explicit typed override.
  it("blocks a deploy that noindexes more than 30% of pages", () => {
    const r = checkSeoSafety({ totalPublished: 10, noindexCount: 4 })
    expect(r.blocked).toBe(true)
    expect(r.passed).toBe(false)
    expect(r.overridden).toBe(false)
    expect(r.reasons.join(" ")).toMatch(/40% of published pages/)
    expect(r.noindexRatio).toBeCloseTo(0.4)
  })

  it("lets the deploy through only with the exact typed override phrase", () => {
    const base = { totalPublished: 10, noindexCount: 9 }
    expect(checkSeoSafety({ ...base, typedOverride: "yes" }).passed).toBe(false)
    expect(checkSeoSafety({ ...base, typedOverride: SEO_SAFETY_OVERRIDE_PHRASE }).passed).toBe(true)
    const ok = checkSeoSafety({ ...base, typedOverride: `  ${SEO_SAFETY_OVERRIDE_PHRASE}  ` })
    expect(ok.passed).toBe(true)
    expect(ok.overridden).toBe(true)
    // still reported as blocked-but-overridden so the caller audit-logs it.
    expect(ok.blocked).toBe(true)
  })

  it("blocks when the effective robots policy would bar major engines", () => {
    const r = checkSeoSafety({ totalPublished: 100, noindexCount: 0, blocksMajorEngines: true })
    expect(r.blocked).toBe(true)
    expect(r.reasons.join(" ")).toMatch(/major search engines/)
    expect(checkSeoSafety({ ...{ totalPublished: 100, noindexCount: 0, blocksMajorEngines: true }, typedOverride: SEO_SAFETY_OVERRIDE_PHRASE }).passed).toBe(true)
  })

  it("passes trivially when there are no published pages", () => {
    const r = checkSeoSafety({ totalPublished: 0, noindexCount: 0 })
    expect(r.passed).toBe(true)
    expect(r.noindexRatio).toBe(0)
  })

  it("keeps the limit at the documented 30%", () => {
    expect(NOINDEX_RATIO_LIMIT).toBe(0.3)
  })
})

describe("noindexTransitionGate (S6 cockpit wiring)", () => {
  it("lets a normal noindex through when the ratio stays under the limit", () => {
    // 10 published, 1 already noindexed; one more = 20% — fine.
    expect(noindexTransitionGate(10, 1).passed).toBe(true)
  })

  // GUARDRAIL FIRES (rail #5): the cockpit save that would tip the site over
  // the 30% deindex limit is refused until the operator types the phrase.
  it("blocks the save that tips the site over 30% without the typed phrase", () => {
    // 10 published, 3 already noindexed; one more = 40% — blocked.
    const blocked = noindexTransitionGate(10, 3)
    expect(blocked.passed).toBe(false)
    expect(blocked.blocked).toBe(true)
    const overridden = noindexTransitionGate(10, 3, SEO_SAFETY_OVERRIDE_PHRASE)
    expect(overridden.passed).toBe(true)
    expect(overridden.overridden).toBe(true) // caller must audit-log this
  })
})
