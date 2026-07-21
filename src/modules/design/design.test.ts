// src/modules/design/design.test.ts
// V1.1 design options: catalog validators + the platform↔template preset sync +
// the covenant-safety of every preset (system fonts only, no external requests)
// + the claude-protected / platform-allowed split for site.config.json.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  PRESETS, PRESET_IDS, isPreset, layoutsFor, isLayout, defaultLayout,
  TONE_IDS, isTone, toneDirective, DEFAULT_PRESET, recommendDesign,
} from "./catalog"

const ROOT = fileURLToPath(new URL("../../..", import.meta.url))
const read = (p: string) => readFileSync(`${ROOT}/${p}`, "utf8")

describe("catalog validators (server-side enum — never free-form)", () => {
  it("presets: known ids accepted, unknown rejected", () => {
    expect(isPreset(DEFAULT_PRESET)).toBe(true)
    expect(PRESET_IDS.length).toBeGreaterThanOrEqual(6)
    expect(isPreset("rainbow")).toBe(false)
  })
  it("layouts are per-kind; classic is every kind's default", () => {
    for (const kind of ["content", "ecommerce", "local-business", "portfolio"]) {
      expect(layoutsFor(kind).length).toBeGreaterThanOrEqual(2)
      expect(defaultLayout(kind)).toBe("classic")
      expect(isLayout(kind, "classic")).toBe(true)
    }
    expect(isLayout("content", "magazine")).toBe(true)
    expect(isLayout("content", "gallery")).toBe(false) // gallery is portfolio-only
    expect(isLayout("nonsense-kind", "classic")).toBe(true) // falls back to content layouts
  })
  it("tones map to a genesis directive", () => {
    expect(TONE_IDS).toEqual(["professional", "friendly", "expert"])
    expect(isTone("friendly")).toBe(true)
    expect(isTone("angry")).toBe(false)
    expect(toneDirective("expert")).toMatch(/expert|technical/i)
  })
})

describe("recommendDesign (D4 niche → art direction)", () => {
  it("matches niche worlds to fitting presets", () => {
    expect(recommendDesign("family law firm", "portfolio").preset).toBe("editorial")
    expect(recommendDesign("artisan sourdough bakery", "content").preset).toBe("warm")
    expect(recommendDesign("developer API platform", "content").preset).toBe("tech")
    expect(recommendDesign("yoga & wellness studio", "local-business").preset).toBe("calm")
    expect(recommendDesign("streetwear fashion brand", "ecommerce").preset).toBe("bold")
  })
  it("always returns valid catalog ids (preset/layout/tone)", () => {
    for (const kind of ["content", "ecommerce", "local-business", "portfolio"]) {
      const r = recommendDesign("something totally generic", kind)
      expect(isPreset(r.preset)).toBe(true)
      expect(isLayout(kind, r.layout)).toBe(true)
      expect(isTone(r.tone)).toBe(true)
      expect(r.why.length).toBeGreaterThan(0)
    }
  })
  it("falls back to a versatile default when no niche keyword hits", () => {
    expect(recommendDesign("", "content").preset).toBe("modern")
  })
})

describe("platform catalog stays in sync with the template preset tokens", () => {
  const tpl = read("site-template/src/lib/presets.ts")
  it("every platform preset id exists in the template's PRESETS map", () => {
    for (const p of PRESETS) {
      expect(tpl, `template presets.ts missing "${p.id}"`).toMatch(new RegExp(`\\b${p.id}:\\s*\\{`))
    }
  })
  it("every preset is covered by the template's covenant build matrix", () => {
    const matrix = read("site-template/.github/workflows/preset-matrix.yml")
    for (const p of PRESETS) {
      expect(matrix, `preset-matrix.yml must build "${p.id}"`).toMatch(new RegExp(`\\b${p.id}\\b`))
    }
  })
  it("platform swatch bg/accent hexes match the template token values", () => {
    for (const p of PRESETS) {
      // The template line for this preset must carry the same bg + accent hex.
      const line = new RegExp(`${p.id}:\\s*\\{[^}]*bg:\\s*"${p.swatch.bg}"[^}]*accent:\\s*"${p.swatch.accent}"`, "i")
      expect(tpl, `swatch drift for "${p.id}"`).toMatch(line)
    }
  })
})

describe("every preset is covenant-safe (P4: no external font/CSS requests)", () => {
  const tpl = read("site-template/src/lib/presets.ts")
  it("uses only system font stacks — no Google Fonts / @import / remote URLs", () => {
    expect(tpl).not.toMatch(/googleapis|typekit|@import|https?:\/\//)
  })
  it("presetRootCss output would be pure CSS custom properties (no JS)", () => {
    // The template emits presetRootCss(...) into a <style> — variables only.
    expect(tpl).toMatch(/export function presetRootCss/)
    expect(tpl).toMatch(/:root\{/)
  })
})

describe("site.config.json: Claude-protected, platform-writable", () => {
  it("claude.yml still rejects a Claude edit to site.config.json", () => {
    const claude = read("site-template/.github/workflows/claude.yml")
    expect(claude).toMatch(/site\\?\.config\\?\.json/) // in the protected-path guard
    expect(claude).toMatch(/NEVER modify:[^\n]*site\.config\.json/)
  })
  it("design.yml (platform-authored) DOES patch site.config.json and gates via preview", () => {
    const design = read("site-template/.github/workflows/design.yml")
    expect(design).toMatch(/writeFileSync\("site\.config\.json"/)
    expect(design).toMatch(/c\.preset = process\.env\.PRESET/)
    expect(design).toMatch(/c\.layout = process\.env\.LAYOUT/)
    // Preview path keeps production unframeable posture (relaxes only the preview).
    expect(design).toMatch(/frame-ancestors https:\/\/arsal\.app/)
    // Never runs Claude (deterministic) — no Anthropic key wired in, unlike claude.yml.
    expect(design).not.toMatch(/ANTHROPIC_API_KEY/)
    expect(read("site-template/.github/workflows/claude.yml")).toMatch(/ANTHROPIC_API_KEY/) // control: claude.yml does
  })
})
