// scripts/check-fonts.mjs — Performance covenant P4 gate (D2): fonts must be
// SELF-HOSTED. Fails the build if any built page references an external font
// (Google Fonts, a CDN, any absolute http(s) font URL, or @import), and
// verifies every preloaded/@font-face file actually exists in dist/fonts.
// Deploy-blocking, like every other template gate.
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs"

const DIST = new URL("../dist", import.meta.url).pathname

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith(".html") || name.endsWith(".css")) out.push(p)
  }
  return out
}

if (!existsSync(DIST)) {
  console.error("font gate: no dist/ — run the build first")
  process.exit(1)
}

const EXTERNAL = [
  /fonts\.googleapis\.com/i,
  /fonts\.gstatic\.com/i,
  /use\.typekit|fonts\.adobe|fontawesome|cdn\.jsdelivr[^"']*font/i,
  /@import/i,
  /url\(\s*["']?https?:\/\/[^)"']+\.(?:woff2?|ttf|otf|eot)/i,
  /<link[^>]+href=["']https?:\/\/[^"']+\.(?:woff2?|css)[^>]*rel=["']?stylesheet/i,
]

const files = walk(DIST)
let violations = 0
const missing = new Set()

for (const f of files) {
  const html = readFileSync(f, "utf8")
  for (const re of EXTERNAL) {
    if (re.test(html)) {
      console.error(`font gate FAIL: external font reference (${re}) in ${f.replace(DIST, "")}`)
      violations++
    }
  }
  // Every self-hosted font URL referenced must exist on disk.
  for (const m of html.matchAll(/\/fonts\/([a-z0-9-]+\.woff2)/gi)) {
    if (!existsSync(`${DIST}/fonts/${m[1]}`)) missing.add(m[1])
  }
}

for (const m of missing) {
  console.error(`font gate FAIL: referenced /fonts/${m} not found in dist/fonts`)
  violations++
}

if (violations > 0) {
  console.error(`\nfont gate: ${violations} problem(s) — fonts must be self-hosted (P4).`)
  process.exit(1)
}
console.log("font gate: OK (self-hosted fonts only, all referenced files present)")
