// src/modules/importer/cleanupRoutes.ts
// "Clean up imported content" dashboard (K9 follow-up). A queue of the posts &
// pages a WordPress import brought in, each with a PREVIEW-THEN-APPROVE cleanup:
//   • Basic cleanup — deterministic, safe, no key needed.
//   • ✨ AI deep-clean — smarter reformat on the customer's own Anthropic key
//     (shown only when connected); the result is previewed and written ONLY on
//     explicit approval. Nothing is ever cleaned automatically.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema, renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { audit, planGate, type Customer } from "../customers"
import { assistAvailable } from "../seo"
import { listImportedPosts, getImportedPost, savePostContent, type ImportSite } from "./service"
import { stripWpArtifacts, countArtifacts, runContentCleanup } from "./cleanup"

const NO_STORE = { "Cache-Control": "no-store, private" }

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}

interface SiteRow { id: string; customer_id: string; cms_site_id: string | null; domain: string; repo_full_name: string | null }

async function loadSite(c: Context<AppEnv>, master: Awaited<ReturnType<typeof masterDb>>, customerId: string): Promise<SiteRow | null> {
  const r = await master.execute({
    sql: "SELECT id, customer_id, cms_site_id, domain, repo_full_name FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [c.req.param("id") ?? "", customerId],
  })
  return r.rows.length ? (r.rows[0] as unknown as SiteRow) : null
}
function importSite(site: SiteRow): ImportSite {
  return { cmsSiteId: site.cms_site_id as string, hostname: site.domain, customerId: site.customer_id, repoFullName: site.repo_full_name }
}
function nowSqlite(): string { return new Date().toISOString().replace("T", " ").slice(0, 19) }

const PRE = "white-space:pre-wrap;word-break:break-word;background:#0a0a0a;border:1px solid #262626;border-radius:8px;padding:12px;color:#d4d4d4;font-family:ui-monospace,monospace;font-size:11px;max-height:340px;overflow:auto"

export async function cleanupListHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const posts = await listImportedPosts(c.env, site.cms_site_id).catch(() => [])
  const aiOn = await assistAvailable(master, customer.id).catch(() => false)

  const rows = posts.length
    ? posts.map((p) => {
        const a = countArtifacts(p.content)
        const n = a.shortcodes + a.blockComments + a.emptyParas
        return `<tr style="border-top:1px solid #1f2937">
          <td style="padding:8px 6px;font-size:13px"><a href="/app/sites/${escapeAttr(site.id)}/cleanup/${escapeAttr(p.id)}" style="color:#fafafa">${escapeHtml(p.title || p.slug)}</a>
            <div class="muted" style="font-size:11px">${escapeHtml(p.type)} · /${escapeHtml(p.type === "page" ? "" : "posts/")}${escapeHtml(p.slug)}/ ${p.published ? "· live" : "· draft"}</div></td>
          <td style="padding:8px 6px;text-align:right;white-space:nowrap;font-size:12px;color:${n ? "#fcd34d" : "#4ade80"}">${n ? `${n} to tidy` : "clean"}</td>
        </tr>`
      }).join("")
    : `<tr><td colspan="2" class="muted" style="padding:10px 6px">No imported content yet. Bring a site over from <a href="/app/sites/${escapeAttr(site.id)}/import" style="color:#93c5fd">Import from WordPress</a> first.</td></tr>`

  const body = `
    <div class="card">
      <p><a href="/app/sites/${escapeAttr(site.id)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Clean up imported content</h2>
      <p class="muted" style="font-size:13px">WordPress exports carry shortcode debris, block comments and inline styles. Tidy each piece — you always preview and approve first; nothing changes automatically.${aiOn ? " ✨ AI deep-clean is available on your connected key." : ""}</p>
    </div>
    <div class="card"><table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table></div>`
  await audit(master, customer.id, "site.cleanup_viewed", site.domain).catch(() => {})
  return c.html(renderSaasLayout({ title: "Clean up", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

function renderDetail(site: SiteRow, postId: string, title: string, original: string, aiOn: boolean, opts: { aiPreview?: string; notice?: string; error?: string } = {}): string {
  const basic = stripWpArtifacts(original)
  const a = countArtifacts(original)
  const changed = basic !== original
  const back = `/app/sites/${escapeAttr(site.id)}/cleanup`
  return `
    <div class="card"><p><a href="${back}" style="color:#93c5fd">← Cleanup queue</a></p>
      <h2 style="margin:0 0 2px;font-size:16px">${escapeHtml(title)}</h2>
      <p class="muted" style="font-size:12px">${a.shortcodes} shortcode(s) · ${a.blockComments} block comment(s) · ${a.emptyParas} empty paragraph(s) · ${a.inlineStyles} inline style(s)</p>
    </div>
    ${opts.notice ? `<div class="banner" style="border-color:#14532d;color:#86efac;background:#0f1a14">${escapeHtml(opts.notice)}</div>` : ""}
    ${opts.error ? `<div class="banner" style="border-color:#7f1d1d;color:#fca5a5;background:#1c1212">${escapeHtml(opts.error)}</div>` : ""}
    <div class="card">
      <h3 style="margin:0 0 6px;font-size:14px">Basic cleanup <span class="muted" style="font-weight:400;font-size:11px">(safe · no AI)</span></h3>
      ${changed
        ? `<p class="muted" style="font-size:12px">Removes shortcodes, block comments and empty tags. Preview:</p>
           <pre style="${PRE}">${escapeHtml(basic.slice(0, 6000))}${basic.length > 6000 ? "\n… (truncated in preview)" : ""}</pre>
           <form method="post" action="${back}/${escapeAttr(postId)}/basic" style="margin-top:10px"><button class="btn" type="submit">Apply basic cleanup</button></form>`
        : `<p class="muted" style="font-size:12px">Nothing for the basic pass to remove — this content is already tidy.</p>`}
    </div>
    ${aiOn
      ? `<div class="card">
          <h3 style="margin:0 0 6px;font-size:14px">✨ AI deep-clean <span class="muted" style="font-weight:400;font-size:11px">(your key · preview first)</span></h3>
          <p class="muted" style="font-size:12px">Reformats to clean semantic HTML — strips builder markup and inline styles while keeping every heading, paragraph, list, link and image. Runs on your Anthropic key; nothing is saved until you approve.</p>
          ${opts.aiPreview !== undefined
            ? `<pre style="${PRE};border-color:#1e3a8a">${escapeHtml(opts.aiPreview.slice(0, 8000))}${opts.aiPreview.length > 8000 ? "\n… (truncated in preview)" : ""}</pre>
               <form method="post" action="${back}/${escapeAttr(postId)}/ai-apply" style="margin-top:10px;display:flex;gap:8px;align-items:center">
                 <textarea name="html" hidden>${escapeHtml(opts.aiPreview)}</textarea>
                 <button type="submit" style="background:#2563eb;color:#fff;border:0;border-radius:7px;padding:8px 15px;font-size:13px;cursor:pointer">Approve &amp; save</button>
                 <a href="${back}/${escapeAttr(postId)}" class="btn ghost" style="font-size:12px">Discard</a>
               </form>`
            : `<form method="post" action="${back}/${escapeAttr(postId)}/ai" style="margin-top:8px"><button class="btn ghost" type="submit">✨ Generate AI cleanup</button></form>`}
        </div>`
      : ""}
    <div class="card"><h3 style="margin:0 0 6px;font-size:14px">Current content</h3>
      <pre style="${PRE}">${escapeHtml(original.slice(0, 6000))}${original.length > 6000 ? "\n… (truncated)" : ""}</pre></div>`
}

export async function cleanupDetailHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const post = await getImportedPost(c.env, site.cms_site_id, c.req.param("postId") ?? "")
  if (!post) return new Response(null, { status: 302, headers: { Location: `/app/sites/${site.id}/cleanup` } })
  const aiOn = await assistAvailable(master, customer.id).catch(() => false)
  const notice = c.req.query("done") || undefined
  const error = c.req.query("error") || undefined
  return c.html(renderSaasLayout({ title: "Clean up", active: "sites", customer, bodyHtml: renderDetail(site, post.id, post.title || post.slug, post.content, aiOn, { notice, error }) }), 200, NO_STORE)
}

export async function cleanupBasicHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  const postId = c.req.param("postId") ?? ""
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `/app/sites/${site?.id}/cleanup/${postId}?${q}` } })
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  if (planGate(customer, nowSqlite()) === "read_only") return back("error=" + encodeURIComponent("Your trial has ended — subscribe to edit content."))
  const post = await getImportedPost(c.env, site.cms_site_id, postId)
  if (!post) return back("error=" + encodeURIComponent("That content no longer exists."))
  const cleaned = stripWpArtifacts(post.content)
  const ok = await savePostContent(c.env, importSite(site), postId, cleaned)
  await audit(master, customer.id, "site.cleanup_basic", site.domain, { postId }).catch(() => {})
  return back(ok ? "done=" + encodeURIComponent("Basic cleanup applied.") : "error=" + encodeURIComponent("Couldn't save — try again."))
}

export async function cleanupAiHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const postId = c.req.param("postId") ?? ""
  const post = await getImportedPost(c.env, site.cms_site_id, postId)
  if (!post) return new Response(null, { status: 302, headers: { Location: `/app/sites/${site.id}/cleanup` } })
  if (planGate(customer, nowSqlite()) === "read_only") {
    return c.html(renderSaasLayout({ title: "Clean up", active: "sites", customer, bodyHtml: renderDetail(site, postId, post.title || post.slug, post.content, true, { error: "Your trial has ended — subscribe to use AI cleanup." }) }), 200, NO_STORE)
  }
  const res = await runContentCleanup(c.env, master, customer.id, post.content)
  await audit(master, customer.id, "site.cleanup_ai", site.domain, { postId, ok: res.ok }).catch(() => {})
  const aiOn = await assistAvailable(master, customer.id).catch(() => false)
  return c.html(renderSaasLayout({
    title: "Clean up", active: "sites", customer,
    bodyHtml: renderDetail(site, postId, post.title || post.slug, post.content, aiOn, res.ok ? { aiPreview: res.html } : { error: res.error }),
  }), 200, NO_STORE)
}

export async function cleanupAiApplyHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  const postId = c.req.param("postId") ?? ""
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `/app/sites/${site?.id}/cleanup/${postId}?${q}` } })
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  if (planGate(customer, nowSqlite()) === "read_only") return back("error=" + encodeURIComponent("Your trial has ended — subscribe to edit content."))
  const form = await c.req.parseBody()
  const html = String(form.html ?? "").trim()
  if (!html) return back("error=" + encodeURIComponent("Nothing to save."))
  const ok = await savePostContent(c.env, importSite(site), postId, html)
  await audit(master, customer.id, "site.cleanup_ai_applied", site.domain, { postId }).catch(() => {})
  return back(ok ? "done=" + encodeURIComponent("AI cleanup approved and saved.") : "error=" + encodeURIComponent("Couldn't save — try again."))
}
