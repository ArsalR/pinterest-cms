// src/modules/network/aeo.ts
// Answer-Engine-Optimization checklist (K8) — PURE logic, unit-tested. Scores a
// single post on how easily an AI assistant (ChatGPT, Perplexity, Google AI
// Overviews) can find, understand, and cite it. This is the per-post half of
// AEO; the sitewide half (llms.txt + JSON-LD schema) lives in the site
// template.
//
// The checks encode what actually helps extraction: a concise meta/summary the
// engine can quote, question-style headings that map to how people ask, lists
// and depth that give a citable answer, and a recent dateModified so the engine
// trusts freshness. No I/O — the caller passes a plain post shape.

export interface AeoPost {
  title: string
  metaDescription: string
  excerpt: string
  contentHtml: string
  updatedAt: string | null // ISO date; drives the freshness check
}

export interface AeoCheck {
  id: string
  label: string
  passed: boolean
  weight: number
  hint: string // shown when failed — what to change
}

export interface AeoResult {
  score: number       // 0..100, weight-based
  passed: boolean     // score >= 70 (a usable AEO baseline)
  checks: AeoCheck[]
}

const STOP_TAGS = /<[^>]+>/g

export function stripTags(html: string): string {
  return html.replace(STOP_TAGS, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
}

export function wordCount(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}

/** Extract heading texts (h2/h3) from post HTML. Pure. */
export function extractHeadings(html: string): string[] {
  const out: string[] = []
  const re = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const text = stripTags(m[1])
    if (text) out.push(text)
  }
  return out
}

const QUESTION_WORDS = /^(how|what|why|when|where|which|who|can|do|does|is|are|should|will)\b/i

/** Headings phrased as questions — the FAQ/answer-eligible ones. Pure. */
export function questionHeadings(headings: string[]): string[] {
  return headings.filter((h) => h.trim().endsWith("?") || QUESTION_WORDS.test(h.trim()))
}

/** Does the HTML contain an extractable list (ul/ol with items)? Pure. */
export function hasList(html: string): boolean {
  return /<li[\s>]/i.test(html)
}

/**
 * Run the AEO checklist. `nowMs` is injected (keeps the function pure/testable;
 * the route passes Date.now()). Freshness = updated within ~12 months.
 */
export function evaluateAeo(post: AeoPost, nowMs: number): AeoResult {
  const text = stripTags(post.contentHtml)
  const words = wordCount(text)
  const headings = extractHeadings(post.contentHtml)
  const questions = questionHeadings(headings)
  const meta = post.metaDescription.trim()
  const summary = (post.excerpt || post.metaDescription).trim()

  let freshMonths: number | null = null
  const updated = post.updatedAt ? Date.parse(post.updatedAt) : NaN
  if (!Number.isNaN(updated)) freshMonths = (nowMs - updated) / (1000 * 60 * 60 * 24 * 30.44)

  const checks: AeoCheck[] = [
    {
      id: "meta",
      label: "Concise meta description (50–160 chars) an engine can quote",
      passed: meta.length >= 50 && meta.length <= 160,
      weight: 15,
      hint: "Write a 1–2 sentence summary (50–160 characters) that directly answers what the page is about.",
    },
    {
      id: "summary",
      label: "Has a short summary / excerpt for answer extraction",
      passed: wordCount(summary) >= 10,
      weight: 10,
      hint: "Add an excerpt or opening paragraph that states the answer up front, before the details.",
    },
    {
      id: "title",
      label: "Descriptive title (≤ 65 chars)",
      passed: post.title.trim().length > 0 && post.title.trim().length <= 65,
      weight: 10,
      hint: "Keep the title specific and under ~65 characters so it isn't truncated.",
    },
    {
      id: "depth",
      label: "Enough depth to be a citable source (≥ 400 words)",
      passed: words >= 400,
      weight: 20,
      hint: "Expand the article — thin pages rarely get cited. Aim for 400+ substantive words.",
    },
    {
      id: "questions",
      label: "Question-style headings that match how people ask",
      passed: questions.length >= 1,
      weight: 20,
      hint: 'Add H2/H3 headings phrased as questions (e.g. "How does X work?") — these become FAQ schema and match AI queries.',
    },
    {
      id: "lists",
      label: "Contains a list or steps (easy to extract)",
      passed: hasList(post.contentHtml),
      weight: 10,
      hint: "Break at least one section into a bulleted or numbered list — engines lift these as direct answers.",
    },
    {
      id: "freshness",
      label: "Updated within the last 12 months",
      passed: freshMonths !== null && freshMonths <= 12,
      weight: 15,
      hint: "Refresh the content and update its date — stale pages lose trust with both Google and AI engines.",
    },
  ]

  const totalWeight = checks.reduce((n, c) => n + c.weight, 0)
  const earned = checks.reduce((n, c) => n + (c.passed ? c.weight : 0), 0)
  const score = Math.round((earned / totalWeight) * 100)
  return { score, passed: score >= 70, checks }
}
