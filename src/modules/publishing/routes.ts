// src/modules/publishing/routes.ts
// Dashboard UI for the quality gate (spec: "default ON, visible in UI").
//   GET  /app/sites/:id/drafts                     — drafts + per-draft gate report
//   POST /app/sites/:id/drafts/:postId/publish     — gate + publish (pass only)
// Server-rendered (no client JS), same conventions as the other dashboard pages.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { renderSaasLayout } from "../../shared"
import { planGate, type Customer } from "../customers"
import { evaluateDrafts, gateAndPublish, publishAllPassing, type CustomerSiteRef } from "./service"

const NO_STORE = { "Cache-Control": "no-store, private" }

function nowSqlite(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}

async function loadOwnedSite(c: Context<AppEnv>, siteId: string): Promise<CustomerSiteRef | null> {
  const customer = c.get("customer") as Customer
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  const r = await db.execute({
    sql: "SELECT id, customer_id, cms_site_id, repo_full_name, domain FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [siteId, customer.id],
  })
  return r.rows.length ? (r.rows[0] as unknown as CustomerSiteRef) : null
}

const STYLES = `<style>
  .chip{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;border-radius:999px;padding:2px 10px}
  .chip.pass{background:rgba(34,197,94,.15);color:#86efac}
  .chip.fail{background:rgba(239,68,68,.15);color:#fca5a5}
  .draft{border:1px solid #262626;border-radius:10px;padding:14px 16px;margin-bottom:12px}
  .checks{list-style:none;padding:0;margin:8px 0 0;font-size:13px}
  .checks li{padding:3px 0;color:#a3a3a3}
  .checks li .ok{color:#86efac} .checks li .no{color:#fca5a5}
</style>`

export async function draftsPageHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const site = await loadOwnedSite(c, siteId)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })

  const url = new URL(c.req.url)
  const notice = url.searchParams.get("notice")
  const error = url.searchParams.get("error")
  const readOnly = planGate(customer, nowSqlite()) === "read_only"

  let drafts: Awaited<ReturnType<typeof evaluateDrafts>> = []
  if (site.cms_site_id) {
    const db = getMasterDb(c.env)
    drafts = await evaluateDrafts(db, site.cms_site_id).catch(() => [])
  }

  const list = drafts.length
    ? drafts
        .map((d) => {
          const checksHtml = d.result.checks
            .map((ch) => `<li><span class="${ch.passed ? "ok" : "no"}">${ch.passed ? "✓" : "✗"}</span> ${escapeHtml(ch.label)} — <span class="muted">${escapeHtml(ch.detail)}</span></li>`)
            .join("")
          const canPublish = d.result.passed && !readOnly
          return `<div class="draft">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
              <strong>${escapeHtml(d.title)}</strong>
              <span class="chip ${d.result.passed ? "pass" : "fail"}">${d.result.passed ? "Passes gate" : "Blocked"}</span>
            </div>
            <ul class="checks">${checksHtml}</ul>
            ${
              canPublish
                ? `<form method="POST" action="/app/sites/${escapeAttr(siteId)}/drafts/${escapeAttr(d.id)}/publish" style="margin-top:10px">
                     <button class="btn" type="submit">Publish now</button>
                   </form>`
                : d.result.passed
                  ? `<p class="muted" style="margin-top:8px;color:#fcd34d">Subscribe to publish.</p>`
                  : `<p class="muted" style="margin-top:8px">Fix the ✗ items above, then this draft can go live. The gate protects your whole network's reputation.</p>`
            }
          </div>`
        })
        .join("")
    : `<p class="muted">No drafts waiting. New drafts appear here and must clear the quality gate before they can publish.</p>`

  const body = `${STYLES}
    ${error ? `<div class="banner" style="border-color:#7f1d1d;color:#fca5a5;background:#1c1212">${escapeHtml(error)}</div>` : ""}
    ${notice ? `<div class="banner" style="border-color:#14532d;color:#86efac;background:#0f1a14">${escapeHtml(notice)}</div>` : ""}
    <div class="card">
      <p><a href="/app/sites/${escapeAttr(siteId)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Drafts &amp; quality gate</h2>
      <p class="muted" style="font-size:13px">The gate is always on. It checks length, a unique title and meta description, and how distinct each page is from the rest of your site — so thin or duplicated content never publishes.</p>
      ${
        drafts.some((d) => d.result.passed) && !readOnly
          ? `<form method="POST" action="/app/sites/${escapeAttr(siteId)}/drafts/publish-all" style="margin-top:10px">
               <button class="btn" type="submit">Publish all ${drafts.filter((d) => d.result.passed).length} passing drafts</button>
             </form>`
          : ""
      }
    </div>
    <div class="card">${list}</div>`

  return c.html(renderSaasLayout({ title: "Drafts", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function publishDraftHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const postId = c.req.param("postId") ?? ""
  const site = await loadOwnedSite(c, siteId)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })

  const to = (params: Record<string, string>) =>
    new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/drafts?${new URLSearchParams(params)}` } })

  if (planGate(customer, nowSqlite()) === "read_only") {
    return to({ error: "Your trial has ended — subscribe to publish." })
  }
  const outcome = await gateAndPublish(c.env, site, postId).catch((err) => {
    console.error("publish failed:", err instanceof Error ? err.message : err)
    return { published: false, result: null, error: "Something went wrong — please try again." }
  })
  if (outcome.published) return to({ notice: "Published — your site is rebuilding and will be live shortly." })
  if (outcome.error) return to({ error: outcome.error })
  return to({ error: "This draft didn't clear the quality gate — see the report." })
}

export async function publishAllHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const site = await loadOwnedSite(c, siteId)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const to = (params: Record<string, string>) =>
    new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/drafts?${new URLSearchParams(params)}` } })
  if (planGate(customer, nowSqlite()) === "read_only") return to({ error: "Your trial has ended — subscribe to publish." })

  const r = await publishAllPassing(c.env, site).catch(() => ({ published: 0, blocked: 0 }))
  return to({
    notice: `Published ${r.published} draft${r.published === 1 ? "" : "s"}${r.blocked ? ` · ${r.blocked} still blocked by the gate` : ""}. Your site is rebuilding.`,
  })
}
