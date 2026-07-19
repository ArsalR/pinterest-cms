// src/modules/forms/service.ts
// Forms Engine data layer (V1.4 F1): form CRUD in the site CMS DB + the
// submission pipeline pieces the public endpoint composes. Direct site-DB
// writes + covenant-gated rebuild on definition changes (a form's static HTML
// lives in the built site).

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { cuid } from "../../lib/utils"
import { siteDbFor, dispatchRebuild } from "../seo"
import { parseFields, formSlug, type FieldDef } from "./model"

export interface FormRow {
  id: string
  slug: string
  title: string
  fields: FieldDef[]
  ackEnabled: boolean
  ackSubject: string
  ackBody: string
  webhookUrl: string
  webhookSecret: string
  active: boolean
}

function rowToForm(row: Record<string, unknown>): FormRow {
  return {
    id: String(row.id),
    slug: String(row.slug ?? ""),
    title: String(row.title ?? ""),
    fields: parseFields(row.fields_json),
    ackEnabled: Number(row.ack_enabled) === 1,
    ackSubject: String(row.ack_subject ?? ""),
    ackBody: String(row.ack_body ?? ""),
    webhookUrl: String(row.webhook_url ?? ""),
    webhookSecret: String(row.webhook_secret ?? ""),
    active: Number(row.active) === 1,
  }
}

export async function listForms(master: Client, cmsSiteId: string): Promise<FormRow[]> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return []
  const r = await siteDb.execute({ sql: "SELECT * FROM forms ORDER BY created_at", args: [] }).catch(() => null)
  return (r?.rows ?? []).map((row) => rowToForm(row as Record<string, unknown>))
}

export async function getForm(master: Client, cmsSiteId: string, formId: string): Promise<FormRow | null> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return null
  const r = await siteDb.execute({ sql: "SELECT * FROM forms WHERE id = ? LIMIT 1", args: [formId] }).catch(() => null)
  return r?.rows.length ? rowToForm(r.rows[0] as Record<string, unknown>) : null
}

/** Form def for the PUBLIC submit endpoint (active forms only). */
export async function getActiveForm(siteDb: Client, formId: string): Promise<FormRow | null> {
  const r = await siteDb.execute({ sql: "SELECT * FROM forms WHERE id = ? AND active = 1 LIMIT 1", args: [formId] }).catch(() => null)
  return r?.rows.length ? rowToForm(r.rows[0] as Record<string, unknown>) : null
}

export interface FormInput {
  title: string
  fields: FieldDef[]
  ackEnabled: boolean
  ackSubject: string
  ackBody: string
  active: boolean
}

export async function createForm(
  env: CloudflareEnv, customerId: string, cmsSiteId: string, repoFullName: string | null,
  input: FormInput, master: Client
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!input.title.trim()) return { ok: false, error: "The form needs a title." }
  if (!input.fields.length) return { ok: false, error: "Add at least one field." }
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { ok: false, error: "The content workspace is unavailable." }
  const id = cuid()
  let slug = formSlug(input.title)
  const dup = await siteDb.execute({ sql: "SELECT 1 FROM forms WHERE slug = ? LIMIT 1", args: [slug] }).catch(() => null)
  if (dup?.rows.length) slug = `${slug}-${id.slice(-4)}`
  await siteDb.execute({
    sql: `INSERT INTO forms (id, slug, title, fields_json, ack_enabled, ack_subject, ack_body, active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, slug, input.title.trim(), JSON.stringify(input.fields), input.ackEnabled ? 1 : 0,
           input.ackSubject.trim() || null, input.ackBody.trim() || null, input.active ? 1 : 0],
  })
  await dispatchRebuild(env, master, customerId, repoFullName, "forms")
  return { ok: true, id }
}

export async function updateForm(
  env: CloudflareEnv, customerId: string, cmsSiteId: string, repoFullName: string | null,
  formId: string, input: FormInput, master: Client
): Promise<{ ok: boolean; error?: string }> {
  if (!input.title.trim()) return { ok: false, error: "The form needs a title." }
  if (!input.fields.length) return { ok: false, error: "Add at least one field." }
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { ok: false, error: "The content workspace is unavailable." }
  await siteDb.execute({
    sql: `UPDATE forms SET title=?, fields_json=?, ack_enabled=?, ack_subject=?, ack_body=?, active=? WHERE id=?`,
    args: [input.title.trim(), JSON.stringify(input.fields), input.ackEnabled ? 1 : 0,
           input.ackSubject.trim() || null, input.ackBody.trim() || null, input.active ? 1 : 0, formId],
  })
  await dispatchRebuild(env, master, customerId, repoFullName, "forms")
  return { ok: true }
}

export async function deleteForm(
  env: CloudflareEnv, customerId: string, cmsSiteId: string, repoFullName: string | null,
  formId: string, master: Client
): Promise<void> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return
  await siteDb.execute({ sql: "DELETE FROM forms WHERE id = ?", args: [formId] }).catch(() => {})
  await dispatchRebuild(env, master, customerId, repoFullName, "forms")
}

/** Store a validated submission. Country only — never a raw IP. */
export async function storeSubmission(
  siteDb: Client, formId: string, values: Record<string, string>, page: string | null, country: string | null
): Promise<string> {
  const id = cuid()
  await siteDb.execute({
    sql: `INSERT INTO form_submissions (id, form_id, fields_json, page, country) VALUES (?, ?, ?, ?, ?)`,
    args: [id, formId, JSON.stringify(values), page, country],
  })
  return id
}
