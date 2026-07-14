// Amendment 3 gate: the deploy-blocking SEO file set. Every generated site's
// build must contain these files or it does not deploy.
import { statSync } from "node:fs"

const REQUIRED = [
  "index.html",        // homepage rendered
  "robots.txt",        // crawler policy + sitemap pointer
  "sitemap-index.xml", // sitemap (Astro integration)
  "llms.txt",          // AI-visibility summary (K8)
  "_headers",          // security headers (S2)
  "_redirects",        // canonical-host 301
]

const missing = REQUIRED.filter((f) => {
  try {
    return !statSync(new URL(`../dist/${f}`, import.meta.url)).isFile()
  } catch {
    return true
  }
})

if (missing.length) {
  console.error("SEO-FILE GATE FAILED — missing from the build:", missing.join(", "))
  process.exit(1)
}
console.log("seo-file gate: OK (" + REQUIRED.join(", ") + ")")
