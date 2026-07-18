// src/modules/seo/aeo.ts
// AI-SEO profile (V1.3 P5, AEO + GEO/LLMO) — PURE builders + analyzers. The
// content blocks are plain-HTML conventions (semantic markup + a marker
// class): answer engines and LLMs quote clean, self-contained units, so the
// builders emit exactly that, and the extractors turn them into matching
// schema. The AI-visibility checklist shares the analyzer pattern from
// content.ts (same rules module family, one source of truth). No I/O.

// ─────────────────────── content blocks ───────────────────────
// Conventions (documented in the dashboard; emitted by builders/genesis):
//   TL;DR      <div class="aeo-tldr"><ul><li>…</li></ul></div>
//   Definition <div class="aeo-definition"><dfn>term</dfn> definition…</div>
//   Q&A        (existing FAQ conventions — question-shaped h2/h3 + answer)
//   Stat       <div class="aeo-stat">stat sentence <a href="src">Source</a></div>

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] ?? c)
}

/** TL;DR / key-takeaways block. Pure. */
export function tldrBlockHtml(items: string[]): string {
  const lis = items.filter((i) => i.trim()).map((i) => `<li>${esc(i.trim())}</li>`).join("")
  return `<div class="aeo-tldr"><p><strong>TL;DR</strong></p><ul>${lis}</ul></div>`
}

/** Definition block (emits DefinedTerm schema at build). Pure. */
export function definitionBlockHtml(term: string, definition: string): string {
  return `<div class="aeo-definition"><p><dfn>${esc(term.trim())}</dfn> — ${esc(definition.trim())}</p></div>`
}

/** Stat-with-source block. Pure. */
export function statBlockHtml(stat: string, sourceName: string, sourceUrl: string): string {
  return `<div class="aeo-stat"><p>${esc(stat.trim())} <a href="${esc(sourceUrl.trim())}" rel="noopener">${esc(sourceName.trim() || "Source")}</a></p></div>`
}

export interface AeoBlocks {
  /** TL;DR bullet texts (first tldr block). */
  tldr: string[]
  /** {term, definition} pairs from definition blocks. */
  definitions: Array<{ term: string; definition: string }>
  /** Stat sentences that carry a source link. */
  stats: Array<{ text: string; sourceUrl: string }>
}

const STRIP = /<[^>]+>/g
const text = (html: string) => html.replace(STRIP, " ").replace(/\s+/g, " ").trim()

/** Extract AEO blocks from post HTML. Tolerant; absent → empty. Pure. */
export function extractAeoBlocks(html: string): AeoBlocks {
  const out: AeoBlocks = { tldr: [], definitions: [], stats: [] }
  if (!html) return out
  const tldr = /<div class="aeo-tldr">([\s\S]*?)<\/div>/i.exec(html)
  if (tldr) {
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi
    let m: RegExpExecArray | null
    while ((m = liRe.exec(tldr[1])) !== null) out.tldr.push(text(m[1]))
  }
  const defRe = /<div class="aeo-definition">([\s\S]*?)<\/div>/gi
  let d: RegExpExecArray | null
  while ((d = defRe.exec(html)) !== null) {
    const term = /<dfn[^>]*>([\s\S]*?)<\/dfn>/i.exec(d[1])
    if (!term) continue
    const full = text(d[1])
    const termText = text(term[1])
    const definition = full.startsWith(termText) ? full.slice(termText.length).replace(/^[\s—–:-]+/, "") : full
    if (termText && definition) out.definitions.push({ term: termText, definition })
  }
  const statRe = /<div class="aeo-stat">([\s\S]*?)<\/div>/gi
  let st: RegExpExecArray | null
  while ((st = statRe.exec(html)) !== null) {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(st[1])
    if (href) out.stats.push({ text: text(st[1]), sourceUrl: href[1] })
  }
  return out
}

/** DefinedTerm JSON-LD nodes for extracted definitions. Pure. */
export function definedTermsLd(blocks: AeoBlocks): object[] {
  return blocks.definitions.map((d) => ({
    "@type": "DefinedTerm",
    name: d.term,
    description: d.definition,
  }))
}

// ─────────────────────── AI-visibility checklist ───────────────────────

export interface AiVisibilityInput {
  title: string
  excerpt: string
  content: string
  hasAuthor: boolean
  /** ISO date of last update (dateModified). */
  updatedAt: string | null
  /** Reference time (ms) — injected for purity. */
  nowMs: number
}

export interface AiCheck {
  id: string
  label: string
  status: "good" | "warn"
  detail: string
}

const QUESTION_HEAD = /^(how|what|why|when|where|which|who|can|do|does|is|are|should|will)\b/i
export const FRESH_MONTHS = 12

/** The per-post AI-visibility checklist (extends the S2 analyzer family —
 *  same shared-rules approach, mirrored in the cockpit JS). Pure. */
export function analyzeAiVisibility(input: AiVisibilityInput): AiCheck[] {
  const checks: AiCheck[] = []
  const blocks = extractAeoBlocks(input.content)

  // 1. Quotable summary: a TL;DR block or a tight excerpt.
  const hasSummary = blocks.tldr.length > 0 || (input.excerpt.trim().length >= 40 && input.excerpt.trim().length <= 300)
  checks.push({
    id: "quotable_summary",
    label: "Quotable summary",
    status: hasSummary ? "good" : "warn",
    detail: hasSummary ? "AI engines can lift a clean summary" : "Add a TL;DR block or a 40-300 character excerpt — that's what AI answers quote",
  })

  // 2. Question-shaped headings where apt.
  const heads: string[] = []
  const hRe = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi
  let m: RegExpExecArray | null
  while ((m = hRe.exec(input.content)) !== null) heads.push(text(m[1]))
  const questionHeads = heads.filter((h) => h.endsWith("?") || QUESTION_HEAD.test(h)).length
  checks.push({
    id: "question_headings",
    label: "Question-shaped headings",
    status: heads.length === 0 || questionHeads > 0 ? "good" : "warn",
    detail: heads.length === 0 ? "no subheadings to shape" : questionHeads > 0 ? `${questionHeads} of ${heads.length} headings answer a question` : "phrase some headings as the questions people actually ask",
  })

  // 3. Stats sourced.
  const hasNumbers = /\d[\d,.]*\s*(%|percent|million|billion|kg|km|mph|\$)/i.test(text(input.content))
  const sourced = blocks.stats.length > 0
  checks.push({
    id: "stats_sourced",
    label: "Stats carry sources",
    status: !hasNumbers || sourced ? "good" : "warn",
    detail: !hasNumbers ? "no statistics to source" : sourced ? `${blocks.stats.length} sourced stat${blocks.stats.length === 1 ? "" : "s"}` : "statistics without a linked source get skipped by answer engines",
  })

  // 4. Author attributed (E-E-A-T).
  checks.push({
    id: "author",
    label: "Author attributed",
    status: input.hasAuthor ? "good" : "warn",
    detail: input.hasAuthor ? "byline + Person schema present" : "assign an author (Advanced tab) — attribution is an AI-citation signal",
  })

  // 5. Dates fresh.
  const t = input.updatedAt ? Date.parse(input.updatedAt.includes("T") ? input.updatedAt : input.updatedAt.replace(" ", "T") + "Z") : NaN
  const fresh = Number.isFinite(t) && input.nowMs - t <= FRESH_MONTHS * 30 * 864e5
  checks.push({
    id: "fresh",
    label: "Dates fresh",
    status: fresh ? "good" : "warn",
    detail: fresh ? "updated within the last year" : `not updated in over ${FRESH_MONTHS} months — stale dates lose AI citations`,
  })

  return checks
}
