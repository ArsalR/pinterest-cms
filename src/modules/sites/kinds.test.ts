// src/modules/sites/kinds.test.ts
// Pure-logic tests for site kinds (amendment 2) + kind-aware genesis.

import { describe, it, expect } from "vitest"
import { isSiteKind, SITE_KINDS, SITE_KIND_LABELS } from "../../shared/masterMigrate"
import { genesisPrompt } from "./prompts"

describe("site kinds", () => {
  it("recognizes the four launch kinds and nothing else", () => {
    for (const k of ["content", "ecommerce", "local-business", "portfolio"]) {
      expect(isSiteKind(k), k).toBe(true)
    }
    for (const bad of ["", "shop", "blog", "CONTENT", "e-commerce"]) {
      expect(isSiteKind(bad), bad).toBe(false)
    }
  })
  it("every kind has a human label", () => {
    for (const k of SITE_KINDS) expect(SITE_KIND_LABELS[k]).toBeTruthy()
  })
})

describe("genesisPrompt is kind-aware", () => {
  it("content: topical map of pillars + supporting articles", () => {
    const p = genesisPrompt("BrewCraft", "home espresso", "content")
    expect(p).toMatch(/pillar/i)
    expect(p).toContain("content site")
    expect(p).not.toMatch(/cart|checkout/i)
  })
  it("ecommerce: buying guides + explicit 'no cart/checkout UI yourself'", () => {
    const p = genesisPrompt("GearShop", "camping gear", "ecommerce")
    expect(p).toContain("online store")
    expect(p).toMatch(/buying guides|how-to/i)
    expect(p).toMatch(/do not add a cart or checkout/i) // commerce UI is platform-provided
  })
  it("local-business: service pages + local SEO", () => {
    const p = genesisPrompt("Acme Plumbing", "plumbing in Austin", "local-business")
    expect(p).toMatch(/service pages/i)
    expect(p).toMatch(/local[- ]?seo/i)
  })
  it("portfolio: case studies", () => {
    const p = genesisPrompt("Jane Doe", "brand design", "portfolio")
    expect(p).toMatch(/case[- ]study|project/i)
  })
  it("all kinds keep the shared covenant guardrails", () => {
    for (const k of SITE_KINDS) {
      const p = genesisPrompt("X", "y", k)
      expect(p).toMatch(/protected files/i)
      expect(p).toMatch(/ZERO client JavaScript/i)
      expect(p).toMatch(/CMS API/)
    }
  })
  it("unknown kind falls back to content behavior", () => {
    expect(genesisPrompt("X", "y", "nonsense")).toContain("content site")
  })
})
