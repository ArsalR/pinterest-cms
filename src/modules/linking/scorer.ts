// src/modules/linking/scorer.ts
// Internal linking engine (K5). Related-post scoring lives behind a
// RelatednessScorer INTERFACE (decision #8) so an embedding-based scorer can
// replace the keyword-overlap default later without touching callers. Pure
// logic — fully unit-tested.

export interface LinkDoc {
  id: string
  title: string
  slug: string
  text: string // title + excerpt + content (plain or HTML)
}

export interface RelatednessScorer {
  /** Similarity of two docs, 0..1. */
  score(a: LinkDoc, b: LinkDoc): number
  /** The top-k docs from `corpus` most related to `doc` (excluding itself). */
  related(doc: LinkDoc, corpus: LinkDoc[], k: number): Array<{ doc: LinkDoc; score: number }>
}

const STOPWORDS = new Set(
  "a an the and or but of to in on for with at by from as is are was were be been being this that these those it its into your you our we they he she them his her their".split(
    " "
  )
)

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ")
}

/** Content keywords (lowercased, de-stopworded, length ≥ 3) as a Set. */
export function keywords(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of stripHtml(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
    if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w)
  }
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0
  let inter = 0
  const [small, large] = a.size < b.size ? [a, b] : [b, a]
  for (const x of small) if (large.has(x)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/** Default scorer: Jaccard over content keywords. Cheap, no external calls.
 *  Swap for an EmbeddingScorer later — callers depend only on the interface. */
export class KeywordOverlapScorer implements RelatednessScorer {
  private cache = new Map<string, Set<string>>()
  private kw(doc: LinkDoc): Set<string> {
    let k = this.cache.get(doc.id)
    if (!k) {
      k = keywords(`${doc.title} ${doc.text}`)
      this.cache.set(doc.id, k)
    }
    return k
  }
  score(a: LinkDoc, b: LinkDoc): number {
    return jaccard(this.kw(a), this.kw(b))
  }
  related(doc: LinkDoc, corpus: LinkDoc[], k: number): Array<{ doc: LinkDoc; score: number }> {
    return corpus
      .filter((o) => o.id !== doc.id)
      .map((o) => ({ doc: o, score: this.score(doc, o) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
  }
}

/** Suggest internal links for a doc: its top-k related docs above a threshold. */
export function suggestLinks(
  doc: LinkDoc,
  corpus: LinkDoc[],
  scorer: RelatednessScorer = new KeywordOverlapScorer(),
  k = 5,
  minScore = 0.05
): Array<{ id: string; title: string; slug: string; score: number }> {
  return scorer
    .related(doc, corpus, k)
    .filter((r) => r.score >= minScore)
    .map((r) => ({ id: r.doc.id, title: r.doc.title, slug: r.doc.slug, score: Math.round(r.score * 100) / 100 }))
}
