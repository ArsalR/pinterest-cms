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
import { importWordpress } from "./service"

const NO_STORE = { "Cache-Control": "no-store, private" }

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}

interface SiteRow { id: string; customer_id: string; cms_site_id: string | null; domain: string }

async function loadSite(c: Context<AppEnv>, master: Awaited<ReturnType<typeof masterDb>>, customerId: string): Promise<SiteRow | null> {
  const siteId = c.req.param("id") ?? ""
  const r = await master.execute({
    sql: "SELECT id, customer_id, cms_site_id, domain FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [siteId, customerId],
  })
  return r.rows.length ? (r.rows[0] as unknown as SiteRow) : null
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

  const body = `
    <div class="card">
      <p><a href="/app/sites/${escapeAttr(site.id)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Import from WordPress</h2>
      <p class="muted" style="font-size:13px">Export your WordPress site (Tools → Export → All content) and paste the <code>.xml</code> (WXR) below. Posts import as <strong>drafts</strong> and flow through the quality gate before going live.</p>
    </div>
    ${done ? `<div class="banner" style="border-color:#14532d;color:#86efac;background:#0f1a14">${escapeHtml(done)}</div>` : ""}
    ${error ? `<div class="banner" style="border-color:#7f1d1d;color:#fca5a5;background:#1c1212">${escapeHtml(error)}</div>` : ""}
    <div class="card">
      <form method="POST" action="/app/sites/${escapeAttr(site.id)}/import">
        <textarea name="wxr" required rows="12" placeholder="Paste the contents of your WordPress export .xml here…"
          style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:12px;color:#fafafa;font-family:ui-monospace,monospace;font-size:12px"></textarea>
        <div style="margin-top:12px"><button class="btn" type="submit">Import as drafts</button></div>
      </form>
    </div>`
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
  try { form = await c.req.formData() } catch { return back({ error: "That upload didn't come through — paste the export again." }) }
  const wxr = String(form.get("wxr") || "").trim()
  if (!wxr.includes("<item")) return back({ error: "That doesn't look like a WordPress export — it should contain <item> entries." })

  try {
    const r = await importWordpress(c.env, site.cms_site_id, wxr)
    await audit(master, customer.id, "site.wordpress_imported", site.domain, { imported: r.imported, existing: r.skippedExisting }).catch(() => {})
    const msg = `Imported ${r.imported} post${r.imported === 1 ? "" : "s"} as drafts${r.skippedExisting ? `, skipped ${r.skippedExisting} already present` : ""}${r.skippedNonPost ? `, ignored ${r.skippedNonPost} non-post items` : ""}. Review them in Drafts & quality gate.`
    return back({ done: msg })
  } catch (err) {
    console.error("wordpress import failed:", err instanceof Error ? err.message : err)
    return back({ error: "The import couldn't be completed — please try again." })
  }
}
