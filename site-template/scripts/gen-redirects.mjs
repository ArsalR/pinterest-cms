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
  const defaults = { blockAiBots: false, blockedBots: [], disallowPaths: [], robotsExtra: "", scripts: [], profiles: [] }
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

// ─────────── Child sitemaps (V1.3 profiles): join Astro's sitemap index ───────────
// News (and later image) sitemaps are separate files; they're referenced from
// the generated sitemap-index so everything composes under ONE index. No
// profile on → index untouched (byte-identical).
import { existsSync } from "node:fs"
function addChildSitemap(childFile) {
  const childUrl = `https://${to}/${childFile}`
  const idxUrl = new URL("../dist/sitemap-index.xml", import.meta.url)
  const childPath = new URL(`../dist/${childFile}`, import.meta.url)
  if (!existsSync(idxUrl.pathname) || !existsSync(childPath.pathname)) return false
  let idx = readFileSync(idxUrl, "utf8")
  if (idx.includes(`<loc>${childUrl}</loc>`)) return true
  idx = idx.replace("</sitemapindex>", `<sitemap><loc>${childUrl}</loc></sitemap></sitemapindex>`)
  writeFileSync(idxUrl, idx)
  console.log(`sitemap-index: added ${childFile}`)
  return true
}
if ((seoSettings.profiles ?? []).includes("news")) addChildSitemap("news-sitemap.xml")
if ((seoSettings.profiles ?? []).includes("image")) addChildSitemap("image-sitemap.xml")

// ─────────── Vetted site scripts (V1.3): budget gate + CSP + zero-JS manifest ───────────
// Mirrors src/lib/cms.ts TEMPLATE_SCRIPT_CATALOG / src/modules/seo/scripts.ts.
// The budget gate here is DEPLOY-BLOCKING (exit 1) — same plain-language report
// as the dashboard, enforced independently so nothing can sneak past it.
const SCRIPT_META = {
  plausible: { name: "Plausible Analytics", costKb: 1, cfg: /^[a-z0-9.-]+\.[a-z]{2,}$/i, scriptHosts: ["https://plausible.io"], connectHosts: ["https://plausible.io"], loader: false },
  fathom: { name: "Fathom Analytics", costKb: 2, cfg: /^[A-Z0-9]{8}$/i, scriptHosts: ["https://cdn.usefathom.com"], connectHosts: ["https://cdn.usefathom.com"], loader: false },
  ga4: { name: "Google Analytics 4", costKb: 55, cfg: /^G-[A-Z0-9]{6,12}$/i, scriptHosts: ["https://www.googletagmanager.com"], connectHosts: ["https://www.google-analytics.com", "https://analytics.google.com"], loader: true },
  crisp: { name: "Crisp chat widget", costKb: 35, cfg: /^[a-f0-9-]{36}$/i, scriptHosts: ["https://client.crisp.chat"], connectHosts: ["https://client.crisp.chat", "wss://client.relay.crisp.chat"], loader: true },
  cookieyes: { name: "CookieYes consent banner", costKb: 40, cfg: /^[a-z0-9]{10,40}$/i, scriptHosts: ["https://cdn-cookieyes.com"], connectHosts: ["https://cdn-cookieyes.com", "https://log.cookieyes.com"], loader: false },
  // V1.5 M4 ad pixels — loader-mode (injected on interaction, consent-gated).
  meta_pixel: { name: "Meta Pixel", costKb: 30, cfg: /^\d{15,16}$/, scriptHosts: ["https://connect.facebook.net"], connectHosts: ["https://www.facebook.com"], loader: true },
  google_ads: { name: "Google Ads tag", costKb: 55, cfg: /^AW-[0-9]{9,12}$/i, scriptHosts: ["https://www.googletagmanager.com"], connectHosts: ["https://www.google-analytics.com", "https://www.googleadservices.com", "https://googleads.g.doubleclick.net"], loader: true },
  tiktok_pixel: { name: "TikTok Pixel", costKb: 45, cfg: /^[A-Z0-9]{16,24}$/i, scriptHosts: ["https://analytics.tiktok.com"], connectHosts: ["https://analytics.tiktok.com"], loader: true },
  linkedin_insight: { name: "LinkedIn Insight Tag", costKb: 25, cfg: /^[0-9]{5,9}$/, scriptHosts: ["https://snap.licdn.com"], connectHosts: ["https://px.ads.linkedin.com"], loader: true },
  pinterest_tag: { name: "Pinterest Tag", costKb: 15, cfg: /^\d{13}$/, scriptHosts: ["https://s.pinimg.com"], connectHosts: ["https://ct.pinterest.com"], loader: true },
}
const SCRIPT_BUDGET_KB = 100

const enabledScripts = (seoSettings.scripts ?? []).filter(
  (s) => SCRIPT_META[s.id] && SCRIPT_META[s.id].cfg.test(String(s.config ?? ""))
)
if (enabledScripts.length) {
  const totalKb = enabledScripts.reduce((sum, s) => sum + SCRIPT_META[s.id].costKb, 0)
  if (totalKb > SCRIPT_BUDGET_KB) {
    const names = enabledScripts.map((s) => `${SCRIPT_META[s.id].name} (~${SCRIPT_META[s.id].costKb}KB)`).join(", ")
    console.error(
      `SCRIPT BUDGET GATE FAILED — enabled scripts weigh ~${totalKb}KB, over the ${SCRIPT_BUDGET_KB}KB budget that keeps pages fast.\n` +
        `Enabled: ${names}.\nTurn one off in the dashboard (Site scripts) — or pick a lighter alternative (e.g. Plausible ~1KB instead of GA4 ~55KB) — and redeploy.`
    )
    process.exit(1)
  }

  // Zero-JS gate manifest: exactly which hosts (and the local loader) the
  // enabled set sanctions. Absent when nothing is enabled.
  const scriptHosts = [...new Set(enabledScripts.flatMap((s) => SCRIPT_META[s.id].scriptHosts))]
  const connectHosts = [...new Set(enabledScripts.flatMap((s) => SCRIPT_META[s.id].connectHosts))]
  const allowLoader = enabledScripts.some((s) => SCRIPT_META[s.id].loader)
  writeFileSync(
    new URL("../dist/.site-scripts.json", import.meta.url),
    JSON.stringify({ scriptHosts, allowLoader }, null, 2) + "\n"
  )

  // Extend the CSP in dist/_headers for exactly the enabled hosts. Untouched
  // when nothing is enabled (byte-identical _headers).
  const headersUrl = new URL("../dist/_headers", import.meta.url)
  let headersTxt = readFileSync(headersUrl, "utf8")
  headersTxt = headersTxt.replace(/(script-src [^;]*)/, (m) => `${m} ${scriptHosts.join(" ")}`)
  headersTxt = headersTxt.replace(/(connect-src [^;]*)/, (m) => `${m} ${connectHosts.join(" ")}`)
  writeFileSync(headersUrl, headersTxt)
  console.log(`site-scripts: ${enabledScripts.map((s) => s.id).join(", ")} (~${totalKb}KB of ${SCRIPT_BUDGET_KB}KB) — CSP extended, manifest written`)
}

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
