// src/modules/cloning/cloning.test.ts
// Pure-logic: clone naming + the re-theme/re-seed prompt (K6). Provisioning I/O
// is Phase-10 mocked-integration territory.

import { describe, it, expect } from "vitest"
import { deriveCloneName, buildClonePrompt, type CloneInput } from "./clone"

describe("clone helpers (K6)", () => {
  it("derives a clone name and caps length", () => {
    expect(deriveCloneName("BrewCraft")).toBe("BrewCraft (clone)")
    expect(deriveCloneName("x".repeat(90)).length).toBe(80)
  })

  const input: CloneInput = {
    domain: "new.com", zoneId: "z1", name: "BrewCraft UK",
    niche: "home espresso in the UK", angle: "beginners in the UK, warmer tone",
  }

  it("builds a distinct re-theme/re-seed prompt referencing the source niche + angle", () => {
    const p = buildClonePrompt("home espresso gear", input, "content")
    expect(p).toContain("CLONE")
    expect(p).toContain("home espresso gear") // source niche
    expect(p).toContain("beginners in the UK") // angle
    expect(p).toMatch(/re-theme/i)
    expect(p).toMatch(/re-seed|10 original/i)
    expect(p).toContain("DRAFT") // still gated
    expect(p).toContain("BrewCraft UK")
  })

  it("names the site kind in the prompt", () => {
    expect(buildClonePrompt("n", input, "ecommerce")).toContain("ecommerce site")
  })
})
