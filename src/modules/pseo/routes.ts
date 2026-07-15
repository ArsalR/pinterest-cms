// src/modules/pseo/routes.ts
// Programmatic SEO dashboard (K2): paste a CSV + a {{column}} template →
// generate a batch → every page runs through the quality gate → passing pages
// publish (as posts) and trigger a rebuild; failing rows are reported and do
// NOT publish. "Programmatic SEO that survives Google updates."

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb, getSiteDb } from "../../lib/turso"
import { ensureMasterSchema, renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr, cuid, slugify, plainExcerpt } from "../../lib/utils"
import { planGate, audit, type Customer } from "../customers"
import { getConnection, installationToken, repositoryDispatch } from "../connections"
import { loadCorpus } from "../publishing"
import { generateBatch, type PseoTemplate } from "./generate"

const NO_STORE = { "Cache-Control": "no-store, private" }
const nowSqlite = () => new Date().toISOString().replace("T", " ").slice(0, 19)

interface SiteRow { id: string; customer_id: string; cms_site_id: string | null; repo_full_name: string | null; domain: string }

async function ownedSite(c: Context<AppEnv>, siteId: string): Promise<SiteRow | null> {
  const customer = c.get("customer") as Customer
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  const r = await db.execute({
    sql: "SELECT id, customer_id, cms_site_id, repo_full_name, domain FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [siteId, customer.id],
  })
  return r.rows.length ? (r.rows[0] as unknown as SiteRow) : null
}

export async function pseoPageHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const site = await ownedSite(c, siteId)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })

  const body = `
    <div class="card">
      <p><a href="/app/sites/${escapeAttr(siteId)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Programmatic SEO</h2>
      <p class="muted" style="font-size:13px">Paste a CSV (first row = column names) and a template using <code>{{column}}</code> placeholders. Every page runs through the quality gate — thin or duplicate pages are rejected, not published. This is the leash that keeps programmatic pages safe.</p>
      <form method="POST" action="/app/sites/${escapeAttr(siteId)}/pseo" style="display:grid;gap:12px;max-width:640px">
        <label>CSV data<textarea name="csv" rows="6" required style="width:100%;font-family:monospace;font-size:12px;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px;color:#fafafa" placeholder="city,state,population&#10;Austin,TX,961000"></textarea></label>
        <label>Title template<input name="title" required style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:9px;color:#fafafa" placeholder="Best coffee shops in {{city}}, {{state}}"></label>
        <label>Meta description template<input name="meta" required style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:9px;color:#fafafa" placeholder="A local guide to coffee in {{city}}."></label>
        <label>Content template (HTML ok)<textarea name="content" rows="6" required style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px;color:#fafafa" placeholder="&lt;p&gt;Everything about coffee in {{city}}…&lt;/p&gt;"></textarea></label>
        <label>Slug template<input name="slug" required style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:9px;color:#fafafa" placeholder="coffee-{{city}}"></label>
        <label>Unique-data columns (comma-separated — each page must differ on these)<input name="uniqueCols" style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:9px;color:#fafafa" placeholder="city,state,population"></label>
        <button class="btn" type="submit">Generate through the gate</button>
      </form>
    </div>`
  return c.html(renderSaasLayout({ title: "Programmatic SEO", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function pseoGenerateHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const site = await ownedSite(c, siteId)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })

  const readOnly = planGate(customer, nowSqlite()) === "read_only"
  let form: FormData
  try { form = await c.req.formData() } catch { return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/pseo` } }) }

  const template: PseoTemplate = {
    titleTemplate: String(form.get("title") || ""),
    metaTemplate: String(form.get("meta") || ""),
    contentTemplate: String(form.get("content") || ""),
    slugTemplate: String(form.get("slug") || ""),
    uniqueDataColumns: String(form.get("uniqueCols") || "").split(",").map((s) => s.trim()).filter(Boolean),
  }
  const csv = String(form.get("csv") || "")

  const master = getMasterDb(c.env)
  await ensureMasterSchema(master)
  const cms = await master.execute({ sql: "SELECT turso_url, turso_token FROM sites WHERE id = ? LIMIT 1", args: [site.cms_site_id] })
  if (!cms.rows.length) return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/pseo` } })
  const siteDb = getSiteDb(cms.rows[0].turso_url as string, cms.rows[0].turso_token as string)

  const corpus = await loadCorpus(siteDb)
  const run = generateBatch(csv, template, corpus)

  // Publish passing pages (they cleared the gate). Skip when read-only.
  let published = 0
  if (!readOnly) {
    for (const page of run.pages.filter((p) => p.result.passed)) {
      const slug = await uniqueSlug(siteDb, page.slug)
      await siteDb.execute({
        sql: `INSERT INTO posts (id, title, slug, content, excerpt, published, published_at, type, source, seo_description, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 1, datetime('now'), 'post', 'pseo', ?, datetime('now'), datetime('now'))`,
        args: [cuid(), page.title, slug, page.content, page.meta || plainExcerpt(page.content, 160), page.meta || null],
      }).then(() => { published++ }).catch(() => {})
    }
    if (published > 0) {
      await audit(master, site.customer_id, "pseo.published", site.domain, { published, failed: run.failed })
      await fireRebuild(c, master, site)
    }
  }

  const rows = run.pages
    .map((p) => `<tr>
      <td>${p.row}</td><td>${escapeHtml(p.title || "(no title)")}</td>
      <td>${p.result.passed ? '<span style="color:#86efac">passed</span>' : '<span style="color:#fca5a5">blocked</span>'}</td>
      <td class="muted" style="font-size:12px">${escapeHtml(p.result.checks.filter((ch) => !ch.passed).map((ch) => ch.label + ": " + ch.detail).join("; ") || "—")}</td>
    </tr>`).join("")
  const body = `
    <div class="card">
      <p><a href="/app/sites/${escapeAttr(siteId)}/pseo" style="color:#93c5fd">← Generate more</a></p>
      <h2 style="margin:0 0 8px;font-size:16px">Batch result</h2>
      <p>${run.total} generated · <strong style="color:#86efac">${published || run.passed} passed</strong> · <strong style="color:#fca5a5">${run.failed} blocked</strong>${readOnly ? " (read-only — nothing published)" : " and published"}.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="text-align:left;color:#a3a3a3"><th>#</th><th>Title</th><th>Gate</th><th>Why blocked</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`
  return c.html(renderSaasLayout({ title: "Programmatic SEO", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

async function uniqueSlug(siteDb: ReturnType<typeof getSiteDb>, base: string): Promise<string> {
  let slug = base || "page"
  for (let i = 0; i < 50; i++) {
    const hit = await siteDb.execute({ sql: "SELECT 1 FROM posts WHERE slug = ? LIMIT 1", args: [slug] }).catch(() => ({ rows: [] as unknown[] }))
    if (!hit.rows.length) return slug
    slug = `${base}-${i + 2}`
  }
  return `${base}-${cuid().slice(-6)}`
}

async function fireRebuild(c: Context<AppEnv>, master: ReturnType<typeof getMasterDb>, site: SiteRow): Promise<void> {
  if (!site.repo_full_name) return
  try {
    const github = await getConnection(master, site.customer_id, "github")
    const installationId = Number((JSON.parse(github?.meta || "{}") as { installationId?: number }).installationId ?? 0)
    if (!installationId) return
    const token = await installationToken(c.env, installationId)
    await repositoryDispatch(token, site.repo_full_name, "content-updated", { reason: "pseo-batch" })
  } catch (err) {
    console.error("pseo: rebuild dispatch failed:", err instanceof Error ? err.message : err)
  }
}
