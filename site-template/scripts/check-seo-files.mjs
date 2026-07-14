// Amendment 3 gate: the deploy-blocking SEO file set + per-page SEO tags.
// Every generated site's build must satisfy ALL of the below or it does not
// deploy. Runs against the built dist/.
import { statSync, readFileSync } from "node:fs"

const dist = (f) => new URL(`../dist/${f}`, import.meta.url)

// 1. Required files.
const REQUIRED_FILES = [
  "index.html",        // homepage rendered
  "404.html",          // custom 404 (wrangler not_found_handling)
  "robots.txt",        // crawler policy + sitemap pointer
  "sitemap-index.xml", // sitemap (Astro integration)
  "rss.xml",           // RSS 2.0 feed
  "llms.txt",          // AI-visibility summary (K8)
  "site.webmanifest",  // PWA manifest
  "favicon.svg",       // favicon
  "_headers",          // security headers (S2)
  "_redirects",        // canonical-host 301
]

const missing = REQUIRED_FILES.filter((f) => {
  try { return !statSync(dist(f)).isFile() } catch { return true }
})

// 2. Per-page SEO tags — checked on the representative homepage.
let tagFailures = []
try {
  const html = readFileSync(dist("index.html"), "utf8")
  const TAGS = [
    { name: "canonical link", re: /<link[^>]+rel=["']canonical["']/i },
    { name: "og:title", re: /<meta[^>]+property=["']og:title["']/i },
    { name: "og:type", re: /<meta[^>]+property=["']og:type["']/i },
    { name: "og:url", re: /<meta[^>]+property=["']og:url["']/i },
    { name: "twitter:card", re: /<meta[^>]+name=["']twitter:card["']/i },
    { name: "JSON-LD", re: /<script[^>]+type=["']application\/ld\+json["']/i },
    { name: "manifest link", re: /<link[^>]+rel=["']manifest["']/i },
    { name: "RSS alternate link", re: /<link[^>]+type=["']application\/rss\+xml["']/i },
  ]
  tagFailures = TAGS.filter((t) => !t.re.test(html)).map((t) => t.name)
} catch {
  tagFailures = ["(could not read index.html)"]
}

const problems = []
if (missing.length) problems.push("missing files: " + missing.join(", "))
if (tagFailures.length) problems.push("missing homepage tags: " + tagFailures.join(", "))

if (problems.length) {
  console.error("SEO GATE FAILED —")
  for (const p of problems) console.error("  " + p)
  process.exit(1)
}
console.log("seo gate: OK (" + REQUIRED_FILES.length + " files + canonical/OG/Twitter/JSON-LD/manifest/RSS tags)")
