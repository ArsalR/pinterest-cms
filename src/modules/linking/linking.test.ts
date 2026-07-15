// src/modules/linking/linking.test.ts
import { describe, it, expect } from "vitest"
import { KeywordOverlapScorer, keywords, suggestLinks, type LinkDoc } from "./scorer"
import { internalLinkTargets, findOrphans, type LinkablePage } from "./orphans"

const doc = (id: string, title: string, text: string): LinkDoc => ({ id, title, slug: id, text })

describe("keywords", () => {
  it("lowercases, drops stopwords + short words, dedupes", () => {
    const k = keywords("The Quick Brown Fox is a fox")
    expect(k.has("quick")).toBe(true)
    expect(k.has("brown")).toBe(true)
    expect(k.has("fox")).toBe(true)
    expect(k.has("the")).toBe(false) // stopword
    expect(k.has("is")).toBe(false)  // stopword
    expect(k.has("a")).toBe(false)   // too short + stopword
  })
})

describe("KeywordOverlapScorer", () => {
  const scorer = new KeywordOverlapScorer()
  const espresso1 = doc("a", "Espresso grind size", "grind size tamping pressure extraction espresso")
  const espresso2 = doc("b", "Dialing in espresso", "espresso extraction grind pressure dialing")
  const gardening = doc("c", "Tomato planting guide", "tomato soil watering sunlight seedling garden")

  it("scores related docs higher than unrelated", () => {
    expect(scorer.score(espresso1, espresso2)).toBeGreaterThan(scorer.score(espresso1, gardening))
  })
  it("related() returns top-k, excludes self, sorts by score desc", () => {
    const rel = scorer.related(espresso1, [espresso1, espresso2, gardening], 5)
    expect(rel[0].doc.id).toBe("b")
    expect(rel.find((r) => r.doc.id === "a")).toBeUndefined() // excludes self
  })
  it("suggestLinks filters by threshold", () => {
    const s = suggestLinks(espresso1, [espresso2, gardening], scorer, 5, 0.9)
    expect(s.length).toBe(0) // nothing that similar
  })
})

describe("internalLinkTargets", () => {
  it("extracts same-site paths, skips external/anchor/mailto", () => {
    const html = `<a href="/posts/foo/">x</a> <a href="https://x.com">ext</a> <a href="#top">a</a> <a href="mailto:a@b.c">m</a> <a href="/bar">y</a>`
    const t = internalLinkTargets(html)
    expect(t).toContain("/posts/foo")
    expect(t).toContain("/bar")
    expect(t).not.toContain("https://x.com")
    expect(t.some((x) => x.includes("#top"))).toBe(false)
  })
})

describe("findOrphans (K5)", () => {
  const pages: LinkablePage[] = [
    { id: "1", slug: "home", title: "Home", content: '<a href="/posts/guide-a/">A</a>' },
    { id: "2", slug: "guide-a", title: "Guide A", content: '<a href="/posts/guide-b/">B</a>' },
    { id: "3", slug: "guide-b", title: "Guide B", content: "no links here" },
    { id: "4", slug: "lonely", title: "Lonely", content: "nobody links to me" },
  ]
  it("flags pages with no inbound internal links", () => {
    const orphans = findOrphans(pages)
    const slugs = orphans.map((o) => o.slug)
    expect(slugs).toContain("lonely")   // linked by nobody
    expect(slugs).toContain("home")     // nobody links to home in this set
    expect(slugs).not.toContain("guide-a") // linked from home
    expect(slugs).not.toContain("guide-b") // linked from guide-a
  })
})
