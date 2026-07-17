// src/modules/network/notfound.ts
// 404 monitor (K3 — "top 404 paths from CF analytics, one-click add redirect").
// Reads the site's top 404 paths from Cloudflare's zone analytics (best-effort,
// like fetchCwv) and writes a one-click 301 into the site's CMS `redirects`
// table — served at the edge by the existing frontend redirect handler. Pure
// path helpers are unit-tested.

import type { Client } from "@libsql/client/web"
import { getSiteDb } from "../../lib/turso"
import { cuid } from "../../lib/utils"

export interface NotFoundPath {
  path: string
  count: number
}

/** A CF-reported path we're willing to surface as a redirect candidate. Pure. */
export function isCandidatePath(path: string): boolean {
  if (!path || path[0] !== "/") return false
  if (path.length > 512) return false
  // Skip asset/dotfile noise and the reserved frontend routes.
  if (/\.(js|css|map|png|jpe?g|gif|svg|ico|woff2?|txt|xml|json)$/i.test(path)) return false
  if (/^\/(api|admin)\b/.test(path)) return false
  return true
}

/** Normalize a redirect source path (leading slash, trim, collapse). Pure. */
export function normalizeFromPath(path: string): string {
  let p = path.trim()
  if (!p.startsWith("/")) p = "/" + p
  return p.replace(/\/{2,}/g, "/")
}

/** Validate a customer-entered redirect target (internal path or absolute URL). Pure. */
export function isValidTarget(target: string): boolean {
  const t = target.trim()
  if (t.startsWith("/")) return t.length <= 512 && !/\s/.test(t)
  return /^https:\/\/[^\s]+$/.test(t) && t.length <= 512
}

/**
 * Fetch the site's top 404 paths from Cloudflare zone analytics (GraphQL).
 * Best-effort → null on any error or when analytics has nothing yet.
 */
export async function fetchTop404s(
  cfToken: string,
  zoneTag: string,
  sinceIso: string,
  untilIso: string,
  limit = 20
): Promise<NotFoundPath[] | null> {
  const query = `query Top404($zoneTag: String!, $since: Time!, $until: Time!, $limit: Int!) {
    viewer { zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(
        limit: $limit,
        filter: { datetime_geq: $since, datetime_leq: $until, edgeResponseStatus: 404 },
        orderBy: [count_DESC]
      ) {
        count
        dimensions { clientRequestPath }
      }
    } }
  }`
  try {
    const resp = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { zoneTag, since: sinceIso, until: untilIso, limit } }),
    })
    if (!resp.ok) return null
    const body = (await resp.json().catch(() => null)) as {
      data?: { viewer?: { zones?: Array<{ httpRequestsAdaptiveGroups?: Array<{ count?: number; dimensions?: { clientRequestPath?: string } }> }> } }
    } | null
    const groups = body?.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups
    if (!groups) return null
    return groups
      .map((g) => ({ path: String(g.dimensions?.clientRequestPath ?? ""), count: Number(g.count ?? 0) }))
      .filter((r) => isCandidatePath(r.path))
  } catch {
    return null
  }
}

/**
 * Write a 301 into the site's CMS redirects table. ON CONFLICT keeps it
 * idempotent and never clobbers a manually-set redirect. Returns false if the
 * CMS DB can't be resolved.
 */
export async function addRedirect(master: Client, cmsSiteId: string, fromPath: string, target: string): Promise<boolean> {
  const reg = await master.execute({ sql: "SELECT turso_url, turso_token FROM sites WHERE id = ? LIMIT 1", args: [cmsSiteId] })
  if (!reg.rows.length) return false
  const siteDb = getSiteDb(reg.rows[0].turso_url as string, reg.rows[0].turso_token as string)
  await siteDb.execute({
    sql: `INSERT INTO redirects (id, from_path, target, kind, match_type, message)
          VALUES (?, ?, ?, '301', 'exact', 'Added from 404 monitor')
          ON CONFLICT(from_path) DO NOTHING`,
    args: [cuid(), normalizeFromPath(fromPath), target.trim()],
  })
  return true
}

/** Existing redirect source paths for a site (to hide already-fixed 404s). */
export async function existingRedirectPaths(master: Client, cmsSiteId: string): Promise<Set<string>> {
  const reg = await master.execute({ sql: "SELECT turso_url, turso_token FROM sites WHERE id = ? LIMIT 1", args: [cmsSiteId] })
  if (!reg.rows.length) return new Set()
  const siteDb = getSiteDb(reg.rows[0].turso_url as string, reg.rows[0].turso_token as string)
  const r = await siteDb.execute({ sql: "SELECT from_path FROM redirects WHERE active = 1", args: [] }).catch(() => null)
  return new Set((r?.rows ?? []).map((row) => String(row.from_path)))
}
