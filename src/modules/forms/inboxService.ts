// src/modules/forms/inboxService.ts
// Submissions Inbox data layer (V1.4 F2): list/filter/search, status, notes,
// reply threads, CSV export, retention purge (lazy — applied on inbox load;
// default keep-forever). Direct site-DB reads/writes, tenant-scoped by the
// route layer.

import type { Client } from "@libsql/client/web"
import { siteDbFor } from "../seo"
import { cuid } from "../../lib/utils"

export interface Submission {
  id: string
  formId: string
  formTitle: string
  fields: Record<string, string>
  page: string | null
  country: string | null
  status: string // new | read | replied | archived
  notes: string
  thread: Array<{ at: string; subject: string; body: string }>
  aiSummary: string | null
  aiScore: string | null
  createdAt: string
}

function rowToSubmission(row: Record<string, unknown>): Submission {
  let fields: Record<string, string> = {}
  try {
    const o = JSON.parse(String(row.fields_json ?? "{}")) as Record<string, unknown>
    if (o && typeof o === "object") fields = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]))
  } catch { /* ignore */ }
  let thread: Submission["thread"] = []
  try {
    const a = JSON.parse(String(row.thread_json ?? "[]")) as unknown
    if (Array.isArray(a)) thread = a as Submission["thread"]
  } catch { /* ignore */ }
  return {
    id: String(row.id),
    formId: String(row.form_id),
    formTitle: String(row.form_title ?? ""),
    fields,
    page: (row.page as string | null) ?? null,
    country: (row.country as string | null) ?? null,
    status: String(row.status ?? "new"),
    notes: String(row.notes ?? ""),
    thread,
    aiSummary: (row.ai_summary as string | null) ?? null,
    aiScore: (row.ai_score as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
  }
}

/** Retention purge (lazy): delete beyond N days when configured (>0). */
async function applyRetention(siteDb: Client, retentionDays: number): Promise<void> {
  if (retentionDays > 0) {
    await siteDb.execute({
      sql: `DELETE FROM form_submissions WHERE created_at < datetime('now', ?)`,
      args: [`-${Math.floor(retentionDays)} days`],
    }).catch(() => {})
  }
}

export interface InboxQuery {
  formId?: string
  status?: string
  search?: string
  limit?: number
}

export async function listSubmissions(master: Client, cmsSiteId: string, q: InboxQuery, retentionDays = 0): Promise<Submission[]> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return []
  await applyRetention(siteDb, retentionDays)
  const where: string[] = []
  const args: (string | number)[] = []
  if (q.formId) { where.push("s.form_id = ?"); args.push(q.formId) }
  if (q.status) { where.push("s.status = ?"); args.push(q.status) }
  if (q.search) { where.push("s.fields_json LIKE ?"); args.push(`%${q.search.replace(/[%_]/g, "")}%`) }
  const r = await siteDb.execute({
    sql: `SELECT s.*, f.title AS form_title FROM form_submissions s
          LEFT JOIN forms f ON f.id = s.form_id
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY s.created_at DESC LIMIT ?`,
    args: [...args, Math.min(q.limit ?? 200, 500)],
  }).catch(() => null)
  return (r?.rows ?? []).map((row) => rowToSubmission(row as Record<string, unknown>))
}

export async function getSubmission(master: Client, cmsSiteId: string, id: string): Promise<Submission | null> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return null
  const r = await siteDb.execute({
    sql: `SELECT s.*, f.title AS form_title FROM form_submissions s LEFT JOIN forms f ON f.id = s.form_id WHERE s.id = ? LIMIT 1`,
    args: [id],
  }).catch(() => null)
  return r?.rows.length ? rowToSubmission(r.rows[0] as Record<string, unknown>) : null
}

export async function countNew(master: Client, cmsSiteId: string): Promise<number> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return 0
  const r = await siteDb.execute({ sql: "SELECT COUNT(*) AS n FROM form_submissions WHERE status = 'new'", args: [] }).catch(() => null)
  return r?.rows.length ? Number(r.rows[0].n) : 0
}

export async function setStatus(master: Client, cmsSiteId: string, id: string, status: string): Promise<void> {
  if (!["new", "read", "replied", "archived"].includes(status)) return
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return
  await siteDb.execute({ sql: "UPDATE form_submissions SET status = ? WHERE id = ?", args: [status, id] }).catch(() => {})
}

export async function saveNotes(master: Client, cmsSiteId: string, id: string, notes: string): Promise<void> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return
  await siteDb.execute({ sql: "UPDATE form_submissions SET notes = ? WHERE id = ?", args: [notes.slice(0, 5000) || null, id] }).catch(() => {})
}

/** Append a sent reply to the thread + mark replied. */
export async function appendReply(master: Client, cmsSiteId: string, id: string, subject: string, body: string): Promise<void> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return
  const cur = await siteDb.execute({ sql: "SELECT thread_json FROM form_submissions WHERE id = ? LIMIT 1", args: [id] }).catch(() => null)
  let thread: Array<{ at: string; subject: string; body: string }> = []
  try {
    const a = JSON.parse(String(cur?.rows[0]?.thread_json ?? "[]")) as unknown
    if (Array.isArray(a)) thread = a as typeof thread
  } catch { /* ignore */ }
  thread.push({ at: new Date().toISOString(), subject: subject.slice(0, 200), body: body.slice(0, 10000) })
  await siteDb.execute({
    sql: "UPDATE form_submissions SET thread_json = ?, status = 'replied' WHERE id = ?",
    args: [JSON.stringify(thread), id],
  }).catch(() => {})
}

/** CSV export (pure serialization once rows are loaded). */
export function submissionsToCsv(subs: Submission[]): string {
  const keys = new Set<string>()
  for (const s of subs) for (const k of Object.keys(s.fields)) keys.add(k)
  const cols = ["id", "form", "created_at", "status", "page", "country", ...keys]
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const lines = [cols.join(",")]
  for (const s of subs) {
    lines.push([
      s.id, s.formTitle, s.createdAt, s.status, s.page ?? "", s.country ?? "",
      ...[...keys].map((k) => s.fields[k] ?? ""),
    ].map((v) => esc(String(v))).join(","))
  }
  return lines.join("\n") + "\n"
}

/** All-inboxes aggregation: newest 'new' submissions across a customer's sites. */
export async function crossSiteNew(
  master: Client,
  sites: Array<{ id: string; domain: string; cms_site_id: string | null }>,
  perSite = 10
): Promise<Array<{ siteId: string; domain: string; sub: Submission }>> {
  const out: Array<{ siteId: string; domain: string; sub: Submission }> = []
  for (const s of sites) {
    if (!s.cms_site_id) continue
    const subs = await listSubmissions(master, s.cms_site_id, { status: "new", limit: perSite }).catch(() => [])
    for (const sub of subs) out.push({ siteId: s.id, domain: s.domain, sub })
  }
  out.sort((a, b) => b.sub.createdAt.localeCompare(a.sub.createdAt))
  return out
}

/** Persist reply id for dedupe? Not needed — thread only. */
export const _inboxInternal = { rowToSubmission, cuid }
