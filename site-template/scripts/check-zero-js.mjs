// Covenant P1 gate: built pages must ship NO client-side JavaScript.
// Inline application/ld+json is data, not script, and is allowed.
// Fails the build (exit 1) on any other <script> in any built HTML page.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"

const dist = new URL("../dist", import.meta.url).pathname
const scriptsDir = new URL(".", import.meta.url).pathname
const offenders = []

// V1.5 M5: on a subdirectory site the base-path rewrite prefixes local script
// srcs (/a.js → /blog/a.js). Strip the base before matching the path-based
// allowlists below so the same sanctioned scripts stay allowed. "" = no-op.
const bpCfg = JSON.parse(readFileSync(new URL("../site.config.json", import.meta.url), "utf8"))
const BASE = (() => {
  const b = (bpCfg.basePath ?? "").trim()
  return !b || b === "/" ? "" : "/" + b.replace(/^\/+|\/+$/g, "").toLowerCase()
})()
const unbase = (tag) => (BASE ? tag.split(`"${BASE}/`).join('"/').split(`'${BASE}/`).join("'/") : tag)

// V1.5 M3 (Amendment 4a): EXACTLY ONE first-party analytics beacon is allowed —
// the file /a.js, and ONLY if its content hash matches the pinned value in
// scripts/beacon.sha256 AND it stays <= 2 KB gzipped. Any edit to the beacon
// changes its hash and blocks the deploy until beacon.sha256 is regenerated
// deliberately. Every other script is still blocked.
const BEACON_SRC = /src\s*=\s*["']\/a\.js["']/i
const beaconExpected = existsSync(join(scriptsDir, "beacon.sha256")) ? readFileSync(join(scriptsDir, "beacon.sha256"), "utf8").trim() : ""
let beaconOk = false
const beaconFile = join(dist, "a.js")
if (beaconExpected && existsSync(beaconFile)) {
  const bytes = readFileSync(beaconFile)
  const hash = createHash("sha256").update(bytes).digest("hex")
  const gz = gzipSync(bytes).length
  beaconOk = hash === beaconExpected && gz <= 2048
  if (!beaconOk) {
    if (hash !== beaconExpected) offenders.push(`/a.js: beacon hash mismatch (edit the beacon? regenerate scripts/beacon.sha256)`)
    else offenders.push(`/a.js: beacon is ${gz} bytes gzipped — exceeds the 2 KB budget (Amendment 4a)`)
  }
}

// Precisely-scoped script allowlist — everything else = deploy blocked (P1/P7):
//  - Turnstile widget, ONLY on /contact/ (K1 spam protection)
//  - /cart.js, ONLY on the ecommerce cart pages (amendment 2: the cart is the
//    ONE JS island) — product, shop, and cart pages
//  - /order-complete.js, ONLY on /order/ pages (clears the cart post-purchase)
const TURNSTILE = /src\s*=\s*["']https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js["']/i
const CART_JS = /src\s*=\s*["']\/cart\.js["']/i
const ORDER_JS = /src\s*=\s*["']\/order-complete\.js["']/i

// V1.3 script controls: the build emits dist/.site-scripts.json ONLY when the
// customer enabled vetted catalog scripts (budget-gated in gen-redirects.mjs).
// Those exact hosts — and the local loader — become sanctioned on all pages.
// No manifest = today's exact zero-JS behavior.
let sanctioned = { scriptHosts: [], allowLoader: false }
try {
  sanctioned = JSON.parse(readFileSync(join(dist, ".site-scripts.json"), "utf8"))
} catch {
  /* no scripts enabled */
}
const LOADER_JS = /src\s*=\s*["']\/js\/site-scripts\.js["']/i
function isSanctionedScript(tag) {
  const m = /src\s*=\s*["']([^"']+)["']/i.exec(tag)
  if (!m) return false
  if (sanctioned.allowLoader && LOADER_JS.test(tag)) return true
  return (sanctioned.scriptHosts ?? []).some((h) => m[1].startsWith(h + "/") || m[1].startsWith(h + "?") || m[1] === h)
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (p.endsWith(".html")) {
      const html = readFileSync(p, "utf8")
      const rel = p.replace(dist, "")
      const isContact = /^\/contact\//.test(rel)
      // V1.4 Forms Engine: form pages and pages with an embedded form carry
      // the SAME single allowed widget script (Turnstile) as /contact/.
      const isFormPage = /^\/forms\//.test(rel) || html.includes('class="cf-turnstile"')
      const isCartPage = /^\/(products\/|shop\/|cart\/)/.test(rel)
      const isOrderPage = /^\/order\//.test(rel)
      const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0])
      const bad = scripts.filter((raw) => {
        const tag = unbase(raw) // strip the /blog base so path allowlists still match
        return (
          !/type\s*=\s*["']application\/ld\+json["']/i.test(tag) &&
          !((isContact || isFormPage) && TURNSTILE.test(tag)) &&
          !(isCartPage && CART_JS.test(tag)) &&
          !(isOrderPage && ORDER_JS.test(tag)) &&
          !(BEACON_SRC.test(tag) && beaconOk) && // Amendment 4a: only the hash-verified beacon
          !isSanctionedScript(tag)
        )
      })
      if (bad.length) offenders.push(`${rel}: ${bad.join(" ")}`)
    }
  }
}

walk(dist)
if (offenders.length) {
  console.error("ZERO-JS GATE FAILED — client JavaScript found in built pages:")
  for (const o of offenders) console.error("  " + o)
  console.error("If a component truly needs JS, make it an explicit Astro island and update this gate deliberately.")
  process.exit(1)
}
console.log("zero-js gate: OK (no client scripts in built HTML)")
