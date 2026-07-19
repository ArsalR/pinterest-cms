// src/modules/forms/intel.ts
// ✨ Submission intelligence (V1.4 F4): per-submission summary + lead score
// computed on arrival, a drafted reply on demand (NEVER auto-sent), and an
// optional daily inbox digest. All inference runs on the CUSTOMER'S OWN
// vault-stored Anthropic key (same contract as the SEO assists): no key ⇒
// every ✨ surface is hidden and F1–F3 work exactly as before.
//
// Privacy contract (spec): the key never appears in logs; prompt content and
// model output are never audit-logged — audit rows carry counts/tags only.
// Prompt builders + response parsing are pure and unit-tested.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { getConnectionSecret } from "../connections"
import { assistAvailable, extractAssistText, siteDbFor } from "../seo"
import { allowRate, type LimitRule } from "../../shared"
import { sendEmail } from "../customers"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared/masterMigrate"
import { escapeHtml } from "../../lib/utils"
import { formsFromAddress } from "./model"

// Per-customer cap shared across all form-intel calls (arrival scoring +
// reply drafts). The spend is on their key; the cap is abuse protection.
export const INTEL_LIMIT: LimitRule = { max: 60, windowSecs: 3600 }
export const INTEL_MODEL = "claude-haiku-4-5-20251001"

export const LEAD_SCORES = ["hot", "warm", "cold"] as const
export type LeadScore = (typeof LEAD_SCORES)[number]

export interface IntelInput {
  formTitle: string
  siteName: string
  fields: Record<string, string>
}

function fieldsText(fields: Record<string, string>, cap = 4000): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
    .slice(0, cap)
}

/** Prompt for the arrival pass: one-line summary + lead score. Pure. */
export function buildIntelPrompt(input: IntelInput): { system: string; user: string } {
  return {
    system:
      'You triage inbound form submissions for a small business. Reply with ONLY a JSON object like {"summary":"…","score":"hot|warm|cold","reason":"…"} — summary is ONE sentence (max 140 chars) of who wrote and what they want; score is hot (ready to buy / urgent / concrete request), warm (genuine interest, needs follow-up), or cold (vague, spammy, or low intent); reason is under 60 chars. Never invent details.',
    user: `Site: ${input.siteName}\nForm: ${input.formTitle}\nSubmission:\n${fieldsText(input.fields)}\n\nTriage it.`,
  }
}

/** Prompt for the on-demand reply draft. Pure. */
export function buildDraftPrompt(input: IntelInput): { system: string; user: string } {
  return {
    system:
      "You draft a short, warm, professional reply email from a small-business owner to someone who just submitted their website form. Reply with ONLY the email body text — no subject line, no signature placeholders, no markdown. 3-6 sentences, address what they asked, propose a concrete next step. Never invent prices, dates, or facts not in the submission.",
    user: `Site: ${input.siteName}\nForm: ${input.formTitle}\nSubmission:\n${fieldsText(input.fields)}\n\nDraft the reply.`,
  }
}

export interface IntelResult {
  summary: string
  score: LeadScore
  reason: string
}

/** Parse the model's triage JSON (tolerates code fences / surrounding prose). Pure. */
export function parseIntelResponse(text: string | null): IntelResult | null {
  if (!text) return null
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    const o = JSON.parse(m[0]) as { summary?: unknown; score?: unknown; reason?: unknown }
    const summary = String(o.summary ?? "").trim().slice(0, 200)
    const score = String(o.score ?? "").trim().toLowerCase()
    if (!summary || !(LEAD_SCORES as readonly string[]).includes(score)) return null
    return { summary, score: score as LeadScore, reason: String(o.reason ?? "").trim().slice(0, 80) }
  } catch {
    return null
  }
}

async function callAnthropic(key: string, system: string, user: string, maxTokens: number): Promise<string | null> {
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: INTEL_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    })
    if (!resp.ok) return null
    return extractAssistText(await resp.json())
  } catch {
    return null
  }
}

/** Shared gate: key present + under the hourly cap. Returns the key or null. */
async function intelKey(env: CloudflareEnv, master: Client, customerId: string): Promise<string | null> {
  if (!(await assistAvailable(master, customerId).catch(() => false))) return null
  if (!(await allowRate(master, `assist:${customerId}`, INTEL_LIMIT).catch(() => false))) return null
  return getConnectionSecret(master, env, customerId, "anthropic", "forms-intel").catch(() => null)
}

/** Arrival pass: summarize + score one submission. Null on any miss (no key,
 *  over cap, API hiccup) — the submission is stored either way. */
export async function runFormIntel(env: CloudflareEnv, master: Client, customerId: string, input: IntelInput): Promise<IntelResult | null> {
  const key = await intelKey(env, master, customerId)
  if (!key) return null
  const prompt = buildIntelPrompt(input)
  return parseIntelResponse(await callAnthropic(key, prompt.system, prompt.user, 300))
}

/** On-demand reply draft. Never sent by us — it prefills the compose box. */
export async function runDraftReply(env: CloudflareEnv, master: Client, customerId: string, input: IntelInput): Promise<string | null> {
  const key = await intelKey(env, master, customerId)
  if (!key) return null
  const text = await callAnthropic(key, buildDraftPrompt(input).system, buildDraftPrompt(input).user, 700)
  return text ? text.slice(0, 5000) : null
}

/** Persist the arrival pass onto the submission row. Score stored as
 *  "hot: reason" — the inbox splits on ':' for the badge. */
export async function saveIntel(siteDb: Client, submissionId: string, intel: IntelResult): Promise<void> {
  await siteDb.execute({
    sql: "UPDATE form_submissions SET ai_summary = ?, ai_score = ? WHERE id = ?",
    args: [intel.summary, intel.reason ? `${intel.score}: ${intel.reason}` : intel.score, submissionId],
  }).catch(() => {})
}

// ─────────────────────── daily digest ───────────────────────

export interface DigestItem {
  formTitle: string
  first: string
  aiSummary: string | null
  aiScore: string | null
  createdAt: string
}

/** Digest email body. Pure — unit-tested (everything escaped). */
export function digestEmailHtml(domain: string, appHost: string, siteId: string, items: DigestItem[]): string {
  const rows = items
    .map(
      (i) =>
        `<li style="margin:6px 0"><strong>${escapeHtml(i.first.slice(0, 60) || "(submission)")}</strong> — ${escapeHtml(i.formTitle)} · ${escapeHtml(i.createdAt.slice(0, 16))}${i.aiSummary ? `<br><span style="color:#2563eb">✨ ${escapeHtml(i.aiSummary)}${i.aiScore ? ` (${escapeHtml(i.aiScore.split(":")[0])})` : ""}</span>` : ""}</li>`
    )
    .join("")
  return `<p>${items.length} new submission${items.length === 1 ? "" : "s"} on <strong>${escapeHtml(domain)}</strong> in the last day:</p><ul style="padding-left:18px">${rows}</ul><p><a href="https://${escapeHtml(appHost)}/app/sites/${escapeHtml(siteId)}/inbox">Open the inbox →</a></p>`
}

/**
 * Daily digest walker — rides the existing 0 4 * * * cron branch (gotcha #8:
 * no new cron string). Per site: opt-in setting + ✨ available + ~daily
 * self-throttle; sends only when there ARE new submissions. Best-effort.
 */
export async function runInboxDigest(env: CloudflareEnv, _now: number): Promise<void> {
  const master = getMasterDb(env)
  await ensureMasterSchema(master)
  const sitesR = await master.execute({
    sql: `SELECT cs.id, cs.domain, cs.name, cs.customer_id, cs.cms_site_id,
                 cs.forms_domain, cs.forms_domain_status, c.email AS owner_email
          FROM customer_sites cs JOIN customers c ON c.id = cs.customer_id
          WHERE cs.cms_site_id IS NOT NULL`,
    args: [],
  }).catch(() => null)
  if (!sitesR) return
  const appHost = env.SAAS_APP_HOSTNAME || "arsal.app"
  for (const row of sitesR.rows as unknown as Array<{
    id: string; domain: string; name: string; customer_id: string; cms_site_id: string
    forms_domain: string | null; forms_domain_status: string | null; owner_email: string
  }>) {
    try {
      const siteDb = await siteDbFor(master, row.cms_site_id)
      if (!siteDb) continue
      const setting = await siteDb.execute({ sql: "SELECT value FROM settings WHERE key = 'inbox_digest_enabled' LIMIT 1", args: [] }).catch(() => null)
      if (String(setting?.rows[0]?.value ?? "") !== "1") continue
      if (!(await assistAvailable(master, row.customer_id).catch(() => false))) continue
      // ~daily throttle so overlapping cron ticks can't double-send.
      if (!(await allowRate(master, `formdigest:${row.id}`, { max: 1, windowSecs: 20 * 3600 }).catch(() => false))) continue
      const subs = await siteDb.execute({
        sql: `SELECT s.fields_json, s.ai_summary, s.ai_score, s.created_at, f.title AS form_title
              FROM form_submissions s LEFT JOIN forms f ON f.id = s.form_id
              WHERE s.created_at >= datetime('now', '-1 day') ORDER BY s.created_at DESC LIMIT 20`,
        args: [],
      }).catch(() => null)
      if (!subs?.rows.length) continue
      const items: DigestItem[] = subs.rows.map((s) => {
        let first = ""
        try {
          const o = JSON.parse(String(s.fields_json ?? "{}")) as Record<string, unknown>
          first = String(Object.values(o)[0] ?? "")
        } catch { /* ignore */ }
        return {
          formTitle: String(s.form_title ?? ""),
          first,
          aiSummary: (s.ai_summary as string | null) ?? null,
          aiScore: (s.ai_score as string | null) ?? null,
          createdAt: String(s.created_at ?? ""),
        }
      })
      await sendEmail(env, {
        to: row.owner_email,
        from: formsFromAddress(row.name, row.forms_domain, row.forms_domain_status),
        subject: `✨ Daily inbox digest — ${items.length} new on ${row.domain}`,
        html: digestEmailHtml(row.domain, appHost, row.id, items),
      }).catch(() => {})
    } catch {
      // one bad site never stalls the walk
    }
  }
}
