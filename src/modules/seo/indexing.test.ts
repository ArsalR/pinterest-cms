// src/modules/seo/indexing.test.ts — indexing ops (S5) + deindex-watch guardrail.
import { describe, it, expect } from "vitest"
import { diagnoseInspection, indexCoverage, inspectDeepLink, DEINDEX_COVERAGE_FLOOR } from "./indexing"

describe("diagnoseInspection", () => {
  it("recognizes an indexed page", () => {
    const d = diagnoseInspection({ verdict: "PASS", coverageState: "Submitted and indexed" })
    expect(d.status).toBe("indexed")
    expect(d.indexed).toBe(true)
    expect(d.recommendation).toBe("")
  })

  it("classifies a noindex exclusion ahead of the bare 'indexed' substring", () => {
    const d = diagnoseInspection({ verdict: "NEUTRAL", coverageState: "Excluded by 'noindex' tag" })
    expect(d.status).toBe("excluded_noindex")
    expect(d.indexed).toBe(false)
    expect(d.recommendation).toMatch(/No-index/i)
  })

  it("maps crawled-not-indexed, blocked, canonical, and errors", () => {
    expect(diagnoseInspection({ verdict: "NEUTRAL", coverageState: "Crawled - currently not indexed" }).status).toBe("not_indexed")
    expect(diagnoseInspection({ verdict: "FAIL", coverageState: "Blocked by robots.txt" }).status).toBe("blocked")
    expect(diagnoseInspection({ verdict: "NEUTRAL", coverageState: "Duplicate without user-selected canonical" }).status).toBe("excluded_canonical")
    expect(diagnoseInspection({ verdict: "FAIL", coverageState: "Not found (404)" }).status).toBe("error")
    expect(diagnoseInspection({ verdict: "NEUTRAL", coverageState: "URL is unknown to Google" }).status).toBe("unknown")
  })
})

describe("indexCoverage (deindex watch)", () => {
  it("reports full coverage and no risk when everything is indexed", () => {
    const c = indexCoverage([{ submitted: 50, indexed: 50 }])
    expect(c.coverage).toBe(1)
    expect(c.deindexRisk).toBe(false)
  })

  it("does not flag tiny samples (avoids noise on brand-new sites)", () => {
    const c = indexCoverage([{ submitted: 4, indexed: 0 }])
    expect(c.deindexRisk).toBe(false)
  })

  // GUARDRAIL FIRES (rail #5): a large coverage drop is the deindex signal —
  // usually an accidental sitewide noindex/robots block or a broken deploy.
  it("flags a deindex event when coverage falls below the floor", () => {
    const c = indexCoverage([{ submitted: 100, indexed: 40 }])
    expect(c.coverage).toBeCloseTo(0.4)
    expect(c.coverage).toBeLessThan(DEINDEX_COVERAGE_FLOOR)
    expect(c.deindexRisk).toBe(true)
  })

  it("sums across multiple sitemaps", () => {
    const c = indexCoverage([{ submitted: 60, indexed: 55 }, { submitted: 40, indexed: 40 }])
    expect(c.submitted).toBe(100)
    expect(c.indexed).toBe(95)
    expect(c.deindexRisk).toBe(false)
  })
})

describe("inspectDeepLink", () => {
  it("builds a Search Console inspect URL", () => {
    const u = inspectDeepLink("sc-domain:example.com", "https://example.com/posts/x/")
    expect(u).toContain("search-console/inspect")
    expect(u).toContain(encodeURIComponent("sc-domain:example.com"))
    expect(u).toContain(encodeURIComponent("https://example.com/posts/x/"))
  })
})
