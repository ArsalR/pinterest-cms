import { describe, it, expect } from "vitest"
import { slugify, sanitizeFilename, escapeHtml, plainExcerpt } from "./utils"

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Hello World")).toBe("hello-world")
  })
  it("strips non-alphanumeric characters", () => {
    expect(slugify("Post: #1 (draft)")).toBe("post-1-draft")
  })
  it("collapses consecutive hyphens", () => {
    expect(slugify("a---b")).toBe("a-b")
  })
  it("strips leading and trailing hyphens", () => {
    expect(slugify("  --hello--  ")).toBe("hello")
  })
  it("normalises diacritics", () => {
    expect(slugify("Ñoño café")).toBe("nono-cafe")
  })
  it("falls back to 'post' for empty input", () => {
    expect(slugify("")).toBe("post")
    expect(slugify("!!!")).toBe("post")
  })
  it("truncates to 100 chars", () => {
    expect(slugify("a".repeat(120)).length).toBeLessThanOrEqual(100)
  })
})

describe("sanitizeFilename", () => {
  it("replaces path separators", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("..-..-etc-passwd")
  })
  it("lowercases and collapses spaces", () => {
    expect(sanitizeFilename("My Photo.JPG")).toBe("my-photo.jpg")
  })
  it("falls back to 'file' for empty input", () => {
    expect(sanitizeFilename("")).toBe("file")
  })
})

describe("escapeHtml", () => {
  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;")
  })
  it("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b")
  })
  it("handles null/undefined gracefully", () => {
    expect(escapeHtml(null)).toBe("")
    expect(escapeHtml(undefined)).toBe("")
  })
})

describe("plainExcerpt", () => {
  it("strips HTML tags", () => {
    expect(plainExcerpt("<p>Hello <strong>world</strong></p>", 100)).toBe("Hello world")
  })
  it("truncates at word boundary", () => {
    const text = "one two three four five"
    const result = plainExcerpt(`<p>${text}</p>`, 10)
    expect(result.length).toBeLessThanOrEqual(13) // 10 + possible "..."
    expect(result).toMatch(/^one/)
  })
  it("does not add ellipsis when text fits", () => {
    expect(plainExcerpt("<p>short</p>", 100)).toBe("short")
  })
})
