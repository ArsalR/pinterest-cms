// src/modules/cloning/routes.ts
// Clone UI (K6): from a source site, pick a new domain + niche + differentiating
// angle → provision an independent clone → then re-theme & re-seed it with
// Claude. The re-seed reuses the sites module's dispatchPrompt with a
// clone-aware prompt so the sibling comes out distinct.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { getConnectionSecret, listCfZones } from "../connections"
import { audit, planGate, type Customer } from "../customers"
import { dispatchPrompt } from "../sites"
import type { CustomerSiteRow } from "../provisioning"
import { buildClonePrompt, deriveCloneName, type CloneInput } from "./clone"
import { loadSourceSite, cloneSite, loadCloneContext } from "./service"

const NO_STORE = { "Cache-Control": "no-store, private" }

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}

function nowSqlite(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}

export async function clonePageHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const sourceId = c.req.param("id") ?? ""
  const source = await loadSourceSite(master, sourceId, customer.id)
  if (!source) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const url = new URL(c.req.url)
  const error = url.searchParams.get("error")

  let zoneOptions = ""
  try {
    const token = await getConnectionSecret(master, c.env, customer.id, "cloudflare", "clone:zone-picker")
    const zones = token ? await listCfZones(token) : null
    zoneOptions = (zones ?? [])
      .filter((z) => z.status === "active" && !z.paused)
      .map((z) => `<option value="${escapeAttr(z.id)}:${escapeAttr(z.name)}">${escapeHtml(z.name)}</option>`)
      .join("")
  } catch (err) {
    console.error("clone: zone picker failed:", err instanceof Error ? err.message : err)
  }

  const body = `
    <div class="card">
      <p><a href="/app/sites/${escapeAttr(sourceId)}" style="color:#93c5fd">← ${escapeHtml(source.name)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Clone this site</h2>
      <p class="muted" style="font-size:13px">Spin up an independent sibling — its own repo, database, and domain — seeded from this one's niche, then re-themed and re-seeded by Claude so it's distinct (never a duplicate).</p>
    </div>
    ${error ? `<div class="banner" style="border-color:#7f1d1d;color:#fca5a5;background:#1c1212">${escapeHtml(error)}</div>` : ""}
    <div class="card">
      ${
        zoneOptions
          ? `<form method="POST" action="/app/sites/${escapeAttr(sourceId)}/clone">
              <label style="display:block;font-size:13px;margin-bottom:6px">Domain</label>
              <select name="zone" required class="wide" style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px;color:#fafafa;margin-bottom:12px">${zoneOptions}</select>
              <label style="display:block;font-size:13px;margin-bottom:6px">Name</label>
              <input name="name" required maxlength="80" value="${escapeAttr(deriveCloneName(source.name))}" style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px;color:#fafafa;margin-bottom:12px">
              <label style="display:block;font-size:13px;margin-bottom:6px">Niche</label>
              <input name="niche" required maxlength="200" value="${escapeAttr(source.niche ?? "")}" style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px;color:#fafafa;margin-bottom:12px">
              <label style="display:block;font-size:13px;margin-bottom:6px">How should this clone differ? <span class="muted">(audience, region, sub-topic, tone)</span></label>
              <input name="angle" required maxlength="200" placeholder="e.g. aimed at beginners in the UK, warmer tone" style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px;color:#fafafa;margin-bottom:12px">
              <button class="btn" type="submit">Create clone</button>
            </form>`
          : `<p class="muted">Add a domain on your Cloudflare account first (Connections → domains), then come back.</p>`
      }
    </div>`
  return c.html(renderSaasLayout({ title: "Clone site", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function cloneSubmitHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const sourceId = c.req.param("id") ?? ""
  const source = await loadSourceSite(master, sourceId, customer.id)
  if (!source) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (params: Record<string, string>) =>
    new Response(null, { status: 302, headers: { Location: `/app/sites/${sourceId}/clone?${new URLSearchParams(params)}` } })

  if (planGate(customer, nowSqlite()) === "read_only") return back({ error: "Your trial has ended — subscribe to clone sites." })

  let form: FormData
  try { form = await c.req.formData() } catch { return back({ error: "That form didn't come through — try again." }) }
  const [zoneId, domain] = String(form.get("zone") || "").split(":", 2)
  const input: CloneInput = {
    zoneId: zoneId ?? "",
    domain: (domain ?? "").toLowerCase(),
    name: String(form.get("name") || "").trim(),
    niche: String(form.get("niche") || "").trim(),
    angle: String(form.get("angle") || "").trim(),
  }
  if (!input.zoneId || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(input.domain)) return back({ error: "Pick a domain." })
  if (!input.name || !input.niche || !input.angle) return back({ error: "Fill in the name, niche, and how the clone should differ." })

  const dup = await master.execute({ sql: "SELECT id FROM customer_sites WHERE domain = ?", args: [input.domain] })
  if (dup.rows.length) return back({ error: "That domain already has a site." })

  const newSiteId = await cloneSite(master, c.env, customer, source, input, (p) => c.executionCtx.waitUntil(p))
  return new Response(null, { status: 302, headers: { Location: `/app/sites/${newSiteId}?notice=${encodeURIComponent("Clone is provisioning. When it's ready, click “Re-theme & re-seed” to make it distinct.")}` } })
}

/** Dispatch the clone-aware genesis (re-theme + re-seed) for a cloned site. */
export async function cloneGenesisHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const siteId = c.req.param("id") ?? ""
  const siteRow = await master.execute({
    sql: "SELECT * FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [siteId, customer.id],
  })
  if (!siteRow.rows.length) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const site = siteRow.rows[0] as unknown as CustomerSiteRow & { name: string; niche: string | null; kind: string | null }
  const redirect = (params: Record<string, string>) =>
    new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}?${new URLSearchParams(params)}` } })

  if (planGate(customer, nowSqlite()) === "read_only") return redirect({ error: "Your trial has ended — re-seed is paused until you subscribe." })

  const ctx = await loadCloneContext(master, customer.id, siteId)
  const input: CloneInput = { domain: "", zoneId: "", name: site.name, niche: site.niche ?? "", angle: ctx?.angle ?? "a fresh, distinct take" }
  const prompt = buildClonePrompt(ctx?.sourceNiche ?? site.niche ?? "", input, site.kind ?? "content")
  const result = await dispatchPrompt(master, c.env, site, prompt, "direct", "genesis")
  await audit(master, customer.id, "site.clone_reseed", site.name).catch(() => {})
  return result.ok
    ? redirect({ notice: "Re-theme & re-seed started — a distinct design and 10 fresh drafts. Usually done within 15 minutes." })
    : redirect({ error: result.problem ?? "Couldn't start the re-seed." })
}
