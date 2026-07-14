// scripts/check-module-boundaries.mjs
// Structure-covenant lint (amendment 3): cross-module imports must go through
// a module's PUBLIC INDEX barrel, never reach into its internal files.
//
// Rule for any file under src/modules/<self>/…:
//   importing a sibling module   → "../<other>"          OK (barrel)
//                                 → "../<other>/anything" VIOLATION (deep import)
// Within the same module ("./x") and CMS-core/shared imports are unrestricted.
// Deploy-blocking: exit 1 on any violation.

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const MODULES_DIR = new URL("../src/modules", import.meta.url).pathname
const moduleNames = new Set(
  readdirSync(MODULES_DIR).filter((n) => statSync(join(MODULES_DIR, n)).isDirectory())
)

const violations = []

function walk(dir, self) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, self)
    else if (p.endsWith(".ts")) checkFile(p, self)
  }
}

function checkFile(file, self) {
  const src = readFileSync(file, "utf8")
  const importRe = /from\s+["'](\.\.\/[^"']+)["']/g
  let m
  while ((m = importRe.exec(src))) {
    const spec = m[1] // e.g. "../connections/github" or "../vault"
    const parts = spec.split("/") // ["..", "connections", "github"]
    const target = parts[1]
    if (!moduleNames.has(target)) continue // ../../lib, ../../shared, etc.
    if (target === self) continue // shouldn't happen (same module uses ./)
    if (parts.length > 2) {
      violations.push(`${file.replace(MODULES_DIR + "/", "modules/")}: imports "${spec}" — reach into module '${target}'; use the barrel "../${target}" instead`)
    }
  }
}

for (const mod of moduleNames) walk(join(MODULES_DIR, mod), mod)

if (violations.length) {
  console.error("MODULE-BOUNDARY GATE FAILED — cross-module imports must use the public index:")
  for (const v of violations) console.error("  " + v)
  process.exit(1)
}
console.log(`module-boundary gate: OK (${moduleNames.size} modules, barrel imports only)`)
