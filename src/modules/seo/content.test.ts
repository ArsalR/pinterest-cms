// src/modules/seo/content.test.ts — content analysis (S2) + shared-rule guardrail.
import { describe, it, expect } from "vitest"
import { analyzeContent, imagesMissingAlt } from "./content"
import { DEFAULT_GATE_CONFIG } from "../quality-gate"

const longBody =
  "<p>" + "word ".repeat(400) + "</p><h2>A section</h2><p>More text with a <a href='/x'>link</a>.</p>"

describe("analyzeContent", () => {
  it("passes a substantial, well-formed post", () => {
    const a = analyzeContent({
      title: "A Complete Guide to Home Espresso",
      metaDescription: "Everything you need to pull a great espresso shot at home, step by step.",
      content: longBody,
    })
    expect(a.wouldPass).toBe(true)
    expect(a.score).toBeGreaterThan(70)
    expect(a.checks.find((c) => c.id === "word_count")?.status).toBe("good")
  })

  // GUARDRAIL FIRES (rail #5): the live analyzer uses the gate's OWN minWords,
  // so a thin post is flagged `bad` here exactly as the gate would block it.
  it("flags thin content using the gate's own threshold", () => {
    const a = analyzeContent({
      title: "Too short",
      metaDescription: "This description is definitely long enough to pass the meta check.",
      content: "<p>Just a few words here.</p>",
    })
    const wc = a.checks.find((c) => c.id === "word_count")!
    expect(wc.status).toBe("bad")
    expect(wc.detail).toContain(String(DEFAULT_GATE_CONFIG.minWords))
    expect(a.wouldPass).toBe(false)
  })

  it("flags a missing/short meta description with the gate's 20-char rule", () => {
    const a = analyzeContent({ title: "Fine title here", metaDescription: "short", content: longBody })
    expect(a.checks.find((c) => c.id === "meta_description")?.status).toBe("bad")
    expect(a.wouldPass).toBe(false)
  })

  it("flags images missing alt text", () => {
    const withImg = longBody + '<img src="/a.jpg"><img src="/b.jpg" alt="ok">'
    const a = analyzeContent({ title: "Has images and words", metaDescription: "A long enough description for the meta check to pass cleanly.", content: withImg })
    const img = a.checks.find((c) => c.id === "image_alt")!
    expect(img.status).toBe("bad")
    expect(img.detail).toContain("1 of 2")
  })

  it("unlocks keyword checks only when a focus keyword is set", () => {
    const base = { title: "Home Espresso Basics", metaDescription: "A long enough description for the meta check to pass cleanly here.", content: longBody }
    expect(analyzeContent(base).checks.some((c) => c.id.startsWith("kw_"))).toBe(false)
    const kw = analyzeContent({ ...base, focusKeyword: "espresso" })
    expect(kw.checks.some((c) => c.id === "kw_title")).toBe(true)
  })

  it("penalizes keyword stuffing as bad", () => {
    const stuffed = "<p>" + "espresso ".repeat(300) + "</p>"
    const a = analyzeContent({ title: "Espresso", metaDescription: "A long enough description for the meta check to pass cleanly here.", content: stuffed, focusKeyword: "espresso" })
    expect(a.checks.find((c) => c.id === "kw_density")?.status).toBe("bad")
  })
})

describe("imagesMissingAlt", () => {
  it("counts only images without a non-empty alt", () => {
    expect(imagesMissingAlt('<img src="a"><img src="b" alt=""><img src="c" alt="x">')).toBe(2)
    expect(imagesMissingAlt("<p>no images</p>")).toBe(0)
  })
})
