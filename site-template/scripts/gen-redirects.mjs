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

// robots.txt (V1.2 S3) — from the SEO Control Center settings when configured,
// else today's exact allow-all + sitemap baseline (byte-identical). Mirrors
// src/modules/seo/settings.ts buildRobotsTxt().
const SITEMAP_URL = `https://${to}/sitemap-index.xml`
const AI_BOTS = [
  "GPTBot", "ChatGPT-User", "OAI-SearchBot", "CCBot", "Google-Extended",
  "anthropic-ai", "ClaudeBot", "Claude-Web", "PerplexityBot", "Bytespider",
  "Amazonbot", "Applebot-Extended", "Meta-ExternalAgent", "Diffbot", "cohere-ai",
]

function robotsIsDefault(s) {
  return !s.blockAiBots && (s.blockedBots ?? []).length === 0 &&
    (s.disallowPaths ?? []).length === 0 && String(s.robotsExtra ?? "").trim() === ""
}

function buildRobots(s) {
  if (robotsIsDefault(s)) return `User-agent: *\nAllow: /\n\nSitemap: ${SITEMAP_URL}\n`
  const lines = []
  const perBot = []
  if (s.blockAiBots) perBot.push(...AI_BOTS)
  for (const b of s.blockedBots ?? []) {
    const name = String(b).trim()
    if (name && !perBot.some((p) => p.toLowerCase() === name.toLowerCase())) perBot.push(name)
  }
  for (const bot of perBot) lines.push(`User-agent: ${bot}`, "Disallow: /", "")
  lines.push("User-agent: *")
  const paths = (s.disallowPaths ?? []).map((p) => String(p).trim()).filter(Boolean)
  if (paths.length) for (const p of paths) lines.push(`Disallow: ${p.startsWith("/") ? p : "/" + p}`)
  else lines.push("Allow: /")
  lines.push("")
  if (String(s.robotsExtra ?? "").trim()) lines.push(String(s.robotsExtra).trim(), "")
  lines.push(`Sitemap: ${SITEMAP_URL}`)
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "") + "\n"
}

async function loadSeoSettings() {
  const key = process.env.CMS_API_KEY
  const defaults = { blockAiBots: false, blockedBots: [], disallowPaths: [], robotsExtra: "" }
  if (!key || !config.cmsApiUrl) return defaults
  try {
    const resp = await fetch(`${config.cmsApiUrl}/seo-settings`, { headers: { Authorization: `Bearer ${key}` } })
    if (!resp.ok) return defaults
    const data = await resp.json()
    return { ...defaults, ...(data.settings ?? {}) }
  } catch {
    return defaults
  }
}

const seoSettings = await loadSeoSettings()
writeFileSync(new URL("../dist/robots.txt", import.meta.url), buildRobots(seoSettings))
console.log(`robots.txt: ${robotsIsDefault(seoSettings) ? "default (allow-all)" : "from SEO Control Center"} -> ${SITEMAP_URL}`)

// PWA manifest (SEO file set) — named + themed from config, SVG icon.
writeFileSync(
  new URL("../dist/site.webmanifest", import.meta.url),
  JSON.stringify(
    {
      name: config.name,
      short_name: config.name.slice(0, 12),
      description: config.niche,
      start_url: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#0a6152",
      icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml" }],
    },
    null,
    2
  ) + "\n"
)
console.log("site.webmanifest: generated")
