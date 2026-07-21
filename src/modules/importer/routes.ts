// src/modules/importer/routes.ts
// WordPress import UI (K9): paste a WXR export, import its posts as drafts, and
// see the counts. Imported posts land in the quality-gate drafts queue — they
// never publish unreviewed. Plan-gated like the other content tools.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { audit, planGate, type Customer } from "../customers"
import { importWordpress, importWordpressRest, type ImportResult, type ImportSite } from "./service"
import { isZip, extractWxrFromZip } from "./backup"

// Uploaded export cap — a WXR for a very large site is still only a few MB of
// text; 60MB is generous and keeps the whole file comfortably in Worker memory.
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024

const NO_STORE = { "Cache-Control": "no-store, private" }

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}

interface SiteRow { id: string; customer_id: string; cms_site_id: string | null; domain: string; repo_full_name: string | null }

async function loadSite(c: Context<AppEnv>, master: Awaited<ReturnType<typeof masterDb>>, customerId: string): Promise<SiteRow | null> {
  const siteId = c.req.param("id") ?? ""
  const r = await master.execute({
    sql: "SELECT id, customer_id, cms_site_id, domain, repo_full_name FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [siteId, customerId],
  })
  return r.rows.length ? (r.rows[0] as unknown as SiteRow) : null
}

/** The context the service needs to write content + trigger a rebuild. */
function importSite(site: SiteRow): ImportSite {
  return { cmsSiteId: site.cms_site_id as string, hostname: site.domain, customerId: site.customer_id, repoFullName: site.repo_full_name }
}

function nowSqlite(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}

export async function importPageHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const url = new URL(c.req.url)
  const done = url.searchParams.get("done")
  const error = url.searchParams.get("error")

  // Shared options block (publish-as-was + include pages) — reused by every form.
  const optionsFieldset = `
      <label style="display:flex;gap:8px;align-items:flex-start;margin:10px 0 2px;font-size:13px;cursor:pointer">
        <input type="checkbox" name="publish" value="1" checked style="margin-top:2px">
        <span><strong>Publish immediately — recreate the site as it was.</strong><br>
          <span class="muted" style="font-size:12px">Content that was live in WordPress goes live here with its original dates. Uncheck to import everything as drafts and review before publishing.</span></span>
      </label>
      <label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0 2px;font-size:13px;cursor:pointer">
        <input type="checkbox" name="pages" value="1" checked style="margin-top:2px">
        <span><strong>Include Pages</strong> (About, Contact, …), not just posts.<br>
          <span class="muted" style="font-size:12px">Pages become editable content with a 301 from their old URL, so links keep working.</span></span>
      </label>`

  const body = `
    <div class="card">
      <p><a href="/app/sites/${escapeAttr(site.id)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Import from WordPress</h2>
      <p class="muted" style="font-size:13px">Bring your posts, pages, images, categories and SEO across. Everything becomes fully editable — by AI or by hand — just like content built here. Old URLs 301 to the new ones, so nothing breaks for visitors or Google.</p>
    </div>
    ${done ? `<div class="banner" style="border-color:#14532d;color:#86efac;background:#0f1a14">${escapeHtml(done)}</div>` : ""}
    ${error ? `<div class="banner" style="border-color:#7f1d1d;color:#fca5a5;background:#1c1212">${escapeHtml(error)}</div>` : ""}
    <div class="card">
      <h3 style="margin:0 0 8px;font-size:15px">Option A — upload your export or backup</h3>
      <p class="muted" style="font-size:13px">In WordPress: <strong>Tools → Export → All content</strong> to download the <code>.xml</code> (WXR). Upload that file here — or a <code>.zip</code> that contains it (WordPress.com exports and some backup plugins zip the XML).</p>
      <form method="POST" action="/app/sites/${escapeAttr(site.id)}/import" enctype="multipart/form-data">
        <input type="hidden" name="mode" value="file">
        <input name="file" type="file" accept=".xml,.zip,text/xml,application/zip" required
          style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px;color:#fafafa;font-size:14px">
        ${optionsFieldset}
        <div style="margin-top:12px"><button class="btn" type="submit">Upload &amp; import</button></div>
      </form>
    </div>
    <div class="card">
      <h3 style="margin:0 0 8px;font-size:15px">Option B — from your live site (REST API)</h3>
      <p class="muted" style="font-size:13px">Fastest if your old WordPress site is still online — we read its public REST API (no export needed).</p>
      <form method="POST" action="/app/sites/${escapeAttr(site.id)}/import">
        <input type="hidden" name="mode" value="rest">
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <input name="url" type="url" required placeholder="https://your-old-site.com"
            style="flex:1;min-width:260px;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px;color:#fafafa;font-size:14px">
        </div>
        ${optionsFieldset}
        <div style="margin-top:12px"><button class="btn" type="submit">Import from URL</button></div>
      </form>
    </div>
    <details class="card">
      <summary style="cursor:pointer;font-size:14px">Option C — paste the WXR text</summary>
      <p class="muted" style="font-size:13px;margin-top:8px">Handy for a quick test — paste the contents of your export <code>.xml</code>.</p>
      <form method="POST" action="/app/sites/${escapeAttr(site.id)}/import">
        <input type="hidden" name="mode" value="wxr">
        <textarea name="wxr" required rows="8" placeholder="Paste the contents of your WordPress export .xml here…"
          style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:12px;color:#fafafa;font-family:ui-monospace,monospace;font-size:12px"></textarea>
        ${optionsFieldset}
        <div style="margin-top:12px"><button class="btn" type="submit">Import</button></div>
      </form>
    </details>
    <p class="muted" style="font-size:12px">Very large sites: images are rehosted in batches — if some are still on their old host, just run the import again to fetch the rest (already-imported content is skipped, so it's safe to repeat).</p>`
  return c.html(renderSaasLayout({ title: "Import", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function importRunHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (params: Record<string, string>) =>
    new Response(null, { status: 302, headers: { Location: `/app/sites/${site.id}/import?${new URLSearchParams(params)}` } })

  // Trial read-only gate: importing writes content, so respect the plan.
  if (planGate(customer, nowSqlite()) === "read_only") {
    return back({ error: "Your trial has ended — subscribe to import content." })
  }
  if (!site.cms_site_id) return back({ error: "This site has no content workspace yet." })

  let form: FormData
  try { form = await c.req.formData() } catch { return back({ error: "That upload didn't come through — try again." }) }
  const mode = String(form.get("mode") || "wxr")
  const opts = { publishLive: form.get("publish") === "1", includePages: form.get("pages") === "1" }

  try {
    let r: ImportResult
    if (mode === "rest") {
      const url = String(form.get("url") || "").trim()
      if (!/^https?:\/\//i.test(url)) return back({ error: "Enter your old site's full URL (including https://)." })
      const out = await importWordpressRest(c.env, importSite(site), url, opts)
      if ("error" in out) return back({ error: out.error })
      r = out
    } else {
      let wxr: string
      if (mode === "file") {
        const f = form.get("file")
        if (!(f instanceof File) || f.size === 0) return back({ error: "Choose your export .xml or .zip file first." })
        if (f.size > MAX_UPLOAD_BYTES) return back({ error: "That file is very large — export a smaller date range, or use the REST API option." })
        const bytes = new Uint8Array(await f.arrayBuffer())
        if (isZip(bytes) || /\.zip$/i.test(f.name)) {
          const extracted = await extractWxrFromZip(bytes)
          if (!extracted) {
            return back({ error: "That .zip doesn't contain a WordPress export (WXR .xml). If it's a database/hosting backup, use Tools → Export → All content in WordPress and upload that .xml instead." })
          }
          wxr = extracted
        } else {
          wxr = new TextDecoder().decode(bytes)
        }
      } else {
        wxr = String(form.get("wxr") || "").trim()
      }
      if (!wxr.includes("<item")) return back({ error: "That doesn't look like a WordPress export — it should contain <item> entries." })
      r = await importWordpress(c.env, importSite(site), wxr, opts)
    }
    await audit(master, customer.id, "site.wordpress_imported", site.domain, { imported: r.imported, pages: r.pagesImported, live: r.publishedLive, existing: r.skippedExisting, mode }).catch(() => {})
    const extras = [
      r.pagesImported ? `${r.pagesImported} page${r.pagesImported === 1 ? "" : "s"}` : "",
      r.skippedExisting ? `skipped ${r.skippedExisting} already present` : "",
      r.skippedNonPost ? `ignored ${r.skippedNonPost} non-content items` : "",
      r.redirectsCreated ? `added ${r.redirectsCreated} redirect${r.redirectsCreated === 1 ? "" : "s"}` : "",
      r.imagesRehosted ? `rehosted ${r.imagesRehosted} image${r.imagesRehosted === 1 ? "" : "s"}` : "",
      r.seoMapped ? `mapped SEO on ${r.seoMapped} item${r.seoMapped === 1 ? "" : "s"} (Yoast/Rank Math)` : "",
    ].filter(Boolean)
    const headline = r.publishedLive > 0
      ? `Imported ${r.imported} item${r.imported === 1 ? "" : "s"} — ${r.publishedLive} published live (rebuilding your site now)`
      : `Imported ${r.imported} item${r.imported === 1 ? "" : "s"} as drafts`
    const tail = r.imagesTruncated ? " Some images are still on their old host — run the import again to finish fetching them." : ""
    const msg = `${headline}${extras.length ? " — " + extras.join(", ") : ""}.${tail}`
    return back({ done: msg })
  } catch (err) {
    console.error("wordpress import failed:", err instanceof Error ? err.message : err)
    return back({ error: "The import couldn't be completed — please try again." })
  }
}
