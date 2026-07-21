// src/modules/design/catalog.ts
// Design catalog (V1.1) — the platform's source of truth for the preset / layout
// / tone ENUMS used by the genesis wizard (swatch + thumbnail cards), the
// /examples gallery, and server-side validation of preset-change requests. The
// actual CSS token VALUES live in the site template (src/lib/presets.ts); the
// swatch hexes below MIRROR that file (kept in sync like the schema copies —
// a mismatch is caught by design.test.ts against a committed snapshot). Pure.

export interface PresetCard {
  id: string
  label: string
  mood: string
  swatch: { bg: string; surface: string; accent: string; fg: string }
  font: string
}

// Mirrors site-template/src/lib/presets.ts (names + colors must match).
export const PRESETS: PresetCard[] = [
  { id: "modern", label: "Modern", mood: "Clean & crisp", swatch: { bg: "#ffffff", surface: "#f8fafc", accent: "#2563eb", fg: "#0f172a" }, font: "Sans / Sans" },
  { id: "editorial", label: "Editorial", mood: "Warm & classic", swatch: { bg: "#fbf9f4", surface: "#ffffff", accent: "#9a4a2f", fg: "#1c1a17" }, font: "Serif / Sans" },
  { id: "bold", label: "Bold", mood: "Dark & high-contrast", swatch: { bg: "#0b0b0f", surface: "#16161e", accent: "#fb5c74", fg: "#f4f4f7" }, font: "Sans / Sans" },
  { id: "calm", label: "Calm", mood: "Soft & rounded", swatch: { bg: "#f6f7f4", surface: "#ffffff", accent: "#4f7a5f", fg: "#232f29" }, font: "Sans / Sans" },
  { id: "warm", label: "Warm", mood: "Earthy & friendly", swatch: { bg: "#fdf8f3", surface: "#ffffff", accent: "#b45016", fg: "#2a211b" }, font: "Serif / Sans" },
  { id: "tech", label: "Tech", mood: "Cool & precise", swatch: { bg: "#ffffff", surface: "#f5f5f8", accent: "#5b5bf0", fg: "#17171b" }, font: "Sans / Sans" },
]

export const PRESET_IDS = PRESETS.map((p) => p.id)
export const DEFAULT_PRESET = "modern"

export function isPreset(v: string): boolean {
  return PRESET_IDS.includes(v)
}

export function presetCard(id: string): PresetCard {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0]
}

// ─────────────────────── layout variants per kind ───────────────────────

export type SiteKindId = "content" | "ecommerce" | "local-business" | "portfolio"

export interface LayoutOption {
  id: string
  label: string
  hint: string
}

// 2–3 homepage layout options per kind. `classic` is every kind's default.
export const LAYOUTS: Record<SiteKindId, LayoutOption[]> = {
  content: [
    { id: "classic", label: "Classic list", hint: "Single-column article list" },
    { id: "magazine", label: "Magazine grid", hint: "Card grid of posts" },
  ],
  ecommerce: [
    { id: "classic", label: "Product list", hint: "Simple product rows" },
    { id: "grid", label: "Product grid", hint: "Card grid of products" },
  ],
  "local-business": [
    { id: "classic", label: "Info-first", hint: "Hours, map, contact up top" },
    { id: "services", label: "Services grid", hint: "Service cards up front" },
  ],
  portfolio: [
    { id: "classic", label: "Case list", hint: "Chronological project list" },
    { id: "gallery", label: "Work gallery", hint: "Visual project grid" },
  ],
}

export function layoutsFor(kind: string): LayoutOption[] {
  return LAYOUTS[(kind as SiteKindId)] ?? LAYOUTS.content
}

export function isLayout(kind: string, v: string): boolean {
  return layoutsFor(kind).some((l) => l.id === v)
}

export function defaultLayout(kind: string): string {
  return "classic"
}

// ─────────────────────── niche → design recommendation (D4) ───────────────────────
// Art-direction as data: match the niche's world to the right preset, layout and
// tone instead of always defaulting to "modern / classic / professional". Pure
// and unit-tested. A specific hit wins; otherwise the site kind decides.

interface DesignRec { preset: string; layout: string; tone: string; why: string }

// Ordered keyword → aesthetic map. First match wins, so put specific worlds first.
const NICHE_RULES: Array<{ re: RegExp; preset: string; tone: string; why: string }> = [
  { re: /\b(law|lawyer|attorney|legal|accountant|accounting|tax|finance|financial|insurance|consult|advisor|notary)\b/i, preset: "editorial", tone: "professional", why: "trust-first professional services read best in a classic, editorial voice" },
  { re: /\b(bakery|cafe|coffee|restaurant|food|recipe|catering|florist|craft|handmade|candle|artisan|wedding|kids|children|nursery)\b/i, preset: "warm", tone: "friendly", why: "warm, hand-made and hospitality niches want an earthy, friendly feel" },
  { re: /\b(saas|software|api|developer|dev|tech|startup|ai|data|cloud|cyber|crypto|analytics|platform|app)\b/i, preset: "tech", tone: "expert", why: "technical products read as precise and credible in the cool tech preset" },
  { re: /\b(gym|fitness|crossfit|nightlife|music|gaming|streetwear|fashion|agency|creative|photography|photographer|film|filmmaker|events?)\b/i, preset: "bold", tone: "friendly", why: "high-energy and creative brands earn a dramatic, high-contrast look" },
  { re: /\b(yoga|wellness|spa|meditation|therapy|counsel|health|clinic|dental|medical|skincare|beauty|garden|plant|eco|sustainab|nature)\b/i, preset: "calm", tone: "friendly", why: "wellness and care niches feel right in a soft, calm, rounded palette" },
]

/** Recommend a preset + layout + tone for a niche & kind. Pure. */
export function recommendDesign(niche: string, kind: string): DesignRec {
  const n = (niche || "").toLowerCase()
  const hit = NICHE_RULES.find((r) => r.re.test(n))
  const preset = hit?.preset ?? (kind === "portfolio" ? "bold" : kind === "ecommerce" ? "modern" : "modern")
  const tone = hit?.tone ?? "professional"
  // Prefer the richer, more visual layout for each kind (still a real catalog id).
  const visual: Record<string, string> = { content: "magazine", ecommerce: "grid", "local-business": "services", portfolio: "gallery" }
  const layout = visual[kind] ?? "classic"
  const why = hit?.why ?? "a clean, versatile default that suits most niches"
  return { preset, layout, tone, why }
}

// ─────────────────────── tone of voice (seed content) ───────────────────────

export const TONES = [
  { id: "professional", label: "Professional", hint: "Authoritative, precise" },
  { id: "friendly", label: "Friendly", hint: "Warm, conversational" },
  { id: "expert", label: "Expert", hint: "Deep, technical, detailed" },
] as const

export const TONE_IDS = TONES.map((t) => t.id)
export const DEFAULT_TONE = "professional"

export function isTone(v: string): boolean {
  return (TONE_IDS as readonly string[]).includes(v)
}

/** One line describing the tone for the genesis prompt. Pure. */
export function toneDirective(tone: string): string {
  switch (tone) {
    case "friendly": return "Write in a warm, friendly, conversational tone — approachable and encouraging."
    case "expert": return "Write in a deep, expert, technical tone — precise, detailed, and authoritative for a knowledgeable reader."
    default: return "Write in a clear, professional tone — authoritative and trustworthy without jargon."
  }
}
