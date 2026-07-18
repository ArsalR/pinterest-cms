// src/modules/seo/indexingService.ts
// Indexing ops data layer (S5). Combines the GSC I/O (network module) with the
// pure diagnosis (indexing.ts) and the site's own published URLs. All GSC calls
// are best-effort — GSC not connected / quota / API error all degrade to a
// friendly empty state, never an exception into the request path.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import {
  gscAccessToken, siteUrlForDomain, fetchSitemapsStatus, inspectUrl,
  type SitemapStatus,
} from "../network"
import { siteDbFor } from "./service"
import { diagnoseInspection, indexCoverage, inspectDeepLink, type CoverageSummary, type IndexDiagnosis } from "./indexing"

// URL Inspection API is quota-limited (≈600/min, 2000/day). Cap on-demand bulk
// checks so one page load can't burn the daily budget. Surfaced in the UI.
export const BULK_INSPECT_CAP = 10

export interface IndexOverview {
  connected: boolean
  property: string
  coverage: CoverageSummary | null
  sitemaps: SitemapStatus[]
}

/** Sitemap coverage + deindex watch for a site. */
export async function indexOverview(master: Client, env: CloudflareEnv, customerId: string, domain: string): Promise<IndexOverview> {
  const property = siteUrlForDomain(domain)
  const token = await gscAccessToken(master, env, customerId).catch(() => null)
  if (!token) return { connected: false, property, coverage: null, sitemaps: [] }
  const sitemaps = (await fetchSitemapsStatus(token, property).catch(() => null)) ?? []
  return { connected: true, property, coverage: indexCoverage(sitemaps), sitemaps }
}

export interface UrlIndexRow {
  url: string
  diagnosis: IndexDiagnosis | null // null = GSC couldn't inspect (quota/error)
  deepLink: string
}

/** Inspect a single URL and diagnose it. */
export async function inspectOne(master: Client, env: CloudflareEnv, customerId: string, domain: string, url: string): Promise<UrlIndexRow> {
  const property = siteUrlForDomain(domain)
  const token = await gscAccessToken(master, env, customerId).catch(() => null)
  const deepLink = inspectDeepLink(property, url)
  if (!token) return { url, diagnosis: null, deepLink }
  const insp = await inspectUrl(token, property, url).catch(() => null)
  return { url, diagnosis: insp ? diagnoseInspection(insp) : null, deepLink }
}

export interface BulkInspectResult {
  connected: boolean
  rows: UrlIndexRow[]
  total: number   // published posts considered
  inspected: number
  capped: boolean // true when more posts exist than the cap allowed
}

/**
 * Bulk-inspect the most recently updated published posts (capped). Surfaces the
 * pages Google hasn't indexed so the operator can act. Sequential to be gentle
 * on the URL Inspection quota.
 */
export async function bulkInspect(master: Client, env: CloudflareEnv, customerId: string, cmsSiteId: string, domain: string): Promise<BulkInspectResult> {
  const property = siteUrlForDomain(domain)
  const token = await gscAccessToken(master, env, customerId).catch(() => null)
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { connected: !!token, rows: [], total: 0, inspected: 0, capped: false }

  const countRow = await siteDb.execute({ sql: "SELECT COUNT(*) AS n FROM posts WHERE published = 1 AND type = 'post'", args: [] }).catch(() => null)
  const total = countRow?.rows.length ? Number(countRow.rows[0].n) : 0

  const r = await siteDb.execute({
    sql: "SELECT slug FROM posts WHERE published = 1 AND type = 'post' ORDER BY updated_at DESC LIMIT ?",
    args: [BULK_INSPECT_CAP],
  }).catch(() => null)
  const urls = (r?.rows ?? []).map((row) => `https://${domain}/posts/${String(row.slug)}/`)

  if (!token) return { connected: false, rows: urls.map((url) => ({ url, diagnosis: null, deepLink: inspectDeepLink(property, url) })), total, inspected: 0, capped: total > urls.length }

  const rows: UrlIndexRow[] = []
  for (const url of urls) {
    const insp = await inspectUrl(token, property, url).catch(() => null)
    rows.push({ url, diagnosis: insp ? diagnoseInspection(insp) : null, deepLink: inspectDeepLink(property, url) })
  }
  return { connected: true, rows, total, inspected: rows.filter((x) => x.diagnosis).length, capped: total > urls.length }
}
