// src/modules/linking/routes.ts
// Content-intelligence dashboard (K5): per-site orphan-page report + internal
// link suggestions. Read-only insights the owner acts on (or a future
// auto-insert). Server-rendered.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb, getSiteDb } from "../../lib/turso"
import { ensureMasterSchema, renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { type Customer } from "../customers"
import { KeywordOverlapScorer, suggestLinks, type LinkDoc } from "./scorer"
import { findOrphans, type LinkablePage } from "./orphans"

const NO_STORE = { "Cache-Control": "no-store, private" }

export async function insightsPageHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = getMasterDb(c.env)
  await ensureMasterSchema(master)
  const siteRow = await master.execute({
    sql: "SELECT id, cms_site_id, domain FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [siteId, customer.id],
  })
  if (!siteRow.rows.length) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const site = siteRow.rows[0] as unknown as { id: string; cms_site_id: string | null; domain: string }

  let orphans: LinkablePage[] = []
  let suggestions: Array<{ from: string; links: Array<{ title: string; slug: string; score: number }> }> = []

  if (site.cms_site_id) {
    const cms = await master.execute({ sql: "SELECT turso_url, turso_token FROM sites WHERE id = ? LIMIT 1", args: [site.cms_site_id] })
    if (cms.rows.length) {
      const siteDb = getSiteDb(cms.rows[0].turso_url as string, cms.rows[0].turso_token as string)
      const posts = await siteDb.execute({
        sql: "SELECT id, title, slug, excerpt, content FROM posts WHERE published = 1 AND type = 'post' LIMIT 500",
        args: [],
      })
      const pages: LinkablePage[] = posts.rows.map((r) => ({ id: String(r.id), slug: String(r.slug), title: String(r.title ?? ""), content: String(r.content ?? "") }))
      orphans = findOrphans(pages)

      const docs: LinkDoc[] = posts.rows.map((r) => ({ id: String(r.id), title: String(r.title ?? ""), slug: String(r.slug), text: `${r.excerpt ?? ""} ${r.content ?? ""}` }))
      const scorer = new KeywordOverlapScorer()
      // Suggestions focused on orphans first (they most need inbound links).
      const focus = docs.filter((d) => orphans.some((o) => o.id === d.id)).slice(0, 20)
      suggestions = focus.map((d) => ({ from: d.title, links: suggestLinks(d, docs, scorer, 4) }))
    }
  }

  const orphanHtml = orphans.length
    ? `<ul style="margin:0;padding-left:1.2rem">${orphans.map((o) => `<li>${escapeHtml(o.title)} <span class="muted">/${escapeHtml(o.slug)}/</span></li>`).join("")}</ul>`
    : `<p class="muted">No orphan pages — every published page has at least one internal link pointing to it. 🎉</p>`

  const sugHtml = suggestions.filter((s) => s.links.length).length
    ? suggestions.filter((s) => s.links.length).map((s) => `<div style="margin-bottom:10px">
        <strong>${escapeHtml(s.from)}</strong> could link to:
        <span class="muted">${s.links.map((l) => escapeHtml(l.title)).join(", ")}</span>
      </div>`).join("")
    : `<p class="muted">No strong link suggestions right now — add more related content and they'll appear.</p>`

  const body = `
    <div class="card">
      <p><a href="/app/sites/${escapeAttr(siteId)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Internal linking</h2>
      <p class="muted" style="font-size:13px">Orphan pages (no internal links pointing to them) rank worse and get found less. Fix them by linking from related posts.</p>
    </div>
    <div class="card"><h3 style="margin:0 0 8px;font-size:14px">Orphan pages (${orphans.length})</h3>${orphanHtml}</div>
    <div class="card"><h3 style="margin:0 0 8px;font-size:14px">Suggested internal links</h3>${sugHtml}</div>`
  return c.html(renderSaasLayout({ title: "Internal linking", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}
