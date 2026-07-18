// src/modules/seo/routes.ts
// The per-post SEO cockpit (S1) — a dashboard screen with Snippet / Social /
// Advanced tabs, live SERP + social previews, and a slug→redirect offer. The
// cockpit shell is server-rendered; live behaviour is hand-written vanilla JS
// (seo-cockpit.js) served from a dashboard route — no framework, no build step.
// AI-assist (✨) buttons are intentionally NOT wired pending the decision-#9
// resolution; absence is a supported state (spec: no key = hidden).

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { audit, planGate, type Customer } from "../customers"
import { SCHEMA_TYPES } from "./analyze"
import { listPostsForSeo, loadPostSeo, savePostSeo, type SeoUpdate } from "./service"
import { SEO_COCKPIT_JS } from "./cockpitJs"

const NO_STORE = { "Cache-Control": "no-store, private" }

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}
function nowSqlite(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}

interface SeoSite { id: string; customer_id: string; cms_site_id: string | null; domain: string; name: string; repo_full_name: string | null }
async function loadSite(master: Awaited<ReturnType<typeof masterDb>>, siteId: string, customerId: string): Promise<SeoSite | null> {
  const r = await master.execute({
    sql: "SELECT id, customer_id, cms_site_id, domain, name, repo_full_name FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [siteId, customerId],
  })
  return r.rows.length ? (r.rows[0] as unknown as SeoSite) : null
}

// ─────────────────────── post list (the cockpit entry) ───────────────────────

export async function seoPostsHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const posts = site.cms_site_id ? await listPostsForSeo(master, site.cms_site_id).catch(() => []) : []

  const rows = posts.length
    ? posts.map((p) => `<tr>
        <td><a href="/app/sites/${escapeAttr(siteId)}/posts/${escapeAttr(p.id)}/seo" style="color:#fafafa">${escapeHtml(p.title)}</a>
          <div class="muted" style="font-size:12px">/posts/${escapeHtml(p.slug)}/</div></td>
        <td style="text-align:right">${p.published ? `<span style="color:#86efac;font-size:12px">published</span>` : `<span class="muted" style="font-size:12px">draft</span>`}${p.noIndex ? ` · <span style="color:#fcd34d;font-size:12px">noindex</span>` : ""}</td>
      </tr>`).join("")
    : `<tr><td colspan="2" class="muted">No posts yet.</td></tr>`

  const body = `
    <div class="card"><p><a href="/app/sites/${escapeAttr(siteId)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">SEO cockpit</h2>
      <p class="muted" style="font-size:13px">Fine-tune each post's search snippet, social card, and indexing. Everything's optional — the defaults are already good.</p>
    </div>
    <div class="card"><table style="width:100%;border-collapse:collapse;font-size:14px"><tbody>${rows}</tbody></table></div>`
  return c.html(renderSaasLayout({ title: "SEO cockpit", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

// ─────────────────────── the cockpit ───────────────────────

export async function seoCockpitHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const postId = c.req.param("postId") ?? ""
  const master = await masterDb(c)
  const site = await loadSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const post = await loadPostSeo(master, site.cms_site_id, postId)
  if (!post) return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/posts` } })

  const url = `https://${site.domain}/posts/${post.slug}/`
  // Seed the client with the current values as JSON (read by seo-cockpit.js).
  const seed = {
    siteName: site.name, url, baseUrl: `https://${site.domain}/posts/`,
    published: post.published,
    title: post.title, excerpt: post.excerpt ?? "", coverImage: post.coverImage ?? "",
    metaTitle: post.metaTitle ?? "", metaDescription: post.metaDescription ?? "", slug: post.slug,
    ogTitle: post.ogTitle ?? "", ogDescription: post.ogDescription ?? "", ogImage: post.ogImage ?? "",
    canonicalUrl: post.canonicalUrl ?? "", noIndex: post.noIndex, sitemapExclude: post.sitemapExclude,
    nofollow: post.nofollow, schemaType: post.schemaType ?? "", faq: post.faq,
  }

  const body = `
    <div class="card"><p><a href="/app/sites/${escapeAttr(siteId)}/posts" style="color:#93c5fd">← SEO cockpit</a></p>
      <h2 style="margin:0 0 2px;font-size:16px">${escapeHtml(post.title)}</h2>
      <p class="muted" style="font-size:12px">${escapeHtml(url)}</p>
    </div>
    <div id="seo-cockpit" data-save="/app/sites/${escapeAttr(siteId)}/posts/${escapeAttr(postId)}/seo"></div>
    <script type="application/json" id="seo-seed">${escapeHtml(JSON.stringify(seed))}</script>
    <script src="/app/assets/seo-cockpit.js" defer></script>
    <template id="schema-types">${SCHEMA_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("")}</template>`
  await audit(master, customer.id, "site.seo_cockpit_viewed", site.domain, { postId }).catch(() => {})
  return c.html(renderSaasLayout({ title: "SEO", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function seoSaveHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const postId = c.req.param("postId") ?? ""
  const json = (o: object, status = 200) => c.json(o, status as 200, NO_STORE)

  const master = await masterDb(c)
  const site = await loadSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return json({ ok: false, error: "Site not found." }, 404)
  if (planGate(customer, nowSqlite()) === "read_only") return json({ ok: false, error: "Your trial has ended — subscribe to edit SEO." }, 403)

  let b: Record<string, unknown>
  try { b = (await c.req.json()) as Record<string, unknown> } catch { return json({ ok: false, error: "Bad request." }, 400) }
  const str = (k: string) => String(b[k] ?? "").slice(0, 2000)
  const bool = (k: string) => b[k] === true || b[k] === "1"
  const faq = Array.isArray(b.faq) ? (b.faq as Array<{ question?: unknown; answer?: unknown }>).slice(0, 30).map((f) => ({ question: String(f.question ?? ""), answer: String(f.answer ?? "") })) : []

  const update: SeoUpdate = {
    metaTitle: str("metaTitle"), metaDescription: str("metaDescription"), slug: str("slug"),
    ogTitle: str("ogTitle"), ogDescription: str("ogDescription"), ogImage: str("ogImage"),
    canonicalUrl: str("canonicalUrl"), noIndex: bool("noIndex"), sitemapExclude: bool("sitemapExclude"),
    nofollow: bool("nofollow"), schemaType: str("schemaType"), faq, addRedirectOnSlugChange: bool("addRedirect"),
  }
  const r = await savePostSeo(c.env, customer.id, site.cms_site_id, site.repo_full_name, postId, update, master)
  if (!r.ok) return json({ ok: false, error: r.error }, 400)
  await audit(master, customer.id, "site.seo_saved", site.domain, { postId, slugChanged: r.slugChanged }).catch(() => {})
  return json({ ok: true, slugChanged: r.slugChanged, redirectAdded: r.redirectAdded })
}

/** Serve the cockpit's vanilla JS (no build step). Public — it's just a script. */
export async function seoCockpitJsHandler(c: Context<AppEnv>): Promise<Response> {
  return new Response(SEO_COCKPIT_JS, {
    headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" },
  })
}
