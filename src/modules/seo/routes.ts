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
import { DEFAULT_SEO_SETTINGS, robotsWouldBlockMajorEngines, type SeoSettings } from "./settings"
import { loadSeoSettings, saveSeoSettings } from "./settingsService"
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

// ─────────────────────── Site SEO Control Center (S3) ───────────────────────
// Robots/crawlers hub with hard rails, sitemap/feeds/archives toggles, and a
// global-schema editor. Plain HTML form POST. Blocking a major search engine
// requires typing the SEO-safety override (rail #2) — enforced server-side.

function lines(v: unknown): string[] {
  return String(v ?? "").split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
}

function renderControlCenter(siteId: string, domain: string, s: SeoSettings, opts: { error?: string; saved?: boolean; needOverride?: boolean } = {}): string {
  const chk = (on: boolean) => (on ? "checked" : "")
  const notice = opts.saved
    ? `<div class="card" style="border-color:#166534;background:#052e16"><p style="margin:0;color:#86efac;font-size:13px">Saved — your site is rebuilding with the new SEO settings.</p></div>`
    : opts.error
      ? `<div class="card" style="border-color:#7f1d1d;background:#2a0d0d"><p style="margin:0;color:#fca5a5;font-size:13px">${escapeHtml(opts.error)}</p></div>`
      : ""
  const overrideField = opts.needOverride
    ? `<div style="margin-top:8px"><label style="font-size:12px;color:#fca5a5">Type <strong>NOINDEX ANYWAY</strong> to confirm hiding your site from search engines:</label>
         <input name="override" placeholder="NOINDEX ANYWAY" style="width:100%;margin-top:4px;padding:8px;border-radius:6px;border:1px solid #b45309;background:#0b0f17;color:#fafafa;font-size:13px" /></div>`
    : ""
  const inputStyle = "width:100%;padding:8px 10px;border-radius:6px;border:1px solid #374151;background:#0b0f17;color:#fafafa;font-size:13px"
  return `
    ${notice}
    <div class="card"><p><a href="/app/sites/${escapeAttr(siteId)}" style="color:#93c5fd">← ${escapeHtml(domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">SEO settings</h2>
      <p class="muted" style="font-size:13px">Site-wide search settings. Everything here is optional — the defaults match a normal, fully-indexed site.</p>
    </div>
    <form method="post" action="/app/sites/${escapeAttr(siteId)}/seo-settings">
      <div class="card">
        <h3 style="margin:0 0 8px;font-size:14px">Crawlers</h3>
        <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;margin:6px 0"><input type="checkbox" name="blockAiBots" ${chk(s.blockAiBots)} />
          <span>Block AI training crawlers <span class="muted">(GPTBot, ClaudeBot, CCBot, Google-Extended… — keeps your content out of AI training without affecting Google/Bing search). <strong style="color:#86efac">Recommended</strong> if you don't want your writing used for training.</span></span></label>
        <label style="display:block;font-size:12px;margin:12px 0 3px" class="muted">Block specific bots (one per line — advanced)</label>
        <textarea name="blockedBots" rows="2" placeholder="e.g. SemrushBot" style="${inputStyle}">${escapeHtml(s.blockedBots.join("\n"))}</textarea>
        <label style="display:block;font-size:12px;margin:12px 0 3px" class="muted">Disallow paths for all bots (one per line — e.g. /tag/)</label>
        <textarea name="disallowPaths" rows="2" placeholder="/search" style="${inputStyle}">${escapeHtml(s.disallowPaths.join("\n"))}</textarea>
        <label style="display:block;font-size:12px;margin:12px 0 3px" class="muted">Extra robots.txt lines (advanced)</label>
        <textarea name="robotsExtra" rows="2" style="${inputStyle}">${escapeHtml(s.robotsExtra)}</textarea>
        ${overrideField}
      </div>
      <div class="card">
        <h3 style="margin:0 0 8px;font-size:14px">Feeds &amp; archives</h3>
        <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin:6px 0"><input type="checkbox" name="rssEnabled" ${chk(s.rssEnabled)} /> RSS feed (/rss.xml)</label>
        <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin:6px 0"><input type="checkbox" name="archivesEnabled" ${chk(s.archivesEnabled)} /> Category &amp; date archive pages</label>
      </div>
      <div class="card">
        <h3 style="margin:0 0 8px;font-size:14px">Global schema</h3>
        <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin:6px 0"><input type="checkbox" name="globalSchemaEnabled" ${chk(s.globalSchemaEnabled)} /> Emit Organization + WebSite structured data site-wide</label>
        <label style="display:block;font-size:12px;margin:10px 0 3px" class="muted">Organization name (defaults to the site name)</label>
        <input name="orgName" value="${escapeAttr(s.orgName)}" style="${inputStyle}" />
        <label style="display:block;font-size:12px;margin:10px 0 3px" class="muted">Logo URL</label>
        <input name="orgLogo" value="${escapeAttr(s.orgLogo)}" placeholder="https://…" style="${inputStyle}" />
        <label style="display:block;font-size:12px;margin:10px 0 3px" class="muted">Social profile URLs (one per line)</label>
        <textarea name="socialProfiles" rows="2" placeholder="https://twitter.com/…" style="${inputStyle}">${escapeHtml(s.socialProfiles.join("\n"))}</textarea>
      </div>
      <div class="card" style="display:flex;justify-content:flex-end"><button type="submit" style="background:#2563eb;color:#fff;border:0;border-radius:7px;padding:9px 16px;font-size:14px;cursor:pointer">Save settings</button></div>
    </form>`
}

export async function seoSettingsHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const s = site.cms_site_id ? await loadSeoSettings(master, site.cms_site_id).catch(() => DEFAULT_SEO_SETTINGS) : DEFAULT_SEO_SETTINGS
  const body = renderControlCenter(siteId, site.domain, s, { saved: c.req.query("saved") === "1" })
  return c.html(renderSaasLayout({ title: "SEO settings", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function seoSettingsSaveHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const render = (s: SeoSettings, opts: { error?: string; needOverride?: boolean }) =>
    c.html(renderSaasLayout({ title: "SEO settings", active: "sites", customer, bodyHtml: renderControlCenter(siteId, site.domain, s, opts) }), 200, NO_STORE)
  if (planGate(customer, nowSqlite()) === "read_only") return render(DEFAULT_SEO_SETTINGS, { error: "Your trial has ended — subscribe to change SEO settings." })

  const form = await c.req.parseBody({ all: true })
  const on = (k: string) => form[k] === "on" || form[k] === "1" || form[k] === "true"
  const first = (k: string) => { const v = form[k]; return Array.isArray(v) ? String(v[0]) : String(v ?? "") }
  const next: SeoSettings = {
    blockAiBots: on("blockAiBots"),
    blockedBots: lines(first("blockedBots")),
    disallowPaths: lines(first("disallowPaths")),
    robotsExtra: first("robotsExtra").slice(0, 4000),
    rssEnabled: on("rssEnabled"),
    archivesEnabled: on("archivesEnabled"),
    globalSchemaEnabled: on("globalSchemaEnabled"),
    orgName: first("orgName").slice(0, 200),
    orgLogo: first("orgLogo").slice(0, 500),
    socialProfiles: lines(first("socialProfiles")),
  }
  const override = first("override")
  const r = await saveSeoSettings(c.env, customer.id, site.cms_site_id, site.repo_full_name, next, master, override)
  if (!r.ok) {
    // Hard rail tripped — re-render with the override field (rail #2).
    return render(next, { error: r.error, needOverride: robotsWouldBlockMajorEngines(next) })
  }
  await audit(master, customer.id, "site.seo_settings_saved", site.domain, { engineBlockOverride: !!r.overrodeEngineBlock }).catch(() => {})
  return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/seo-settings?saved=1` } })
}

/** Serve the cockpit's vanilla JS (no build step). Public — it's just a script. */
export async function seoCockpitJsHandler(c: Context<AppEnv>): Promise<Response> {
  return new Response(SEO_COCKPIT_JS, {
    headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" },
  })
}
