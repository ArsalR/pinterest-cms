// src/lib/turso.ts
// Turso libSQL clients for master + per-site databases.
// Hostname → site config resolution with edge cache.

import { createClient, type Client } from "@libsql/client/web"
import type { CloudflareEnv, SiteConfig } from "./types"

/** Master DB client — used to resolve hostnames to site configs. */
export function getMasterDb(env: CloudflareEnv): Client {
  return createClient({
    url: env.TURSO_MASTER_URL,
    authToken: env.TURSO_MASTER_TOKEN,
  })
}

/** Per-site DB client. */
export function getSiteDb(tursoUrl: string, tursoToken: string): Client {
  return createClient({ url: tursoUrl, authToken: tursoToken })
}

/**
 * Resolve hostname → site config. Cached at the edge for 60 seconds via
 * Cloudflare Cache API to avoid re-querying the master DB on every request.
 *
 * Returns null when the hostname is not registered or inactive.
 */
export async function resolveSite(
  env: CloudflareEnv,
  hostname: string
): Promise<SiteConfig | null> {
  const cache = await caches.open("site-configs")
  // Cache key must be a Request to a fully-qualified URL.
  const cacheKey = new Request(`https://internal.cache/site-config/${encodeURIComponent(hostname)}`)

  try {
    const cached = await cache.match(cacheKey)
    if (cached) {
      const data = (await cached.json()) as SiteConfig | { __miss: true }
      if ("__miss" in data) return null
      return data
    }
  } catch {
    // Cache miss path is safe to fall through.
  }

  const db = getMasterDb(env)
  const result = await db.execute({
    sql: "SELECT id, hostname, name, turso_url, turso_token, active, created_at FROM sites WHERE hostname = ? AND active = 1 LIMIT 1",
    args: [hostname],
  })

  if (!result.rows.length) {
    // Negative-cache misses for a short period to avoid hammering on bad hosts.
    await cache.put(
      cacheKey,
      new Response(JSON.stringify({ __miss: true }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=30" },
      })
    )
    return null
  }

  const row = result.rows[0] as unknown as SiteConfig

  await cache.put(
    cacheKey,
    new Response(JSON.stringify(row), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60" },
    })
  )

  return row
}

/** Invalidate the cached site config for a hostname (e.g. after deactivation). */
export async function invalidateSiteConfig(hostname: string): Promise<void> {
  const cache = await caches.open("site-configs")
  const cacheKey = new Request(`https://internal.cache/site-config/${encodeURIComponent(hostname)}`)
  await cache.delete(cacheKey).catch(() => {})
}
