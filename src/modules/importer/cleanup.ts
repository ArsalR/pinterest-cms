// src/modules/importer/cleanup.ts
// "Clean up imported content" (K9 follow-up). WordPress exports carry debris:
// Gutenberg block comments, [shortcodes], page-builder wrappers, and piles of
// inline styles. Two tiers, both PREVIEW-THEN-APPROVE — never automatic:
//   1. stripWpArtifacts()  — deterministic, safe, always available (no key).
//   2. AI deep-clean       — smarter reformat on the CUSTOMER'S OWN key
//                            (same vault/rate-limit contract as the ✨ assists);
//                            hidden without a key. F1–F3 unaffected.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { getConnectionSecret } from "../connections"
import { assistAvailable, extractAssistText } from "../seo"
import { allowRate, type LimitRule } from "../../shared"

// Shares the per-customer assist bucket (spend is on their key; cap is abuse).
export const CLEANUP_LIMIT: LimitRule = { max: 60, windowSecs: 3600 }
export const CLEANUP_MODEL = "claude-haiku-4-5-20251001"

/**
 * Deterministic cleanup — removes WordPress/page-builder debris without
 * touching real content. Pure, unit-tested, safe to apply without review
 * (though the UI still previews it). Conservative on shortcodes: only strips
 * bracket tags that look like real shortcodes (attributes, a closing tag, or a
 * known builder/media name), so citation markers like [1] survive.
 */
export function stripWpArtifacts(html: string): string {
  let s = html
  // Gutenberg block delimiters: <!-- wp:paragraph --> … <!-- /wp:paragraph -->
  s = s.replace(/<!--\s*\/?wp:[\s\S]*?-->/g, "")
  // Any closing shortcode [/tag]
  s = s.replace(/\[\/[a-z][a-z0-9_-]*\]/gi, "")
  // Opening shortcode WITH attributes: [caption id="x" width="300"] etc.
  s = s.replace(/\[[a-z][a-z0-9_-]*\s[^\]]*\]/gi, "")
  // Known attribute-less builder/media shortcodes
  s = s.replace(/\[\/?(?:caption|gallery|embed|audio|video|playlist|et_pb_[a-z_]+|vc_[a-z_]+|fusion_[a-z_]+)\]/gi, "")
  // Empty paragraphs left behind (WP loves <p>&nbsp;</p>)
  s = s.replace(/<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, "")
  // Tidy whitespace
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
  return s.trim()
}

/** Rough count of debris the deterministic pass targets — drives the preview
 *  ("removes N shortcodes, M block comments, …"). Pure. */
export function countArtifacts(html: string): { shortcodes: number; blockComments: number; emptyParas: number; inlineStyles: number } {
  return {
    shortcodes: (html.match(/\[\/?[a-z][a-z0-9_-]*(?:\s[^\]]*)?\]/gi) || []).filter((m) => !/^\[\d+\]$/.test(m)).length,
    blockComments: (html.match(/<!--\s*\/?wp:[\s\S]*?-->/g) || []).length,
    emptyParas: (html.match(/<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/gi) || []).length,
    inlineStyles: (html.match(/\sstyle\s*=\s*"[^"]*"/gi) || []).length,
  }
}

// ─────────────────────── AI deep-clean (customer's key) ───────────────────────

/** Prompt for the AI cleanup. Pure. */
export function buildCleanupPrompt(html: string): { system: string; user: string } {
  return {
    system:
      "You clean up HTML that was migrated from WordPress into a modern static CMS. Return ONLY the cleaned HTML — no markdown fences, no commentary. Remove: leftover [shortcodes], Gutenberg block comments, page-builder wrapper markup, inline style attributes, empty tags, and redundant nested wrappers. KEEP all real content and structure: headings, paragraphs, lists, tables, blockquotes, links, and <img> tags (with their src/alt). Never invent, summarize, or delete real content — only clean the markup around it.",
    user: `Clean up this content:\n\n${html.slice(0, 40000)}`,
  }
}

/** Pull cleaned HTML out of the model reply, tolerating stray code fences. Pure. */
export function extractCleanedHtml(text: string | null): string | null {
  if (!text) return null
  let s = text.trim()
  const fence = /^```(?:html)?\s*([\s\S]*?)\s*```$/i.exec(s)
  if (fence) s = fence[1].trim()
  return s || null
}

/**
 * Content-loss guard: reject an AI result that lost too much visible text —
 * cleaning markup should barely change the text content. Compares stripped
 * text length; true = safe to offer. Pure.
 */
export function cleanupIsSafe(original: string, cleaned: string): boolean {
  const textLen = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length
  const before = textLen(original)
  const after = textLen(cleaned)
  if (before === 0) return after === 0
  return after >= before * 0.75 // lost >25% of visible text ⇒ reject
}

export interface CleanupResult {
  ok: boolean
  html?: string
  error?: string
}

/**
 * Run the AI deep-clean on the customer's own key. Returns cleaned HTML for
 * PREVIEW — the caller shows it and only writes it on explicit approval.
 * Never logs prompt/output; audit rows are counts-only (caller's concern).
 */
export async function runContentCleanup(env: CloudflareEnv, master: Client, customerId: string, html: string): Promise<CleanupResult> {
  if (!(await assistAvailable(master, customerId).catch(() => false))) {
    return { ok: false, error: "Connect your Anthropic key in Connections to use AI cleanup." }
  }
  if (!(await allowRate(master, `assist:${customerId}`, CLEANUP_LIMIT).catch(() => false))) {
    return { ok: false, error: "You've hit the hourly limit for AI actions — try again in a bit." }
  }
  const key = await getConnectionSecret(master, env, customerId, "anthropic", "content-cleanup").catch(() => null)
  if (!key) return { ok: false, error: "Your Anthropic key isn't available — re-connect it in Connections." }

  const prompt = buildCleanupPrompt(html)
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: CLEANUP_MODEL, max_tokens: 8000, system: prompt.system, messages: [{ role: "user", content: prompt.user }] }),
    })
    if (resp.status === 401 || resp.status === 403) return { ok: false, error: "Your Anthropic key was rejected — re-connect it in Connections." }
    if (resp.status === 429) return { ok: false, error: "Anthropic is rate-limiting your key right now — try again shortly." }
    if (!resp.ok) return { ok: false, error: "The cleanup service had a hiccup — try again." }
    const cleaned = extractCleanedHtml(extractAssistText(await resp.json()))
    if (!cleaned) return { ok: false, error: "No cleaned content came back — try again." }
    if (!cleanupIsSafe(html, cleaned)) return { ok: false, error: "The cleanup looked like it dropped content, so it was discarded. Your original is untouched." }
    return { ok: true, html: cleaned }
  } catch {
    return { ok: false, error: "Couldn't reach the cleanup service — try again." }
  }
}
