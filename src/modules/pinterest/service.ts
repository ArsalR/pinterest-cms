// src/modules/pinterest/service.ts
// Pinterest queue + processing. Scheduled pins live in the master `jobs` table
// (kind='pin'): status 'scheduled' → 'done' | 'failed', with the target time and
// pin content in the JSON payload (no schema migration needed). The cron calls
// processDuePins on the existing */5 branch; everything is best-effort and
// gated, so it's inert until Pinterest is connected and standard access is live.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { getMasterDb, getSiteDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { getConnectionSecret } from "../connections"
import { cuid } from "../../lib/utils"
import { refreshPinterestToken, createPin, type PinInput } from "./pins"
import { nextSlots, partitionDue, type PinCadence, DEFAULT_CADENCE } from "./schedule"

/** Resolve a live Pinterest access token from the stored refresh token. */
export async function pinterestAccessToken(master: Client, env: CloudflareEnv, customerId: string): Promise<string | null> {
  const refresh = await getConnectionSecret(master, env, customerId, "pinterest", "pinterest:pin")
  if (!refresh) return null
  return refreshPinterestToken(env, refresh)
}

export interface PinnablePost {
  id: string
  slug: string
  title: string
  description: string
  imageUrl: string
}

/** Published posts with a cover image (Pinterest requires a source image). */
export async function loadPinnablePosts(master: Client, cmsSiteId: string, limit = 100): Promise<PinnablePost[]> {
  const reg = await master.execute({ sql: "SELECT turso_url, turso_token FROM sites WHERE id = ? LIMIT 1", args: [cmsSiteId] })
  if (!reg.rows.length) return []
  const siteDb = getSiteDb(reg.rows[0].turso_url as string, reg.rows[0].turso_token as string)
  const r = await siteDb.execute({
    sql: `SELECT id, slug, title, excerpt, seo_description, cover_image
          FROM posts WHERE published = 1 AND type = 'post' AND cover_image IS NOT NULL AND cover_image != ''
          ORDER BY published_at DESC LIMIT ?`,
    args: [limit],
  })
  return r.rows.map((row) => ({
    id: String(row.id),
    slug: String(row.slug ?? ""),
    title: String(row.title ?? ""),
    description: String(row.seo_description ?? row.excerpt ?? ""),
    imageUrl: String(row.cover_image ?? ""),
  }))
}

export interface PinJob {
  id: string
  status: string
  scheduledAt: string  // ISO
  postId: string
  title: string
  link: string
}

interface PinPayload {
  siteId: string
  postId: string
  boardId: string
  title: string
  description: string
  link: string
  imageUrl: string
  scheduledAt: string
}

/** Existing scheduled-pin times (ms) for a customer — feeds the drip spacer. */
async function scheduledTimesMs(master: Client, customerId: string): Promise<number[]> {
  const r = await master.execute({
    sql: "SELECT payload FROM jobs WHERE customer_id = ? AND kind = 'pin' AND status = 'scheduled'",
    args: [customerId],
  })
  const out: number[] = []
  for (const row of r.rows) {
    const t = Date.parse((JSON.parse(String(row.payload ?? "{}")) as PinPayload).scheduledAt ?? "")
    if (!Number.isNaN(t)) out.push(t)
  }
  return out
}

/**
 * Queue drip-scheduled pins for a set of posts on a board. Returns how many
 * were scheduled. Times are spaced by the cadence, after any already-queued pins.
 */
export async function enqueuePins(
  master: Client,
  customerId: string,
  siteId: string,
  domain: string,
  boardId: string,
  posts: PinnablePost[],
  nowMs: number,
  cadence: PinCadence = DEFAULT_CADENCE
): Promise<number> {
  if (!posts.length) return 0
  const existing = await scheduledTimesMs(master, customerId)
  const slots = nextSlots(existing, posts.length, nowMs, cadence)
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i]
    const payload: PinPayload = {
      siteId, postId: p.id, boardId,
      title: p.title,
      description: p.description,
      link: `https://${domain}/posts/${p.slug}/`,
      imageUrl: p.imageUrl,
      scheduledAt: new Date(slots[i]).toISOString(),
    }
    await master.execute({
      sql: "INSERT INTO jobs (id, customer_id, kind, status, payload) VALUES (?, ?, 'pin', 'scheduled', ?)",
      args: [cuid(), customerId, JSON.stringify(payload)],
    })
  }
  return posts.length
}

/** The customer's pin queue (scheduled + recent outcomes) for the UI. */
export async function listPins(master: Client, customerId: string, siteId: string, limit = 50): Promise<PinJob[]> {
  const r = await master.execute({
    sql: "SELECT id, status, payload FROM jobs WHERE customer_id = ? AND kind = 'pin' ORDER BY created_at DESC LIMIT ?",
    args: [customerId, limit],
  })
  const out: PinJob[] = []
  for (const row of r.rows) {
    const p = JSON.parse(String(row.payload ?? "{}")) as PinPayload
    if (p.siteId !== siteId) continue
    out.push({ id: String(row.id), status: String(row.status), scheduledAt: p.scheduledAt, postId: p.postId, title: p.title, link: p.link })
  }
  return out
}

/**
 * Cron entry: create every pin whose scheduled time has passed. Groups by
 * customer so one token is minted per customer per tick. Best-effort — a failed
 * pin is marked 'failed' with the reason and never blocks the others.
 */
export async function processDuePins(env: CloudflareEnv, nowMs: number, maxPerTick = 50): Promise<{ created: number; failed: number }> {
  const master = getMasterDb(env)
  await ensureMasterSchema(master)
  const r = await master.execute({
    sql: "SELECT id, customer_id, payload FROM jobs WHERE kind = 'pin' AND status = 'scheduled' LIMIT 500",
    args: [],
  })
  const scheduled = r.rows.map((row) => ({
    item: { jobId: String(row.id), customerId: String(row.customer_id), payload: JSON.parse(String(row.payload ?? "{}")) as PinPayload },
    scheduledAtMs: Date.parse((JSON.parse(String(row.payload ?? "{}")) as PinPayload).scheduledAt ?? ""),
  }))
  const { due } = partitionDue(scheduled, nowMs)
  const batch = due.slice(0, maxPerTick)

  let created = 0
  let failed = 0
  const tokenByCustomer = new Map<string, string | null>()
  for (const { item } of batch) {
    if (!tokenByCustomer.has(item.customerId)) {
      tokenByCustomer.set(item.customerId, await pinterestAccessToken(master, env, item.customerId).catch(() => null))
    }
    const token = tokenByCustomer.get(item.customerId) ?? null
    if (!token) {
      await markPin(master, item.jobId, "failed", "Pinterest not connected")
      failed++
      continue
    }
    const input: PinInput = {
      boardId: item.payload.boardId,
      title: item.payload.title,
      description: item.payload.description,
      link: item.payload.link,
      imageUrl: item.payload.imageUrl,
    }
    const pinId = await createPin(token, input).catch(() => null)
    if (pinId) {
      await markPin(master, item.jobId, "done", pinId)
      created++
    } else {
      await markPin(master, item.jobId, "failed", "Pinterest rejected the pin")
      failed++
    }
  }
  return { created, failed }
}

async function markPin(master: Client, jobId: string, status: string, result: string): Promise<void> {
  await master
    .execute({ sql: "UPDATE jobs SET status = ?, result = ?, updated_at = datetime('now') WHERE id = ?", args: [status, result, jobId] })
    .catch(() => {})
}
