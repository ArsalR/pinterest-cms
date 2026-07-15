// src/modules/network/gsc.ts
// Google Search Console (K3) — OAuth + Search Analytics + sitemaps + index
// status. Two layers:
//   • pure helpers (scopes, auth-URL builder, property URL, row aggregation)
//     — unit-tested, no I/O;
//   • best-effort I/O (token exchange/refresh, searchAnalytics.query, sitemap
//     submit, sitemaps.list) — return null on any failure, never throw into a
//     request path (mirrors fetchCwv in analytics/cwv.ts).
//
// The refresh_token is stored as the vault-encrypted `gsc` connection secret;
// access tokens are minted on demand from it. The whole feature self-gates on
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, so it is inert until the platform's
// Google verification (OAUTH_SETUP.md) clears.

import type { CloudflareEnv } from "../../lib/types"

const OAUTH_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token"
const WMX_API = "https://www.googleapis.com/webmasters/v3"

// Both scopes are requested: readonly powers the dashboard; the writable
// webmasters scope is required to submit sitemaps. Order is stable for tests.
export const GSC_SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/webmasters",
] as const

export function googleConfigured(env: CloudflareEnv): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
}

/** Dashboard callback URL (absolute — Google requires an exact registered match). */
export function gscRedirectUri(env: CloudflareEnv): string {
  const host = env.SAAS_APP_HOSTNAME || "arsal.app"
  return `https://${host}/app/connections/gsc/callback`
}

/**
 * Build the consent-screen URL. `access_type=offline` + `prompt=consent`
 * guarantees a refresh_token even on re-connect. Pure — unit-tested.
 */
export function gscAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GSC_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  })
  return `${OAUTH_AUTH}?${params.toString()}`
}

/**
 * Map a bare domain to the GSC "property" identifier. Domain properties
 * (`sc-domain:`) cover http/https + all subdomains, which is what our
 * provisioned sites use. Pure — unit-tested.
 */
export function siteUrlForDomain(domain: string): string {
  return `sc-domain:${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`
}

export interface GscTokens {
  accessToken: string
  refreshToken: string | null
  expiresIn: number
}

/** Exchange an auth code for tokens. Best-effort → null. */
export async function exchangeGscCode(env: CloudflareEnv, code: string): Promise<GscTokens | null> {
  if (!googleConfigured(env)) return null
  try {
    const resp = await fetch(OAUTH_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: gscRedirectUri(env),
        grant_type: "authorization_code",
      }),
    })
    if (!resp.ok) return null
    const body = (await resp.json().catch(() => null)) as
      | { access_token?: string; refresh_token?: string; expires_in?: number }
      | null
    if (!body?.access_token) return null
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresIn: body.expires_in ?? 3600,
    }
  } catch {
    return null
  }
}

/** Mint a fresh access token from a stored refresh token. Best-effort → null. */
export async function refreshGscToken(env: CloudflareEnv, refreshToken: string): Promise<string | null> {
  if (!googleConfigured(env)) return null
  try {
    const resp = await fetch(OAUTH_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        grant_type: "refresh_token",
      }),
    })
    if (!resp.ok) return null
    const body = (await resp.json().catch(() => null)) as { access_token?: string } | null
    return body?.access_token ?? null
  } catch {
    return null
  }
}

export interface SearchRow {
  keys: string[]     // dimension values, e.g. [query] or [page]
  clicks: number
  impressions: number
  ctr: number        // 0..1
  position: number   // average, 1-based
}

/**
 * searchAnalytics.query for a property. Best-effort → null.
 * dimensions defaults to ["page"] (feeds the decay radar); pass ["query"] for
 * the top-queries table.
 */
export async function fetchSearchAnalytics(
  accessToken: string,
  siteUrl: string,
  startDate: string,
  endDate: string,
  dimensions: string[] = ["page"],
  rowLimit = 1000
): Promise<SearchRow[] | null> {
  try {
    const resp = await fetch(
      `${WMX_API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ startDate, endDate, dimensions, rowLimit }),
      }
    )
    if (!resp.ok) return null
    const body = (await resp.json().catch(() => null)) as { rows?: SearchRow[] } | null
    return body?.rows ?? []
  } catch {
    return null
  }
}

/** Submit a sitemap for a property (K3 auto-submit). Best-effort → boolean. */
export async function submitSitemap(
  accessToken: string,
  siteUrl: string,
  sitemapUrl: string
): Promise<boolean> {
  try {
    const resp = await fetch(
      `${WMX_API}/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`,
      { method: "PUT", headers: { Authorization: `Bearer ${accessToken}` } }
    )
    return resp.ok
  } catch {
    return false
  }
}

export interface SitemapStatus {
  path: string
  lastSubmitted: string | null
  isPending: boolean
  errors: number
  warnings: number
  submitted: number  // URLs submitted (contents count)
  indexed: number    // URLs indexed (contents count)
}

/** Read sitemap + index-coverage status for a property. Best-effort → null. */
export async function fetchSitemapsStatus(accessToken: string, siteUrl: string): Promise<SitemapStatus[] | null> {
  try {
    const resp = await fetch(`${WMX_API}/sites/${encodeURIComponent(siteUrl)}/sitemaps`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!resp.ok) return null
    const body = (await resp.json().catch(() => null)) as {
      sitemap?: Array<{
        path?: string
        lastSubmitted?: string
        isPending?: boolean
        errors?: string | number
        warnings?: string | number
        contents?: Array<{ submitted?: string | number; indexed?: string | number }>
      }>
    } | null
    return (body?.sitemap ?? []).map((s) => {
      const submitted = (s.contents ?? []).reduce((n, c) => n + Number(c.submitted ?? 0), 0)
      const indexed = (s.contents ?? []).reduce((n, c) => n + Number(c.indexed ?? 0), 0)
      return {
        path: s.path ?? "",
        lastSubmitted: s.lastSubmitted ?? null,
        isPending: !!s.isPending,
        errors: Number(s.errors ?? 0),
        warnings: Number(s.warnings ?? 0),
        submitted,
        indexed,
      }
    })
  } catch {
    return null
  }
}

/**
 * Sum a set of search rows into portfolio/site totals. Pure — unit-tested.
 * CTR is recomputed from summed clicks/impressions (never averaged).
 */
export function summarizeRows(rows: SearchRow[]): { clicks: number; impressions: number; ctr: number } {
  let clicks = 0
  let impressions = 0
  for (const r of rows) {
    clicks += r.clicks
    impressions += r.impressions
  }
  return { clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0 }
}
