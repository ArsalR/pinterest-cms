// site-template/src/lib/presets.ts
// Design presets (V1.1 → design-engine D1). Curated CSS-variable token sets:
// not just colors, but a full system — a per-preset TYPE SCALE (modular ratio),
// heading weight/tracking, elevation, and reading/section widths. Zero-JS
// covenant untouched: everything is pure CSS custom properties emitted at build
// time from site.config.json's `preset`. Fonts stay SYSTEM stacks in D1 (curated
// self-hosted faces arrive in D2). The platform mirrors these NAMES + swatch
// colors in src/modules/design/catalog.ts (kept in sync like the schema copies).

export interface PresetTokens {
  bg: string
  surface: string
  fg: string
  muted: string
  border: string
  accent: string
  accentFg: string
  fontHead: string
  fontBody: string
  /** Modular type-scale ratio (1.2 minor third … 1.333 perfect fourth). */
  scale: number
  /** Heading weight + tracking give each preset its typographic voice. */
  headWeight: string
  headTracking: string
  bodyLh: string
  radius: string
  /** Elevation for cards/popovers — tuned per ground (soft on light, deep on dark). */
  shadow: string
  /** Reading measure (article body) and the wider band for heros/sections. */
  maxw: string
  wide: string
}

const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const SERIF = 'Georgia, "Iowan Old Style", "Times New Roman", serif'
const SOFT_SHADOW = "0 1px 2px rgba(15,23,42,.05), 0 12px 28px -16px rgba(15,23,42,.18)"

// ─────────────────────── curated typography (D2) ───────────────────────
// Self-hosted latin-subset VARIABLE fonts (OFL, in public/fonts). Each family
// ships with a metric-matched fallback @font-face so font-display:swap causes
// ~zero layout shift: while the woff2 loads, a size-adjusted local system font
// stands in at the same dimensions. size-adjust/overrides are tuned to keep
// CLS < 0.02 (verified in CI). Variable → real weight axes, never faux-bold.
interface FontDef {
  family: string
  file: string
  weight: string // variable wght axis range
  serif: boolean
  fbLocal: string // metric-matched system stand-in
  sizeAdjust: string
  ascent: string
  descent: string
  lineGap: string
}
const FONTS: Record<string, FontDef> = {
  inter:           { family: "Inter",         file: "inter-variable-latin.woff2",         weight: "100 900", serif: false, fbLocal: "Arial",   sizeAdjust: "107%",   ascent: "90%",   descent: "22.4%", lineGap: "0%" },
  "space-grotesk": { family: "Space Grotesk", file: "space-grotesk-variable-latin.woff2", weight: "300 700", serif: false, fbLocal: "Arial",   sizeAdjust: "100.8%", ascent: "95%",   descent: "24%",   lineGap: "0%" },
  archivo:         { family: "Archivo",       file: "archivo-variable-latin.woff2",       weight: "100 900", serif: false, fbLocal: "Arial",   sizeAdjust: "100%",   ascent: "92%",   descent: "24%",   lineGap: "0%" },
  manrope:         { family: "Manrope",       file: "manrope-variable-latin.woff2",       weight: "200 800", serif: false, fbLocal: "Arial",   sizeAdjust: "104%",   ascent: "92.9%", descent: "24.4%", lineGap: "0%" },
  fraunces:        { family: "Fraunces",      file: "fraunces-variable-latin.woff2",      weight: "100 900", serif: true,  fbLocal: "Georgia", sizeAdjust: "97%",    ascent: "96%",   descent: "24%",   lineGap: "0%" },
  newsreader:      { family: "Newsreader",    file: "newsreader-variable-latin.woff2",    weight: "200 800", serif: true,  fbLocal: "Georgia", sizeAdjust: "95%",    ascent: "96%",   descent: "24%",   lineGap: "0%" },
  lora:            { family: "Lora",          file: "lora-variable-latin.woff2",          weight: "400 700", serif: true,  fbLocal: "Georgia", sizeAdjust: "100%",   ascent: "92%",   descent: "24%",   lineGap: "0%" },
}

// Per-preset DARK color variant (D5.2), emitted under prefers-color-scheme:dark
// when the site opts in (default on). Only the light presets get one — "bold"
// is already dark, so it renders the same in both modes. Every value here is
// WCAG AA verified (the contrast gate checks the dark block too). Tokens only,
// zero JS.
interface DarkTokens { bg: string; surface: string; fg: string; muted: string; border: string; accent: string; accentFg: string }
const DARK: Record<string, DarkTokens> = {
  editorial: { bg: "#14120f", surface: "#1e1b17", fg: "#f0ebe2", muted: "#a99f90", border: "#322d26", accent: "#df9366", accentFg: "#14120f" },
  modern:    { bg: "#0b1120", surface: "#141c2e", fg: "#e8eef7", muted: "#9aa8be", border: "#253046", accent: "#5b9bff", accentFg: "#08101f" },
  calm:      { bg: "#131a16", surface: "#1b241f", fg: "#e6efe8", muted: "#98ac9f", border: "#2a352e", accent: "#77b389", accentFg: "#0a140e" },
  warm:      { bg: "#17110c", surface: "#211812", fg: "#f2e9df", muted: "#b09e8d", border: "#342820", accent: "#e89355", accentFg: "#17110c" },
  tech:      { bg: "#0c0c12", surface: "#15151f", fg: "#eaeaf2", muted: "#9d9db3", border: "#26263a", accent: "#9494f8", accentFg: "#0a0a12" },
}

// Display / body pairing per preset (kept out of PRESETS to avoid churn).
const PAIRING: Record<string, { head: string; body: string }> = {
  editorial: { head: "fraunces", body: "newsreader" },
  modern:    { head: "inter", body: "inter" },
  bold:      { head: "archivo", body: "inter" },
  calm:      { head: "lora", body: "manrope" },
  warm:      { head: "fraunces", body: "manrope" },
  tech:      { head: "space-grotesk", body: "inter" },
}

function fontStack(key: string): string {
  const d = FONTS[key]
  if (!d) return SANS
  return `"${d.family}","${d.family} Fallback",${d.serif ? SERIF : SANS}`
}
function pairFor(name: string | undefined): { head: string; body: string } {
  return (name && PAIRING[name]) || PAIRING[DEFAULT_PRESET]
}

/** @font-face blocks (webfont + metric-matched fallback) for the 2 families a
 *  preset uses, de-duplicated. Emitted into the page's inline <style>. Pure. */
export function presetFontFaces(name: string | undefined): string {
  const p = pairFor(name)
  const keys = p.head === p.body ? [p.head] : [p.head, p.body]
  return keys
    .map((k) => {
      const d = FONTS[k]
      return (
        `@font-face{font-family:"${d.family}";src:url(/fonts/${d.file}) format("woff2");font-weight:${d.weight};font-style:normal;font-display:swap}` +
        `@font-face{font-family:"${d.family} Fallback";src:local("${d.fbLocal}");size-adjust:${d.sizeAdjust};ascent-override:${d.ascent};descent-override:${d.descent};line-gap-override:${d.lineGap}}`
      )
    })
    .join("")
}

/** The woff2 files a preset uses (deduped) — for <link rel=preload>. Pure. */
export function presetFontPreload(name: string | undefined): string[] {
  const p = pairFor(name)
  const files = p.head === p.body ? [FONTS[p.head].file] : [FONTS[p.head].file, FONTS[p.body].file]
  return files.map((f) => `/fonts/${f}`)
}

export const PRESETS: Record<string, PresetTokens> = {
  editorial: { bg: "#fbf9f4", surface: "#ffffff", fg: "#1c1a17", muted: "#6b6357", border: "#e7e1d6", accent: "#9a4a2f", accentFg: "#ffffff", fontHead: SERIF, fontBody: SANS, scale: 1.333, headWeight: "600", headTracking: "-.01em", bodyLh: "1.72", radius: "4px", shadow: "0 1px 2px rgba(60,40,20,.05), 0 14px 30px -18px rgba(60,40,20,.2)", maxw: "42rem", wide: "60rem" },
  modern:    { bg: "#ffffff", surface: "#f8fafc", fg: "#0f172a", muted: "#5b6675", border: "#e4e9f0", accent: "#2563eb", accentFg: "#ffffff", fontHead: SANS, fontBody: SANS, scale: 1.25, headWeight: "760", headTracking: "-.021em", bodyLh: "1.65", radius: "8px", shadow: SOFT_SHADOW, maxw: "44rem", wide: "62rem" },
  bold:      { bg: "#0b0b0f", surface: "#16161e", fg: "#f4f4f7", muted: "#9d9daa", border: "#2a2a35", accent: "#fb5c74", accentFg: "#12030a", fontHead: SANS, fontBody: SANS, scale: 1.28, headWeight: "800", headTracking: "-.03em", bodyLh: "1.62", radius: "6px", shadow: "0 1px 3px rgba(0,0,0,.55), 0 18px 40px -20px rgba(0,0,0,.7)", maxw: "44rem", wide: "62rem" },
  calm:      { bg: "#f6f7f4", surface: "#ffffff", fg: "#232f29", muted: "#636f68", border: "#dde3dc", accent: "#4f7a5f", accentFg: "#ffffff", fontHead: SANS, fontBody: SANS, scale: 1.2, headWeight: "700", headTracking: "-.012em", bodyLh: "1.72", radius: "14px", shadow: "0 1px 2px rgba(30,50,40,.04), 0 16px 34px -18px rgba(30,50,40,.16)", maxw: "42rem", wide: "58rem" },
  warm:      { bg: "#fdf8f3", surface: "#ffffff", fg: "#2a211b", muted: "#7a6a5c", border: "#ece0d4", accent: "#b45016", accentFg: "#ffffff", fontHead: SERIF, fontBody: SANS, scale: 1.333, headWeight: "600", headTracking: "-.01em", bodyLh: "1.72", radius: "10px", shadow: "0 1px 2px rgba(90,60,30,.05), 0 14px 30px -18px rgba(90,60,30,.2)", maxw: "42rem", wide: "58rem" },
  tech:      { bg: "#ffffff", surface: "#f5f5f8", fg: "#17171b", muted: "#63676f", border: "#e5e5ea", accent: "#5b5bf0", accentFg: "#ffffff", fontHead: SANS, fontBody: SANS, scale: 1.25, headWeight: "720", headTracking: "-.022em", bodyLh: "1.62", radius: "4px", shadow: "0 1px 2px rgba(20,20,40,.05), 0 12px 28px -16px rgba(20,20,40,.16)", maxw: "45rem", wide: "64rem" },
}

export const PRESET_NAMES = Object.keys(PRESETS)
export const DEFAULT_PRESET = "modern"

export function resolvePreset(name: string | undefined): PresetTokens {
  return (name && PRESETS[name]) || PRESETS[DEFAULT_PRESET]
}

/** round to 3 decimals */
function r3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * Emit the preset's tokens as a `:root { … }` CSS block, including a computed
 * modular type scale (rem sizes from the preset's ratio) and a fluid display
 * size. Pure. Every value is a CSS custom property — no JS ships.
 */
export function presetRootCss(name: string | undefined, dark = true): string {
  const t = resolvePreset(name)
  const s = t.scale
  const fs = {
    sm: r3(1 / s), // captions / meta
    base: 1,
    md: r3(s * 0.92), // lead paragraph
    h4: r3(s),
    h3: r3(s * s),
    h2: r3(s * s * s),
    h1max: r3(s * s * s * s),
  }
  // Fluid h1: scales with the viewport between the h2 size and the h1 ceiling.
  const h1 = `clamp(${fs.h2}rem, calc(1.2rem + 3.2vw), ${fs.h1max}rem)`
  const pair = pairFor(name)
  return (
    `:root{` +
    `--bg:${t.bg};--surface:${t.surface};--fg:${t.fg};--muted:${t.muted};--border:${t.border};` +
    `--accent:${t.accent};--accent-fg:${t.accentFg};` +
    `--accent-soft:color-mix(in srgb, ${t.accent} 12%, ${t.surface});` +
    `--accent-line:color-mix(in srgb, ${t.accent} 32%, ${t.border});` +
    `--font-head:${fontStack(pair.head)};--font-body:${fontStack(pair.body)};` +
    `--fw-head:${t.headWeight};--ls-head:${t.headTracking};--lh-body:${t.bodyLh};` +
    `--radius:${t.radius};--shadow:${t.shadow};` +
    `--maxw:${t.maxw};--wide:${t.wide};` +
    `--fs-sm:${fs.sm}rem;--fs-base:${fs.base}rem;--fs-md:${fs.md}rem;` +
    `--fs-h4:${fs.h4}rem;--fs-h3:${fs.h3}rem;--fs-h2:${fs.h2}rem;--fs-h1:${h1};` +
    `--sp-1:.25rem;--sp-2:.5rem;--sp-3:.75rem;--sp-4:1rem;--sp-6:1.5rem;--sp-8:2rem;--sp-12:3rem;--sp-16:4rem;` +
    `}` +
    darkCss(name, dark)
  )
}

/** The prefers-color-scheme:dark override block for a preset (color tokens
 *  only — type scale, fonts and spacing are shared). Empty when the site opted
 *  out or the preset has no dark variant (e.g. "bold" is already dark). Pure. */
function darkCss(name: string | undefined, enabled: boolean): string {
  if (!enabled) return ""
  const key = name && DARK[name] ? name : DARK[DEFAULT_PRESET] && (!name || !PRESETS[name]) ? DEFAULT_PRESET : name
  const d = key ? DARK[key] : undefined
  if (!d) return ""
  return (
    `@media (prefers-color-scheme:dark){:root{` +
    `--bg:${d.bg};--surface:${d.surface};--fg:${d.fg};--muted:${d.muted};--border:${d.border};` +
    `--accent:${d.accent};--accent-fg:${d.accentFg};` +
    `--accent-soft:color-mix(in srgb, ${d.accent} 16%, ${d.surface});` +
    `--accent-line:color-mix(in srgb, ${d.accent} 36%, ${d.border});` +
    `}}`
  )
}
