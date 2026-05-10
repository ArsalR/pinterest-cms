// src/lib/revalidate.ts
// Cloudflare Cache invalidation helpers. Two paths:
//   1. Edge Cache API (caches.default) — for the runtime cache this Worker
//      writes to via c.executionCtx.waitUntil(cache.put(...))
//   2. Cloudflare Cache Purge REST API — for the public CDN cache layer.
// Both are called on every content/theme change to keep sites live in seconds.

import type { CloudflareEnv } from "./types"

/** Purge specific URLs from Cloudflare's CDN cache. */
export async function purgeUrls(env: CloudflareEnv, urls: string[]): Promise<void> {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID || !urls.length) return
  // CF max 30 URLs per request — chunk if needed.
  const chunks: string[][] = []
  for (let i = 0; i < urls.length; i += 30) chunks.push(urls.slice(i, i + 30))

  await Promise.all(
    chunks.map((chunk) =>
      fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ files: chunk }),
      }).catch((err) => {
        console.error("Cloudflare purge failed:", err)
      })
    )
  )

  // Also clear Worker-level edge cache.
  const edgeCache = await caches.open("page-cache")
  await Promise.all(urls.map((u) => edgeCache.delete(new Request(u)).catch(() => {})))
}

/** Purge everything for a hostname (used after theme/menu/permalink changes). */
export async function purgeEverything(env: CloudflareEnv, hostname: string): Promise<void> {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) return
  // The CF API also accepts hosts: ["paintings.com"] for targeted-everything.
  await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ hosts: [hostname] }),
  }).catch((err) => console.error("Cloudflare host purge failed:", err))
}

/** Convenience: purge a post + the URLs whose content depends on it. */
export async function purgePostCache(
  env: CloudflareEnv,
  hostname: string,
  paths: string[]
): Promise<void> {
  const urls = new Set<string>()
  for (const p of paths) urls.add(`https://${hostname}${p.startsWith("/") ? p : "/" + p}`)
  urls.add(`https://${hostname}/`)
  urls.add(`https://${hostname}/sitemap.xml`)
  urls.add(`https://${hostname}/feed.xml`)
  await purgeUrls(env, [...urls])
}
