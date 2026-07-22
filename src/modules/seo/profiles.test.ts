// src/modules/seo/profiles.test.ts — profile registry (V1.3 foundation).
import { describe, it, expect } from "vitest"
import { SEO_PROFILES, isProfileId, parseProfiles, normalizeProfiles, defaultProfilesForKind } from "./profiles"

describe("profile registry", () => {
  it("is the closed five-profile set", () => {
    expect(SEO_PROFILES.map((p) => p.id)).toEqual(["local", "news", "ecommerce", "image", "ai"])
    expect(isProfileId("local")).toBe(true)
    expect(isProfileId("doorway-spam")).toBe(false)
  })
})

describe("parseProfiles (byte-identical rail)", () => {
  // GUARDRAIL: absent/junk storage MUST mean no profiles — an untouched site
  // builds exactly as today.
  it("returns [] for null, empty, junk, and non-array JSON", () => {
    expect(parseProfiles(null)).toEqual([])
    expect(parseProfiles("")).toEqual([])
    expect(parseProfiles("not json")).toEqual([])
    expect(parseProfiles('{"local":true}')).toEqual([])
  })
  it("keeps only valid ids, deduped, order preserved", () => {
    expect(parseProfiles('["ai","local","ai","bogus"]')).toEqual(["ai", "local"])
  })
})

describe("normalizeProfiles", () => {
  it("drops unknown ids and dedupes", () => {
    expect(normalizeProfiles(["ecommerce", "ecommerce", "x", "news"])).toEqual(["ecommerce", "news"])
  })
})

describe("defaultProfilesForKind (genesis mapping)", () => {
  it("maps kinds to sensible defaults, with the AEO baseline on every kind (V1.5 M6)", () => {
    expect(defaultProfilesForKind("ecommerce")).toEqual(["ecommerce", "image", "ai"])
    expect(defaultProfilesForKind("local-business")).toEqual(["local", "ai"])
    expect(defaultProfilesForKind("content")).toEqual(["image", "ai"])
    expect(defaultProfilesForKind("portfolio")).toEqual(["ai"])
    expect(defaultProfilesForKind(undefined)).toEqual(["ai"])
  })
  it("always includes the AI/AEO baseline (always-optimized default)", () => {
    for (const kind of ["ecommerce", "local-business", "content", "portfolio", "anything"]) {
      expect(defaultProfilesForKind(kind)).toContain("ai")
    }
  })
})
