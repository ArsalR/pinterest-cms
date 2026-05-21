// src/lib/gc.ts
// Daily R2 garbage collector (runs at 04:00 UTC via cron).
// Controlled by GC_ENABLED env var — set to "1" to enable.
//
// Two operations per run:
//   1. Orphan sweep: lists uploads/<hostname>/ in R2, cross-checks against
//      media.r2_key in each site DB, moves unreferenced objects to
//      _trash/YYYYMMDD/<original-key>. Capped at 20 orphans/site/run
//      to stay well within CPU budget.
//   2. Trash purge: deletes _trash/ objects whose date bucket is > 7 days old.

import type { CloudflareEnv } from "./types"
import { getMasterDb, getSiteDb } from "./turso"

const ORPHAN_LIMIT = 20    // max orphans to move per site per run
const TRASH_RETAIN_DAYS = 7
const TRASH_SCAN_DAYS = 30 // look back this many days when purging trash

function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "")
}

export async function runR2Gc(env: CloudflareEnv): Promise<void> {
  if (!env.GC_ENABLED || env.GC_ENABLED === "0" || env.GC_ENABLED === "false") return

  const master = getMasterDb(env)
  let sites: Array<{ hostname: string; turso_url: string; turso_token: string }>
  try {
    const r = await master.execute("SELECT hostname, turso_url, turso_token FROM sites WHERE active = 1")
    sites = r.rows as unknown as typeof sites
  } catch (err) {
    console.error("r2-gc: failed to fetch sites:", err)
    return
  }

  const today = yyyymmdd(new Date())

  for (const site of sites) {
    try {
      await sweepOrphans(env, site.hostname, site.turso_url, site.turso_token, today)
    } catch (err) {
      console.error(`r2-gc: orphan sweep failed for ${site.hostname}:`, err)
    }
  }

  try {
    await purgeOldTrash(env)
  } catch (err) {
    console.error("r2-gc: trash purge failed:", err)
  }
}

async function sweepOrphans(
  env: CloudflareEnv,
  hostname: string,
  tursoUrl: string,
  tursoToken: string,
  today: string
): Promise<void> {
  const db = getSiteDb(tursoUrl, tursoToken)

  // Load all known R2 keys from the site DB.
  const mediaRows = await db.execute("SELECT r2_key FROM media WHERE r2_key IS NOT NULL")
  const knownKeys = new Set(mediaRows.rows.map((r) => r.r2_key as string))

  // Also collect post cover_image and og_image URLs → convert to keys.
  const postRows = await db.execute(
    "SELECT cover_image, og_image FROM posts WHERE cover_image IS NOT NULL OR og_image IS NOT NULL"
  )
  for (const row of postRows.rows) {
    for (const urlField of [row.cover_image, row.og_image]) {
      if (urlField) {
        const url = urlField as string
        const prefix = env.R2_PUBLIC_URL.replace(/\/$/, "") + "/"
        if (url.startsWith(prefix)) knownKeys.add(url.slice(prefix.length))
      }
    }
  }

  let moved = 0
  let cursor: string | undefined

  do {
    const list = await env.R2_BUCKET.list({
      prefix: `uploads/${hostname}/`,
      cursor,
      limit: 100,
    })

    for (const obj of list.objects) {
      if (knownKeys.has(obj.key)) continue
      if (moved >= ORPHAN_LIMIT) break

      // Move orphan to trash.
      const trashKey = `_trash/${today}/${obj.key}`
      const body = await env.R2_BUCKET.get(obj.key)
      if (body) {
        await env.R2_BUCKET.put(trashKey, body.body, {
          httpMetadata: body.httpMetadata,
          customMetadata: {
            ...(body.customMetadata ?? {}),
            trashedAt: new Date().toISOString(),
            originalKey: obj.key,
          },
        })
        await env.R2_BUCKET.delete(obj.key)
        moved++
        console.log(`r2-gc: moved orphan to trash: ${obj.key}`)
      }
    }

    cursor = list.truncated ? list.cursor : undefined
    if (moved >= ORPHAN_LIMIT) break
  } while (cursor)
}

async function purgeOldTrash(env: CloudflareEnv): Promise<void> {
  const cutoff = new Date()
  cutoff.setUTCDate(cutoff.getUTCDate() - TRASH_RETAIN_DAYS)

  // Walk date buckets older than retention window.
  for (let daysBack = TRASH_RETAIN_DAYS + 1; daysBack <= TRASH_SCAN_DAYS; daysBack++) {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - daysBack)
    const dateStr = yyyymmdd(d)

    let cursor: string | undefined
    do {
      const list = await env.R2_BUCKET.list({
        prefix: `_trash/${dateStr}/`,
        cursor,
        limit: 100,
      })

      if (list.objects.length) {
        await Promise.all(list.objects.map((obj) => env.R2_BUCKET.delete(obj.key)))
        console.log(`r2-gc: purged ${list.objects.length} trash object(s) from _trash/${dateStr}/`)
      }

      cursor = list.truncated ? list.cursor : undefined
    } while (cursor)
  }
}
