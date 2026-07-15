// src/modules/affiliate/service.ts
// Affiliate config storage + batch application. The config (affiliate domains +
// disclosure text) lives in the site's CMS `settings` table (key/value). "Scan"
// audits published posts read-only; "Apply" rewrites their content in place to
// be compliant (rel=sponsored/nofollow + disclosure) and triggers one rebuild.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { getMasterDb, getSiteDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { getConnection, installationToken, repositoryDispatch } from "../connections"
import { auditLinks, rewriteAffiliateLinks, type AffiliateConfig, DEFAULT_DISCLOSURE } from "./links"

const KEY_DOMAINS = "affiliate_domains"
const KEY_DISCLOSURE = "affiliate_disclosure"

async function siteDbFor(master: Client, cmsSiteId: string): Promise<Client | null> {
  const r = await master.execute({ sql: "SELECT turso_url, turso_token FROM sites WHERE id = ? LIMIT 1", args: [cmsSiteId] })
  if (!r.rows.length) return null
  return getSiteDb(r.rows[0].turso_url as string, r.rows[0].turso_token as string)
}

async function readSetting(siteDb: Client, key: string): Promise<string | null> {
  const r = await siteDb.execute({ sql: "SELECT value FROM settings WHERE key = ? LIMIT 1", args: [key] })
  return r.rows.length ? String(r.rows[0].value) : null
}

async function writeSetting(siteDb: Client, key: string, value: string): Promise<void> {
  await siteDb.execute({
    sql: "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [key, value],
  })
}

/** Parse the stored domains list (newline/comma separated) into clean hostnames. */
export function parseDomains(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "").toLowerCase())
    .filter(Boolean)
}

export async function loadConfig(master: Client, cmsSiteId: string): Promise<AffiliateConfig> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { affiliateDomains: [], disclosureText: DEFAULT_DISCLOSURE }
  const domains = (await readSetting(siteDb, KEY_DOMAINS)) ?? ""
  const disclosure = (await readSetting(siteDb, KEY_DISCLOSURE)) ?? DEFAULT_DISCLOSURE
  return { affiliateDomains: parseDomains(domains), disclosureText: disclosure }
}

export async function saveConfig(master: Client, cmsSiteId: string, domainsRaw: string, disclosure: string): Promise<void> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return
  await writeSetting(siteDb, KEY_DOMAINS, domainsRaw.trim())
  await writeSetting(siteDb, KEY_DISCLOSURE, (disclosure || DEFAULT_DISCLOSURE).trim())
}

export interface ScanResult {
  postsScanned: number
  affiliateLinks: number
  nonCompliant: number     // affiliate links missing rel=sponsored/nofollow
  postsMissingDisclosure: number
}

/** Read-only audit of every published post against the affiliate config. */
export async function scanPosts(master: Client, cmsSiteId: string, config: AffiliateConfig): Promise<ScanResult> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  const res: ScanResult = { postsScanned: 0, affiliateLinks: 0, nonCompliant: 0, postsMissingDisclosure: 0 }
  if (!siteDb || !config.affiliateDomains.length) return res
  const rows = await siteDb.execute({ sql: "SELECT content FROM posts WHERE published = 1 AND type = 'post'", args: [] })
  for (const row of rows.rows) {
    const html = String(row.content ?? "")
    res.postsScanned++
    const links = auditLinks(html, config).filter((l) => l.isAffiliate)
    if (!links.length) continue
    res.affiliateLinks += links.length
    res.nonCompliant += links.filter((l) => !l.compliant).length
    if (!html.includes("affiliate-disclosure")) res.postsMissingDisclosure++
  }
  return res
}

export interface ApplyResult {
  postsUpdated: number
  linksFixed: number
  disclosuresAdded: number
}

/**
 * Rewrite every published post to be affiliate-compliant, writing changes back
 * to the CMS and firing one rebuild. Idempotent — posts already compliant are
 * left untouched (no needless updates, no rebuild churn).
 */
export async function applyToAllPosts(
  env: CloudflareEnv,
  customerId: string,
  cmsSiteId: string,
  repoFullName: string | null,
  config: AffiliateConfig
): Promise<ApplyResult> {
  const master = getMasterDb(env)
  await ensureMasterSchema(master)
  const siteDb = await siteDbFor(master, cmsSiteId)
  const res: ApplyResult = { postsUpdated: 0, linksFixed: 0, disclosuresAdded: 0 }
  if (!siteDb || !config.affiliateDomains.length) return res

  const rows = await siteDb.execute({ sql: "SELECT id, content FROM posts WHERE published = 1 AND type = 'post'", args: [] })
  for (const row of rows.rows) {
    const html = String(row.content ?? "")
    const out = rewriteAffiliateLinks(html, config)
    if (!out.linksFixed && !out.disclosureAdded) continue // already compliant
    await siteDb
      .execute({ sql: "UPDATE posts SET content = ?, updated_at = datetime('now') WHERE id = ?", args: [out.html, String(row.id)] })
      .then(() => {
        res.postsUpdated++
        res.linksFixed += out.linksFixed
        if (out.disclosureAdded) res.disclosuresAdded++
      })
      .catch(() => {})
  }

  if (res.postsUpdated > 0 && repoFullName) {
    const github = await getConnection(master, customerId, "github")
    const installationId = Number((JSON.parse(github?.meta || "{}") as { installationId?: number }).installationId ?? 0)
    if (installationId) {
      try {
        const token = await installationToken(env, installationId)
        await repositoryDispatch(token, repoFullName, "content-updated", { reason: "affiliate-compliance" })
      } catch (err) {
        console.error("affiliate applyToAllPosts: rebuild dispatch failed:", err instanceof Error ? err.message : err)
      }
    }
  }
  return res
}
