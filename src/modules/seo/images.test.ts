// src/modules/seo/images.test.ts — pure filename-slugify (S2 image SEO).
import { describe, it, expect } from "vitest"
import { slugifyFilename } from "./images"

describe("slugifyFilename", () => {
  it("slugifies the base and preserves a lowercased extension", () => {
    expect(slugifyFilename("My Photo (1).JPG")).toBe("my-photo-1.jpg")
    expect(slugifyFilename("Café Del Mar.PNG")).toBe("caf-del-mar.png")
    expect(slugifyFilename("already-clean.webp")).toBe("already-clean.webp")
  })
  it("handles no-extension and empty-base names", () => {
    expect(slugifyFilename("Just A Name")).toBe("just-a-name")
    expect(slugifyFilename("____.png")).toBe("image.png")
    expect(slugifyFilename(".gitignore")).toBe("gitignore")
  })
  it("collapses runs of separators and trims", () => {
    expect(slugifyFilename("a  b__c--d.jpeg")).toBe("a-b-c-d.jpeg")
  })
})
