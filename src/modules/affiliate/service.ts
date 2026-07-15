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
import { auditLinks, rewriteAffiliateLinks, extractOutboundLinks, type AffiliateConfig, DEFAULT_DISCLOSURE } from "./links"
import { checkLink, type LinkCheck } from "./deadlinks"

const KEY_DOMAINS = "affiliate_domains"
const KEY_DISCLOSURE = "affiliate_disclosure"
const KEY_CLICKTRACK = "affiliate_click_tracking"

// A weekly-ish dead-link cadence and per-run caps so the cron stays cheap.
const DEADLINK_INTERVAL_MS = 7 * 86_400_000
const MAX_LINKS_PER_SCAN = 150
const MAX_SITES_PER_CRON = 20

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

export interface ConfigView extends AffiliateConfig {
  clickTrackingEnabled: boolean
}

/**
 * Load the affiliate config. When `edge` is passed (siteId + saasHost) AND the
 * site has click-tracking enabled, the returned config carries `clickTracking`
 * so rewriteAffiliateLinks wraps links through the edge counter.
 */
export async function loadConfig(master: Client, cmsSiteId: string, edge?: { siteId: string; saasHost: string }): Promise<ConfigView> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { affiliateDomains: [], disclosureText: DEFAULT_DISCLOSURE, clickTrackingEnabled: false }
  const domains = (await readSetting(siteDb, KEY_DOMAINS)) ?? ""
  const disclosure = (await readSetting(siteDb, KEY_DISCLOSURE)) ?? DEFAULT_DISCLOSURE
  const clickTrackingEnabled = (await readSetting(siteDb, KEY_CLICKTRACK)) === "1"
  return {
    affiliateDomains: parseDomains(domains),
    disclosureText: disclosure,
    clickTrackingEnabled,
    ...(clickTrackingEnabled && edge ? { clickTracking: edge } : {}),
  }
}

export async function saveConfig(master: Client, cmsSiteId: string, domainsRaw: string, disclosure: string, clickTracking: boolean): Promise<void> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return
  await writeSetting(siteDb, KEY_DOMAINS, domainsRaw.trim())
  await writeSetting(siteDb, KEY_DISCLOSURE, (disclosure || DEFAULT_DISCLOSURE).trim())
  await writeSetting(siteDb, KEY_CLICKTRACK, clickTracking ? "1" : "0")
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

// ─────────────────────── edge click counting (K10) ───────────────────────

interface SiteLite { id: string; customer_id: string; cms_site_id: string | null }

async function siteLite(master: Client, siteId: string): Promise<SiteLite | null> {
  const r = await master.execute({ sql: "SELECT id, customer_id, cms_site_id FROM customer_sites WHERE id = ? LIMIT 1", args: [siteId] })
  return r.rows.length ? (r.rows[0] as unknown as SiteLite) : null
}

/**
 * Validate a click-redirect target and record the click. Returns the target to
 * redirect to, or null if the site is unknown or the target isn't one of the
 * site's affiliate domains (open-redirect guard — we never bounce to arbitrary
 * URLs). Called from the public /api/saas/go edge endpoint.
 */
export async function resolveAndCountClick(master: Client, siteId: string, target: string, day: string): Promise<string | null> {
  const site = await siteLite(master, siteId)
  if (!site?.cms_site_id) return null
  const cfg = await loadConfig(master, site.cms_site_id)
  let host: string
  try {
    host = new URL(target).hostname.replace(/^www\./, "").toLowerCase()
  } catch {
    return null
  }
  const allowed = cfg.affiliateDomains.some((d) => host === d || host.endsWith(`.${d}`))
  if (!allowed) return null

  // Increment the per-day host counter in site_metrics (source='clicks').
  const existing = await master.execute({
    sql: "SELECT payload FROM site_metrics WHERE customer_site_id = ? AND day = ? AND source = 'clicks' LIMIT 1",
    args: [siteId, day],
  })
  const counts: Record<string, number> = existing.rows.length ? safeObj(String(existing.rows[0].payload)) : {}
  counts[host] = (counts[host] ?? 0) + 1
  await master.execute({
    sql: `INSERT INTO site_metrics (customer_site_id, day, source, payload) VALUES (?, ?, 'clicks', ?)
          ON CONFLICT(customer_site_id, day, source) DO UPDATE SET payload = excluded.payload, updated_at = datetime('now')`,
    args: [siteId, day, JSON.stringify(counts)],
  })
  return target
}

export interface ClickTotals {
  total: number
  byHost: Array<{ host: string; count: number }>
}

/** Aggregate all recorded clicks for a site (for the affiliate dashboard). */
export async function loadClickTotals(master: Client, siteId: string): Promise<ClickTotals> {
  const r = await master.execute({
    sql: "SELECT payload FROM site_metrics WHERE customer_site_id = ? AND source = 'clicks'",
    args: [siteId],
  })
  const acc: Record<string, number> = {}
  for (const row of r.rows) {
    const day = safeObj(String(row.payload))
    for (const [host, n] of Object.entries(day)) acc[host] = (acc[host] ?? 0) + Number(n)
  }
  const byHost = Object.entries(acc).map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count)
  return { total: byHost.reduce((n, h) => n + h.count, 0), byHost }
}

function safeObj(s: string): Record<string, number> {
  try {
    const o = JSON.parse(s) as Record<string, number>
    return o && typeof o === "object" ? o : {}
  } catch {
    return {}
  }
}

// ─────────────────────── dead-link scan + weekly cron (K10) ───────────────────────

export interface DeadLinkReport {
  scannedAt: string
  checked: number
  dead: LinkCheck[]
}

/** Scan a site's published posts for broken outbound links; cache the result. */
export async function scanDeadLinks(env: CloudflareEnv, customerSiteId: string, cmsSiteId: string, day: string): Promise<DeadLinkReport> {
  const master = getMasterDb(env)
  const siteDb = await siteDbFor(master, cmsSiteId)
  const report: DeadLinkReport = { scannedAt: new Date().toISOString(), checked: 0, dead: [] }
  if (!siteDb) return report

  const rows = await siteDb.execute({ sql: "SELECT content FROM posts WHERE published = 1 AND type = 'post'", args: [] })
  const links = new Set<string>()
  for (const row of rows.rows) {
    for (const l of extractOutboundLinks(String(row.content ?? ""))) links.add(l)
    if (links.size >= MAX_LINKS_PER_SCAN) break
  }
  const checks = await Promise.all(Array.from(links).slice(0, MAX_LINKS_PER_SCAN).map((u) => checkLink(u)))
  report.checked = checks.length
  report.dead = checks.filter((c) => c.health === "dead")

  await master.execute({
    sql: `INSERT INTO site_metrics (customer_site_id, day, source, payload) VALUES (?, ?, 'deadlinks', ?)
          ON CONFLICT(customer_site_id, day, source) DO UPDATE SET payload = excluded.payload, updated_at = datetime('now')`,
    args: [customerSiteId, day, JSON.stringify(report)],
  })
  return report
}

/** The most recent dead-link scan for a site (for the dashboard). */
export async function loadDeadLinks(master: Client, customerSiteId: string): Promise<DeadLinkReport | null> {
  const r = await master.execute({
    sql: "SELECT payload FROM site_metrics WHERE customer_site_id = ? AND source = 'deadlinks' ORDER BY day DESC LIMIT 1",
    args: [customerSiteId],
  })
  if (!r.rows.length) return null
  try {
    return JSON.parse(String(r.rows[0].payload)) as DeadLinkReport
  } catch {
    return null
  }
}

/**
 * Cron entry (rides the daily branch, SAAS_MODE-gated): scan sites whose last
 * dead-link check is older than a week. Capped per tick so it never runs long.
 */
export async function runDeadLinkCron(env: CloudflareEnv, nowMs: number): Promise<{ scanned: number }> {
  const master = getMasterDb(env)
  await ensureMasterSchema(master)
  const sites = await master.execute({
    sql: "SELECT id, cms_site_id FROM customer_sites WHERE cms_site_id IS NOT NULL ORDER BY created_at ASC",
    args: [],
  })
  const today = new Date(nowMs).toISOString().slice(0, 10)
  let scanned = 0
  for (const row of sites.rows) {
    if (scanned >= MAX_SITES_PER_CRON) break
    const siteId = String(row.id)
    const cmsSiteId = String(row.cms_site_id)
    const last = await master.execute({
      sql: "SELECT updated_at FROM site_metrics WHERE customer_site_id = ? AND source = 'deadlinks' ORDER BY day DESC LIMIT 1",
      args: [siteId],
    })
    if (last.rows.length) {
      const t = Date.parse(String(last.rows[0].updated_at).replace(" ", "T") + "Z")
      if (!Number.isNaN(t) && nowMs - t < DEADLINK_INTERVAL_MS) continue // checked within the week
    }
    try {
      await scanDeadLinks(env, siteId, cmsSiteId, today)
      scanned++
    } catch {
      // best-effort — skip this site, keep going
    }
  }
  return { scanned }
}
