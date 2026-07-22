import { describe, it, expect } from "vitest"
import { isValidSubdomainLabel, subdomainDomain, RESERVED_SUBDOMAIN_LABELS } from "./subsites"

describe("isValidSubdomainLabel", () => {
  it("accepts normal DNS labels", () => {
    for (const l of ["blog", "shop", "help-center", "a", "b2b", "x1"]) {
      expect(isValidSubdomainLabel(l)).toBe(true)
    }
  })
  it("is case-insensitive (lowercased)", () => {
    expect(isValidSubdomainLabel("Blog")).toBe(true)
  })
  it("rejects invalid shapes", () => {
    for (const l of ["", "-blog", "blog-", "blog.eu", "b*g", "b g", "a".repeat(64), "under_score"]) {
      expect(isValidSubdomainLabel(l)).toBe(false)
    }
  })
  it("rejects reserved labels", () => {
    for (const l of RESERVED_SUBDOMAIN_LABELS) expect(isValidSubdomainLabel(l)).toBe(false)
    expect(isValidSubdomainLabel("www")).toBe(false)
  })
})

describe("subdomainDomain", () => {
  it("composes the child host on the parent apex", () => {
    expect(subdomainDomain("blog", "example.com")).toBe("blog.example.com")
    expect(subdomainDomain("Shop", "Example.CO.UK")).toBe("shop.example.co.uk")
  })
  it("fails closed on bad label or bad parent", () => {
    expect(subdomainDomain("www", "example.com")).toBe("")
    expect(subdomainDomain("blog", "not-a-domain")).toBe("")
    expect(subdomainDomain("", "example.com")).toBe("")
  })
  it("won't duplicate the label onto a matching parent", () => {
    expect(subdomainDomain("blog", "blog.example.com")).toBe("")
  })
})
