// src/modules/sites/preview.ts
// The visual preview window (K12): iframe the throwaway `<worker>-preview`
// worker beside the live site with before/after tabs + device widths, and
// Approve (merge the preview PR → covenant-gated deploy) / Discard (close PR +
// delete branch). The preview worker relaxes frame-ancestors for freecoinslink.de
// (claude.yml preview step); production stays unframeable (check-headers gate).

import type { Context } from "hono"
import type { AppEnv, CloudflareEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { audit, planGate, type Customer } from "../customers"
import {
  getConnection, getConnectionSecret, getWorkersSubdomain,
  installationToken, listClaudePreviewPrs, mergePullRequest, closePullRequest, type OpenPr,
} from "../connections"

const NO_STORE = { "Cache-Control": "no-store, private" }

/** Derive a site's preview-worker URL. Pure. */
export function previewWorkersUrl(subdomain: string, workerName: string): string {
  return `https://${workerName}-preview.${subdomain}.workers.dev`
}

function nowSqlite(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}

interface PreviewSite {
  id: string
  customer_id: string
  domain: string
  worker_name: string | null
  repo_full_name: string | null
}

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}

async function loadSite(master: Awaited<ReturnType<typeof masterDb>>, siteId: string, customerId: string): Promise<PreviewSite | null> {
  const r = await master.execute({
    sql: "SELECT id, customer_id, domain, worker_name, repo_full_name FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [siteId, customerId],
  })
  return r.rows.length ? (r.rows[0] as unknown as PreviewSite) : null
}

/** Resolve an installation token for the customer's GitHub App install. */
async function installToken(master: Awaited<ReturnType<typeof masterDb>>, env: CloudflareEnv, customerId: string): Promise<string | null> {
  const gh = await getConnection(master, customerId, "github")
  const installationId = Number((JSON.parse(gh?.meta || "{}") as { installationId?: number }).installationId ?? 0)
  if (!installationId) return null
  return installationToken(env, installationId).catch(() => null)
}

export async function previewPageHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const url = new URL(c.req.url)
  const done = url.searchParams.get("done")
  const error = url.searchParams.get("error")

  const header = `<div class="card">
    <p><a href="/app/sites/${escapeAttr(siteId)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
    <h2 style="margin:0 0 4px;font-size:16px">Preview &amp; approve</h2>
    <p class="muted" style="font-size:13px">Review a pending prompt-edit side-by-side with your live site, then approve to go live or discard it.</p>
  </div>`

  // Find the pending preview PR + derive the preview URL.
  let pr: OpenPr | null = null
  let previewUrl = ""
  const token = await installToken(master, c.env, customer.id).catch(() => null)
  if (token && site.repo_full_name) {
    const prs = await listClaudePreviewPrs(token, site.repo_full_name).catch(() => [])
    pr = prs[0] ?? null
  }
  if (site.worker_name) {
    const cfToken = await getConnectionSecret(master, c.env, customer.id, "cloudflare", "preview-url").catch(() => null)
    const cf = await getConnection(master, customer.id, "cloudflare")
    const accountId = String((JSON.parse(cf?.meta || "{}") as { accountId?: string }).accountId ?? "")
    if (cfToken && accountId) {
      const sub = await getWorkersSubdomain(cfToken, accountId).catch(() => null)
      if (sub) previewUrl = previewWorkersUrl(sub, site.worker_name)
    }
  }

  if (!pr) {
    return c.html(
      renderSaasLayout({ title: "Preview", active: "sites", customer, banner: done ? escapeHtml(done) : error ? escapeHtml(error) : undefined,
        bodyHtml: `${header}<div class="card"><p class="muted">No pending preview. Make a prompt-edit in <em>Preview first</em> mode and it'll appear here to review.</p></div>` }),
      200, NO_STORE
    )
  }

  const liveUrl = `https://${site.domain}/`
  const body = `
    ${header}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div><strong style="font-size:14px">${escapeHtml(pr.title)}</strong> <a href="${escapeAttr(pr.htmlUrl)}" target="_blank" class="muted" style="font-size:12px;color:#93c5fd">PR #${pr.number} ↗</a></div>
        <div style="display:flex;gap:8px">
          <form method="POST" action="/app/sites/${escapeAttr(siteId)}/preview/approve" style="margin:0"><input type="hidden" name="pr" value="${pr.number}"><button class="btn" type="submit">✓ Approve &amp; go live</button></form>
          <form method="POST" action="/app/sites/${escapeAttr(siteId)}/preview/discard" style="margin:0" onsubmit="return confirm('Discard this preview? The branch and PR are deleted.')"><input type="hidden" name="pr" value="${pr.number}"><input type="hidden" name="ref" value="${escapeAttr(pr.headRef)}"><button class="btn ghost" type="submit">Discard</button></form>
        </div>
      </div>
    </div>
    ${
      previewUrl
        ? `<div class="card">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <div class="seg" style="display:inline-flex;border:1px solid #404040;border-radius:8px;overflow:hidden">
          <button type="button" id="tab-after" onclick="pvTab('after')" style="background:#fafafa;color:#0a0a0a;border:none;padding:7px 14px;font-size:13px;cursor:pointer">After (preview)</button>
          <button type="button" id="tab-before" onclick="pvTab('before')" style="background:transparent;color:#fafafa;border:none;padding:7px 14px;font-size:13px;cursor:pointer">Before (live)</button>
        </div>
        <span style="flex:1"></span>
        <div class="seg" style="display:inline-flex;border:1px solid #404040;border-radius:8px;overflow:hidden">
          <button type="button" onclick="pvW('390px')" style="background:transparent;color:#fafafa;border:none;padding:7px 12px;font-size:13px;cursor:pointer">📱</button>
          <button type="button" onclick="pvW('820px')" style="background:transparent;color:#fafafa;border:none;padding:7px 12px;font-size:13px;cursor:pointer">📲</button>
          <button type="button" onclick="pvW('100%')" style="background:transparent;color:#fafafa;border:none;padding:7px 12px;font-size:13px;cursor:pointer">🖥️</button>
        </div>
      </div>
      <div id="pv-wrap" style="width:100%;margin:0 auto;transition:width .15s;border:1px solid #262626;border-radius:8px;overflow:hidden;background:#fff">
        <iframe id="pv-after" src="${escapeAttr(previewUrl)}" style="width:100%;height:600px;border:0;display:block"></iframe>
        <iframe id="pv-before" src="${escapeAttr(liveUrl)}" style="width:100%;height:600px;border:0;display:none"></iframe>
      </div>
      <p class="muted" style="font-size:12px;margin-top:8px">Preview: <a href="${escapeAttr(previewUrl)}" target="_blank" style="color:#93c5fd">${escapeHtml(previewUrl)}</a> (noindexed, throwaway)</p>
      <script>
        function pvTab(w){var a=document.getElementById('pv-after'),b=document.getElementById('pv-before');
          var ta=document.getElementById('tab-after'),tb=document.getElementById('tab-before');
          var after=w==='after';a.style.display=after?'block':'none';b.style.display=after?'none':'block';
          ta.style.background=after?'#fafafa':'transparent';ta.style.color=after?'#0a0a0a':'#fafafa';
          tb.style.background=after?'transparent':'#fafafa';tb.style.color=after?'#fafafa':'#0a0a0a';}
        function pvW(w){document.getElementById('pv-wrap').style.width=w;}
      </script>
    </div>`
        : `<div class="card"><p class="muted" style="font-size:13px">The preview is deploying (or Cloudflare isn't reachable to resolve its URL). Refresh in a moment — you can still Approve/Discard above using the PR.</p></div>`
    }`
  await audit(master, customer.id, "site.preview_viewed", site.domain).catch(() => {})
  return c.html(renderSaasLayout({ title: "Preview", active: "sites", customer, bodyHtml: body, banner: done ? escapeHtml(done) : error ? escapeHtml(error) : undefined }), 200, NO_STORE)
}

export async function previewApproveHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (p: Record<string, string>) => new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/preview?${new URLSearchParams(p)}` } })

  if (planGate(customer, nowSqlite()) === "read_only") return back({ error: "Your trial has ended — subscribe to publish changes." })
  const form = await c.req.formData().catch(() => null)
  const number = Number(form?.get("pr") ?? 0)
  if (!number || !site.repo_full_name) return back({ error: "That preview is no longer available." })

  const token = await installToken(master, c.env, customer.id)
  if (!token) return back({ error: "GitHub isn't connected — reconnect it in Connections." })
  const merged = await mergePullRequest(token, site.repo_full_name, number).catch(() => false)
  await audit(master, customer.id, "site.preview_approved", site.domain, { pr: number, merged }).catch(() => {})
  return back(merged ? { done: "Approved — merging to main; the covenant-gated deploy takes it live in a couple of minutes." } : { error: "Couldn't merge the preview (conflicts or checks pending). Open the PR to resolve." })
}

export async function previewDiscardHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (p: Record<string, string>) => new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/preview?${new URLSearchParams(p)}` } })

  const form = await c.req.formData().catch(() => null)
  const number = Number(form?.get("pr") ?? 0)
  const ref = String(form?.get("ref") ?? "")
  if (!number || !ref || !site.repo_full_name) return back({ error: "That preview is no longer available." })

  const token = await installToken(master, c.env, customer.id)
  if (!token) return back({ error: "GitHub isn't connected — reconnect it in Connections." })
  await closePullRequest(token, site.repo_full_name, number, ref).catch(() => {})
  await audit(master, customer.id, "site.preview_discarded", site.domain, { pr: number }).catch(() => {})
  return back({ done: "Preview discarded — the branch and PR were removed. Your live site is untouched." })
}
