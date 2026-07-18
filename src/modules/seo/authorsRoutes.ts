// src/modules/seo/authorsRoutes.ts
// Authors dashboard (V1.3 P2) — /app/sites/:id/authors. The E-E-A-T backbone:
// author pages with Person schema, bylines and bios. Useful to every profile;
// surfaced on the hub when the News profile is on.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema, renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { audit, planGate, type Customer } from "../customers"
import { listAuthors, saveAuthor, deleteAuthor } from "./newsService"

const NO_STORE = { "Cache-Control": "no-store, private" }
const IN = "width:100%;padding:8px 10px;border-radius:6px;border:1px solid #374151;background:#0b0f17;color:#fafafa;font-size:13px"

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}
function nowSqlite(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}
async function loadAuthorsSite(master: Awaited<ReturnType<typeof masterDb>>, siteId: string, customerId: string) {
  const r = await master.execute({
    sql: "SELECT id, cms_site_id, domain, name, repo_full_name FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [siteId, customerId],
  })
  return r.rows.length ? (r.rows[0] as unknown as { id: string; cms_site_id: string | null; domain: string; name: string; repo_full_name: string | null }) : null
}

export async function authorsHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadAuthorsSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const authors = site.cms_site_id ? await listAuthors(master, site.cms_site_id).catch(() => []) : []
  const editId = c.req.query("edit") ?? ""
  const editing = authors.find((a) => a.id === editId)
  const saved = c.req.query("saved")
  const error = c.req.query("error")
  const notice = saved
    ? `<div class="card" style="border-color:#166534;background:#052e16"><p style="margin:0;color:#86efac;font-size:13px">${escapeHtml(saved)} Your site is rebuilding (usually ~2 minutes).</p></div>`
    : error
      ? `<div class="card" style="border-color:#7f1d1d;background:#2a0d0d"><p style="margin:0;color:#fca5a5;font-size:13px">${escapeHtml(error)}</p></div>`
      : ""
  const rows = authors.length
    ? authors.map((a) => `<tr style="border-top:1px solid #1f2937">
        <td style="padding:8px 6px;font-size:13px">${escapeHtml(a.name)}<div class="muted" style="font-size:11px">/authors/${escapeHtml(a.slug)}/</div></td>
        <td style="padding:8px 6px;text-align:right;white-space:nowrap">
          <a href="/app/sites/${escapeAttr(siteId)}/authors?edit=${escapeAttr(a.id)}" class="btn ghost" style="font-size:12px">Edit</a>
          <form method="post" action="/app/sites/${escapeAttr(siteId)}/authors/delete" style="display:inline;margin:0" onsubmit="return confirm('Remove this author? Their posts keep publishing without a byline.')">
            <input type="hidden" name="id" value="${escapeAttr(a.id)}" /><button type="submit" style="background:none;border:none;color:#737373;cursor:pointer">✕</button>
          </form></td></tr>`).join("")
    : `<tr><td colspan="2" class="muted" style="padding:10px 6px">No authors yet. Bylines with real bios are an E-E-A-T signal Google looks for — add the people behind the site.</td></tr>`

  const body = `
    ${notice}
    <div class="card"><p><a href="/app/sites/${escapeAttr(siteId)}/seo" style="color:#93c5fd">← SEO</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Authors</h2>
      <p class="muted" style="font-size:13px">Each author gets a page with their bio and Person schema; posts carry their byline. Assign an author to a post in the SEO cockpit's Advanced tab.</p>
    </div>
    <div class="card"><table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table></div>
    <form method="post" action="/app/sites/${escapeAttr(siteId)}/authors">
      <input type="hidden" name="id" value="${escapeAttr(editing?.id ?? "")}" />
      <div class="card">
        <h3 style="margin:0 0 8px;font-size:14px">${editing ? `Edit ${escapeHtml(editing.name)}` : "Add an author"}</h3>
        <label class="muted" style="font-size:12px">Name</label><input name="name" required value="${escapeAttr(editing?.name ?? "")}" style="${IN}" />
        <label class="muted" style="font-size:12px;display:block;margin-top:8px">Bio (a real one — expertise, background, why readers should trust them)</label>
        <textarea name="bio" rows="3" style="${IN}">${escapeHtml(editing?.bio ?? "")}</textarea>
        <label class="muted" style="font-size:12px;display:block;margin-top:8px">Photo URL</label><input name="photo" value="${escapeAttr(editing?.photo ?? "")}" placeholder="https://…" style="${IN}" />
        <label class="muted" style="font-size:12px;display:block;margin-top:8px">Profiles (one per line — LinkedIn, X, Wikipedia… → Person sameAs)</label>
        <textarea name="sameAs" rows="2" style="${IN}">${escapeHtml(editing?.sameAs.join("\n") ?? "")}</textarea>
      </div>
      <div class="card" style="display:flex;justify-content:flex-end;gap:8px">
        ${editing ? `<a class="btn ghost" href="/app/sites/${escapeAttr(siteId)}/authors">Cancel</a>` : ""}
        <button type="submit" style="background:#2563eb;color:#fff;border:0;border-radius:7px;padding:9px 16px;font-size:14px;cursor:pointer">${editing ? "Save author" : "Add author"}</button>
      </div>
    </form>`
  await audit(master, customer.id, "site.authors_viewed", site.domain).catch(() => {})
  return c.html(renderSaasLayout({ title: "Authors", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function authorsSaveHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadAuthorsSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/authors${q}` } })
  if (planGate(customer, nowSqlite()) === "read_only") return back("?error=" + encodeURIComponent("Your trial has ended — subscribe to edit."))
  const form = (await c.req.parseBody()) as Record<string, unknown>
  const r = await saveAuthor(c.env, customer.id, site.cms_site_id, site.repo_full_name, String(form.id ?? ""), {
    name: String(form.name ?? ""),
    bio: String(form.bio ?? ""),
    photo: String(form.photo ?? ""),
    sameAs: String(form.sameAs ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
  }, master)
  if (!r.ok) return back("?error=" + encodeURIComponent(r.error ?? "Couldn't save."))
  await audit(master, customer.id, "site.author_saved", site.domain).catch(() => {})
  return back("?saved=" + encodeURIComponent("Author saved."))
}

export async function authorsDeleteHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadAuthorsSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  if (planGate(customer, nowSqlite()) !== "read_only") {
    const form = await c.req.parseBody()
    await deleteAuthor(c.env, customer.id, site.cms_site_id, site.repo_full_name, String(form.id ?? ""), master)
    await audit(master, customer.id, "site.author_deleted", site.domain).catch(() => {})
  }
  return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/authors?saved=${encodeURIComponent("Author removed.")}` } })
}
