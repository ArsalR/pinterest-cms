// src/modules/seo/assist.ts
// ✨ AI assists (V1.3, decision resolved): suggestion calls to the Anthropic
// API made with the CUSTOMER'S OWN vault-stored key — the platform never pays
// for or proxies inference by default; no key in the vault ⇒ the buttons are
// hidden and everything works manually. Privacy contract: the prompt and the
// suggestion are NEVER logged or stored; the audit log records usage counts
// only ({task}, no content). Rate-limited per customer (generous).
//
// Prompt builders + response extraction are pure and unit-tested; the fetch
// wrapper is best-effort and returns a friendly error string.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { getConnection, getConnectionSecret } from "../connections"
import { allowRate, type LimitRule } from "../../shared"

// Generous per-customer cap (the spend is on their key, the cap is for abuse).
export const ASSIST_LIMIT: LimitRule = { max: 60, windowSecs: 3600 }

// Small/fast model — assists are one-line suggestions on the customer's bill.
export const ASSIST_MODEL = "claude-haiku-4-5-20251001"

export type AssistTask = "meta_title" | "meta_description" | "faq" | "alt_text"

export interface AssistInput {
  /** Post title (meta/faq tasks). */
  title?: string
  /** Post body HTML or text, truncated by the builder (meta/faq tasks). */
  content?: string
  /** Site name for tone/branding context. */
  siteName?: string
  /** Image URL (alt_text task — sent to the model as an image block). */
  imageUrl?: string
  /** Image filename, a weak hint alongside the pixels. */
  filename?: string
}

const STRIP = /<[^>]+>/g
function textOf(html: string, cap: number): string {
  return html.replace(STRIP, " ").replace(/\s+/g, " ").trim().slice(0, cap)
}

/** Build the (system, user) prompt for a task. Pure — unit-tested. */
export function buildAssistPrompt(task: AssistTask, input: AssistInput): { system: string; user: string } | null {
  const site = (input.siteName ?? "").trim()
  const body = textOf(input.content ?? "", 6000)
  switch (task) {
    case "meta_title":
      if (!input.title && !body) return null
      return {
        system:
          "You write SEO meta titles. Reply with ONLY the title text — no quotes, no explanations. Keep it under 60 characters, compelling and accurate to the content.",
        user: `Site: ${site}\nPost title: ${input.title ?? ""}\nContent:\n${body}\n\nWrite one meta title.`,
      }
    case "meta_description":
      if (!input.title && !body) return null
      return {
        system:
          "You write SEO meta descriptions. Reply with ONLY the description text — no quotes, no explanations. 140-155 characters, active voice, accurate to the content, ends with a reason to click.",
        user: `Site: ${site}\nPost title: ${input.title ?? ""}\nContent:\n${body}\n\nWrite one meta description.`,
      }
    case "faq":
      if (!body) return null
      return {
        system:
          'You extract FAQ pairs from an article. Reply with ONLY a JSON array like [{"question":"…","answer":"…"}] — 2 to 5 pairs, answers under 300 characters, strictly grounded in the article (never invent facts).',
        user: `Article:\n${body}\n\nExtract the FAQ pairs.`,
      }
    case "alt_text":
      if (!input.imageUrl) return null
      return {
        system:
          "You write image alt text for accessibility and SEO. Reply with ONLY the alt text — no quotes, under 120 characters, describe what the image shows; don't start with \"image of\".",
        user: `Filename hint: ${input.filename ?? "none"}\nDescribe this image as alt text.`,
      }
  }
}

/** Pull the suggestion text out of an Anthropic Messages response. Pure. */
export function extractAssistText(json: unknown): string | null {
  const body = json as { content?: Array<{ type?: string; text?: string }> } | null
  if (!body?.content?.length) return null
  const text = body.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim()
  return text || null
}

/** Is the ✨ surface available for this customer (anthropic key in the vault)? */
export async function assistAvailable(master: Client, customerId: string): Promise<boolean> {
  const row = await getConnection(master, customerId, "anthropic").catch(() => null)
  return row?.status === "active"
}

export interface AssistResult {
  ok: boolean
  text?: string
  error?: string
}

/**
 * Run one assist call with the customer's key. Rate-limited per customer.
 * NEVER logs prompt or output — the caller audit-logs {task} counts only.
 */
export async function runAssist(
  env: CloudflareEnv,
  master: Client,
  customerId: string,
  task: AssistTask,
  input: AssistInput
): Promise<AssistResult> {
  const prompt = buildAssistPrompt(task, input)
  if (!prompt) return { ok: false, error: "Not enough content to suggest from yet." }

  const allowed = await allowRate(master, `assist:${customerId}`, ASSIST_LIMIT)
  if (!allowed) return { ok: false, error: "You've hit the hourly limit for AI suggestions — try again in a bit." }

  const key = await getConnectionSecret(master, env, customerId, "anthropic", "seo-assist").catch(() => null)
  if (!key) return { ok: false, error: "Connect your Anthropic key in Connections to use AI suggestions." }

  const userContent: unknown =
    task === "alt_text" && input.imageUrl
      ? [
          { type: "image", source: { type: "url", url: input.imageUrl } },
          { type: "text", text: prompt.user },
        ]
      : prompt.user

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: ASSIST_MODEL,
        max_tokens: 600,
        system: prompt.system,
        messages: [{ role: "user", content: userContent }],
      }),
    })
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, error: "Your Anthropic key was rejected — re-connect it in Connections." }
    }
    if (resp.status === 429) {
      return { ok: false, error: "Anthropic is rate-limiting your key right now — try again shortly." }
    }
    if (!resp.ok) return { ok: false, error: "The suggestion service had a hiccup — try again." }
    const text = extractAssistText(await resp.json())
    if (!text) return { ok: false, error: "No suggestion came back — try again." }
    return { ok: true, text }
  } catch {
    return { ok: false, error: "Couldn't reach the suggestion service — try again." }
  }
}
