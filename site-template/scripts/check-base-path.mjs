// V1.5 M5 — subdirectory base-path gate. Runs AFTER gen-basepath.mjs. A
// subdirectory site (domain.com/blog) must emit EVERY internal URL under its
// base ("/blog") — links, canonicals, OG URLs, sitemap <loc>s, RSS, JSON-LD,
// assets. A single un-prefixed path silently poisons SEO (wrong canonical, 404
// links, unfetchable sitemap entries), so this gate scans the built output and
// FAILS the deploy (exit 1) on any internal URL missing the base prefix or
// double-prefixed. No-op for top-level sites (base "") — byte-identical.
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const dist = new URL("../dist", import.meta.url).pathname
const config = JSON.parse(readFileSync(new URL("../site.config.json", import.meta.url), "utf8"))
const host = config.canonicalHost === "www" ? `www.${config.domain}` : config.domain
const BASE = (() => {
  const b = (config.basePath ?? "").trim()
  return !b || b === "/" ? "" : "/" + b.replace(/^\/+|\/+$/g, "").toLowerCase()
})()

if (!BASE) {
  console.log("base-path gate: n/a (top-level site — root-served)")
  process.exit(0)
}

const offenders = []
const underBase = (p) => p === BASE || p.startsWith(BASE + "/")
const doubled = (p) => p.startsWith(BASE + BASE + "/") || p === BASE + BASE

function checkPath(p, where, kind) {
  if (!p.startsWith("/") || p.startsWith("//")) return
  if (doubled(p)) offenders.push(`${where}: ${kind} "${p}" is double-prefixed with ${BASE}`)
  else if (!underBase(p)) offenders.push(`${where}: ${kind} "${p}" is missing the ${BASE} base prefix`)
}

const HOST_ABS = new RegExp(`https?://${host.replace(/[.]/g, "\\.")}(/[^"'\\s<>)]*)`, "gi")
const ATTR = /\b(?:href|src|action)\s*=\s*["'](\/[^"'#][^"']*)["']/gi
const SRCSET = /\bsrcset\s*=\s*"([^"]*)"/gi
const LOC = /<loc>\s*([^<\s]+)\s*<\/loc>/gi

function scan(file, rel) {
  const txt = readFileSync(file, "utf8")
  const isHtml = file.endsWith(".html")
  if (isHtml) {
    let m
    while ((m = ATTR.exec(txt))) checkPath(m[1], rel, "link")
    let s
    while ((s = SRCSET.exec(txt))) {
      for (const part of s[1].split(",")) {
        const url = part.trim().split(/\s+/)[0]
        if (url) checkPath(url, rel, "srcset")
      }
    }
  }
  let a
  while ((a = HOST_ABS.exec(txt))) checkPath(a[1], rel, "absolute-url")
  let l
  while ((l = LOC.exec(txt))) {
    const loc = l[1]
    const path = loc.startsWith("http") ? loc.replace(/https?:\/\/[^/]+/, "") : loc
    if (path) checkPath(path, rel, "sitemap-loc")
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(html|xml|txt)$/.test(p)) scan(p, p.replace(dist, ""))
  }
}

walk(dist)

if (offenders.length) {
  console.error(`BASE-PATH GATE FAILED — internal URLs not under the "${BASE}" base (would poison SEO):`)
  for (const o of offenders.slice(0, 60)) console.error("  " + o)
  if (offenders.length > 60) console.error(`  …and ${offenders.length - 60} more`)
  console.error(`Every internal URL on a subdirectory site must start with ${BASE}. Check scripts/gen-basepath.mjs coverage.`)
  process.exit(1)
}
console.log(`base-path gate: OK (all internal URLs under ${BASE})`)
