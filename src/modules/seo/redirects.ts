// src/modules/seo/redirects.ts
// Redirects manager (S4) — PURE helpers for the customer-facing redirects &
// branded-links manager. The redirect ENGINE already lives in src/lib/redirects.ts
// (301/302/410, exact/prefix match, served at the edge); this module adds the
// management layer: validation, CSV round-trip, chain/loop detection, and the
// branded-link classification. No I/O — unit-tested.

export type RedirectKind = "301" | "302" | "410"
export type RedirectMatch = "exact" | "prefix"

export interface RedirectInput {
  from: string
  to: string
  kind: RedirectKind
  matchType: RedirectMatch
}

export interface RedirectRow extends RedirectInput {
  id: string
  hits: number
  lastHitAt: string | null
  message: string | null
}

/** Normalize a source path: leading slash, trimmed, collapse double slashes. Pure. */
export function normalizeFrom(path: string): string {
  let p = path.trim()
  if (!p) return ""
  if (!p.startsWith("/")) p = "/" + p
  return p.replace(/\/{2,}/g, "/")
}

const KINDS: RedirectKind[] = ["301", "302", "410"]
const MATCHES: RedirectMatch[] = ["exact", "prefix"]

/** Validate a single redirect. Returns an error string, or null when valid. Pure. */
export function validateRedirect(input: RedirectInput): string | null {
  const from = normalizeFrom(input.from)
  if (!from || from === "/") return "Source path is required (e.g. /old-page/)."
  if (from.length > 512 || /\s/.test(from)) return "Source path is too long or contains spaces."
  if (!KINDS.includes(input.kind)) return "Type must be 301, 302 or 410."
  if (!MATCHES.includes(input.matchType)) return "Match must be exact or prefix."
  if (input.kind === "410") return null // a 410 (Gone) needs no target
  const to = input.to.trim()
  if (!to) return "A 301/302 needs a target."
  const okInternal = to.startsWith("/") && to.length <= 512 && !/\s/.test(to)
  const okExternal = /^https:\/\/[^\s]+$/.test(to) && to.length <= 512
  if (!okInternal && !okExternal) return "Target must be an internal path (/page/) or an https:// URL."
  return null
}

/** A branded link is a redirect to an EXTERNAL https URL (short, shareable). Pure. */
export function isBrandedLink(r: Pick<RedirectRow, "to" | "kind">): boolean {
  return r.kind !== "410" && /^https:\/\//i.test(r.to.trim())
}

// ─────────────────────── CSV round-trip ───────────────────────

const CSV_HEADER = "from,to,kind,match"

function csvField(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** Serialize redirects to CSV (from,to,kind,match). Pure. */
export function toRedirectsCsv(rows: Array<Pick<RedirectRow, "from" | "to" | "kind" | "matchType">>): string {
  const lines = [CSV_HEADER]
  for (const r of rows) lines.push([r.from, r.to, r.kind, r.matchType].map((x) => csvField(String(x ?? ""))).join(","))
  return lines.join("\n") + "\n"
}

/** Split one CSV line into fields, honoring simple double-quote quoting. Pure. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = "", inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ }
        else inQ = false
      } else cur += c
    } else if (c === '"') inQ = true
    else if (c === ",") { out.push(cur); cur = "" }
    else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

export interface CsvParseResult {
  rows: RedirectInput[]
  errors: Array<{ line: number; message: string }>
}

/**
 * Parse a redirects CSV (from,to,kind,match). A header row is optional and
 * skipped if present. kind defaults to 301, match to exact. Each row is
 * validated; invalid rows are reported and skipped, never thrown. Pure.
 */
export function parseRedirectsCsv(text: string): CsvParseResult {
  const rows: RedirectInput[] = []
  const errors: Array<{ line: number; message: string }> = []
  const rawLines = text.split(/\r?\n/)
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]
    if (!raw.trim()) continue
    const f = splitCsvLine(raw)
    if (i === 0 && f[0]?.toLowerCase() === "from" && f[1]?.toLowerCase() === "to") continue // header
    const input: RedirectInput = {
      from: f[0] ?? "",
      to: f[1] ?? "",
      kind: (KINDS.includes(f[2] as RedirectKind) ? f[2] : "301") as RedirectKind,
      matchType: (MATCHES.includes(f[3] as RedirectMatch) ? f[3] : "exact") as RedirectMatch,
    }
    const err = validateRedirect(input)
    if (err) errors.push({ line: i + 1, message: err })
    else rows.push({ ...input, from: normalizeFrom(input.from), to: input.to.trim() })
  }
  return { rows, errors }
}

// ─────────────────────── chain / loop detection ───────────────────────

export interface RedirectChain {
  /** The source path that begins the chain. */
  from: string
  /** Ordered hops (target paths) — length ≥ 2 means a multi-hop chain. */
  hops: string[]
  /** True when the chain cycles back to a path already visited. */
  loop: boolean
}

/** Path portion of a redirect target (internal only; external → null). Pure. */
function targetPath(to: string): string | null {
  const t = to.trim()
  if (t.startsWith("/")) return normalizeFrom(t.split(/[?#]/)[0])
  return null // external target — chains stop here
}

/**
 * Detect redirect chains and loops. A chain is a redirect whose target lands on
 * another redirect's source (a→b→c), forcing browsers through extra hops and
 * bleeding link equity; a loop cycles forever. Returns one entry per source
 * that starts a chain of length ≥ 2 (or any self/loop). Pure.
 */
export function detectChains(rows: Array<Pick<RedirectRow, "from" | "to" | "kind" | "matchType">>): RedirectChain[] {
  // Map exact source → target path (only exact 301/302 with internal targets chain).
  const byFrom = new Map<string, string | null>()
  for (const r of rows) {
    if (r.kind === "410" || r.matchType !== "exact") continue
    byFrom.set(normalizeFrom(r.from), targetPath(r.to))
  }
  const out: RedirectChain[] = []
  for (const [start, firstTo] of byFrom) {
    if (firstTo == null) continue
    // Only a problem when the first target is ITSELF a redirect source (a→b→…)
    // or the whole thing loops. A plain a→x (x not a source) is a normal redirect.
    const firstTargetIsSource = byFrom.has(firstTo)
    const hops: string[] = []
    const visited = new Set<string>([start])
    let cur: string | null = firstTo
    let loop = false
    while (cur != null) {
      hops.push(cur)
      if (visited.has(cur)) { loop = true; break }
      visited.add(cur)
      if (!byFrom.has(cur)) break
      cur = byFrom.get(cur) ?? null
    }
    if (firstTargetIsSource || loop) out.push({ from: start, hops, loop })
  }
  return out
}
