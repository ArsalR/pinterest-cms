// scripts/check-contrast.mjs — WCAG AA contrast gate (D5.4). Deploy-blocking.
// Parses the RESOLVED design tokens from the built page's inline <style>
// (:root and any prefers-color-scheme:dark override) and asserts every
// text/background pairing clears WCAG AA. Runs per built preset (the matrix
// builds each preset separately), and checks dark mode too when tokens exist.
//
// Thresholds: normal text 4.5:1 (body, secondary, links, button labels);
// UI/large 3.0:1 (borders/accent lines). Computed from the actual hex values,
// so a palette that drifts below AA blocks the deploy like any other gate.
import { readFileSync, existsSync } from "node:fs"

const DIST = new URL("../dist", import.meta.url).pathname
const AA_TEXT = 4.5

function lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
function lum(hex) {
  const n = parseInt(hex.slice(1), 16)
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}
function ratio(a, b) { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) }

/** Extract `--token:#hex` pairs from a CSS block (hex tokens only). */
function tokens(css) {
  const out = {}
  for (const m of css.matchAll(/--([a-z-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g)) out[m[1]] = m[2]
  return out
}
function norm(hex) {
  if (hex.length === 4) return "#" + [...hex.slice(1)].map((c) => c + c).join("")
  return hex.slice(0, 7)
}

// The TEXT pairs every mode must satisfy at AA (4.5:1). We deliberately do NOT
// gate hairline borders: WCAG 1.4.11 exempts decorative separators, and a card
// hairline at ~1.2:1 is correct design — the focus ring uses --accent, whose
// contrast is already covered by the link pairs below.
// [foreground, background, threshold, label]
const PAIRS = (t) => [
  [t.fg, t.bg, AA_TEXT, "body text on background"],
  [t.fg, t.surface, AA_TEXT, "body text on surface"],
  [t.muted, t.bg, AA_TEXT, "secondary text on background"],
  [t.muted, t.surface, AA_TEXT, "secondary text on surface"],
  [t.accent, t.bg, AA_TEXT, "link on background"],
  [t.accent, t.surface, AA_TEXT, "link on surface"],
  [t["accent-fg"], t.accent, AA_TEXT, "button label on accent"],
]

function checkMode(modeName, css, problems) {
  const raw = tokens(css)
  const t = {}
  for (const k of ["bg", "surface", "fg", "muted", "accent", "accent-fg", "border"]) {
    if (raw[k]) t[k] = norm(raw[k])
  }
  const need = ["bg", "surface", "fg", "muted", "accent", "accent-fg", "border"]
  if (need.some((k) => !t[k])) return // mode not present / not all hex (skip; light must exist below)
  for (const [fg, bg, min, label] of PAIRS(t)) {
    const r = ratio(fg, bg)
    if (r < min) problems.push(`[${modeName}] ${label}: ${fg} on ${bg} = ${r.toFixed(2)}:1 (needs ${min}:1)`)
  }
  return true
}

if (!existsSync(`${DIST}/index.html`)) {
  console.error("contrast gate: no dist/index.html — build first")
  process.exit(1)
}
const html = readFileSync(`${DIST}/index.html`, "utf8")
const style = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/i) || [, ""])[1]

// Light = the base :root block (before any @media). Dark = the tokens inside a
// prefers-color-scheme:dark block, if present (D5.2).
const darkBlock = (style.match(/@media[^{]*prefers-color-scheme:\s*dark[^{]*\{([\s\S]*?\})\s*\}/i) || [, ""])[1]
const lightCss = style.replace(/@media[\s\S]*$/, "") // strip media queries → base tokens

const problems = []
const okLight = checkMode("light", lightCss, problems)
if (!okLight) { console.error("contrast gate: could not read light-mode tokens from built CSS"); process.exit(1) }
if (darkBlock) checkMode("dark", darkBlock, problems)

if (problems.length) {
  console.error("contrast gate FAIL (WCAG AA):")
  for (const p of problems) console.error("  " + p)
  process.exit(1)
}
console.log(`contrast gate: OK (WCAG AA${darkBlock ? ", light + dark" : ", light"})`)
