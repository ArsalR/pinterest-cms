// Covenant P1 gate: built pages must ship NO client-side JavaScript.
// Inline application/ld+json is data, not script, and is allowed.
// Fails the build (exit 1) on any other <script> in any built HTML page.
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const dist = new URL("../dist", import.meta.url).pathname
const offenders = []

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (p.endsWith(".html")) {
      const html = readFileSync(p, "utf8")
      const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0])
      const bad = scripts.filter((tag) => !/type\s*=\s*["']application\/ld\+json["']/i.test(tag))
      if (bad.length) offenders.push(`${p.replace(dist, "")}: ${bad.join(" ")}`)
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
