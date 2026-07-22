// src/modules/mail/service.ts
// Site Mailbox data layer (V1.5 M1). Stores inbound mail (envelope+body in the
// site DB, attachments in R2 — vetted, executables rejected), groups messages
// into conversations by thread_key, and lists/reads threads for the dashboard.
// All site-DB access is tenant-scoped by the route layer (like the forms inbox).

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { siteDbFor } from "../seo"
import { uploadToR2 } from "../../lib/r2"
import { cuid } from "../../lib/utils"
import { fireWebhooks } from "../../lib/webhooks"
import { threadKey, vetAttachment, isSpam, preview, type InboundMail } from "./model"

export interface StoredAttachment { url: string; filename: string; mime: string; size: number }

export interface MailMessage {
  id: string
  threadKey: string
  direction: "in" | "out"
  from: string
  to: string
  subject: string
  bodyText: string
  bodyHtml: string
  attachments: StoredAttachment[]
  status: string
  spam: boolean
  createdAt: string
}

function rowToMessage(row: Record<string, unknown>): MailMessage {
  let attachments: StoredAttachment[] = []
  try {
    const a = JSON.parse(String(row.attachments_json ?? "[]")) as unknown
    if (Array.isArray(a)) attachments = a as StoredAttachment[]
  } catch { /* ignore */ }
  return {
    id: String(row.id), threadKey: String(row.thread_key ?? ""),
    direction: String(row.direction ?? "in") === "out" ? "out" : "in",
    from: String(row.from_addr ?? ""), to: String(row.to_addr ?? ""),
    subject: String(row.subject ?? ""), bodyText: String(row.body_text ?? ""), bodyHtml: String(row.body_html ?? ""),
    attachments, status: String(row.status ?? "new"), spam: Number(row.spam) === 1, createdAt: String(row.created_at ?? ""),
  }
}

/**
 * Store one inbound message: thread it, vet + rehost attachments to R2 (any
 * executable/unknown type is dropped, never stored), insert the row. Returns
 * the new message id, or null if the site DB is unavailable.
 */
export async function storeInbound(master: Client, env: CloudflareEnv, cmsSiteId: string, host: string, mail: InboundMail): Promise<string | null> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return null
  const tk = threadKey(mail)

  const stored: StoredAttachment[] = []
  for (const a of mail.attachments || []) {
    const vetted = vetAttachment(a)
    if (!vetted.ok) continue // executables + unknown types silently dropped
    try {
      const up = await uploadToR2(env, `${host}/mail-attachments`, `${cuid()}.${vetted.ext}`, vetted.bytes.buffer as ArrayBuffer, vetted.mime)
      stored.push({ url: up.url, filename: a.filename.slice(0, 200), mime: vetted.mime, size: vetted.bytes.byteLength })
    } catch { /* best-effort per attachment */ }
  }

  const id = cuid()
  await siteDb.execute({
    sql: `INSERT INTO mail_messages
            (id, thread_key, direction, from_addr, to_addr, subject, body_text, body_html,
             message_id, in_reply_to, refs, attachments_json, status, spam)
          VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, tk, mail.from, mail.to, mail.subject || null, mail.text || null, mail.html || null,
      mail.messageId || null, mail.inReplyTo || null, (mail.references || []).join(" ") || null,
      JSON.stringify(stored), isSpam(mail.spamVerdict) ? "spam" : "new", isSpam(mail.spamVerdict) ? 1 : 0,
    ],
  }).catch(() => {})
  // M2: site-wide "mail.received" event (envelope only — no body/attachments).
  if (!isSpam(mail.spamVerdict)) {
    await fireWebhooks(siteDb, env.FEATURE_WEBHOOKS, host, "mail.received", { from: mail.from, to: mail.to, subject: mail.subject, threadKey: tk, messageId: id }).catch(() => {})
  }
  return id
}

/** Append an outbound (sent) message to a thread. */
export async function appendOutbound(master: Client, cmsSiteId: string, m: { threadKey: string; from: string; to: string; subject: string; html: string; text: string }): Promise<void> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return
  await siteDb.execute({
    sql: `INSERT INTO mail_messages (id, thread_key, direction, from_addr, to_addr, subject, body_text, body_html, status, spam)
          VALUES (?, ?, 'out', ?, ?, ?, ?, ?, 'replied', 0)`,
    args: [cuid(), m.threadKey, m.from, m.to, m.subject || null, m.text || null, m.html || null],
  }).catch(() => {})
  // Any inbound messages in this thread are now "replied".
  await siteDb.execute({ sql: "UPDATE mail_messages SET status = 'replied' WHERE thread_key = ? AND direction = 'in' AND status IN ('new','read')", args: [m.threadKey] }).catch(() => {})
}

export interface ThreadSummary {
  threadKey: string
  subject: string
  who: string
  preview: string
  status: string
  unread: boolean
  count: number
  at: string
}

export type MailFolder = "inbox" | "archived" | "spam"

/** Thread list for a folder: latest message per thread. */
export async function listThreads(master: Client, cmsSiteId: string, folder: MailFolder, search?: string): Promise<ThreadSummary[]> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return []
  const where: string[] = []
  const args: (string | number)[] = []
  if (folder === "spam") where.push("spam = 1")
  else if (folder === "archived") where.push("spam = 0 AND status = 'archived'")
  else where.push("spam = 0 AND status != 'archived'")
  if (search) { where.push("(subject LIKE ? OR from_addr LIKE ? OR body_text LIKE ?)"); const s = `%${search.replace(/[%_]/g, "")}%`; args.push(s, s, s) }
  const r = await siteDb.execute({
    sql: `SELECT m.* FROM mail_messages m
          JOIN (SELECT thread_key, MAX(created_at) mx FROM mail_messages ${where.length ? "WHERE " + where.join(" AND ") : ""} GROUP BY thread_key) t
            ON m.thread_key = t.thread_key AND m.created_at = t.mx
          ORDER BY m.created_at DESC LIMIT 300`,
    args,
  }).catch(() => null)
  const rows = r?.rows ?? []
  const out: ThreadSummary[] = []
  for (const row of rows) {
    const m = rowToMessage(row as Record<string, unknown>)
    const cnt = await siteDb.execute({ sql: "SELECT COUNT(*) n, SUM(CASE WHEN status='new' AND direction='in' THEN 1 ELSE 0 END) u FROM mail_messages WHERE thread_key = ?", args: [m.threadKey] }).catch(() => null)
    out.push({
      threadKey: m.threadKey, subject: m.subject || "(no subject)",
      who: m.direction === "in" ? m.from : m.to, preview: preview(m.bodyText, m.bodyHtml),
      status: m.status, unread: Number(cnt?.rows[0]?.u ?? 0) > 0, count: Number(cnt?.rows[0]?.n ?? 1), at: m.createdAt,
    })
  }
  return out
}

export async function getThread(master: Client, cmsSiteId: string, tk: string): Promise<MailMessage[]> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return []
  const r = await siteDb.execute({ sql: "SELECT * FROM mail_messages WHERE thread_key = ? ORDER BY created_at ASC", args: [tk] }).catch(() => null)
  return (r?.rows ?? []).map((row) => rowToMessage(row as Record<string, unknown>))
}

export async function markThreadRead(master: Client, cmsSiteId: string, tk: string): Promise<void> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return
  await siteDb.execute({ sql: "UPDATE mail_messages SET status = 'read' WHERE thread_key = ? AND direction = 'in' AND status = 'new'", args: [tk] }).catch(() => {})
}

export async function setThreadFolder(master: Client, cmsSiteId: string, tk: string, action: "archive" | "spam" | "inbox"): Promise<void> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return
  if (action === "spam") await siteDb.execute({ sql: "UPDATE mail_messages SET spam = 1 WHERE thread_key = ?", args: [tk] }).catch(() => {})
  else if (action === "inbox") await siteDb.execute({ sql: "UPDATE mail_messages SET spam = 0, status = CASE WHEN status='archived' THEN 'read' ELSE status END WHERE thread_key = ?", args: [tk] }).catch(() => {})
  else await siteDb.execute({ sql: "UPDATE mail_messages SET status = 'archived' WHERE thread_key = ?", args: [tk] }).catch(() => {})
}

export async function countUnread(master: Client, cmsSiteId: string): Promise<number> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return 0
  const r = await siteDb.execute({ sql: "SELECT COUNT(DISTINCT thread_key) n FROM mail_messages WHERE status = 'new' AND direction = 'in' AND spam = 0", args: [] }).catch(() => null)
  return Number(r?.rows[0]?.n ?? 0)
}

// ─────────────────────── addresses ───────────────────────

export interface MailAddress { id: string; address: string; label: string; isCatchAll: boolean; active: boolean }

export async function listAddresses(master: Client, cmsSiteId: string): Promise<MailAddress[]> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return []
  const r = await siteDb.execute({ sql: "SELECT * FROM mail_addresses ORDER BY is_catch_all DESC, created_at ASC", args: [] }).catch(() => null)
  return (r?.rows ?? []).map((row) => ({
    id: String(row.id), address: String(row.address), label: String(row.label ?? ""),
    isCatchAll: Number(row.is_catch_all) === 1, active: Number(row.active) === 1,
  }))
}

export async function addAddress(master: Client, cmsSiteId: string, address: string, label: string): Promise<boolean> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return false
  const r = await siteDb.execute({ sql: "INSERT OR IGNORE INTO mail_addresses (id, address, label) VALUES (?, ?, ?)", args: [cuid(), address.toLowerCase(), label || null] }).catch(() => null)
  return !!r && Number(r.rowsAffected) > 0
}

export async function setAddressActive(master: Client, cmsSiteId: string, id: string, active: boolean): Promise<void> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return
  await siteDb.execute({ sql: "UPDATE mail_addresses SET active = ? WHERE id = ?", args: [active ? 1 : 0, id] }).catch(() => {})
}
