// src/modules/agency/agency.test.ts
// Pure-logic: white-label brand resolution/validation + monthly report builder
// and renderer (K11). Seat tokens + email/cron are I/O (Phase 10).

import { describe, it, expect } from "vitest"
import { resolveBrand, validateBrand, validLogo, DEFAULT_BRAND } from "./branding"
import { buildSiteReport, renderReportHtml, reportEmailSubject, type SiteMetrics } from "./reports"

describe("white-label branding (K11)", () => {
  it("returns defaults when disabled or empty", () => {
    expect(resolveBrand(null)).toEqual(DEFAULT_BRAND)
    expect(resolveBrand({ enabled: false, brand_name: "X" })).toEqual(DEFAULT_BRAND)
  })

  it("resolves a valid brand and falls back on bad fields", () => {
    const b = resolveBrand({ enabled: true, brand_name: "Acme SEO", brand_color: "#2563eb", logo_url: "https://a.com/l.png" })
    expect(b).toEqual({ name: "Acme SEO", color: "#2563eb", logoUrl: "https://a.com/l.png" })
    const bad = resolveBrand({ enabled: true, brand_name: "", brand_color: "blue", logo_url: "javascript:alert(1)" })
    expect(bad.name).toBe(DEFAULT_BRAND.name)
    expect(bad.color).toBe(DEFAULT_BRAND.color)
    expect(bad.logoUrl).toBeNull()
  })

  it("validLogo only accepts https image URLs", () => {
    expect(validLogo("https://a.com/x.png")).toBe("https://a.com/x.png")
    expect(validLogo("http://a.com/x.png")).toBeNull()
    expect(validLogo("javascript:alert(1)")).toBeNull()
    expect(validLogo(null)).toBeNull()
  })

  it("validateBrand rejects bad input", () => {
    expect(validateBrand("Acme", "#2563eb", "https://a.com/l.png")).toEqual({ ok: true })
    expect(validateBrand("", "#2563eb", "").ok).toBe(false)
    expect(validateBrand("Acme", "nothex", "").ok).toBe(false)
    expect(validateBrand("Acme", "", "ftp://x").ok).toBe(false)
  })
})

describe("monthly report (K11)", () => {
  const base: SiteMetrics = {
    siteName: "BrewCraft", domain: "brewcraft.com", clicks: 120, impressions: 4000,
    prevClicks: 100, cwv: { lcpMs: 1800, cls: 0.02, inpMs: 120 }, decayingPages: 2, affiliateClicks: 15,
  }

  it("computes a click delta and an up headline", () => {
    const r = buildSiteReport(base)
    expect(r.clicksDeltaPct).toBe(20)
    expect(r.headline).toMatch(/up 20%/)
    expect(r.cwvSummary).toContain("good")
  })

  it("handles no previous data and no cwv", () => {
    const r = buildSiteReport({ ...base, prevClicks: null, cwv: null })
    expect(r.clicksDeltaPct).toBeNull()
    expect(r.headline).toContain("120 search clicks")
    expect(r.cwvSummary).toContain("no data")
  })

  it("flags a click drop", () => {
    const r = buildSiteReport({ ...base, clicks: 60, prevClicks: 100 })
    expect(r.clicksDeltaPct).toBe(-40)
    expect(r.headline).toMatch(/down 40%/)
  })

  it("renders an escaped, branded report card", () => {
    const brand = { name: "Acme <SEO>", color: "#2563eb", logoUrl: null }
    const html = renderReportHtml(buildSiteReport(base), brand, "July 2026")
    expect(html).toContain("#2563eb")
    expect(html).toContain("Acme &lt;SEO&gt;") // escaped
    expect(html).toContain("BrewCraft")
    expect(html).toContain("120") // clicks
    expect(html).toContain("July 2026")
  })

  it("builds a branded email subject", () => {
    expect(reportEmailSubject({ name: "Acme", color: "#000", logoUrl: null }, "July 2026")).toBe("Acme — your July 2026 site report")
  })
})
