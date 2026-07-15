// src/modules/affiliate/routes.ts
// Affiliate manager UI (K10): set affiliate domains + disclosure, scan
// published posts for non-compliant links / missing disclosures, and apply a
// one-click compliance rewrite across the site. Plan-gated for the write path.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { audit, planGate, type Customer } from "../customers"
import { loadConfig, saveConfig, scanPosts, applyToAllPosts } from "./service"

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

function nowSqlite(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}

export async function affiliatePageHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const url = new URL(c.req.url)
  const done = url.searchParams.get("done")
  const error = url.searchParams.get("error")

  const config = site.cms_site_id ? await loadConfig(master, site.cms_site_id) : { affiliateDomains: [], disclosureText: "" }
  const scan = site.cms_site_id && config.affiliateDomains.length ? await scanPosts(master, site.cms_site_id, config).catch(() => null) : null

  const scanCard = scan
    ? `<div class="card">
        <h3 style="margin:0 0 10px;font-size:15px">Scan of published posts</h3>
        <table style="width:100%;font-size:14px"><tbody>
          <tr><td>Posts scanned</td><td style="text-align:right">${scan.postsScanned}</td></tr>
          <tr><td>Affiliate links found</td><td style="text-align:right">${scan.affiliateLinks}</td></tr>
          <tr><td>Links missing <code>rel="sponsored"</code></td><td style="text-align:right">${scan.nonCompliant ? `<span style="color:#fca5a5">${scan.nonCompliant}</span>` : "0"}</td></tr>
          <tr><td>Posts missing a disclosure</td><td style="text-align:right">${scan.postsMissingDisclosure ? `<span style="color:#fcd34d">${scan.postsMissingDisclosure}</span>` : "0"}</td></tr>
        </tbody></table>
        ${
          scan.nonCompliant || scan.postsMissingDisclosure
            ? `<form method="POST" action="/app/sites/${escapeAttr(site.id)}/affiliate/apply" style="margin-top:12px"
                 onsubmit="return confirm('Rewrite ${scan.nonCompliant + scan.postsMissingDisclosure} item(s) across your published posts and rebuild the site?')">
                <button class="btn" type="submit">Fix all &amp; rebuild</button>
              </form>`
            : `<p class="muted" style="font-size:13px;margin-top:10px">Everything's compliant — nothing to fix. 🎉</p>`
        }
      </div>`
    : config.affiliateDomains.length
      ? `<div class="card"><p class="muted">No published posts to scan yet.</p></div>`
      : ""

  const body = `
    <div class="card">
      <p><a href="/app/sites/${escapeAttr(site.id)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Affiliate links</h2>
      <p class="muted" style="font-size:13px">Keep affiliate links compliant: <code>rel="sponsored nofollow"</code> on paid links and an FTC disclosure on pages that use them.</p>
    </div>
    ${done ? `<div class="banner" style="border-color:#14532d;color:#86efac;background:#0f1a14">${escapeHtml(done)}</div>` : ""}
    ${error ? `<div class="banner" style="border-color:#7f1d1d;color:#fca5a5;background:#1c1212">${escapeHtml(error)}</div>` : ""}
    <div class="card">
      <form method="POST" action="/app/sites/${escapeAttr(site.id)}/affiliate">
        <label style="display:block;font-size:13px;margin-bottom:6px">Affiliate domains <span class="muted">(one per line or comma-separated — e.g. amazon.com, amzn.to)</span></label>
        <textarea name="domains" rows="4" style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px;color:#fafafa;font-family:ui-monospace,monospace;font-size:13px">${escapeHtml(config.affiliateDomains.join("\n"))}</textarea>
        <label style="display:block;font-size:13px;margin:14px 0 6px">Disclosure text</label>
        <textarea name="disclosure" rows="2" style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px;color:#fafafa;font-size:13px">${escapeHtml(config.disclosureText)}</textarea>
        <div style="margin-top:12px"><button class="btn" type="submit">Save settings</button></div>
      </form>
    </div>
    ${scanCard}`
  return c.html(renderSaasLayout({ title: "Affiliate", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function affiliateSaveHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (params: Record<string, string>) =>
    new Response(null, { status: 302, headers: { Location: `/app/sites/${site.id}/affiliate?${new URLSearchParams(params)}` } })
  if (!site.cms_site_id) return back({ error: "This site has no content workspace yet." })

  let form: FormData
  try { form = await c.req.formData() } catch { return back({ error: "That form didn't come through — try again." }) }
  await saveConfig(master, site.cms_site_id, String(form.get("domains") || ""), String(form.get("disclosure") || ""))
  await audit(master, customer.id, "site.affiliate_configured", site.domain).catch(() => {})
  return back({ done: "Affiliate settings saved." })
}

export async function affiliateApplyHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (params: Record<string, string>) =>
    new Response(null, { status: 302, headers: { Location: `/app/sites/${site.id}/affiliate?${new URLSearchParams(params)}` } })

  if (planGate(customer, nowSqlite()) === "read_only") return back({ error: "Your trial has ended — subscribe to edit content." })
  if (!site.cms_site_id) return back({ error: "This site has no content workspace yet." })

  const config = await loadConfig(master, site.cms_site_id)
  if (!config.affiliateDomains.length) return back({ error: "Add at least one affiliate domain first." })

  try {
    const r = await applyToAllPosts(c.env, customer.id, site.cms_site_id, site.repo_full_name, config)
    await audit(master, customer.id, "site.affiliate_applied", site.domain, { updated: r.postsUpdated }).catch(() => {})
    return back({ done: `Updated ${r.postsUpdated} post${r.postsUpdated === 1 ? "" : "s"} — fixed ${r.linksFixed} link${r.linksFixed === 1 ? "" : "s"}, added ${r.disclosuresAdded} disclosure${r.disclosuresAdded === 1 ? "" : "s"}. Rebuild triggered.` })
  } catch (err) {
    console.error("affiliate apply failed:", err instanceof Error ? err.message : err)
    return back({ error: "Couldn't apply the changes — please try again." })
  }
}
