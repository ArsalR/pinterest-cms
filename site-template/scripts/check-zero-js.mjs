// Covenant P1 gate: built pages must ship NO client-side JavaScript.
// Inline application/ld+json is data, not script, and is allowed.
// Fails the build (exit 1) on any other <script> in any built HTML page.
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const dist = new URL("../dist", import.meta.url).pathname
const offenders = []

// Precisely-scoped script allowlist — everything else = deploy blocked (P1/P7):
//  - Turnstile widget, ONLY on /contact/ (K1 spam protection)
//  - /cart.js, ONLY on the ecommerce cart pages (amendment 2: the cart is the
//    ONE JS island) — product, shop, and cart pages
//  - /order-complete.js, ONLY on /order/ pages (clears the cart post-purchase)
const TURNSTILE = /src\s*=\s*["']https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js["']/i
const CART_JS = /src\s*=\s*["']\/cart\.js["']/i
const ORDER_JS = /src\s*=\s*["']\/order-complete\.js["']/i

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (p.endsWith(".html")) {
      const html = readFileSync(p, "utf8")
      const rel = p.replace(dist, "")
      const isContact = /^\/contact\//.test(rel)
      const isCartPage = /^\/(products\/|shop\/|cart\/)/.test(rel)
      const isOrderPage = /^\/order\//.test(rel)
      const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0])
      const bad = scripts.filter(
        (tag) =>
          !/type\s*=\s*["']application\/ld\+json["']/i.test(tag) &&
          !(isContact && TURNSTILE.test(tag)) &&
          !(isCartPage && CART_JS.test(tag)) &&
          !(isOrderPage && ORDER_JS.test(tag))
      )
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
