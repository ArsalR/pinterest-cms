// src/modules/seo/scripts.test.ts — vetted script catalog (V1.3) + budget guardrail.
import { describe, it, expect } from "vitest"
import {
  SCRIPT_CATALOG, SCRIPT_BUDGET_KB, parseEnabledScripts, totalScriptWeightKb,
  checkScriptBudget, cspAdditions, catalogEntry,
  pixelEntries, hasConsentPixels, effectiveConsentMode,
} from "./scripts"

describe("catalog", () => {
  it("is a small closed set with honest costs and validated config", () => {
    expect(SCRIPT_CATALOG.length).toBe(10)
    for (const s of SCRIPT_CATALOG) {
      expect(s.costKb).toBeGreaterThan(0)
      expect(s.scriptHosts.length).toBeGreaterThan(0)
      expect(s.scriptHosts.every((h) => h.startsWith("https://"))).toBe(true)
      expect(["defer", "interaction"]).toContain(s.strategy)
    }
  })

  it("every ad pixel is consent-gated, interaction-loaded, with a validating pattern", () => {
    const pixels = SCRIPT_CATALOG.filter((s) => s.category === "pixel")
    expect(pixels.map((p) => p.id).sort()).toEqual(
      ["google_ads", "linkedin_insight", "meta_pixel", "pinterest_tag", "tiktok_pixel"]
    )
    for (const p of pixels) {
      expect(p.requiresConsent).toBe(true)
      expect(p.strategy).toBe("interaction")
      // config patterns must reject URLs/markup
      expect(p.configPattern.test("https://evil.com")).toBe(false)
      expect(p.configPattern.test("<script>")).toBe(false)
    }
    // known-good ids validate
    expect(catalogEntry("meta_pixel")!.configPattern.test("123456789012345")).toBe(true)
    expect(catalogEntry("google_ads")!.configPattern.test("AW-123456789")).toBe(true)
    expect(catalogEntry("pinterest_tag")!.configPattern.test("2612345678901")).toBe(true)
  })
})

describe("pixel consent helpers (V1.5 M4)", () => {
  const meta = [{ id: "meta_pixel", config: "123456789012345" }]
  const plausibleOnly = [{ id: "plausible", config: "example.com" }]

  it("pixelEntries returns only enabled pixels", () => {
    expect(pixelEntries([...meta, ...plausibleOnly]).map((e) => e.id)).toEqual(["meta_pixel"])
    expect(pixelEntries(plausibleOnly)).toEqual([])
  })

  it("hasConsentPixels is true only when a consent-gated pixel is on", () => {
    expect(hasConsentPixels(meta)).toBe(true)
    expect(hasConsentPixels(plausibleOnly)).toBe(false)
  })

  it("effectiveConsentMode: auto follows pixels; forced overrides both ways", () => {
    expect(effectiveConsentMode(meta, undefined)).toBe(true) // auto → on (pixel present)
    expect(effectiveConsentMode(plausibleOnly, undefined)).toBe(false) // auto → off (no pixel)
    expect(effectiveConsentMode(meta, false)).toBe(false) // forced off
    expect(effectiveConsentMode(plausibleOnly, true)).toBe(true) // forced on
  })
})

describe("parseEnabledScripts (no arbitrary injection)", () => {
  // GUARDRAIL: unknown ids and malformed config are DROPPED — there is no way
  // to smuggle an arbitrary script through the stored value.
  it("drops unknown ids and invalid config", () => {
    const raw = JSON.stringify([
      { id: "plausible", config: "example.com" },
      { id: "evil", config: "https://evil.com/x.js" },
      { id: "ga4", config: "not-a-measurement-id" },
    ])
    expect(parseEnabledScripts(raw)).toEqual([{ id: "plausible", config: "example.com" }])
  })
  it("returns [] for junk (byte-identical default)", () => {
    expect(parseEnabledScripts(null)).toEqual([])
    expect(parseEnabledScripts("nope")).toEqual([])
  })
  it("validates real config formats", () => {
    expect(parseEnabledScripts(JSON.stringify([{ id: "ga4", config: "G-ABC123XYZ" }]))).toHaveLength(1)
    expect(parseEnabledScripts(JSON.stringify([{ id: "crisp", config: "12345678-abcd-ef01-2345-6789abcdef01" }]))).toHaveLength(1)
  })
})

describe("checkScriptBudget (deploy-blocking covenant gate)", () => {
  it("passes light selections", () => {
    const r = checkScriptBudget([{ id: "plausible", config: "x.com" }])
    expect(r.ok).toBe(true)
    expect(r.totalKb).toBe(1)
  })

  // GUARDRAIL FIRES: a heavy selection is blocked with a plain-language report
  // that names the offenders and suggests the lighter alternative.
  it("blocks a selection over the budget with a plain-language report", () => {
    const heavy = [
      { id: "ga4", config: "G-ABC123XYZ" },      // 55
      { id: "crisp", config: "12345678-abcd-ef01-2345-6789abcdef01" }, // 35
      { id: "cookieyes", config: "abcdef123456" }, // 40 → 130 > 100
    ]
    const r = checkScriptBudget(heavy)
    expect(r.ok).toBe(false)
    expect(r.totalKb).toBe(130)
    expect(r.budgetKb).toBe(SCRIPT_BUDGET_KB)
    expect(r.report).toContain("BLOCKED")
    expect(r.report).toContain("Google Analytics 4")
    expect(r.report).toContain("Plausible")
  })
})

describe("cspAdditions", () => {
  it("returns empty additions for an empty set (byte-identical _headers)", () => {
    expect(cspAdditions([])).toEqual({ scriptSrc: [], connectSrc: [] })
  })
  it("collects deduped hosts for the enabled set", () => {
    const r = cspAdditions([
      { id: "ga4", config: "G-ABC123XYZ" },
      { id: "plausible", config: "x.com" },
    ])
    expect(r.scriptSrc).toContain("https://www.googletagmanager.com")
    expect(r.scriptSrc).toContain("https://plausible.io")
    expect(r.connectSrc).toContain("https://www.google-analytics.com")
  })
})

describe("weights", () => {
  it("sums catalog costs", () => {
    expect(totalScriptWeightKb([{ id: "ga4", config: "x" }, { id: "fathom", config: "x" }])).toBe(57)
    expect(catalogEntry("nope")).toBeNull()
  })
})
