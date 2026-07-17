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
  { id: "bold", label: "Bold", mood: "Dark & high-contrast", swatch: { bg: "#0b0b0f", surface: "#17171f", accent: "#f43f5e", fg: "#f5f5f7" }, font: "Sans / Sans" },
  { id: "calm", label: "Calm", mood: "Soft & rounded", swatch: { bg: "#f6f7f4", surface: "#ffffff", accent: "#4f7a5f", fg: "#24302a" }, font: "Sans / Sans" },
  { id: "warm", label: "Warm", mood: "Earthy & friendly", swatch: { bg: "#fdf8f3", surface: "#ffffff", accent: "#c2571f", fg: "#2a211b" }, font: "Serif / Sans" },
  { id: "tech", label: "Tech", mood: "Cool & precise", swatch: { bg: "#ffffff", surface: "#f4f4f6", accent: "#6366f1", fg: "#18181b" }, font: "Sans / Sans" },
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
