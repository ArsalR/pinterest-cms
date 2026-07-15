// src/modules/network/service.ts
// Data plumbing for the network brain: resolve a live GSC access token from the
// stored refresh token, fetch + shape Search Console data for a customer site,
// and read a site's published posts (for the AEO checklist). All I/O is
// best-effort — a missing connection or an API hiccup yields empty data and an
// unfurnished dashboard, never a thrown request.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { getSiteDb } from "../../lib/turso"
import { getConnectionSecret, getConnection } from "../connections"
import {
  refreshGscToken, fetchSearchAnalytics, fetchSitemapsStatus, siteUrlForDomain,
  type SearchRow, type SitemapStatus,
} from "./gsc"
import { detectDecay, DEFAULT_DECAY_CONFIG, type PageClicks, type DecayReport } from "./decay"
import type { AeoPost } from "./aeo"

export interface CustomerSiteRow {
  id: string
  customer_id: string
  cms_site_id: string | null
  domain: string
  name: string
  repo_full_name: string | null
}

/** Load one customer site (ownership-checked). */
export async function loadCustomerSite(master: Client, siteId: string, customerId: string): Promise<CustomerSiteRow | null> {
  const r = await master.execute({
    sql: `SELECT id, customer_id, cms_site_id, domain, name, repo_full_name
          FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1`,
    args: [siteId, customerId],
  })
  return r.rows.length ? (r.rows[0] as unknown as CustomerSiteRow) : null
}

/** All of a customer's sites (for the cross-site dashboard). */
export async function loadCustomerSites(master: Client, customerId: string): Promise<CustomerSiteRow[]> {
  const r = await master.execute({
    sql: `SELECT id, customer_id, cms_site_id, domain, name, repo_full_name
          FROM customer_sites WHERE customer_id = ? ORDER BY created_at DESC`,
    args: [customerId],
  })
  return r.rows as unknown as CustomerSiteRow[]
}

/** True if the customer has an active GSC connection. */
export async function gscConnected(master: Client, customerId: string): Promise<boolean> {
  const conn = await getConnection(master, customerId, "gsc")
  return conn?.status === "active"
}

/**
 * Resolve a usable GSC access token for this customer from their stored refresh
 * token. Returns null when GSC isn't connected or the refresh fails.
 */
export async function gscAccessToken(master: Client, env: CloudflareEnv, customerId: string): Promise<string | null> {
  const refresh = await getConnectionSecret(master, env, customerId, "gsc", "network:gsc")
  if (!refresh) return null
  return refreshGscToken(env, refresh)
}

const DAY_MS = 86_400_000
function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function rowsToPageClicks(rows: SearchRow[]): PageClicks[] {
  return rows.map((r) => ({
    page: r.keys[0] ?? "",
    clicks: r.clicks,
    impressions: r.impressions,
    position: r.position,
  }))
}

export interface SiteSearchData {
  topQueries: SearchRow[]
  sitemaps: SitemapStatus[] | null
  decay: DecayReport[]
  totals: { clicks: number; impressions: number }
}

/**
 * Fetch a site's Search Console picture for the dashboard: top queries (28d),
 * sitemap/index status, and a decay report (recent 28d vs. prior 28d per page).
 * `nowMs` is injected so windows are deterministic in tests. Best-effort.
 */
export async function fetchSiteSearchData(
  accessToken: string,
  domain: string,
  nowMs: number
): Promise<SiteSearchData> {
  const siteUrl = siteUrlForDomain(domain)
  const recentEnd = isoDay(nowMs - 2 * DAY_MS)       // GSC data lags ~2 days
  const recentStart = isoDay(nowMs - 30 * DAY_MS)
  const priorEnd = isoDay(nowMs - 31 * DAY_MS)
  const priorStart = isoDay(nowMs - 59 * DAY_MS)

  const [queries, recentPages, priorPages, sitemaps] = await Promise.all([
    fetchSearchAnalytics(accessToken, siteUrl, recentStart, recentEnd, ["query"], 25),
    fetchSearchAnalytics(accessToken, siteUrl, recentStart, recentEnd, ["page"], 1000),
    fetchSearchAnalytics(accessToken, siteUrl, priorStart, priorEnd, ["page"], 1000),
    fetchSitemapsStatus(accessToken, siteUrl),
  ])

  const topQueries = queries ?? []
  const decay = detectDecay(
    rowsToPageClicks(recentPages ?? []),
    rowsToPageClicks(priorPages ?? []),
    DEFAULT_DECAY_CONFIG
  )
  let clicks = 0
  let impressions = 0
  for (const r of recentPages ?? []) {
    clicks += r.clicks
    impressions += r.impressions
  }
  return { topQueries, sitemaps, decay, totals: { clicks, impressions } }
}

export interface SitePostRow {
  id: string
  slug: string
  title: string
  post: AeoPost
}

/** Read a customer site's published posts (from its CMS DB) for AEO scoring. */
export async function readSitePosts(master: Client, cmsSiteId: string, limit = 100): Promise<SitePostRow[]> {
  const reg = await master.execute({
    sql: "SELECT turso_url, turso_token FROM sites WHERE id = ? LIMIT 1",
    args: [cmsSiteId],
  })
  if (!reg.rows.length) return []
  const siteDb = getSiteDb(reg.rows[0].turso_url as string, reg.rows[0].turso_token as string)
  const r = await siteDb.execute({
    sql: `SELECT id, slug, title, excerpt, seo_description, content, updated_at
          FROM posts WHERE published = 1 AND type = 'post' ORDER BY updated_at DESC LIMIT ?`,
    args: [limit],
  })
  return r.rows.map((row) => ({
    id: String(row.id),
    slug: String(row.slug ?? ""),
    title: String(row.title ?? ""),
    post: {
      title: String(row.title ?? ""),
      metaDescription: String(row.seo_description ?? row.excerpt ?? ""),
      excerpt: String(row.excerpt ?? ""),
      contentHtml: String(row.content ?? ""),
      updatedAt: (row.updated_at as string | null) ?? null,
    },
  }))
}
