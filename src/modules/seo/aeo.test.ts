// src/modules/seo/aeo.test.ts — AI-SEO profile (V1.3 P5) pure parts.
import { describe, it, expect } from "vitest"
import {
  tldrBlockHtml, definitionBlockHtml, statBlockHtml,
  extractAeoBlocks, definedTermsLd, analyzeAiVisibility,
} from "./aeo"

const NOW = Date.parse("2026-07-18T12:00:00Z")

describe("block builders → extractors round-trip", () => {
  it("TL;DR builds and extracts", () => {
    const html = tldrBlockHtml(["Point one", "Point two", ""])
    const b = extractAeoBlocks(`<p>intro</p>${html}<p>rest</p>`)
    expect(b.tldr).toEqual(["Point one", "Point two"])
  })
  it("definitions build, extract, and emit DefinedTerm", () => {
    const html = definitionBlockHtml("Espresso", "Coffee brewed under ~9 bar of pressure.")
    const b = extractAeoBlocks(html)
    expect(b.definitions).toEqual([{ term: "Espresso", definition: "Coffee brewed under ~9 bar of pressure." }])
    const ld = definedTermsLd(b) as Array<Record<string, unknown>>
    expect(ld[0]["@type"]).toBe("DefinedTerm")
    expect(ld[0].name).toBe("Espresso")
  })
  it("stats require a source link to count", () => {
    const withSrc = statBlockHtml("73% of shots fail from bad grind.", "SCA", "https://sca.coffee/report")
    expect(extractAeoBlocks(withSrc).stats).toHaveLength(1)
    expect(extractAeoBlocks('<div class="aeo-stat"><p>73% of shots fail.</p></div>').stats).toHaveLength(0)
  })
  it("escapes builder input (no markup smuggling)", () => {
    expect(tldrBlockHtml(['<script>x</script>'])).not.toContain("<script>")
  })
})

describe("analyzeAiVisibility (the checklist)", () => {
  const base = {
    title: "T",
    excerpt: "A tight, quotable summary of the whole article in one clean sentence.",
    content: "<h2>How does espresso work?</h2><p>" + "words ".repeat(100) + "</p>",
    hasAuthor: true,
    updatedAt: "2026-07-01T00:00:00Z",
    nowMs: NOW,
  }
  it("all-good post passes every check", () => {
    const checks = analyzeAiVisibility(base)
    expect(checks.every((c) => c.status === "good")).toBe(true)
    expect(checks.map((c) => c.id)).toEqual(["quotable_summary", "question_headings", "stats_sourced", "author", "fresh"])
  })
  // GUARDRAIL: each degraded signal is flagged with a plain-language fix.
  it("flags missing summary, unsourced stats, missing author, stale dates", () => {
    const bad = analyzeAiVisibility({
      ...base,
      excerpt: "",
      content: "<h2>Espresso notes</h2><p>Sales grew 45% this year according to nobody.</p>",
      hasAuthor: false,
      updatedAt: "2024-01-01T00:00:00Z",
    })
    const byId = new Map(bad.map((c) => [c.id, c]))
    expect(byId.get("quotable_summary")!.status).toBe("warn")
    expect(byId.get("stats_sourced")!.status).toBe("warn")
    expect(byId.get("stats_sourced")!.detail).toContain("without a linked source")
    expect(byId.get("author")!.status).toBe("warn")
    expect(byId.get("fresh")!.status).toBe("warn")
  })
  it("doesn't nag about stats when there are no numbers", () => {
    const c = analyzeAiVisibility({ ...base, content: "<p>Just prose, no figures at all.</p>" })
    expect(c.find((x) => x.id === "stats_sourced")!.status).toBe("good")
  })
})
