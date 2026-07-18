// Zero-JS by default (Performance Covenant P1): no client framework, no
// islands unless a future component explicitly opts in.
import { defineConfig } from "astro/config"
import sitemap from "@astrojs/sitemap"
import { readFileSync } from "node:fs"

const config = JSON.parse(readFileSync(new URL("./site.config.json", import.meta.url), "utf8"))
const canonicalHost = config.canonicalHost === "www" ? `www.${config.domain}` : config.domain

// Sitemap exclusions (V1.2 S3): posts flagged sitemap_exclude in the SEO cockpit
// are dropped from the sitemap. Best-effort — on any error nothing is excluded,
// so the sitemap is byte-identical to today's for an unconfigured site.
async function excludedSitemapUrls() {
  const key = process.env.CMS_API_KEY
  const set = new Set()
  if (!key || !config.cmsApiUrl) return set
  try {
    const resp = await fetch(`${config.cmsApiUrl}/seo`, { headers: { Authorization: `Bearer ${key}` } })
    if (!resp.ok) return set
    const data = await resp.json()
    for (const s of data.seo ?? []) {
      if (s.sitemapExclude && s.slug) set.add(`https://${canonicalHost}/posts/${s.slug}/`)
    }
  } catch {
    /* keep the set empty — sitemap unchanged */
  }
  return set
}

const excluded = await excludedSitemapUrls()

export default defineConfig({
  site: `https://${canonicalHost}`,
  integrations: [sitemap({ filter: (page) => !excluded.has(page) })],
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
