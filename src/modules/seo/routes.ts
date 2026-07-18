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
import { listSiteImages, bulkUpdateAlt, slugifyFilenames, type AltUpdate } from "./images"
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
    content: post.content, focusKeyword: post.focusKeyword ?? "",
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
    metaTitle: str("metaTitle"), metaDescription: str("metaDescription"), slug: str("slug"), focusKeyword: str("focusKeyword"),
    ogTitle: str("ogTitle"), ogDescription: str("ogDescription"), ogImage: str("ogImage"),
    canonicalUrl: str("canonicalUrl"), noIndex: bool("noIndex"), sitemapExclude: bool("sitemapExclude"),
    nofollow: bool("nofollow"), schemaType: str("schemaType"), faq, addRedirectOnSlugChange: bool("addRedirect"),
  }
  const r = await savePostSeo(c.env, customer.id, site.cms_site_id, site.repo_full_name, postId, update, master)
  if (!r.ok) return json({ ok: false, error: r.error }, 400)
  await audit(master, customer.id, "site.seo_saved", site.domain, { postId, slugChanged: r.slugChanged }).catch(() => {})
  return json({ ok: true, slugChanged: r.slugChanged, redirectAdded: r.redirectAdded })
}

// ─────────────────────── image SEO (S2) ───────────────────────
// Media-library alt text + filename hygiene. Plain HTML form POST — no client
// JS needed. Edits library metadata only, so the live site is unaffected until
// images are (re)used (byte-identical, rail #3).

export async function imageSeoHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const lib = site.cms_site_id ? await listSiteImages(master, site.cms_site_id).catch(() => ({ images: [], total: 0, missingAlt: 0 })) : { images: [], total: 0, missingAlt: 0 }

  const saved = c.req.query("saved")
  const notice = saved ? `<div class="card" style="border-color:#166534;background:#052e16"><p style="margin:0;color:#86efac;font-size:13px">Saved — updated ${escapeHtml(saved)}.</p></div>` : ""

  const rows = lib.images.length
    ? lib.images.map((im) => `<tr style="border-top:1px solid #1f2937">
        <td style="padding:8px 6px"><img src="${escapeAttr(im.url)}" alt="" loading="lazy" style="width:56px;height:56px;object-fit:cover;border-radius:6px;background:#111" /></td>
        <td style="padding:8px 6px;font-size:12px">
          <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="slugify" value="${escapeAttr(im.id)}" /><span class="muted" style="word-break:break-all">${escapeHtml(im.filename)}</span></label>
        </td>
        <td style="padding:8px 6px">
          <input name="alt_${escapeAttr(im.id)}" value="${escapeAttr(im.alt ?? "")}" placeholder="Describe this image…" maxlength="300"
                 style="width:100%;padding:7px 9px;border-radius:6px;border:1px solid ${im.hasAlt ? "#374151" : "#b45309"};background:#0b0f17;color:#fafafa;font-size:13px" />
        </td>
      </tr>`).join("")
    : `<tr><td colspan="3" class="muted" style="padding:12px 6px">No images in the media library yet.</td></tr>`

  const body = `
    ${notice}
    <div class="card"><p><a href="/app/sites/${escapeAttr(siteId)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Image SEO</h2>
      <p class="muted" style="font-size:13px">Alt text describes an image for search engines and screen readers. ${lib.missingAlt ? `<strong style="color:#fcd34d">${lib.missingAlt} of ${lib.total}</strong> images are missing it.` : `All ${lib.total} images have alt text. 🎉`}</p>
    </div>
    <form method="post" action="/app/sites/${escapeAttr(siteId)}/images">
      <div class="card" style="padding:6px 10px"><table style="width:100%;border-collapse:collapse">
        <thead><tr style="font-size:11px;text-transform:uppercase;letter-spacing:.04em" class="muted">
          <th style="text-align:left;padding:6px">Image</th><th style="text-align:left;padding:6px">Filename <span style="font-weight:400">(tick to slugify)</span></th><th style="text-align:left;padding:6px">Alt text</th>
        </tr></thead><tbody>${rows}</tbody></table></div>
      <div class="card" style="display:flex;justify-content:flex-end"><button type="submit" style="background:#2563eb;color:#fff;border:0;border-radius:7px;padding:9px 16px;font-size:14px;cursor:pointer">Save changes</button></div>
    </form>`
  return c.html(renderSaasLayout({ title: "Image SEO", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function imageSeoSaveHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (q = "") => new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/images${q}` } })
  if (planGate(customer, nowSqlite()) === "read_only") return back()

  const form = await c.req.parseBody({ all: true })
  const alts: AltUpdate[] = []
  const slugifyIds: string[] = []
  for (const [k, v] of Object.entries(form)) {
    if (k.startsWith("alt_")) alts.push({ id: k.slice(4), alt: Array.isArray(v) ? String(v[0]) : String(v) })
    else if (k === "slugify") (Array.isArray(v) ? v : [v]).forEach((x) => slugifyIds.push(String(x)))
  }
  const altRes = await bulkUpdateAlt(master, site.cms_site_id, alts)
  const slugRes = slugifyIds.length ? await slugifyFilenames(master, site.cms_site_id, slugifyIds) : { updated: 0 }
  await audit(master, customer.id, "site.image_seo_saved", site.domain, { alts: altRes.updated, filenames: slugRes.updated }).catch(() => {})
  const parts = [altRes.updated ? `${altRes.updated} alt text${altRes.updated === 1 ? "" : "s"}` : "", slugRes.updated ? `${slugRes.updated} filename${slugRes.updated === 1 ? "" : "s"}` : ""].filter(Boolean)
  return back(parts.length ? `?saved=${encodeURIComponent(parts.join(" + "))}` : "")
}

/** Serve the cockpit's vanilla JS (no build step). Public — it's just a script. */
export async function seoCockpitJsHandler(c: Context<AppEnv>): Promise<Response> {
  return new Response(SEO_COCKPIT_JS, {
    headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" },
  })
}
