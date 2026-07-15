// src/modules/quality-gate/gate.test.ts
// Flagship suite — the quality gate is the product's moat (K2). Pure logic,
// exhaustively tested: thin content, duplicate titles, near-duplicate content,
// missing meta, unique-data requirements, and the full pass/fail decision.

import { describe, it, expect } from "vitest"
import {
  checkGate, wordCount, stripHtml, shingles, jaccard, maxContentSimilarity,
  DEFAULT_GATE_CONFIG, type GateItem,
} from "./gate"

const lorem = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 40}`).join(" ")

function itemWith(overrides: Partial<GateItem> = {}): GateItem {
  return {
    title: "A Genuinely Useful Guide to Cold Brew",
    meta: "Everything you need to make great cold brew at home, step by step.",
    content: `<p>${lorem(400)}</p>`,
    ...overrides,
  }
}

describe("text helpers", () => {
  it("stripHtml removes tags, scripts, styles, entities", () => {
    expect(stripHtml("<p>Hello <b>world</b></p><script>evil()</script>")).toBe("Hello world")
    expect(stripHtml("a &amp; b")).toBe("a b")
  })
  it("wordCount counts words in stripped text", () => {
    expect(wordCount("<p>one two three</p>")).toBe(3)
    expect(wordCount("")).toBe(0)
  })
  it("jaccard: identical=1, disjoint=0, partial in between", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1)
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0)
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "c"]))).toBeCloseTo(1 / 3)
  })
  it("shingles produces k-word windows", () => {
    expect(shingles("the quick brown fox", 3)).toEqual(new Set(["the quick brown", "quick brown fox"]))
  })
  it("maxContentSimilarity finds the closest corpus match", () => {
    const item = itemWith({ content: "the quick brown fox jumps" })
    const corpus = [itemWith({ content: "totally different text here" }), itemWith({ content: "the quick brown fox jumps" })]
    expect(maxContentSimilarity(item, corpus, 3)).toBe(1)
  })
})

describe("checkGate — passing case", () => {
  it("a substantial, unique, well-formed post passes against an empty site", () => {
    const r = checkGate(itemWith(), [])
    expect(r.passed).toBe(true)
    expect(r.score).toBe(100)
  })
})

describe("checkGate — thin content blocker", () => {
  it("fails a too-short post", () => {
    const r = checkGate(itemWith({ content: "<p>Too short.</p>" }), [])
    expect(r.passed).toBe(false)
    expect(r.checks.find((c) => c.id === "word_count")?.passed).toBe(false)
  })
})

describe("checkGate — title checks", () => {
  it("fails a missing title", () => {
    const r = checkGate(itemWith({ title: "" }), [])
    expect(r.checks.find((c) => c.id === "title")?.passed).toBe(false)
  })
  it("fails a title that duplicates an existing page", () => {
    const corpus = [itemWith({ title: "A Genuinely Useful Guide to Cold Brew" })]
    const r = checkGate(itemWith({ title: "A Genuinely Useful Guide to Cold Brew", content: `<p>${lorem(500)} extra unique words zzz</p>` }), corpus)
    expect(r.checks.find((c) => c.id === "title")?.passed).toBe(false)
  })
})

describe("checkGate — meta requirement", () => {
  it("fails missing or too-short meta", () => {
    expect(checkGate(itemWith({ meta: "" }), []).checks.find((c) => c.id === "meta")?.passed).toBe(false)
    expect(checkGate(itemWith({ meta: "short" }), []).checks.find((c) => c.id === "meta")?.passed).toBe(false)
  })
})

describe("checkGate — unique-content ratio (the anti-spam core)", () => {
  it("fails a near-duplicate of an existing page", () => {
    const body = `<p>${lorem(400)}</p>`
    const corpus = [itemWith({ title: "Different Title Entirely", content: body })]
    const r = checkGate(itemWith({ title: "Another Different Title", content: body }), corpus)
    expect(r.checks.find((c) => c.id === "unique_content")?.passed).toBe(false)
    expect(r.passed).toBe(false)
  })
  it("passes genuinely distinct content even on a populated site", () => {
    const corpus = [itemWith({ title: "Cold Brew Basics", content: `<p>${lorem(400)}</p>` })]
    const distinct = Array.from({ length: 400 }, (_, i) => `espresso${i % 37} tamping pressure grind`).join(" ")
    const r = checkGate(itemWith({ title: "Dialing In Espresso Extraction", content: `<p>${distinct}</p>` }), corpus)
    expect(r.checks.find((c) => c.id === "unique_content")?.passed).toBe(true)
  })
})

describe("checkGate — programmatic unique-data (K2)", () => {
  const cfg = { ...DEFAULT_GATE_CONFIG, minUniqueDataFields: 3 }
  it("fails a programmatic page with too little unique data", () => {
    const r = checkGate(itemWith({ uniqueData: { city: "Austin", pop: "" } }), [], cfg)
    expect(r.checks.find((c) => c.id === "unique_data")?.passed).toBe(false)
  })
  it("passes when enough unique data fields are present", () => {
    const r = checkGate(itemWith({ uniqueData: { city: "Austin", pop: "961k", zip: "78701", founded: "1839" } }), [], cfg)
    expect(r.checks.find((c) => c.id === "unique_data")?.passed).toBe(true)
  })
  it("does not run the unique-data check when not configured (default)", () => {
    const r = checkGate(itemWith(), [])
    expect(r.checks.find((c) => c.id === "unique_data")).toBeUndefined()
  })
})

describe("checkGate — decision is all-or-nothing", () => {
  it("passed is true only when every check passes", () => {
    const r = checkGate(itemWith(), [])
    expect(r.passed).toBe(r.checks.every((c) => c.passed))
  })
  it("one failing check fails the whole gate", () => {
    const r = checkGate(itemWith({ meta: "" }), [])
    expect(r.passed).toBe(false)
  })
})
