// Post-build config-derived files: dist/_redirects (301 the non-canonical
// host — apex ↔ www, wizard choice) and dist/robots.txt (canonical sitemap
// reference — part of the deploy-blocking SEO file set, amendment 3).
import { readFileSync, writeFileSync } from "node:fs"

const config = JSON.parse(readFileSync(new URL("../site.config.json", import.meta.url), "utf8"))
const apex = config.domain
const www = `www.${config.domain}`
const [from, to] = config.canonicalHost === "www" ? [apex, www] : [www, apex]

writeFileSync(
  new URL("../dist/_redirects", import.meta.url),
  `https://${from}/* https://${to}/:splat 301\n`
)
console.log(`_redirects: ${from} -> ${to} (301)`)

writeFileSync(
  new URL("../dist/robots.txt", import.meta.url),
  `User-agent: *\nAllow: /\n\nSitemap: https://${to}/sitemap-index.xml\n`
)
console.log(`robots.txt: sitemap -> https://${to}/sitemap-index.xml`)
