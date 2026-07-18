// src/modules/seo/localRoutes.ts
// Local SEO dashboard (V1.3 P1) — /app/sites/:id/local. Business info stored
// ONCE and injected everywhere; multi-location list; honest-reviews warning;
// a local-landing preset that routes through the EXISTING pSEO engine + gate.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema, renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { audit, planGate, type Customer } from "../customers"
import { LOCAL_SUBTYPES, DAY_KEYS, type HoursModel } from "./local"
import { listLocations, saveLocation, deleteLocation, type LocationInput } from "./localService"

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
interface LocalSite { id: string; cms_site_id: string | null; domain: string; name: string; repo_full_name: string | null }
async function loadLocalSite(master: Awaited<ReturnType<typeof masterDb>>, siteId: string, customerId: string): Promise<LocalSite | null> {
  const r = await master.execute({
    sql: "SELECT id, cms_site_id, domain, name, repo_full_name FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [siteId, customerId],
  })
  return r.rows.length ? (r.rows[0] as unknown as LocalSite) : null
}

const DAY_LABEL: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" }

export async function localSeoHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadLocalSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const locations = site.cms_site_id ? await listLocations(master, site.cms_site_id).catch(() => []) : []

  const editId = c.req.query("edit") ?? ""
  const editing = locations.find((l) => l.id === editId)
  const saved = c.req.query("saved")
  const error = c.req.query("error")
  const notice = saved
    ? `<div class="card" style="border-color:#166534;background:#052e16"><p style="margin:0;color:#86efac;font-size:13px">${escapeHtml(saved)} Your site is rebuilding (usually ~2 minutes).</p></div>`
    : error
      ? `<div class="card" style="border-color:#7f1d1d;background:#2a0d0d"><p style="margin:0;color:#fca5a5;font-size:13px">${escapeHtml(error)}</p></div>`
      : ""

  const subtypeOpts = LOCAL_SUBTYPES.map(
    (t) => `<option value="${t}" ${editing?.subtype === t ? "selected" : ""}>${t === "LocalBusiness" ? "General local business" : t.replace(/([A-Z])/g, " $1").trim()}</option>`
  ).join("")
  const hoursInputs = DAY_KEYS.map((d) => `
    <div style="display:flex;gap:6px;align-items:center;margin:3px 0">
      <span style="width:36px;font-size:12px" class="muted">${DAY_LABEL[d]}</span>
      <input name="hours_${d}" value="${escapeAttr(editing?.hours.weekly[d] ?? "")}" placeholder="09:00-17:00 (empty = closed)" style="${IN};max-width:220px" />
    </div>`).join("")
  const holidayLines = (editing?.hours.holidays ?? []).map((h) => `${h.date} ${h.hours ?? "closed"}`).join("\n")

  const rows = locations.length
    ? locations.map((l) => `<tr style="border-top:1px solid #1f2937">
        <td style="padding:8px 6px;font-size:13px">${escapeHtml(l.name)}${l.isPrimary ? ` <span style="color:#86efac;font-size:11px">● primary</span>` : ""}
          <div class="muted" style="font-size:11px">${escapeHtml([l.street, l.city].filter(Boolean).join(", ") || l.serviceAreas.join(" · "))}</div></td>
        <td style="padding:8px 6px;text-align:right;white-space:nowrap">
          <a href="/app/sites/${escapeAttr(siteId)}/local?edit=${escapeAttr(l.id)}" class="btn ghost" style="font-size:12px">Edit</a>
          <form method="post" action="/app/sites/${escapeAttr(siteId)}/local/delete" style="display:inline;margin:0" onsubmit="return confirm('Delete this location?')">
            <input type="hidden" name="id" value="${escapeAttr(l.id)}" /><button type="submit" style="background:none;border:none;color:#737373;cursor:pointer">✕</button>
          </form>
        </td></tr>`).join("")
    : `<tr><td colspan="2" class="muted" style="padding:10px 6px">No locations yet — add your business below. The first one becomes the primary.</td></tr>`

  const body = `
    ${notice}
    <div class="card"><p><a href="/app/sites/${escapeAttr(siteId)}/seo" style="color:#93c5fd">← SEO</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Local SEO</h2>
      <p class="muted" style="font-size:13px">Your business details, stored once and shown consistently everywhere — on the site, in LocalBusiness schema for the map pack, and on location pages.</p>
    </div>
    <div class="card"><h3 style="margin:0 0 6px;font-size:14px">Locations</h3>
      <table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table></div>
    <form method="post" action="/app/sites/${escapeAttr(siteId)}/local">
      <input type="hidden" name="id" value="${escapeAttr(editing?.id ?? "")}" />
      <div class="card">
        <h3 style="margin:0 0 8px;font-size:14px">${editing ? `Edit ${escapeHtml(editing.name)}` : "Add a location"}</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">
          <div><label class="muted" style="font-size:12px">Business name</label><input name="name" required value="${escapeAttr(editing?.name ?? site.name)}" style="${IN}" /></div>
          <div><label class="muted" style="font-size:12px">Business type</label><select name="subtype" style="${IN}">${subtypeOpts}</select></div>
          <div><label class="muted" style="font-size:12px">Phone</label><input name="phone" value="${escapeAttr(editing?.phone ?? "")}" style="${IN}" /></div>
          <div><label class="muted" style="font-size:12px">Street address</label><input name="street" value="${escapeAttr(editing?.street ?? "")}" style="${IN}" /></div>
          <div><label class="muted" style="font-size:12px">City</label><input name="city" value="${escapeAttr(editing?.city ?? "")}" style="${IN}" /></div>
          <div><label class="muted" style="font-size:12px">Region/State</label><input name="region" value="${escapeAttr(editing?.region ?? "")}" style="${IN}" /></div>
          <div><label class="muted" style="font-size:12px">Postal code</label><input name="postal" value="${escapeAttr(editing?.postal ?? "")}" style="${IN}" /></div>
          <div><label class="muted" style="font-size:12px">Country code</label><input name="country" value="${escapeAttr(editing?.country ?? "")}" placeholder="US" style="${IN}" /></div>
          <div><label class="muted" style="font-size:12px">Latitude</label><input name="latitude" value="${editing?.latitude ?? ""}" placeholder="53.80" style="${IN}" /></div>
          <div><label class="muted" style="font-size:12px">Longitude</label><input name="longitude" value="${editing?.longitude ?? ""}" placeholder="-1.55" style="${IN}" /></div>
          <div><label class="muted" style="font-size:12px">Price range</label><select name="priceRange" style="${IN}">
            ${["", "$", "$$", "$$$"].map((p) => `<option value="${p}" ${editing?.priceRange === p ? "selected" : ""}>${p || "(not shown)"}</option>`).join("")}</select></div>
          <div><label class="muted" style="font-size:12px">Google Business Profile link</label><input name="gbpUrl" value="${escapeAttr(editing?.gbpUrl ?? "")}" placeholder="https://maps.google.com/…" style="${IN}" /></div>
        </div>
        <label class="muted" style="font-size:12px;display:block;margin:10px 0 3px">Service areas (one per line — for businesses that travel to customers)</label>
        <textarea name="serviceAreas" rows="2" style="${IN}">${escapeHtml(editing?.serviceAreas.join("\n") ?? "")}</textarea>
        <h4 style="margin:12px 0 4px;font-size:13px">Opening hours</h4>
        ${hoursInputs}
        <label class="muted" style="font-size:12px;display:block;margin:8px 0 3px">Holiday overrides (one per line: YYYY-MM-DD 10:00-14:00, or YYYY-MM-DD closed)</label>
        <textarea name="holidays" rows="2" style="${IN}">${escapeHtml(holidayLines)}</textarea>
        <h4 style="margin:12px 0 4px;font-size:13px">Ratings <span class="muted" style="font-weight:400;font-size:11px">— only if you genuinely collect reviews</span></h4>
        <p style="font-size:12px;color:#fcd34d;margin:0 0 6px">Only enter ratings you actually collect and display on this site. Fake or copied review markup gets sites penalized by Google — leave these empty otherwise.</p>
        <div style="display:flex;gap:10px">
          <input name="ratingValue" value="${editing?.ratingValue ?? ""}" placeholder="Average (1-5)" style="${IN};max-width:160px" />
          <input name="ratingCount" value="${editing?.ratingCount ?? ""}" placeholder="Number of reviews" style="${IN};max-width:160px" />
        </div>
        <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin:12px 0 0"><input type="checkbox" name="isPrimary" ${editing?.isPrimary || locations.length === 0 ? "checked" : ""} /> This is the primary location (shown on the homepage &amp; contact page)</label>
      </div>
      <div class="card" style="display:flex;justify-content:flex-end;gap:8px">
        ${editing ? `<a class="btn ghost" href="/app/sites/${escapeAttr(siteId)}/local">Cancel</a>` : ""}
        <button type="submit" style="background:#2563eb;color:#fff;border:0;border-radius:7px;padding:9px 16px;font-size:14px;cursor:pointer">${editing ? "Save location" : "Add location"}</button>
      </div>
    </form>
    <div class="card">
      <h3 style="margin:0 0 4px;font-size:14px">Local landing pages</h3>
      <p class="muted" style="font-size:12px;margin:0 0 8px">Generate a city × service page matrix through the <a href="/app/sites/${escapeAttr(siteId)}/pseo" style="color:#93c5fd">programmatic engine</a> — every page runs the same quality gate, so thin duplicate "doorway" pages are blocked, not published. Use the city/service CSV columns and write genuinely local substance per city.</p>
    </div>`
  await audit(master, customer.id, "site.local_seo_viewed", site.domain).catch(() => {})
  return c.html(renderSaasLayout({ title: "Local SEO", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

function parseHoursForm(form: Record<string, unknown>): HoursModel {
  const weekly: HoursModel["weekly"] = {}
  for (const d of DAY_KEYS) {
    const v = String(form[`hours_${d}`] ?? "").trim()
    weekly[d] = v || null
  }
  const holidays: HoursModel["holidays"] = []
  for (const line of String(form.holidays ?? "").split(/\r?\n/)) {
    const m = /^(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(line.trim())
    if (!m) continue
    holidays.push({ date: m[1], hours: m[2] === "closed" ? null : m[2] })
  }
  return { weekly, holidays }
}

export async function localSeoSaveHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadLocalSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/local${q}` } })
  if (planGate(customer, nowSqlite()) === "read_only") return back("?error=" + encodeURIComponent("Your trial has ended — subscribe to edit."))

  const form = (await c.req.parseBody()) as Record<string, unknown>
  const num = (k: string): number | null => {
    const v = String(form[k] ?? "").trim()
    if (!v) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const input: LocationInput = {
    name: String(form.name ?? ""), subtype: String(form.subtype ?? "LocalBusiness"),
    street: String(form.street ?? ""), city: String(form.city ?? ""), region: String(form.region ?? ""),
    postal: String(form.postal ?? ""), country: String(form.country ?? ""), phone: String(form.phone ?? ""),
    hours: parseHoursForm(form),
    latitude: num("latitude"), longitude: num("longitude"),
    serviceAreas: String(form.serviceAreas ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    priceRange: String(form.priceRange ?? ""), gbpUrl: String(form.gbpUrl ?? ""),
    ratingValue: num("ratingValue"), ratingCount: num("ratingCount"),
    isPrimary: form.isPrimary === "on",
  }
  const r = await saveLocation(c.env, customer.id, site.cms_site_id, site.repo_full_name, String(form.id ?? ""), input, master)
  if (!r.ok) return back("?error=" + encodeURIComponent(r.error ?? "Couldn't save."))
  await audit(master, customer.id, "site.local_location_saved", site.domain).catch(() => {})
  return back("?saved=" + encodeURIComponent("Location saved."))
}

export async function localSeoDeleteHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadLocalSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  if (planGate(customer, nowSqlite()) !== "read_only") {
    const form = await c.req.parseBody()
    await deleteLocation(c.env, customer.id, site.cms_site_id, site.repo_full_name, String(form.id ?? ""), master)
    await audit(master, customer.id, "site.local_location_deleted", site.domain).catch(() => {})
  }
  return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/local?saved=${encodeURIComponent("Location removed.")}` } })
}
