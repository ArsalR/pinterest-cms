// V1.5 M5 — subdirectory base-path rewrite. A subdirectory site (domain.com/blog)
// is BUILT exactly like a root site, then this post-build pass prefixes every
// internal URL in the emitted output with the base ("/blog"): links, canonicals,
// OG URLs, sitemap <loc>s, RSS, JSON-LD, assets, srcset, and inline url(). The
// source templates never change, so a top-level site (base "") is byte-for-byte
// identical and this script is a no-op. The child worker strips the base prefix
// before serving assets, so the files stay at the dist root (no nesting) and the
// other build gates are unaffected.
//
// check-base-path.mjs re-scans the result and fails the deploy on anything this
// pass missed — so the rewrite can never silently poison SEO.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const dist = new URL("../dist", import.meta.url).pathname
const config = JSON.parse(readFileSync(new URL("../site.config.json", import.meta.url), "utf8"))
const host = config.canonicalHost === "www" ? `www.${config.domain}` : config.domain
const BASE = (() => {
  const b = (config.basePath ?? "").trim()
  return !b || b === "/" ? "" : "/" + b.replace(/^\/+|\/+$/g, "").toLowerCase()
})()

if (!BASE) {
  console.log("base-path rewrite: n/a (top-level site)")
  process.exit(0)
}

// Prefix one root-relative path, unless it's already prefixed / external / an
// anchor. Returns the (possibly) rewritten path.
function pfx(p) {
  if (!p.startsWith("/") || p.startsWith("//")) return p
  if (p === BASE || p.startsWith(BASE + "/")) return p
  return BASE + p
}

// Rewrite a comma-separated srcset ("url 1x, url 2x").
function rewriteSrcset(v) {
  return v
    .split(",")
    .map((part) => {
      const seg = part.trim()
      const sp = seg.indexOf(" ")
      const url = sp === -1 ? seg : seg.slice(0, sp)
      const desc = sp === -1 ? "" : seg.slice(sp)
      return pfx(url) + desc
    })
    .join(", ")
}

const HOST_ABS = new RegExp(`(https?://${host.replace(/[.]/g, "\\.")})(/[^"'\\s<>)]*)`, "gi")

function rewrite(txt) {
  let out = txt
  // href/src/action="/x" and poster/data-* left alone (rare); cover the common set.
  out = out.replace(/\b(href|src|action)\s*=\s*"(\/[^"]*)"/gi, (m, attr, p) => `${attr}="${pfx(p)}"`)
  out = out.replace(/\b(href|src|action)\s*=\s*'(\/[^']*)'/gi, (m, attr, p) => `${attr}='${pfx(p)}'`)
  // srcset (responsive images)
  out = out.replace(/\bsrcset\s*=\s*"([^"]*)"/gi, (m, v) => `srcset="${rewriteSrcset(v)}"`)
  // absolute self-URLs: canonical, og:url, og:image, <loc>, RSS <link>, JSON-LD
  out = out.replace(HOST_ABS, (m, origin, p) => `${origin}${pfx(p)}`)
  // inline CSS url(/x) (e.g. @font-face in critical CSS)
  out = out.replace(/url\(\s*(\/[^)"']*)\s*\)/gi, (m, p) => `url(${pfx(p)})`)
  out = out.replace(/url\(\s*"(\/[^"]*)"\s*\)/gi, (m, p) => `url("${pfx(p)}")`)
  return out
}

let files = 0
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(html|xml|txt)$/.test(p)) {
      const before = readFileSync(p, "utf8")
      const after = rewrite(before)
      if (after !== before) {
        writeFileSync(p, after)
        files++
      }
    }
  }
}

walk(dist)
console.log(`base-path rewrite: prefixed internal URLs with ${BASE} in ${files} file(s)`)
