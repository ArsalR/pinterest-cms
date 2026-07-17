// Covenant S2 gate: the built output must carry the security-header file with
// every required header. Fail = deploy blocked.
import { readFileSync } from "node:fs"

const REQUIRED = [
  "Content-Security-Policy",
  "Strict-Transport-Security",
  "X-Content-Type-Options",
  "Referrer-Policy",
  "Permissions-Policy",
]

let headers
try {
  headers = readFileSync(new URL("../dist/_headers", import.meta.url), "utf8")
} catch {
  console.error("SECURITY-HEADER GATE FAILED — dist/_headers is missing from the build output.")
  process.exit(1)
}

const missing = REQUIRED.filter((h) => !headers.includes(h))
if (missing.length) {
  console.error("SECURITY-HEADER GATE FAILED — missing:", missing.join(", "))
  process.exit(1)
}

// Production must be UNFRAMEABLE. The dashboard's preview-window feature relaxes
// frame-ancestors on the *preview* worker only (claude.yml preview step); this
// gate runs on the production deploy path (deploy.yml) and blocks any build
// whose framing protection was weakened — a preview-flavored _headers can never
// reach production.
if (!headers.includes("frame-ancestors 'none'")) {
  console.error("SECURITY-HEADER GATE FAILED — production CSP must keep frame-ancestors 'none' (found a relaxed/preview value).")
  process.exit(1)
}
if (!headers.includes("X-Frame-Options: DENY")) {
  console.error("SECURITY-HEADER GATE FAILED — production must keep X-Frame-Options: DENY.")
  process.exit(1)
}
console.log("security-header gate: OK (incl. production-unframeable assertion)")
