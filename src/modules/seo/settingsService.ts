// src/modules/seo/settingsService.ts
// Data layer for the Site SEO Control Center (S3). Reads/writes the single
// seo_settings row directly in the site CMS DB (same direct-write pattern as
// the cockpit). A missing row → DEFAULT_SEO_SETTINGS (byte-identical). Saving a
// config that would block a major search engine is refused unless the operator
// passes the SEO-safety override phrase (safety rail #2), which the caller
// audit-logs. Every save triggers a covenant-gated rebuild (rail #1).

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import {
  DEFAULT_SEO_SETTINGS, robotsWouldBlockMajorEngines, type SeoSettings,
} from "./settings"
import { parseProfiles, type ProfileId } from "./profiles"
import { parseEnabledScripts, checkScriptBudget, type EnabledScript } from "./scripts"
import { SEO_SAFETY_OVERRIDE_PHRASE } from "./safety"
import { siteDbFor, dispatchRebuild } from "./service"
import { generateAnalyticsToken } from "../../lib/auth"

function arr(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return []
  try {
    const a = JSON.parse(raw) as unknown
    return Array.isArray(a) ? a.map((x) => String(x)).filter(Boolean) : []
  } catch {
    return []
  }
}

/** Load a site's SEO settings, or the defaults when no row exists. */
export async function loadSeoSettings(master: Client, cmsSiteId: string): Promise<SeoSettings> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { ...DEFAULT_SEO_SETTINGS }
  let rows
  try {
    const r = await siteDb.execute({ sql: "SELECT * FROM seo_settings WHERE id = 'default' LIMIT 1", args: [] })
    rows = r.rows
  } catch {
    return { ...DEFAULT_SEO_SETTINGS } // table not migrated yet on this site
  }
  if (!rows.length) return { ...DEFAULT_SEO_SETTINGS }
  const p = rows[0]
  return {
    profiles: parseProfiles(p.profiles),
    scripts: parseEnabledScripts(p.scripts),
    blockAiBots: Number(p.block_ai_bots) === 1,
    blockedBots: arr(p.blocked_bots),
    disallowPaths: arr(p.disallow_paths),
    robotsExtra: (p.robots_extra as string | null) ?? "",
    rssEnabled: Number(p.rss_enabled) === 1,
    archivesEnabled: Number(p.archives_enabled) === 1,
    globalSchemaEnabled: Number(p.global_schema_enabled) === 1,
    orgName: (p.org_name as string | null) ?? "",
    orgLogo: (p.org_logo as string | null) ?? "",
    socialProfiles: arr(p.social_profiles),
    pixelConsent: p.pixel_consent == null ? undefined : Number(p.pixel_consent) === 1,
  }
}

export interface SaveSettingsResult {
  ok: boolean
  error?: string
  /** True when a major-engine block was applied under a valid typed override. */
  overrodeEngineBlock?: boolean
}

/**
 * Persist a site's SEO settings. If the config would block a major search
 * engine, the caller must pass a matching `typedOverride` — otherwise the save
 * is refused. Returns overrodeEngineBlock so the route can audit-log the
 * override.
 */
export async function saveSeoSettings(
  env: CloudflareEnv,
  customerId: string,
  cmsSiteId: string,
  repoFullName: string | null,
  next: SeoSettings,
  master: Client,
  typedOverride?: string | null
): Promise<SaveSettingsResult> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { ok: false, error: "The content workspace is unavailable." }

  const wouldBlock = robotsWouldBlockMajorEngines(next)
  const overrideOk = (typedOverride ?? "").trim() === SEO_SAFETY_OVERRIDE_PHRASE
  if (wouldBlock && !overrideOk) {
    return {
      ok: false,
      error: `This would hide your site from major search engines. If you're sure, type "${SEO_SAFETY_OVERRIDE_PHRASE}" to confirm.`,
    }
  }

  await siteDb.execute({
    sql: `INSERT INTO seo_settings
            (id, block_ai_bots, blocked_bots, disallow_paths, robots_extra,
             rss_enabled, archives_enabled, global_schema_enabled, org_name, org_logo, social_profiles, updated_at)
          VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            block_ai_bots=excluded.block_ai_bots, blocked_bots=excluded.blocked_bots,
            disallow_paths=excluded.disallow_paths, robots_extra=excluded.robots_extra,
            rss_enabled=excluded.rss_enabled,
            archives_enabled=excluded.archives_enabled, global_schema_enabled=excluded.global_schema_enabled,
            org_name=excluded.org_name, org_logo=excluded.org_logo, social_profiles=excluded.social_profiles,
            updated_at=datetime('now')`,
    args: [
      next.blockAiBots ? 1 : 0,
      JSON.stringify(next.blockedBots),
      JSON.stringify(next.disallowPaths),
      next.robotsExtra.trim() || null,
      next.rssEnabled ? 1 : 0,
      next.archivesEnabled ? 1 : 0,
      next.globalSchemaEnabled ? 1 : 0,
      next.orgName.trim() || null,
      next.orgLogo.trim() || null,
      JSON.stringify(next.socialProfiles),
    ],
  })

  await dispatchRebuild(env, master, customerId, repoFullName, "seo-settings")
  return { ok: true, overrodeEngineBlock: wouldBlock && overrideOk }
}

/**
 * Persist the site's SEO profile activations (V1.3). Touches ONLY the profiles
 * column — the Control Center's other settings are never clobbered — then
 * triggers a covenant-gated rebuild.
 */
export async function saveProfiles(
  env: CloudflareEnv,
  customerId: string,
  cmsSiteId: string,
  repoFullName: string | null,
  profiles: ProfileId[],
  master: Client
): Promise<{ ok: boolean; error?: string }> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { ok: false, error: "The content workspace is unavailable." }
  await siteDb.execute({
    sql: `INSERT INTO seo_settings (id, profiles, updated_at) VALUES ('default', ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET profiles = excluded.profiles, updated_at = datetime('now')`,
    args: [JSON.stringify(profiles)],
  })
  await dispatchRebuild(env, master, customerId, repoFullName, "seo-profiles")
  return { ok: true }
}

/**
 * Persist the vetted-script enablements (V1.3, decision #2). The covenant
 * budget gate runs HERE first — an over-budget selection refuses to save with
 * the plain-language report (and the template build enforces the same gate
 * independently, deploy-blocking). Touches only the scripts column.
 */
export async function saveScripts(
  env: CloudflareEnv,
  customerId: string,
  cmsSiteId: string,
  repoFullName: string | null,
  scripts: EnabledScript[],
  master: Client
): Promise<{ ok: boolean; error?: string }> {
  const budget = checkScriptBudget(scripts)
  if (!budget.ok) return { ok: false, error: budget.report }
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { ok: false, error: "The content workspace is unavailable." }
  await siteDb.execute({
    sql: `INSERT INTO seo_settings (id, scripts, updated_at) VALUES ('default', ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET scripts = excluded.scripts, updated_at = datetime('now')`,
    args: [JSON.stringify(scripts)],
  })
  await dispatchRebuild(env, master, customerId, repoFullName, "site-scripts")
  return { ok: true }
}

/**
 * Persist the EU consent-mode preference for ad pixels (V1.5 M4). Tri-state:
 *   undefined → auto (NULL: ON when a consent-requiring pixel is enabled),
 *   true → forced ON, false → forced OFF. Touches only the pixel_consent column,
 *   then triggers a covenant-gated rebuild so the banner/gating reflects it.
 */
export async function savePixelConsent(
  env: CloudflareEnv,
  customerId: string,
  cmsSiteId: string,
  repoFullName: string | null,
  pref: boolean | undefined,
  master: Client
): Promise<{ ok: boolean; error?: string }> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { ok: false, error: "The content workspace is unavailable." }
  const value = pref === undefined ? null : pref ? 1 : 0
  await siteDb.execute({
    sql: `INSERT INTO seo_settings (id, pixel_consent, updated_at) VALUES ('default', ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET pixel_consent = excluded.pixel_consent, updated_at = datetime('now')`,
    args: [value],
  })
  await dispatchRebuild(env, master, customerId, repoFullName, "pixel-consent")
  return { ok: true }
}

/**
 * Toggle first-party analytics (V1.5 M3). Enabling mints a public site token
 * (kept stable across re-enables), writes analytics_enabled + analytics_key into
 * the site's CMS seo_settings so the static build embeds the beacon, AND mirrors
 * the token into master customer_sites so the ingest endpoint can resolve it
 * without a hostname. Disabling clears the master token (ingest immediately
 * rejects) and flips the build flag off. Either way a covenant-gated rebuild
 * runs so the beacon appears/disappears. Off = byte-identical zero-JS.
 */
export async function saveAnalytics(
  env: CloudflareEnv,
  customerId: string,
  cmsSiteId: string,
  repoFullName: string | null,
  enabled: boolean,
  master: Client,
): Promise<{ ok: boolean; error?: string }> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { ok: false, error: "The content workspace is unavailable." }

  // Reuse an existing token so re-enabling doesn't orphan historical data.
  let token = ""
  try {
    const r = await siteDb.execute({ sql: "SELECT analytics_key FROM seo_settings WHERE id = 'default' LIMIT 1", args: [] })
    token = String(r.rows[0]?.analytics_key ?? "")
  } catch { /* table not migrated yet → mint fresh below */ }
  if (enabled && !token) token = generateAnalyticsToken()

  await siteDb.execute({
    sql: `INSERT INTO seo_settings (id, analytics_enabled, analytics_key, updated_at)
          VALUES ('default', ?, ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            analytics_enabled = excluded.analytics_enabled,
            analytics_key = excluded.analytics_key,
            updated_at = datetime('now')`,
    args: [enabled ? 1 : 0, token || null],
  })

  // Master mirror: only the ACTIVE token is stored (null when off) so the public
  // ingest resolves a token only while the owner has analytics turned on.
  await master.execute({
    sql: "UPDATE customer_sites SET analytics_key = ? WHERE cms_site_id = ? AND customer_id = ?",
    args: [enabled ? token : null, cmsSiteId, customerId],
  })

  await dispatchRebuild(env, master, customerId, repoFullName, "analytics")
  return { ok: true }
}
