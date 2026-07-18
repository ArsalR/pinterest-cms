// src/modules/seo/analyze.test.ts
import { describe, it, expect } from "vitest"
import {
  pixelWidth, truncateToPixels, serpPreview, socialPreview, faqToJsonLd,
  slugify, isValidSlug, isSchemaType, computeRobots, SERP_TITLE_PX, type PostSeoInput,
} from "./analyze"

const base: PostSeoInput = {
  title: "Home Espresso Guide", excerpt: "Everything about pulling a great shot at home.",
  metaTitle: null, metaDescription: null, ogTitle: null, ogDescription: null, ogImage: null, coverImage: null,
}

describe("pixel width + truncation", () => {
  it("wider strings measure wider; truncation only past the budget", () => {
    expect(pixelWidth("WWWW")).toBeGreaterThan(pixelWidth("iiii"))
    const short = truncateToPixels("Short title", SERP_TITLE_PX)
    expect(short.truncated).toBe(false)
    const long = truncateToPixels("W".repeat(120), SERP_TITLE_PX)
    expect(long.truncated).toBe(true)
    expect(long.text.endsWith("…")).toBe(true)
    expect(long.px).toBeLessThanOrEqual(SERP_TITLE_PX)
  })
})

describe("serpPreview fallbacks", () => {
  it("falls back to '<title> — <site>' and excerpt when no meta set", () => {
    const s = serpPreview(base, "BrewCraft", "brewcraft.com/guide")
    expect(s.title.full).toBe("Home Espresso Guide — BrewCraft")
    expect(s.description.full).toContain("great shot")
  })
  it("uses the meta overrides when present", () => {
    const s = serpPreview({ ...base, metaTitle: "Custom Title", metaDescription: "Custom desc" }, "BrewCraft", "u")
    expect(s.title.full).toBe("Custom Title")
    expect(s.description.full).toBe("Custom desc")
  })
})

describe("socialPreview fallback chain", () => {
  it("og → meta → post title; image og → cover → null", () => {
    expect(socialPreview(base, "S").title).toBe("Home Espresso Guide")
    expect(socialPreview({ ...base, metaTitle: "M", ogTitle: "O" }, "S").title).toBe("O")
    expect(socialPreview({ ...base, coverImage: "c.jpg" }, "S").image).toBe("c.jpg")
    expect(socialPreview({ ...base, coverImage: "c.jpg", ogImage: "o.jpg" }, "S").image).toBe("o.jpg")
    expect(socialPreview(base, "S").image).toBeNull()
  })
})

describe("faqToJsonLd", () => {
  it("builds FAQPage from valid pairs, null when none", () => {
    expect(faqToJsonLd([])).toBeNull()
    expect(faqToJsonLd([{ question: "", answer: "x" }])).toBeNull()
    const jsonld = faqToJsonLd([{ question: "How?", answer: "Like this." }]) as { "@type": string; mainEntity: unknown[] }
    expect(jsonld["@type"]).toBe("FAQPage")
    expect(jsonld.mainEntity).toHaveLength(1)
  })
})

describe("slug + schema type", () => {
  it("slugify + validate", () => {
    expect(slugify("Hello, World!")).toBe("hello-world")
    expect(isValidSlug("good-slug-2")).toBe(true)
    expect(isValidSlug("Bad Slug")).toBe(false)
    expect(isValidSlug("-leading")).toBe(false)
    expect(isValidSlug("double--hyphen")).toBe(false)
  })
  it("schema types are a closed set", () => {
    expect(isSchemaType("FAQ")).toBe(true)
    expect(isSchemaType("Nonsense")).toBe(false)
  })
})

describe("computeRobots (byte-identical rail)", () => {
  // Safety rail #3: an untouched post (both toggles absent/false) must emit NO
  // robots meta — null here — so the built page is byte-identical to today's.
  it("returns null when both flags are absent or false", () => {
    expect(computeRobots()).toBeNull()
    expect(computeRobots(false, false)).toBeNull()
    expect(computeRobots(undefined, undefined)).toBeNull()
  })
  it("composes only the directives that are set", () => {
    expect(computeRobots(true, false)).toBe("noindex")
    expect(computeRobots(false, true)).toBe("nofollow")
    expect(computeRobots(true, true)).toBe("noindex, nofollow")
  })
})
