// src/modules/seo/assist.test.ts — ✨ assists (V1.3) pure parts + guardrails.
import { describe, it, expect } from "vitest"
import { buildAssistPrompt, extractAssistText, ASSIST_LIMIT, ASSIST_MODEL } from "./assist"

describe("buildAssistPrompt", () => {
  it("builds meta prompts with truncated, tag-stripped content", () => {
    const p = buildAssistPrompt("meta_description", {
      title: "Espresso Guide", siteName: "BrewCraft",
      content: "<p>" + "words ".repeat(3000) + "</p>",
    })!
    expect(p.system).toContain("meta descriptions")
    expect(p.user).toContain("Espresso Guide")
    expect(p.user).not.toContain("<p>")
    expect(p.user.length).toBeLessThan(7000) // 6k cap + scaffolding
  })

  it("faq prompt demands grounded JSON output", () => {
    const p = buildAssistPrompt("faq", { content: "<p>Some article body.</p>" })!
    expect(p.system).toContain("JSON array")
    expect(p.system).toContain("never invent")
  })

  it("alt_text requires an image URL; meta requires some content", () => {
    expect(buildAssistPrompt("alt_text", {})).toBeNull()
    expect(buildAssistPrompt("meta_title", {})).toBeNull()
    expect(buildAssistPrompt("alt_text", { imageUrl: "https://x/img.jpg" })).not.toBeNull()
  })
})

describe("extractAssistText", () => {
  it("joins text blocks and trims", () => {
    expect(extractAssistText({ content: [{ type: "text", text: "  A great title  " }] })).toBe("A great title")
    expect(extractAssistText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("ab")
  })
  it("returns null for empty/malformed responses", () => {
    expect(extractAssistText(null)).toBeNull()
    expect(extractAssistText({})).toBeNull()
    expect(extractAssistText({ content: [] })).toBeNull()
    expect(extractAssistText({ content: [{ type: "tool_use" }] })).toBeNull()
  })
})

describe("assist policy constants", () => {
  // GUARDRAIL: the per-customer cap exists and is the agreed generous 60/hour;
  // the model is the small/fast tier (the spend is on the customer's key).
  it("rate limit is 60 per hour per customer", () => {
    expect(ASSIST_LIMIT.max).toBe(60)
    expect(ASSIST_LIMIT.windowSecs).toBe(3600)
  })
  it("uses the small model tier", () => {
    expect(ASSIST_MODEL).toContain("haiku")
  })
})
