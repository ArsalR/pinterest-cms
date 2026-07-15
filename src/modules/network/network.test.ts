// src/modules/network/network.test.ts
// Pure-logic tests for the network brain: GSC helpers (scopes, auth-URL,
// property URL, row summary), the decay radar (K4), and the AEO checklist (K8).
// The best-effort I/O (OAuth exchange, searchAnalytics fetch) is Phase-10
// mocked-integration territory — not exercised here.

import { describe, it, expect } from "vitest"
import { GSC_SCOPES, gscAuthUrl, siteUrlForDomain, summarizeRows, type SearchRow } from "./gsc"
import { detectDecay, decayedPages, DEFAULT_DECAY_CONFIG, type PageClicks } from "./decay"
import { evaluateAeo, extractHeadings, questionHeadings, hasList, type AeoPost } from "./aeo"

describe("GSC pure helpers", () => {
  it("requests both readonly and writable webmasters scopes", () => {
    expect(GSC_SCOPES).toContain("https://www.googleapis.com/auth/webmasters.readonly")
    expect(GSC_SCOPES).toContain("https://www.googleapis.com/auth/webmasters")
  })

  it("builds a consent URL with offline access + forced consent + state", () => {
    const u = new URL(gscAuthUrl("client-123", "https://arsal.app/app/connections/gsc/callback", "state-abc"))
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(u.searchParams.get("client_id")).toBe("client-123")
    expect(u.searchParams.get("access_type")).toBe("offline")
    expect(u.searchParams.get("prompt")).toBe("consent")
    expect(u.searchParams.get("state")).toBe("state-abc")
    expect(u.searchParams.get("redirect_uri")).toBe("https://arsal.app/app/connections/gsc/callback")
  })

  it("maps a domain to a GSC domain property, stripping scheme + trailing slash", () => {
    expect(siteUrlForDomain("example.com")).toBe("sc-domain:example.com")
    expect(siteUrlForDomain("https://example.com/")).toBe("sc-domain:example.com")
  })

  it("summarizes rows with CTR recomputed from totals, not averaged", () => {
    const rows: SearchRow[] = [
      { keys: ["a"], clicks: 10, impressions: 100, ctr: 0.1, position: 3 },
      { keys: ["b"], clicks: 30, impressions: 100, ctr: 0.3, position: 5 },
    ]
    const s = summarizeRows(rows)
    expect(s.clicks).toBe(40)
    expect(s.impressions).toBe(200)
    expect(s.ctr).toBeCloseTo(0.2) // 40/200, not (0.1+0.3)/2
  })

  it("summarizes empty rows without dividing by zero", () => {
    expect(summarizeRows([])).toEqual({ clicks: 0, impressions: 0, ctr: 0 })
  })
})

describe("decay radar (K4)", () => {
  const page = (p: string, clicks: number, position = 5): PageClicks => ({ page: p, clicks, impressions: clicks * 10, position })

  it("flags a large drop above the noise floor as decayed", () => {
    const recent = [page("/a", 40)]
    const prior = [page("/a", 100)]
    const [r] = detectDecay(recent, prior)
    expect(r.status).toBe("decayed") // 60% drop ≥ 0.5
    expect(r.dropRatio).toBeCloseTo(0.6)
  })

  it("flags a moderate drop as slipping", () => {
    const [r] = detectDecay([page("/a", 70)], [page("/a", 100)])
    expect(r.status).toBe("slipping") // 30% drop, between 0.25 and 0.5
  })

  it("ignores drops below the prior-clicks noise floor", () => {
    const [r] = detectDecay([page("/a", 1)], [page("/a", 5)]) // 80% drop but only 5 prior clicks
    expect(r.status).toBe("stable")
  })

  it("marks a rising page as growing", () => {
    const [r] = detectDecay([page("/a", 200)], [page("/a", 100)])
    expect(r.status).toBe("growing")
    expect(r.dropRatio).toBeLessThan(0)
  })

  it("treats a brand-new page (no prior) as growing, not decayed", () => {
    const [r] = detectDecay([page("/new", 50)], [])
    expect(r.status).toBe("growing")
  })

  it("sorts decayed pages first and decayedPages() filters to actionable ones", () => {
    const reports = detectDecay(
      [page("/keep", 210), page("/slip", 70), page("/dead", 20)],
      [page("/keep", 200), page("/slip", 100), page("/dead", 100)]
    )
    expect(reports[0].status).toBe("decayed") // worst first
    const actionable = decayedPages(reports)
    expect(actionable.map((r) => r.page).sort()).toEqual(["/dead", "/slip"])
  })

  it("computes position delta (positive = fell in rankings)", () => {
    const [r] = detectDecay([page("/a", 60, 9)], [page("/a", 100, 4)])
    expect(r.positionDelta).toBeCloseTo(5)
  })

  it("respects a custom config", () => {
    const strict = { ...DEFAULT_DECAY_CONFIG, decayedDrop: 0.9 }
    const [r] = detectDecay([page("/a", 40)], [page("/a", 100)], strict)
    expect(r.status).toBe("slipping") // 60% no longer clears the 90% decayed bar
  })
})

describe("AEO checklist (K8)", () => {
  const now = Date.parse("2026-07-15T00:00:00Z")

  it("extracts headings and identifies question-style ones", () => {
    const html = "<h2>How does it work?</h2><p>...</p><h3>Overview</h3><h2>What is X</h2>"
    const headings = extractHeadings(html)
    expect(headings).toEqual(["How does it work?", "Overview", "What is X"])
    expect(questionHeadings(headings)).toEqual(["How does it work?", "What is X"])
  })

  it("detects extractable lists", () => {
    expect(hasList("<ul><li>a</li></ul>")).toBe(true)
    expect(hasList("<p>no list here</p>")).toBe(false)
  })

  const strongPost: AeoPost = {
    title: "How to brew great espresso at home",
    metaDescription: "A practical guide to pulling better espresso shots at home, covering grind, dose, and pressure in plain terms.",
    excerpt: "Everything you need to pull a better shot: grind size, dose, and pressure explained simply for beginners.",
    contentHtml:
      "<p>Intro paragraph that answers up front.</p>" +
      "<h2>What grind size should I use?</h2><p>" + "word ".repeat(200) + "</p>" +
      "<h2>How much coffee per shot?</h2><ul><li>Single: 9g</li><li>Double: 18g</li></ul>" +
      "<p>" + "more ".repeat(220) + "</p>",
    updatedAt: "2026-06-01T00:00:00Z",
  }

  it("scores a strong, fresh, question-structured post as AI-citation ready", () => {
    const r = evaluateAeo(strongPost, now)
    expect(r.passed).toBe(true)
    expect(r.score).toBeGreaterThanOrEqual(70)
    expect(r.checks.find((c) => c.id === "questions")!.passed).toBe(true)
    expect(r.checks.find((c) => c.id === "lists")!.passed).toBe(true)
  })

  it("fails a thin, stale, structureless post and returns actionable hints", () => {
    const weak: AeoPost = {
      title: "espresso",
      metaDescription: "short",
      excerpt: "",
      contentHtml: "<p>Too little to cite.</p>",
      updatedAt: "2023-01-01T00:00:00Z",
    }
    const r = evaluateAeo(weak, now)
    expect(r.passed).toBe(false)
    const failed = r.checks.filter((c) => !c.passed).map((c) => c.id)
    expect(failed).toEqual(expect.arrayContaining(["meta", "depth", "questions", "freshness"]))
    for (const c of r.checks.filter((c) => !c.passed)) expect(c.hint.length).toBeGreaterThan(0)
  })

  it("flags a stale post specifically on freshness", () => {
    const stale = { ...strongPost, updatedAt: "2024-01-01T00:00:00Z" }
    const r = evaluateAeo(stale, now)
    expect(r.checks.find((c) => c.id === "freshness")!.passed).toBe(false)
  })

  it("handles a null updatedAt as failing freshness (never throws)", () => {
    const r = evaluateAeo({ ...strongPost, updatedAt: null }, now)
    expect(r.checks.find((c) => c.id === "freshness")!.passed).toBe(false)
  })
})
