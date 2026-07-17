// src/modules/design/routes.ts
// Change a site's design preset / layout after launch (V1.1). The dashboard —
// NOT Claude — authors the change: input is validated against the catalog enums
// (never free-form), audit-logged, then a deterministic `design.yml` workflow
// (no Anthropic) patches the platform-managed site.config.json and flows through
// the EXISTING preview-then-approve path (preview worker builds with the new
// tokens; Approve merges → covenant-gated deploy). claude.yml's protected-path
// list is untouched — its guard is against Claude's output, not the platform.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr, cuid } from "../../lib/utils"
import { audit, planGate, type Customer } from "../customers"
import { getConnection, installationToken, dispatchWorkflow } from "../connections"
import { PRESETS, isPreset, isLayout, layoutsFor, DEFAULT_PRESET } from "./catalog"

const NO_STORE = { "Cache-Control": "no-store, private" }

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}
function nowSqlite(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}

interface DesignSite { id: string; customer_id: string; kind: string; domain: string; repo_full_name: string | null; design_preset: string | null; layout_variant: string | null }

async function loadSite(master: Awaited<ReturnType<typeof masterDb>>, siteId: string, customerId: string): Promise<DesignSite | null> {
  const r = await master.execute({
    sql: "SELECT id, customer_id, kind, domain, repo_full_name, design_preset, layout_variant FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [siteId, customerId],
  })
  return r.rows.length ? (r.rows[0] as unknown as DesignSite) : null
}

export async function designPageHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const url = new URL(c.req.url)
  const done = url.searchParams.get("done")
  const error = url.searchParams.get("error")

  const currentPreset = site.design_preset ?? DEFAULT_PRESET
  const currentLayout = site.layout_variant ?? "classic"
  const layouts = layoutsFor(site.kind)

  const cards = PRESETS.map(
    (p) => `<label style="cursor:pointer;display:block">
      <input type="radio" name="preset" value="${escapeAttr(p.id)}" ${p.id === currentPreset ? "checked" : ""} style="position:absolute;opacity:0">
      <span class="dcard" style="display:block;border:2px solid ${p.id === currentPreset ? "#fafafa" : "#404040"};border-radius:10px;overflow:hidden">
        <span style="display:block;height:44px;background:${p.swatch.bg};position:relative">
          <span style="position:absolute;left:10px;top:12px;width:20px;height:20px;border-radius:5px;background:${p.swatch.accent}"></span>
          <span style="position:absolute;left:34px;top:14px;width:44px;height:8px;border-radius:4px;background:${p.swatch.fg};opacity:.85"></span>
        </span>
        <span style="display:block;padding:7px 9px;background:#171717"><span style="font-size:13px;font-weight:600">${escapeHtml(p.label)}</span><span class="muted" style="display:block;font-size:11px">${escapeHtml(p.mood)}</span></span>
      </span>
    </label>`
  ).join("")

  const layoutRadios = layouts
    .map((l) => `<label style="flex:1;min-width:150px;border:1px solid #404040;border-radius:8px;padding:9px;cursor:pointer;font-size:13px"><input type="radio" name="layout" value="${escapeAttr(l.id)}" ${l.id === currentLayout ? "checked" : ""}> ${escapeHtml(l.label)}<span class="muted" style="display:block;font-size:11px;margin-left:20px">${escapeHtml(l.hint)}</span></label>`)
    .join("")

  const body = `
    <style>.dgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin:6px 0}input[name="preset"]:checked + .dcard{border-color:#fafafa!important}</style>
    <div class="card"><p><a href="/app/sites/${escapeAttr(siteId)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Design</h2>
      <p class="muted" style="font-size:13px">Pick a new look — you'll see a before/after preview and approve before it goes live. Current: <strong>${escapeHtml(currentPreset)}</strong> · ${escapeHtml(currentLayout)}.</p>
    </div>
    ${done ? `<div class="banner" style="border-color:#14532d;color:#86efac;background:#0f1a14">${escapeHtml(done)}</div>` : ""}
    ${error ? `<div class="banner" style="border-color:#7f1d1d;color:#fca5a5;background:#1c1212">${escapeHtml(error)}</div>` : ""}
    <div class="card">
      <form method="POST" action="/app/sites/${escapeAttr(siteId)}/design">
        <label>Design preset</label>
        <div class="dgrid">${cards}</div>
        <label style="margin-top:8px">Homepage layout</label>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">${layoutRadios}</div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:6px 0 12px"><input type="checkbox" name="direct" value="1"> Skip preview — apply straight to live</label>
        <button class="btn" type="submit">Preview new design</button>
      </form>
      <p class="muted" style="font-size:12px;margin-top:8px">Applies as a platform-authored change to your site's config, then builds a preview for you to approve.</p>
    </div>`
  return c.html(renderSaasLayout({ title: "Design", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function designApplyHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (p: Record<string, string>) => new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/design?${new URLSearchParams(p)}` } })

  if (planGate(customer, nowSqlite()) === "read_only") return back({ error: "Your trial has ended — subscribe to change your design." })
  if (!site.repo_full_name) return back({ error: "This site isn't fully set up yet." })

  const form = await c.req.formData().catch(() => null)
  const preset = String(form?.get("preset") ?? "")
  const layout = String(form?.get("layout") ?? "")
  const mode = form?.get("direct") === "1" ? "direct" : "preview"
  // Server-side enum validation — never trust the posted value.
  if (!isPreset(preset)) return back({ error: "Unknown preset." })
  if (!isLayout(site.kind, layout)) return back({ error: "That layout isn't available for this site kind." })

  const gh = await getConnection(master, customer.id, "github")
  const installationId = Number((JSON.parse(gh?.meta || "{}") as { installationId?: number }).installationId ?? 0)
  if (!installationId) return back({ error: "GitHub isn't connected — reconnect it in Connections." })

  const jobId = `design-${cuid().slice(0, 8)}`
  try {
    const token = await installationToken(c.env, installationId)
    await dispatchWorkflow(token, site.repo_full_name, "design.yml", "main", { preset, layout, mode, job_id: jobId })
  } catch (err) {
    console.error("design dispatch failed:", err instanceof Error ? err.message : err)
    return back({ error: "Couldn't start the design change — please try again." })
  }
  // Reflect the intended selection on the site row (source of truth for the
  // next provisioning/config write); the deploy still gates via preview/approve.
  await master.execute({ sql: "UPDATE customer_sites SET design_preset = ?, layout_variant = ?, updated_at = datetime('now') WHERE id = ?", args: [preset, layout, siteId] }).catch(() => {})
  await audit(master, customer.id, "site.design_changed", site.domain, { preset, layout, mode }).catch(() => {})

  return mode === "direct"
    ? back({ done: "Applying the new design to your live site — the covenant-gated deploy takes it live in a couple of minutes." })
    : new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/preview?done=${encodeURIComponent("New design building — review the before/after and approve.")}` } })
}
