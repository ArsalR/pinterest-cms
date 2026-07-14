// Emit dist/_redirects from site.config.json: 301 the non-canonical host to
// the canonical one (apex ↔ www, wizard choice). Static-pure — no worker code.
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
