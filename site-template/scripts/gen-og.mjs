// scripts/gen-og.mjs — build-time social cards (D5.5). Runs AFTER astro build.
// For every page that points at /og/<slug>.png (i.e. has no custom social
// image), render a designed 1200×630 PNG from the preset's palette + display
// font: the page title on the accent ground with the site name. Nothing ships
// to the client — this only writes static images into dist/og. Self-contained:
// the site's own woff2 is decompressed to a ttf in memory (wawoff2) and resvg
// rasterizes a hand-built SVG (satori can't parse the subset variable fonts).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { Resvg } from "@resvg/resvg-js"
import wawoff from "wawoff2"

const DIST = new URL("../dist", import.meta.url).pathname
const config = JSON.parse(readFileSync(new URL("../site.config.json", import.meta.url), "utf8"))

// Display font per preset (mirrors PAIRING head in src/lib/presets.ts).
const HEAD = {
  editorial: ["fraunces", "Fraunces"], modern: ["inter", "Inter"], bold: ["archivo", "Archivo"],
  calm: ["lora", "Lora"], warm: ["fraunces", "Fraunces"], tech: ["space-grotesk", "Space Grotesk"],
}
const [file, family] = HEAD[config.preset] || HEAD.modern

// Resolved palette from the built CSS (base :root, light mode).
const home = readFileSync(`${DIST}/index.html`, "utf8")
const style = (home.match(/<style[^>]*>([\s\S]*?)<\/style>/i) || [, ""])[1]
const root = style.replace(/@media[\s\S]*$/, "")
const tok = (k, d) => ((root.match(new RegExp(`--${k}\\s*:\\s*(#[0-9a-fA-F]{3,8})`)) || [])[1] || d)
const accent = tok("accent", "#2563eb")
const accentFg = tok("accent-fg", "#ffffff")

mkdirSync(`${DIST}/og`, { recursive: true })
// Decompress the display woff2 → ttf for resvg, in the OS temp dir so the
// intermediate never ships in dist.
const fontPath = `${tmpdir()}/og-${file}.ttf`
writeFileSync(fontPath, Buffer.from(await wawoff.decompress(readFileSync(`${DIST}/fonts/${file}-variable-latin.woff2`))))

const esc = (s) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))

/** Greedy word-wrap by estimated advance width. Pure enough for display type. */
function wrap(text, fontSize, maxWidth, maxLines) {
  const words = text.split(/\s+/)
  const lines = []
  let line = ""
  const width = (s) => s.length * fontSize * 0.53
  for (const w of words) {
    const test = line ? line + " " + w : w
    if (width(test) > maxWidth && line) { lines.push(line); line = w } else line = test
  }
  if (line) lines.push(line)
  if (lines.length > maxLines) {
    lines.length = maxLines
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s+\S*$/, "") + "…"
  }
  return lines
}

function card(title, siteName) {
  let size = 70
  let lines = wrap(title, size, 1040, 4)
  if (lines.length > 3) { size = 56; lines = wrap(title, size, 1040, 3) }
  const lh = size * 1.16
  const blockH = lines.length * lh
  const startY = 300 - blockH / 2 + size // vertically centered-ish block
  const tspans = lines
    .map((l, i) => `<text x="80" y="${Math.round(startY + i * lh)}" font-family="${family}" font-size="${size}" font-weight="700" fill="${accentFg}">${esc(l)}</text>`)
    .join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
    <rect width="1200" height="630" fill="${accent}"/>
    <rect x="80" y="70" width="52" height="6" rx="3" fill="${accentFg}" opacity="0.85"/>
    ${tspans}
    <text x="80" y="560" font-family="${family}" font-size="30" font-weight="600" fill="${accentFg}" opacity="0.82">${esc(siteName)}</text>
  </svg>`
}

// Walk built HTML, render a card for each page pointing at /og/<slug>.png.
function walk(dir) {
  const out = []
  for (const n of readdirSync(dir)) {
    const p = `${dir}/${n}`
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (n.endsWith(".html")) out.push(p)
  }
  return out
}

const siteName = config.name || "Website"
const done = new Set()
let made = 0
for (const f of walk(DIST)) {
  const html = readFileSync(f, "utf8")
  const m = html.match(/property="og:image"\s+content="[^"]*\/og\/([a-z0-9-]+)\.png"/i)
  if (!m) continue
  const slug = m[1]
  if (done.has(slug)) continue
  done.add(slug)
  const ogTitle = (html.match(/property="og:title"\s+content="([^"]*)"/i) || [])[1]
  const rawTitle = ogTitle || (html.match(/<title>([^<]*)<\/title>/i) || [, siteName])[1]
  const title = rawTitle.split(" — ")[0].trim() || siteName
  try {
    const svg = card(title, siteName)
    const png = new Resvg(svg, { font: { fontFiles: [fontPath], defaultFontFamily: family, loadSystemFonts: false } }).render().asPng()
    writeFileSync(`${DIST}/og/${slug}.png`, png)
    made++
  } catch (e) {
    console.error(`og: failed for ${slug}: ${e.message}`)
  }
}
console.log(`og cards: generated ${made} social image(s) (${config.preset} palette, ${family})`)
