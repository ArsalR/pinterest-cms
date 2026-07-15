// src/modules/quality-gate/gate.ts
// The quality gate (K2 "the gate is the moat"). Pure functions — the flagship
// test suite lives beside this file. Default-ON: nothing publishes through the
// SaaS pipeline unless it clears these checks. Enforces, per the spec:
//   - minimum word count / thin-content blocker
//   - title + meta present, and NOT duplicated across the site
//   - unique-content ratio between pages (shingling / Jaccard)
//   - required unique data per page (for programmatic batches, K2)

export interface GateConfig {
  minWords: number
  /** Required uniqueness (1 - max similarity to any existing page), 0..1. */
  minUniqueRatio: number
  requireTitle: boolean
  requireMeta: boolean
  /** Two titles this similar (normalized Jaccard on words) count as duplicates. */
  maxTitleSimilarity: number
  /** k for k-word shingles used in the content similarity check. */
  shingleK: number
  /** Programmatic batches: each page must carry at least this many unique-data fields. */
  minUniqueDataFields: number
}

// Default-ON thresholds (spec non-negotiable). Tuned to block spam-grade
// content without rejecting genuinely useful short pages too aggressively.
export const DEFAULT_GATE_CONFIG: GateConfig = {
  minWords: 300,
  minUniqueRatio: 0.7,
  requireTitle: true,
  requireMeta: true,
  maxTitleSimilarity: 0.8,
  shingleK: 3,
  minUniqueDataFields: 0, // only enforced when the caller passes uniqueData
}

export interface GateItem {
  title: string
  meta?: string | null // excerpt / meta description
  content: string // HTML or plain
  /** Programmatic-page data fields (K2); their uniqueness is checked vs the corpus. */
  uniqueData?: Record<string, string>
}

export interface GateCheck {
  id: string
  label: string
  passed: boolean
  detail: string
}

export interface GateResult {
  passed: boolean
  score: number // 0..100, informational
  checks: GateCheck[]
}

// ─────────────────────── text helpers (pure) ───────────────────────

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function wordCount(text: string): number {
  const t = stripHtml(text)
  return t ? t.split(/\s+/).length : 0
}

function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
}

/** Set of k-word shingles for content-similarity. */
export function shingles(text: string, k: number): Set<string> {
  const words = normalizeWords(stripHtml(text))
  const out = new Set<string>()
  if (words.length < k) {
    if (words.length) out.add(words.join(" "))
    return out
  }
  for (let i = 0; i + k <= words.length; i++) out.add(words.slice(i, i + k).join(" "))
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0
  let inter = 0
  const [small, large] = a.size < b.size ? [a, b] : [b, a]
  for (const x of small) if (large.has(x)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/** Max content similarity of `item` to any corpus entry (0..1). */
export function maxContentSimilarity(item: GateItem, corpus: GateItem[], k: number): number {
  const s = shingles(item.content, k)
  let max = 0
  for (const other of corpus) {
    const sim = jaccard(s, shingles(other.content, k))
    if (sim > max) max = sim
  }
  return max
}

function titleSimilarity(a: string, b: string): number {
  return jaccard(new Set(normalizeWords(a)), new Set(normalizeWords(b)))
}

// ─────────────────────── the gate ───────────────────────

export function checkGate(
  item: GateItem,
  corpus: GateItem[],
  config: GateConfig = DEFAULT_GATE_CONFIG
): GateResult {
  const checks: GateCheck[] = []

  // 1. Word count / thin content.
  const wc = wordCount(item.content)
  checks.push({
    id: "word_count",
    label: "Enough substance",
    passed: wc >= config.minWords,
    detail: `${wc} words (minimum ${config.minWords})`,
  })

  // 2. Title present + not a duplicate of an existing page.
  const title = (item.title ?? "").trim()
  if (config.requireTitle) {
    const dupTitle = corpus.find((o) => titleSimilarity(title, o.title ?? "") >= config.maxTitleSimilarity)
    checks.push({
      id: "title",
      label: "Unique title",
      passed: !!title && !dupTitle,
      detail: !title ? "missing title" : dupTitle ? `too similar to an existing page ("${dupTitle.title}")` : "ok",
    })
  }

  // 3. Meta / excerpt present.
  if (config.requireMeta) {
    const meta = (item.meta ?? "").trim()
    checks.push({
      id: "meta",
      label: "Meta description",
      passed: meta.length >= 20,
      detail: meta.length >= 20 ? "ok" : "missing or too short (needs ≥ 20 chars)",
    })
  }

  // 4. Unique content ratio vs the rest of the site.
  const maxSim = maxContentSimilarity(item, corpus, config.shingleK)
  const uniqueRatio = 1 - maxSim
  checks.push({
    id: "unique_content",
    label: "Distinct from other pages",
    passed: uniqueRatio >= config.minUniqueRatio,
    detail: `${Math.round(uniqueRatio * 100)}% unique (minimum ${Math.round(config.minUniqueRatio * 100)}%)`,
  })

  // 5. Required unique data (programmatic batches, K2).
  if (config.minUniqueDataFields > 0) {
    const fields = item.uniqueData ? Object.values(item.uniqueData).filter((v) => v && v.trim()).length : 0
    checks.push({
      id: "unique_data",
      label: "Per-page unique data",
      passed: fields >= config.minUniqueDataFields,
      detail: `${fields} unique data fields (minimum ${config.minUniqueDataFields})`,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  return {
    passed: checks.every((c) => c.passed),
    score: checks.length ? Math.round((passedCount / checks.length) * 100) : 100,
    checks,
  }
}
