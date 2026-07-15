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
  image: {
    // Image pipeline (Performance Covenant P3): remote CMS/R2 images are
    // optimized at build time (sharp) into AVIF/WebP responsive srcset with
    // explicit dimensions (zero CLS). Any https image host is allowed since
    // the CMS R2 domain is per-deployment.
    remotePatterns: [{ protocol: "https" }],
    service: { entrypoint: "astro/assets/services/sharp" },
  },
})
