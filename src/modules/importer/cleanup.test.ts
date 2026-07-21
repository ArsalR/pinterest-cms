// Pure-logic tests for the imported-content cleanup (K9 follow-up).
import { describe, it, expect } from "vitest"
import {
  stripWpArtifacts, countArtifacts,
  buildCleanupPrompt, extractCleanedHtml, cleanupIsSafe,
} from "./cleanup"

describe("stripWpArtifacts (deterministic)", () => {
  it("removes Gutenberg block comments but keeps the content", () => {
    const out = stripWpArtifacts(`<!-- wp:paragraph --><p>Hello world</p><!-- /wp:paragraph -->`)
    expect(out).toBe("<p>Hello world</p>")
  })

  it("strips shortcodes (with attributes, closing tags, known builders) but keeps inner content", () => {
    const out = stripWpArtifacts(`[caption id="a" width="300"]<img src="x.jpg">A photo[/caption]`)
    expect(out).toContain(`<img src="x.jpg">`)
    expect(out).toContain("A photo")
    expect(out).not.toContain("[caption")
    expect(out).not.toContain("[/caption]")
  })

  it("removes Divi/VC builder shortcodes", () => {
    const out = stripWpArtifacts(`[et_pb_section][et_pb_row]<p>Real text</p>[/et_pb_row][/et_pb_section]`)
    expect(out).toBe("<p>Real text</p>")
  })

  it("does NOT eat citation markers like [1]", () => {
    const out = stripWpArtifacts(`<p>As shown [1] and [2], this holds.</p>`)
    expect(out).toContain("[1]")
    expect(out).toContain("[2]")
  })

  it("removes empty and nbsp-only paragraphs", () => {
    const out = stripWpArtifacts(`<p>Keep</p><p>&nbsp;</p><p>  </p><p><br></p>`)
    expect(out).toBe("<p>Keep</p>")
  })

  it("leaves already-clean content unchanged", () => {
    const clean = `<h2>Title</h2>\n<p>Body with a <a href="/x">link</a>.</p>`
    expect(stripWpArtifacts(clean)).toBe(clean)
  })
})

describe("countArtifacts", () => {
  it("counts debris and ignores [n] citations", () => {
    const c = countArtifacts(`<!-- wp:x -->[gallery ids="1,2"]<p style="color:red">a</p><p></p>[1]`)
    expect(c.blockComments).toBe(1)
    expect(c.shortcodes).toBe(1) // gallery, not [1]
    expect(c.inlineStyles).toBe(1)
    expect(c.emptyParas).toBe(1)
  })
})

describe("AI cleanup helpers", () => {
  it("prompt carries the content and forbids inventing/deleting", () => {
    const p = buildCleanupPrompt("<p>hi</p>")
    expect(p.user).toContain("<p>hi</p>")
    expect(p.system).toContain("Never invent")
  })

  it("extractCleanedHtml strips code fences", () => {
    expect(extractCleanedHtml("```html\n<p>x</p>\n```")).toBe("<p>x</p>")
    expect(extractCleanedHtml("<p>y</p>")).toBe("<p>y</p>")
    expect(extractCleanedHtml(null)).toBeNull()
    expect(extractCleanedHtml("   ")).toBeNull()
  })

  it("cleanupIsSafe rejects results that dropped most of the text", () => {
    const original = "<div><p>" + "word ".repeat(100) + "</p></div>"
    expect(cleanupIsSafe(original, "<p>" + "word ".repeat(100) + "</p>")).toBe(true) // markup-only change
    expect(cleanupIsSafe(original, "<p>word word</p>")).toBe(false) // lost ~98% of text
    expect(cleanupIsSafe("", "")).toBe(true)
  })
})
