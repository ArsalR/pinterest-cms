// src/modules/linking/orphans.ts
// Orphan-page detection (K5): a published page with ZERO inbound internal
// links from other pages on the same site. Pure logic — link extraction from
// HTML content + the graph analysis.

export interface LinkablePage {
  id: string
  slug: string
  title: string
  content: string // HTML
}

/** Extract same-site internal link targets (paths) from an HTML body. */
export function internalLinkTargets(html: string): string[] {
  const out: string[] = []
  const re = /href\s*=\s*["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const href = m[1].trim()
    // Same-site only: relative paths or root-relative. Skip external, anchors, mailto, tel.
    if (/^(https?:|mailto:|tel:|#)/i.test(href)) continue
    out.push(href.replace(/[?#].*$/, "").replace(/\/+$/, "")) // normalize: drop query/hash/trailing slash
  }
  return out
}

/** Does a page's slug appear as a link target anywhere in the set of hrefs? */
function slugLinked(slug: string, allTargets: Set<string>): boolean {
  const norm = slug.replace(/^\/+|\/+$/g, "")
  return (
    allTargets.has(norm) ||
    allTargets.has(`/${norm}`) ||
    allTargets.has(`/posts/${norm}`) ||
    [...allTargets].some((t) => t.endsWith(`/${norm}`))
  )
}

/** Published pages with no inbound internal link from any OTHER page. */
export function findOrphans(pages: LinkablePage[]): LinkablePage[] {
  // Collect every internal link target across the whole site (from other pages).
  const orphans: LinkablePage[] = []
  for (const page of pages) {
    const inbound = new Set<string>()
    for (const other of pages) {
      if (other.id === page.id) continue
      for (const t of internalLinkTargets(other.content)) inbound.add(t)
    }
    if (!slugLinked(page.slug, inbound)) orphans.push(page)
  }
  return orphans
}
