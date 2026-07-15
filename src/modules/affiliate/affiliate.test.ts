// src/modules/affiliate/affiliate.test.ts
// Pure-logic: affiliate link detection, audit, and the compliance rewrite (K10).

import { describe, it, expect } from "vitest"
import {
  isAffiliateHref, auditLinks, rewriteAffiliateLinks, hasDisclosure,
  DEFAULT_DISCLOSURE, DISCLOSURE_CLASS, type AffiliateConfig,
} from "./links"
import { parseDomains } from "./service"

const config: AffiliateConfig = { affiliateDomains: ["amazon.com", "amzn.to"], disclosureText: "We earn commissions." }

describe("affiliate link detection", () => {
  it("matches configured domains and subdomains, ignores others", () => {
    expect(isAffiliateHref("https://www.amazon.com/dp/123", config.affiliateDomains)).toBe(true)
    expect(isAffiliateHref("https://smile.amazon.com/x", config.affiliateDomains)).toBe(true)
    expect(isAffiliateHref("https://amzn.to/abc", config.affiliateDomains)).toBe(true)
    expect(isAffiliateHref("https://example.com/x", config.affiliateDomains)).toBe(false)
    expect(isAffiliateHref("not-a-url", config.affiliateDomains)).toBe(false)
  })
})

describe("auditLinks", () => {
  it("flags non-compliant affiliate links and treats non-affiliate as fine", () => {
    const html = `
      <a href="https://amazon.com/dp/1">buy</a>
      <a href="https://amazon.com/dp/2" rel="sponsored nofollow">ok</a>
      <a href="https://example.com/blog">internal</a>`
    const links = auditLinks(html, config)
    const aff = links.filter((l) => l.isAffiliate)
    expect(aff).toHaveLength(2)
    expect(aff.find((l) => l.href.endsWith("/1"))!.compliant).toBe(false)
    expect(aff.find((l) => l.href.endsWith("/2"))!.compliant).toBe(true)
    expect(links.find((l) => l.href.includes("example.com"))!.compliant).toBe(true)
  })

  it("skips anchors, mailto, tel", () => {
    expect(auditLinks(`<a href="#top">x</a><a href="mailto:a@b.c">m</a>`, config)).toHaveLength(0)
  })
})

describe("rewriteAffiliateLinks", () => {
  it("adds rel + target + a disclosure to a page with a bare affiliate link", () => {
    const out = rewriteAffiliateLinks(`<p>Try <a href="https://amazon.com/dp/1">this</a>.</p>`, config)
    expect(out.linksFixed).toBe(1)
    expect(out.disclosureAdded).toBe(true)
    expect(out.html).toMatch(/rel="[^"]*sponsored[^"]*"/)
    expect(out.html).toMatch(/rel="[^"]*nofollow[^"]*"/)
    expect(out.html).toContain('target="_blank"')
    expect(out.html).toContain(DISCLOSURE_CLASS)
    expect(out.html).toContain("We earn commissions.")
  })

  it("preserves existing rel tokens while adding the required ones", () => {
    const out = rewriteAffiliateLinks(`<a href="https://amazon.com/x" rel="noopener external">x</a>`, config)
    const rel = /rel="([^"]*)"/.exec(out.html)![1]
    expect(rel).toContain("external")
    expect(rel).toContain("sponsored")
    expect(rel).toContain("nofollow")
  })

  it("is idempotent — a second pass changes nothing", () => {
    const once = rewriteAffiliateLinks(`<p><a href="https://amazon.com/x">x</a></p>`, config)
    const twice = rewriteAffiliateLinks(once.html, config)
    expect(twice.linksFixed).toBe(0)
    expect(twice.disclosureAdded).toBe(false)
    expect(twice.html).toBe(once.html)
  })

  it("leaves non-affiliate links and pages untouched", () => {
    const html = `<p><a href="https://example.com/x">x</a></p>`
    const out = rewriteAffiliateLinks(html, config)
    expect(out.linksFixed).toBe(0)
    expect(out.disclosureAdded).toBe(false)
    expect(out.html).toBe(html)
  })

  it("falls back to the default disclosure text when none is configured", () => {
    const out = rewriteAffiliateLinks(`<a href="https://amzn.to/x">x</a>`, { affiliateDomains: ["amzn.to"], disclosureText: "" })
    expect(out.html).toContain(DEFAULT_DISCLOSURE)
  })

  it("hasDisclosure detects the injected banner", () => {
    const out = rewriteAffiliateLinks(`<a href="https://amazon.com/x">x</a>`, config)
    expect(hasDisclosure(out.html)).toBe(true)
    expect(hasDisclosure("<p>nothing</p>")).toBe(false)
  })
})

describe("parseDomains", () => {
  it("splits, strips scheme/path/www, lowercases", () => {
    expect(parseDomains("https://www.Amazon.com/dp\namzn.to, Example.com/ref")).toEqual(["amazon.com", "amzn.to", "example.com"])
  })
  it("drops blanks", () => {
    expect(parseDomains("\n, ,")).toEqual([])
  })
})
