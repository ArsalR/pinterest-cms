// src/modules/seo/redirectsService.ts
// Data layer for the redirects & branded-links manager (S4). Direct writes to
// the site CMS `redirects` table (the same table the edge redirect engine
// reads), then a covenant-gated rebuild. Reuses siteDbFor + dispatchRebuild.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { cuid } from "../../lib/utils"
import { siteDbFor, dispatchRebuild } from "./service"
import {
  normalizeFrom, validateRedirect, parseRedirectsCsv,
  type RedirectInput, type RedirectRow,
} from "./redirects"

/** All redirects for a site, newest first. */
export async function listRedirects(master: Client, cmsSiteId: string, limit = 1000): Promise<RedirectRow[]> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return []
  const r = await siteDb.execute({
    sql: `SELECT id, from_path, target, kind, match_type, message, hit_count, last_hit_at
          FROM redirects WHERE active = 1 ORDER BY created_at DESC LIMIT ?`,
    args: [limit],
  }).catch(() => null)
  return (r?.rows ?? []).map((row) => ({
    id: String(row.id),
    from: String(row.from_path ?? ""),
    to: (row.target as string | null) ?? "",
    kind: (String(row.kind ?? "301") as RedirectRow["kind"]),
    matchType: (String(row.match_type ?? "exact") as RedirectRow["matchType"]),
    message: (row.message as string | null) ?? null,
    hits: Number(row.hit_count ?? 0),
    lastHitAt: (row.last_hit_at as string | null) ?? null,
  }))
}

export interface WriteResult {
  ok: boolean
  error?: string
}

/** Create or update a redirect (upsert on from_path). */
export async function upsertRedirect(
  env: CloudflareEnv, customerId: string, cmsSiteId: string, repoFullName: string | null,
  input: RedirectInput, master: Client, message?: string | null
): Promise<WriteResult> {
  const err = validateRedirect(input)
  if (err) return { ok: false, error: err }
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { ok: false, error: "The content workspace is unavailable." }

  const from = normalizeFrom(input.from)
  const target = input.kind === "410" ? null : input.to.trim()
  await siteDb.execute({
    sql: `INSERT INTO redirects (id, from_path, target, kind, match_type, message)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(from_path) DO UPDATE SET
            target=excluded.target, kind=excluded.kind, match_type=excluded.match_type,
            message=excluded.message, active=1`,
    args: [cuid(), from, target, input.kind, input.matchType, message?.trim() || null],
  })
  await dispatchRebuild(env, master, customerId, repoFullName, "redirects")
  return { ok: true }
}

/** Soft-delete a redirect (active=0 so the edge stops serving it). */
export async function deleteRedirect(
  env: CloudflareEnv, customerId: string, cmsSiteId: string, repoFullName: string | null,
  id: string, master: Client
): Promise<WriteResult> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { ok: false, error: "The content workspace is unavailable." }
  await siteDb.execute({ sql: "UPDATE redirects SET active = 0 WHERE id = ?", args: [id] })
  await dispatchRebuild(env, master, customerId, repoFullName, "redirects")
  return { ok: true }
}

export interface CsvImportResult {
  added: number
  errors: Array<{ line: number; message: string }>
}

/** Bulk-import redirects from CSV text. Invalid rows are reported, not fatal. */
export async function importRedirectsCsv(
  env: CloudflareEnv, customerId: string, cmsSiteId: string, repoFullName: string | null,
  text: string, master: Client
): Promise<CsvImportResult> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { added: 0, errors: [{ line: 0, message: "The content workspace is unavailable." }] }
  const { rows, errors } = parseRedirectsCsv(text)
  let added = 0
  for (const input of rows) {
    try {
      await siteDb.execute({
        sql: `INSERT INTO redirects (id, from_path, target, kind, match_type, message)
              VALUES (?, ?, ?, ?, ?, 'Imported from CSV')
              ON CONFLICT(from_path) DO UPDATE SET
                target=excluded.target, kind=excluded.kind, match_type=excluded.match_type, active=1`,
        args: [cuid(), normalizeFrom(input.from), input.kind === "410" ? null : input.to.trim(), input.kind, input.matchType],
      })
      added++
    } catch {
      errors.push({ line: 0, message: `Couldn't save ${input.from}` })
    }
  }
  if (added) await dispatchRebuild(env, master, customerId, repoFullName, "redirects-csv")
  return { added, errors }
}
