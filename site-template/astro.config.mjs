// Zero-JS by default (Performance Covenant P1): no client framework, no
// islands unless a future component explicitly opts in.
import { defineConfig } from "astro/config"
import sitemap from "@astrojs/sitemap"
import { readFileSync } from "node:fs"

const config = JSON.parse(readFileSync(new URL("./site.config.json", import.meta.url), "utf8"))
const canonicalHost = config.canonicalHost === "www" ? `www.${config.domain}` : config.domain

export default defineConfig({
  site: `https://${canonicalHost}`,
  integrations: [sitemap()],
  build: { inlineStylesheets: "always" }, // critical CSS inlined (P5)
})
