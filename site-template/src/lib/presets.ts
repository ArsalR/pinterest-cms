// site-template/src/lib/presets.ts
// Design presets (V1.1) — curated CSS-variable token sets. Zero-JS covenant
// untouched: presets are pure CSS custom properties emitted at build time from
// site.config.json's `preset`. Fonts are SYSTEM stacks only (no webfont
// requests — Performance covenant P4). The platform mirrors these NAMES + swatch
// colors in src/modules/design/presets.ts (kept in sync like the schema copies).

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
  radius: string
  maxw: string
}

const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const SERIF = 'Georgia, "Iowan Old Style", "Times New Roman", serif'

export const PRESETS: Record<string, PresetTokens> = {
  editorial: { bg: "#fbf9f4", surface: "#ffffff", fg: "#1c1a17", muted: "#6b6357", border: "#e7e1d6", accent: "#9a4a2f", accentFg: "#ffffff", fontHead: SERIF, fontBody: SANS, radius: "4px", maxw: "44rem" },
  modern:    { bg: "#ffffff", surface: "#f8fafc", fg: "#0f172a", muted: "#64748b", border: "#e2e8f0", accent: "#2563eb", accentFg: "#ffffff", fontHead: SANS, fontBody: SANS, radius: "8px", maxw: "46rem" },
  bold:      { bg: "#0b0b0f", surface: "#17171f", fg: "#f5f5f7", muted: "#a1a1aa", border: "#2a2a35", accent: "#f43f5e", accentFg: "#ffffff", fontHead: SANS, fontBody: SANS, radius: "6px", maxw: "46rem" },
  calm:      { bg: "#f6f7f4", surface: "#ffffff", fg: "#24302a", muted: "#6a7770", border: "#dde3dc", accent: "#4f7a5f", accentFg: "#ffffff", fontHead: SANS, fontBody: SANS, radius: "14px", maxw: "44rem" },
  warm:      { bg: "#fdf8f3", surface: "#ffffff", fg: "#2a211b", muted: "#7a6a5c", border: "#ece0d4", accent: "#c2571f", accentFg: "#ffffff", fontHead: SERIF, fontBody: SANS, radius: "10px", maxw: "44rem" },
  tech:      { bg: "#ffffff", surface: "#f4f4f6", fg: "#18181b", muted: "#6b7280", border: "#e4e4e7", accent: "#6366f1", accentFg: "#ffffff", fontHead: SANS, fontBody: SANS, radius: "4px", maxw: "47rem" },
}

export const PRESET_NAMES = Object.keys(PRESETS)
export const DEFAULT_PRESET = "modern"

export function resolvePreset(name: string | undefined): PresetTokens {
  return (name && PRESETS[name]) || PRESETS[DEFAULT_PRESET]
}

/** Emit the preset's tokens as a `:root { … }` CSS block. Pure. */
export function presetRootCss(name: string | undefined): string {
  const t = resolvePreset(name)
  return `:root{--bg:${t.bg};--surface:${t.surface};--fg:${t.fg};--muted:${t.muted};--border:${t.border};--accent:${t.accent};--accent-fg:${t.accentFg};--font-head:${t.fontHead};--font-body:${t.fontBody};--radius:${t.radius};--maxw:${t.maxw}}`
}
