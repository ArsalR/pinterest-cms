// src/modules/pseo/generate.ts
// Programmatic SEO factory (K2), "with a leash". Upload a CSV + a page
// template with {{column}} placeholders → generate one page per row → run each
// through the QUALITY GATE. Rows that fail don't publish. The gate (unique
// title/meta, unique-content ratio, required per-page unique data) is the moat
// that makes this survive Google updates. Pure logic — unit-tested.

import { checkGate, DEFAULT_GATE_CONFIG, type GateConfig, type GateItem, type GateResult } from "../quality-gate"

// ─────────────────────── CSV parsing (pure, quote-aware) ───────────────────────

/** Minimal RFC-4180-ish CSV parser: handles quoted fields, commas, CRLF, "" escapes. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = []
  let field = ""
  let row: string[] = []
  let inQuotes = false
  const src = text.replace(/\r\n?/g, "\n")
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ",") { row.push(field); field = "" }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = "" }
    else field += ch
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""))
  if (nonEmpty.length < 2) return []
  const headers = nonEmpty[0].map((h) => h.trim())
  return nonEmpty.slice(1).map((r) => {
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => (obj[h] = (r[i] ?? "").trim()))
    return obj
  })
}

/** Render a {{column}} template against a row. Missing columns → empty string. */
export function renderTemplate(template: string, row: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => row[String(key).trim()] ?? "")
}

export interface PseoTemplate {
  titleTemplate: string
  metaTemplate: string
  contentTemplate: string
  slugTemplate: string
  /** Columns whose per-row values count as the page's "unique data" (K2 leash). */
  uniqueDataColumns: string[]
}

export interface GeneratedPage {
  row: number
  slug: string
  title: string
  meta: string
  content: string
  result: GateResult
}

export interface PseoRunSummary {
  total: number
  passed: number
  failed: number
  pages: GeneratedPage[]
}

/**
 * Generate + gate a batch from a CSV and template. Each page is scored against
 * the existing corpus AND the other generated pages (so near-duplicate rows
 * block each other). Config forces per-page unique data on by default.
 */
export function generateBatch(
  csv: string,
  template: PseoTemplate,
  corpus: GateItem[],
  config: GateConfig = { ...DEFAULT_GATE_CONFIG, minUniqueDataFields: Math.max(1, 0) }
): PseoRunSummary {
  const rows = parseCsv(csv)
  const generated: GeneratedPage[] = []
  const runningCorpus: GateItem[] = [...corpus]

  // Effective config: require at least 1 unique-data field for programmatic pages.
  const cfg: GateConfig = { ...config, minUniqueDataFields: Math.max(1, config.minUniqueDataFields || 1) }

  rows.forEach((row, i) => {
    const slug = slugify(renderTemplate(template.slugTemplate, row))
    const title = renderTemplate(template.titleTemplate, row)
    const meta = renderTemplate(template.metaTemplate, row)
    const content = renderTemplate(template.contentTemplate, row)
    const uniqueData: Record<string, string> = {}
    for (const col of template.uniqueDataColumns) uniqueData[col] = row[col] ?? ""

    const item: GateItem = { title, meta, content, uniqueData }
    const result = checkGate(item, runningCorpus, cfg)
    generated.push({ row: i + 1, slug, title, meta, content, result })
    // Passing pages join the corpus so later rows can't duplicate them.
    if (result.passed) runningCorpus.push(item)
  })

  return {
    total: generated.length,
    passed: generated.filter((g) => g.result.passed).length,
    failed: generated.filter((g) => !g.result.passed).length,
    pages: generated,
  }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "page"
}
