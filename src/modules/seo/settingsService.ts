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
import { SEO_SAFETY_OVERRIDE_PHRASE } from "./safety"
import { siteDbFor, dispatchRebuild } from "./service"

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
