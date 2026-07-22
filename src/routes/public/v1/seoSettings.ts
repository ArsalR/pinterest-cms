// src/routes/public/v1/seoSettings.ts
// V1.2 S3 — per-site SEO Control Center record (additive endpoint). The site
// template reads this at build to emit robots.txt, toggle feeds/archives, and
// inject global schema. Read-only, Bearer-authed, same conventions as /v1.
// A site with no seo_settings row returns the defaults, so the build stays
// byte-identical until the customer configures anything.

import { Hono } from "hono"
import type { AppEnv } from "../../../lib/types"
import { validateApiKey, logApiRequest } from "../../../lib/apiAuth"
import { apiError } from "../../../lib/errors"

export const seoSettingsRoutes = new Hono<AppEnv>()

function jsonArr(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return []
  try {
    const a = JSON.parse(raw) as unknown
    return Array.isArray(a) ? a.map((x) => String(x)).filter(Boolean) : []
  } catch {
    return []
  }
}

// GET /v1/seo-settings — the site's SEO Control Center config (or defaults).
seoSettingsRoutes.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const auth = await validateApiKey(siteDb, c.req.raw, "read")
  if (auth.error) return apiError(c, auth.status, auth.code, auth.error)

  // Defaults mirror DEFAULT_SEO_SETTINGS — an unconfigured site is byte-identical.
  const defaults = {
    blockAiBots: false, blockedBots: [] as string[], disallowPaths: [] as string[],
    robotsExtra: "", rssEnabled: true, archivesEnabled: true,
    globalSchemaEnabled: false, orgName: "", orgLogo: "", socialProfiles: [] as string[],
    profiles: [] as string[],
    scripts: [] as Array<{ id: string; config: string }>,
    indexnowKey: "",
    imageLicense: null as null | { licenseUrl?: string; acquireLicenseUrl?: string; creatorName?: string },
    analyticsEnabled: false,
    analyticsKey: "",
  }
  // Valid profile/script ids — mirror src/modules/seo/{profiles,scripts}.ts
  // (CMS core stays dependency-clean of the SaaS modules, so the closed sets
  // are inlined; the template ALSO validates against its own catalog copy).
  const PROFILE_IDS = new Set(["local", "news", "ecommerce", "image", "ai"])
  const SCRIPT_IDS = new Set(["plausible", "fathom", "ga4", "crisp", "cookieyes"])
  const parseScripts = (raw: unknown): Array<{ id: string; config: string }> => {
    if (typeof raw !== "string" || !raw.trim()) return []
    try {
      const a = JSON.parse(raw) as Array<{ id?: unknown; config?: unknown }>
      if (!Array.isArray(a)) return []
      return a
        .map((v) => ({ id: String(v?.id ?? ""), config: String(v?.config ?? "").trim() }))
        .filter((v) => SCRIPT_IDS.has(v.id) && v.config)
    } catch {
      return []
    }
  }
  let settings = defaults
  try {
    const r = await siteDb.execute({ sql: "SELECT * FROM seo_settings WHERE id = 'default' LIMIT 1", args: [] })
    if (r.rows.length) {
      const p = r.rows[0]
      settings = {
        blockAiBots: Number(p.block_ai_bots) === 1,
        blockedBots: jsonArr(p.blocked_bots),
        disallowPaths: jsonArr(p.disallow_paths),
        robotsExtra: (p.robots_extra as string | null) ?? "",
        rssEnabled: Number(p.rss_enabled) === 1,
        archivesEnabled: Number(p.archives_enabled) === 1,
        globalSchemaEnabled: Number(p.global_schema_enabled) === 1,
        orgName: (p.org_name as string | null) ?? "",
        orgLogo: (p.org_logo as string | null) ?? "",
        socialProfiles: jsonArr(p.social_profiles),
        profiles: jsonArr(p.profiles).filter((id) => PROFILE_IDS.has(id)),
        scripts: parseScripts(p.scripts),
        indexnowKey: String(p.indexnow_key ?? ""),
        analyticsEnabled: Number(p.analytics_enabled) === 1,
        analyticsKey: String(p.analytics_key ?? ""),
        imageLicense: (() => {
          try {
            const o = JSON.parse(String(p.image_license_json ?? "null")) as unknown
            return o && typeof o === "object" ? (o as { licenseUrl?: string; acquireLicenseUrl?: string; creatorName?: string }) : null
          } catch {
            return null
          }
        })(),
      }
    }
  } catch {
    // table not migrated on this site yet → defaults (byte-identical)
  }
  await logApiRequest(siteDb, auth.keyId, "/v1/seo-settings", "GET", 200)
  return c.json({ success: true, settings })
})
