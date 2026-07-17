// src/modules/network/notfound.test.ts
// Pure helpers for the 404 monitor (K3, B-1): which CF-reported paths are
// redirect candidates, path normalization, and target validation. The CF
// GraphQL fetch + redirect write are best-effort I/O.

import { describe, it, expect } from "vitest"
import { isCandidatePath, normalizeFromPath, isValidTarget } from "./notfound"

describe("isCandidatePath", () => {
  it("accepts real content paths", () => {
    expect(isCandidatePath("/old-post")).toBe(true)
    expect(isCandidatePath("/2023/guide/")).toBe(true)
  })
  it("rejects assets, dotfiles, api/admin, and non-slash noise", () => {
    expect(isCandidatePath("/style.css")).toBe(false)
    expect(isCandidatePath("/img/a.png")).toBe(false)
    expect(isCandidatePath("/favicon.ico")).toBe(false)
    expect(isCandidatePath("/api/x")).toBe(false)
    expect(isCandidatePath("/admin/login")).toBe(false)
    expect(isCandidatePath("no-slash")).toBe(false)
    expect(isCandidatePath("")).toBe(false)
    expect(isCandidatePath("/" + "x".repeat(600))).toBe(false)
  })
})

describe("normalizeFromPath", () => {
  it("ensures a leading slash and collapses doubles", () => {
    expect(normalizeFromPath("old-page")).toBe("/old-page")
    expect(normalizeFromPath("  /a//b ")).toBe("/a/b")
    expect(normalizeFromPath("/keep/")).toBe("/keep/")
  })
})

describe("isValidTarget", () => {
  it("accepts internal paths and https URLs, rejects the rest", () => {
    expect(isValidTarget("/new-page/")).toBe(true)
    expect(isValidTarget("https://example.com/x")).toBe(true)
    expect(isValidTarget("http://example.com")).toBe(false) // https only
    expect(isValidTarget("javascript:alert(1)")).toBe(false)
    expect(isValidTarget("/has space")).toBe(false)
    expect(isValidTarget("")).toBe(false)
  })
})
