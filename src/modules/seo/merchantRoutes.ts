// src/modules/seo/merchantRoutes.ts
// Merchant SEO dashboard (V1.3 P3) — /app/sites/:id/merchant. Site-level
// shipping/returns (referenced by every product's schema) + a per-product
// bulk editor for brand/GTIN/MPN/condition/ratings. Honest-ratings warning as
// everywhere. Feed URL shown for Merchant Center submission.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema, renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { audit, planGate, type Customer } from "../customers"
import { loadMerchantConfig, saveMerchantConfig, listMerchantProducts, saveMerchantProducts, type ProductMerchantUpdate } from "./merchantService"
import { parseMerchantConfig } from "./merchant"

const NO_STORE = { "Cache-Control": "no-store, private" }
const IN = "width:100%;padding:7px 9px;border-radius:6px;border:1px solid #374151;background:#0b0f17;color:#fafafa;font-size:12px"

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}
function nowSqlite(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}
async function loadMerchantSite(master: Awaited<ReturnType<typeof masterDb>>, siteId: string, customerId: string) {
  const r = await master.execute({
    sql: "SELECT id, cms_site_id, domain, name, repo_full_name FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [siteId, customerId],
  })
  return r.rows.length ? (r.rows[0] as unknown as { id: string; cms_site_id: string | null; domain: string; name: string; repo_full_name: string | null }) : null
}

export async function merchantSeoHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadMerchantSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const cfg = site.cms_site_id ? await loadMerchantConfig(master, site.cms_site_id).catch(() => parseMerchantConfig(null)) : parseMerchantConfig(null)
  const products = site.cms_site_id ? await listMerchantProducts(master, site.cms_site_id).catch(() => []) : []
  const saved = c.req.query("saved")
  const error = c.req.query("error")
  const notice = saved
    ? `<div class="card" style="border-color:#166534;background:#052e16"><p style="margin:0;color:#86efac;font-size:13px">${escapeHtml(saved)} Your site is rebuilding (usually ~2 minutes).</p></div>`
    : error
      ? `<div class="card" style="border-color:#7f1d1d;background:#2a0d0d"><p style="margin:0;color:#fca5a5;font-size:13px">${escapeHtml(error)}</p></div>`
      : ""

  const condOpts = (cur: string | null) =>
    ["", "new", "refurbished", "used"].map((v) => `<option value="${v}" ${cur === v || (!cur && v === "") ? "selected" : ""}>${v || "—"}</option>`).join("")
  const rows = products.length
    ? products.map((p) => `<tr style="border-top:1px solid #1f2937">
        <td style="padding:6px;font-size:12px">${escapeHtml(p.title)}<div class="muted" style="font-size:10px">${escapeHtml(p.slug)}</div></td>
        <td style="padding:6px"><input name="brand_${escapeAttr(p.id)}" value="${escapeAttr(p.brand ?? "")}" placeholder="Brand" style="${IN}" /></td>
        <td style="padding:6px"><input name="gtin_${escapeAttr(p.id)}" value="${escapeAttr(p.gtin ?? "")}" placeholder="GTIN" style="${IN}" /></td>
        <td style="padding:6px"><input name="mpn_${escapeAttr(p.id)}" value="${escapeAttr(p.mpn ?? "")}" placeholder="MPN" style="${IN}" /></td>
        <td style="padding:6px"><select name="cond_${escapeAttr(p.id)}" style="${IN}">${condOpts(p.condition)}</select></td>
        <td style="padding:6px"><input name="rv_${escapeAttr(p.id)}" value="${p.ratingValue ?? ""}" placeholder="4.5" style="${IN};width:60px" /></td>
        <td style="padding:6px"><input name="rc_${escapeAttr(p.id)}" value="${p.ratingCount ?? ""}" placeholder="12" style="${IN};width:60px" /></td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="muted" style="padding:10px 6px">No products yet.</td></tr>`

  const feedUrl = `https://${site.domain}/feed.xml`
  const body = `
    ${notice}
    <div class="card"><p><a href="/app/sites/${escapeAttr(siteId)}/seo" style="color:#93c5fd">← SEO</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Merchant SEO</h2>
      <p class="muted" style="font-size:13px">Product details that unlock rich results and Shopping listings. Your product feed is built on every deploy at
        <code style="font-size:12px">${escapeHtml(feedUrl)}</code> — submit that URL in <a href="https://merchants.google.com" style="color:#93c5fd" rel="noopener">Google Merchant Center</a>.</p>
    </div>
    <form method="post" action="/app/sites/${escapeAttr(siteId)}/merchant/config">
      <div class="card">
        <h3 style="margin:0 0 8px;font-size:14px">Shipping &amp; returns <span class="muted" style="font-weight:400;font-size:11px">— shown on every product's rich result</span></h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">
          <div><label class="muted" style="font-size:12px">Flat shipping (e.g. 4.99; empty = omit)</label><input name="shippingRate" value="${cfg.shippingRateCents != null ? (cfg.shippingRateCents / 100).toFixed(2) : ""}" style="${IN}" /></div>
          <div><label class="muted" style="font-size:12px">Currency</label><input name="shippingCurrency" value="${escapeAttr(cfg.shippingCurrency)}" style="${IN}" /></div>
          <div><label class="muted" style="font-size:12px">Ships to (country code)</label><input name="shipCountry" value="${escapeAttr(cfg.shipCountry)}" style="${IN}" /></div>
          <div><label class="muted" style="font-size:12px">Handling days (max)</label><input name="handlingDaysMax" value="${cfg.handlingDaysMax ?? ""}" style="${IN}" /></div>
          <div><label class="muted" style="font-size:12px">Transit days (max)</label><input name="transitDaysMax" value="${cfg.transitDaysMax ?? ""}" style="${IN}" /></div>
          <div><label class="muted" style="font-size:12px">Return window (days; empty = omit)</label><input name="returnDays" value="${cfg.returnDays ?? ""}" style="${IN}" /></div>
          <div><label class="muted" style="font-size:12px">Return shipping</label><select name="returnFees" style="${IN}">
            <option value="customer" ${cfg.returnFees === "customer" ? "selected" : ""}>Customer pays</option>
            <option value="free" ${cfg.returnFees === "free" ? "selected" : ""}>Free returns</option></select></div>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:10px"><button type="submit" style="background:#2563eb;color:#fff;border:0;border-radius:7px;padding:8px 15px;font-size:13px;cursor:pointer">Save shipping &amp; returns</button></div>
      </div>
    </form>
    <form method="post" action="/app/sites/${escapeAttr(siteId)}/merchant/products">
      <div class="card" style="overflow-x:auto">
        <h3 style="margin:0 0 4px;font-size:14px">Products</h3>
        <p style="font-size:12px;color:#fcd34d;margin:0 0 8px">Ratings: only enter numbers from reviews you genuinely collect — fake review markup gets sites penalized by Google. Leave empty otherwise.</p>
        <table style="width:100%;border-collapse:collapse;min-width:720px"><thead><tr class="muted" style="font-size:10px;text-transform:uppercase">
          <th style="text-align:left;padding:4px 6px">Product</th><th style="text-align:left;padding:4px 6px">Brand</th><th style="text-align:left;padding:4px 6px">GTIN</th><th style="text-align:left;padding:4px 6px">MPN</th><th style="text-align:left;padding:4px 6px">Condition</th><th style="text-align:left;padding:4px 6px">Rating</th><th style="text-align:left;padding:4px 6px">Reviews</th>
        </tr></thead><tbody>${rows}</tbody></table>
        <div style="display:flex;justify-content:flex-end;margin-top:10px"><button type="submit" style="background:#2563eb;color:#fff;border:0;border-radius:7px;padding:8px 15px;font-size:13px;cursor:pointer">Save products</button></div>
      </div>
    </form>`
  await audit(master, customer.id, "site.merchant_seo_viewed", site.domain).catch(() => {})
  return c.html(renderSaasLayout({ title: "Merchant SEO", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function merchantConfigSaveHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadMerchantSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/merchant${q}` } })
  if (planGate(customer, nowSqlite()) === "read_only") return back("?error=" + encodeURIComponent("Your trial has ended — subscribe to edit."))
  const form = (await c.req.parseBody()) as Record<string, unknown>
  const num = (k: string): number | null => {
    const v = String(form[k] ?? "").trim()
    if (!v) return null
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  const rate = num("shippingRate")
  const cfg = parseMerchantConfig(
    JSON.stringify({
      shippingRateCents: rate != null ? Math.round(rate * 100) : null,
      shippingCurrency: String(form.shippingCurrency ?? "usd"),
      shipCountry: String(form.shipCountry ?? "US"),
      handlingDaysMax: num("handlingDaysMax"),
      transitDaysMax: num("transitDaysMax"),
      returnDays: num("returnDays"),
      returnFees: String(form.returnFees ?? "customer"),
    })
  )
  const r = await saveMerchantConfig(c.env, customer.id, site.cms_site_id, site.repo_full_name, cfg, master)
  if (!r.ok) return back("?error=" + encodeURIComponent(r.error ?? "Couldn't save."))
  await audit(master, customer.id, "site.merchant_config_saved", site.domain).catch(() => {})
  return back("?saved=" + encodeURIComponent("Shipping & returns saved."))
}

export async function merchantProductsSaveHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadMerchantSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/merchant${q}` } })
  if (planGate(customer, nowSqlite()) === "read_only") return back("?error=" + encodeURIComponent("Your trial has ended — subscribe to edit."))
  const form = (await c.req.parseBody()) as Record<string, unknown>
  const byId = new Map<string, ProductMerchantUpdate>()
  for (const [k, v] of Object.entries(form)) {
    const m = /^(brand|gtin|mpn|cond|rv|rc)_(.+)$/.exec(k)
    if (!m) continue
    const [, field, id] = m
    const u = byId.get(id) ?? { id, brand: "", gtin: "", mpn: "", condition: "", ratingValue: null, ratingCount: null }
    const val = String(v ?? "").trim()
    if (field === "brand") u.brand = val
    else if (field === "gtin") u.gtin = val
    else if (field === "mpn") u.mpn = val
    else if (field === "cond") u.condition = val
    else if (field === "rv") u.ratingValue = val ? Number(val) : null
    else if (field === "rc") u.ratingCount = val ? Number(val) : null
    byId.set(id, u)
  }
  const r = await saveMerchantProducts(c.env, customer.id, site.cms_site_id, site.repo_full_name, [...byId.values()], master)
  await audit(master, customer.id, "site.merchant_products_saved", site.domain, { updated: r.updated }).catch(() => {})
  return back("?saved=" + encodeURIComponent(`Updated ${r.updated} product${r.updated === 1 ? "" : "s"}.`))
}
