// src/modules/sites/routes.ts
// /app/sites — site list, add-site wizard step (zone picker + canonical
// apex/www choice), and the per-site provisioning timeline with retry.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema, isSiteKind } from "../../shared/masterMigrate"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { renderSaasLayout } from "../../shared/ui"
import { planGate, type Customer } from "../customers"
import { getConnection, getConnectionSecret } from "../connections"
import { listCfZones } from "../connections"
import {
  createProvisioningPlan, runProvisioning, retryProvisioning, provisioningStatus, siteSlug,
  type CustomerSiteRow,
} from "../provisioning"
import { dispatchPrompt, promptRuns, genesisPrompt } from "./prompts"
import { installationToken, listCommits, rollbackToCommit } from "../connections"
import { audit } from "../customers"

const NO_STORE = { "Cache-Control": "no-store, private" }

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}

function nowSqlite(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}

function chip(status: string): string {
  const map: Record<string, string> = {
    active: "done", done: "done", provisioning: "pending", running: "pending",
    pending: "todo", failed: "err", skipped: "done", detached: "todo",
  }
  const cls = map[status] ?? "todo"
  return `<span class="chip ${cls}">${escapeHtml(status)}</span>`
}

const SITES_STYLES = `<style>
  .chip{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;border-radius:999px;padding:2px 10px}
  .chip.done{background:rgba(34,197,94,.15);color:#86efac}
  .chip.todo{background:rgba(115,115,115,.2);color:#a3a3a3}
  .chip.pending{background:rgba(245,158,11,.15);color:#fcd34d}
  .chip.err{background:rgba(239,68,68,.15);color:#fca5a5}
  .site-row{display:flex;justify-content:space-between;align-items:center;border:1px solid #262626;border-radius:10px;padding:12px 16px;margin-bottom:8px}
  .steps li{display:flex;gap:10px;align-items:baseline;padding:6px 0;border-bottom:1px solid #1f1f1f;list-style:none;font-size:14px}
  .steps{padding:0;margin:0}
  .steps .err-text{color:#fca5a5;font-size:13px;display:block;margin-top:2px}
  label{display:block;font-size:13px;font-weight:500;color:#d4d4d4;margin:12px 0 6px}
  input.wide,select.wide{width:100%;max-width:440px;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px 12px;color:#fafafa;font-size:14px;font-family:inherit}
</style>`

// ─────────────────────── list + add form ───────────────────────

export async function sitesPageHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const db = await masterDb(c)
  const url = new URL(c.req.url)
  const error = url.searchParams.get("error")

  const sites = await db.execute({
    sql: "SELECT * FROM customer_sites WHERE customer_id = ? ORDER BY created_at DESC",
    args: [customer.id],
  })

  const github = await getConnection(db, customer.id, "github")
  const cloudflare = await getConnection(db, customer.id, "cloudflare")
  const stripe = await getConnection(db, customer.id, "stripe")
  const ready = github?.status === "active" && cloudflare?.status === "active"
  const stripeConnected = stripe?.status === "active"

  let zoneOptions = ""
  if (ready) {
    try {
      const token = await getConnectionSecret(db, c.env, customer.id, "cloudflare", "sites:zone-picker")
      const zones = token ? await listCfZones(token) : null
      const active = (zones ?? []).filter((z) => z.status === "active" && !z.paused)
      zoneOptions = active
        .map((z) => `<option value="${escapeAttr(z.id)}:${escapeAttr(z.name)}">${escapeHtml(z.name)}</option>`)
        .join("")
    } catch (err) {
      console.error("sites: zone picker failed:", err instanceof Error ? err.message : err)
    }
  }

  const gate = planGate(customer, nowSqlite())

  const listHtml = sites.rows.length
    ? (sites.rows as unknown as CustomerSiteRow[])
        .map(
          (s) => `<div class="site-row">
            <span><a href="/app/sites/${escapeAttr(s.id)}" style="color:#fafafa">${escapeHtml(s.domain)}</a>
              <span class="muted" style="margin-left:8px">${escapeHtml(s.name)}</span></span>
            ${chip(s.status)}
          </div>`
        )
        .join("")
    : `<p class="muted">No sites yet.</p>`

  const addForm = !ready
    ? `<p class="muted">Connect GitHub and Cloudflare first — <a href="/app/connections" style="color:#93c5fd">Connections</a>.</p>`
    : gate === "read_only"
      ? `<p class="muted" style="color:#fcd34d">Your trial has ended — subscribe to add new sites. Existing sites stay live.</p>`
      : !zoneOptions
        ? `<p class="muted" style="color:#fcd34d">No active domains on your Cloudflare account yet — finish the domain step in <a href="/app/connections" style="color:#93c5fd">Connections</a>.</p>`
        : `<form method="POST" action="/app/sites">
             <label for="zone">Domain</label>
             <select id="zone" name="zone" class="wide" required>${zoneOptions}</select>
             <label for="kind">What kind of site?</label>
             <select id="kind" name="kind" class="wide" required>
               <option value="content">Blog / content site</option>
               <option value="ecommerce">Online store</option>
               <option value="local-business">Local business</option>
               <option value="portfolio">Portfolio / services</option>
             </select>
             ${stripeConnected ? "" : `<p class="muted" style="font-size:12px;margin:6px 0 0">Online stores need Stripe — connect it under <a href="/app/connections" style="color:#93c5fd">Connections</a> (you can do it after creating the site).</p>`}
             <label>Canonical address</label>
             <div style="font-size:14px;display:flex;gap:18px">
               <label style="margin:0;font-weight:400"><input type="radio" name="canonical" value="apex" checked> yourdomain.com <span class="muted">(www redirects here)</span></label>
               <label style="margin:0;font-weight:400"><input type="radio" name="canonical" value="www"> www.yourdomain.com</label>
             </div>
             <label for="name">Site name</label>
             <input class="wide" id="name" name="name" required maxlength="80" placeholder="BrewCraft">
             <label for="niche">Niche (one line — guides the design and trust pages)</label>
             <input class="wide" id="niche" name="niche" required maxlength="200" placeholder="Home espresso gear and technique">
             <button class="btn" type="submit" style="margin-top:16px">Create site</button>
             <p class="muted" style="margin-top:8px;font-size:12px">Creates a repository in your GitHub, deploys to your Cloudflare, connects your domain — typically live in under 10 minutes.</p>
           </form>`

  const body = `${SITES_STYLES}
    ${error ? `<div class="banner" style="border-color:#7f1d1d;color:#fca5a5;background:#1c1212">${escapeHtml(error)}</div>` : ""}
    <div class="card"><h2 style="margin:0 0 12px;font-size:16px">Your sites</h2>${listHtml}</div>
    <div class="card"><h2 style="margin:0 0 12px;font-size:16px">Add a site</h2>${addForm}</div>`

  return c.html(renderSaasLayout({ title: "Sites", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function createSitePostHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const fail = (msg: string) =>
    new Response(null, { status: 302, headers: { Location: `/app/sites?error=${encodeURIComponent(msg)}` } })

  const db = await masterDb(c)
  if (planGate(customer, nowSqlite()) === "read_only") {
    return fail("Your trial has ended — subscribe to add new sites.")
  }

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return fail("That form didn't come through — please try again.")
  }
  const zoneRaw = String(form.get("zone") || "")
  const [zoneId, domain] = zoneRaw.split(":", 2)
  const canonical = String(form.get("canonical") || "apex") === "www" ? "www" : "apex"
  const name = String(form.get("name") || "").trim()
  const niche = String(form.get("niche") || "").trim()
  const kindRaw = String(form.get("kind") || "content")
  const kind = isSiteKind(kindRaw) ? kindRaw : "content"

  if (!zoneId || !domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return fail("Pick a domain from the list.")
  if (!name) return fail("Give the site a name.")
  if (!niche) return fail("Describe the niche in one line — it drives the design and trust pages.")

  const dup = await db.execute({ sql: "SELECT id FROM customer_sites WHERE domain = ?", args: [domain.toLowerCase()] })
  if (dup.rows.length) return fail("That domain already has a site.")

  const siteId = await createProvisioningPlan(db, customer, {
    domain: domain.toLowerCase(),
    canonicalHost: canonical,
    name,
    niche,
    zoneId,
    kind,
  })
  c.executionCtx.waitUntil(
    runProvisioning(db, c.env, siteId).catch((err) => console.error("provisioning crashed:", err))
  )
  return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}` } })
}

// ─────────────────────── site detail (timeline + retry) ───────────────────────

export async function siteDetailHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const db = await masterDb(c)

  const r = await db.execute({
    sql: "SELECT * FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [siteId, customer.id],
  })
  if (!r.rows.length) {
    return new Response(null, { status: 302, headers: { Location: "/app/sites?error=" + encodeURIComponent("That site doesn't exist.") } })
  }
  const site = r.rows[0] as unknown as CustomerSiteRow
  const steps = await provisioningStatus(db, siteId)
  const failed = steps.some((s) => s.status === "failed")
  const inProgress = site.status === "provisioning" && !failed

  const stepsHtml = steps
    .map(
      (s) => `<li>${chip(s.status)} <span>${escapeHtml(s.label)}${
        s.error ? `<span class="err-text">${escapeHtml(s.error)}</span>` : ""
      }</span></li>`
    )
    .join("")

  const canonicalHost = site.canonical_host === "www" ? `www.${site.domain}` : site.domain
  const url = new URL(c.req.url)
  const error = url.searchParams.get("error")
  const notice = url.searchParams.get("notice")
  const gate = planGate(customer, nowSqlite())

  // ── Prompt-to-build + rollback (Phase 4) — active sites only ──
  let buildHtml = ""
  if (site.status === "active") {
    const runs = await promptRuns(db, c.env, site, 5).catch(() => [])
    const anyLive = runs.some((r) => ["queued", "running", "committed", "building"].includes(r.phase))
    const runsHtml = runs.length
      ? `<ul class="steps">${runs
          .map((r) => {
            const phaseChip =
              r.phase === "deployed" ? "done" : r.phase === "failed" ? "err" : r.phase === "unknown" ? "todo" : "pending"
            return `<li><span class="chip ${phaseChip}">${escapeHtml(r.phase)}</span>
              <span>${r.kind === "genesis" ? "🌱 Genesis" : escapeHtml(r.promptPreview)}
                <span class="muted" style="font-size:12px"> · ${escapeHtml(r.mode)}${r.minutes ? ` · this run used ${escapeHtml(r.minutes)}` : ""}
                ${r.diff ? ` · ${r.diff.filesChanged} files, +${r.diff.additions}/−${r.diff.deletions}` : ""}
                ${r.runUrl ? ` · <a href="${escapeAttr(r.runUrl)}" target="_blank" style="color:#93c5fd">run ↗</a>` : ""}</span>
              </span></li>`
          })
          .join("")}</ul>`
      : `<p class="muted">No Claude runs yet.</p>`

    const promptForm =
      gate === "read_only"
        ? `<p class="muted" style="color:#fcd34d">Your trial has ended — prompt-edits are paused until you subscribe. Your site stays live.</p>`
        : `<form method="POST" action="/app/sites/${escapeAttr(siteId)}/prompt">
            <textarea name="prompt" required maxlength="2000" rows="3" placeholder="e.g. Make the design warmer and add a category menu to the homepage"
              style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px 12px;color:#fafafa;font-size:14px;font-family:inherit"></textarea>
            <div style="display:flex;gap:16px;align-items:center;margin-top:10px;font-size:13px">
              <label style="margin:0;font-weight:400"><input type="radio" name="mode" value="preview" checked> Preview first (branch + PR — approve to go live)</label>
              <label style="margin:0;font-weight:400"><input type="radio" name="mode" value="direct"> Straight to live</label>
              <button class="btn" type="submit">Ask Claude</button>
            </div>
            <p class="muted" style="font-size:12px;margin-top:6px">Runs in <strong>your</strong> GitHub Actions with <strong>your</strong> Anthropic key. Hard limits: 15 min per run, one run at a time, 6 runs/hour.</p>
          </form>
          <form method="POST" action="/app/sites/${escapeAttr(siteId)}/genesis" style="margin-top:10px">
            <button class="btn ghost" type="submit">🌱 Generate the whole site (design + 10 seed articles)</button>
          </form>`

    // Rollback: recent commits.
    let commitsHtml = ""
    try {
      const github = await getConnection(db, customer.id, "github")
      const installationId = Number((JSON.parse(github?.meta || "{}") as { installationId?: number }).installationId ?? 0)
      if (installationId && site.repo_full_name) {
        const token = await installationToken(c.env, installationId)
        const commits = await listCommits(token, site.repo_full_name, 8)
        commitsHtml = commits
          .map(
            (cm, i) => `<li><code style="color:#93c5fd">${escapeHtml(cm.sha.slice(0, 7))}</code>
              <span>${escapeHtml(cm.message.slice(0, 90))}
              ${i === 0 ? `<span class="chip done">current</span>` : gate === "read_only" ? "" : `
                <form class="inline" method="POST" action="/app/sites/${escapeAttr(siteId)}/rollback" style="display:inline"
                  onsubmit="return confirm('Restore the site to this state? This adds a rollback commit and redeploys — nothing is lost.')">
                  <input type="hidden" name="sha" value="${escapeAttr(cm.sha)}">
                  <button class="linkish" type="submit" style="background:none;border:none;color:#fca5a5;font-size:12px;cursor:pointer;text-decoration:underline;font-family:inherit;padding:0">Roll back to here</button>
                </form>`}</span></li>`
          )
          .join("")
      }
    } catch (err) {
      console.error("site commits failed:", err instanceof Error ? err.message : err)
    }

    buildHtml = `
      <div class="card">
        <h2 style="margin:0 0 12px;font-size:16px">Build with Claude</h2>
        ${promptForm}
        <h3 style="font-size:14px;margin:18px 0 8px">Recent runs</h3>
        ${runsHtml}
        ${anyLive ? `<script>setTimeout(function(){location.reload()}, 10000)</script>` : ""}
      </div>
      ${commitsHtml ? `<div class="card">
        <h2 style="margin:0 0 12px;font-size:16px">History &amp; rollback</h2>
        <p class="muted" style="font-size:13px">Every version of your site lives in your repository forever. Rolling back adds a new commit — no history is ever destroyed.</p>
        <ul class="steps">${commitsHtml}</ul>
      </div>` : ""}`
  }

  const body = `${SITES_STYLES}
    ${error ? `<div class="banner" style="border-color:#7f1d1d;color:#fca5a5;background:#1c1212">${escapeHtml(error)}</div>` : ""}
    ${notice ? `<div class="banner" style="border-color:#14532d;color:#86efac;background:#0f1a14">${escapeHtml(notice)}</div>` : ""}
    <div class="card">
      <h2 style="margin:0 0 4px;font-size:16px">${escapeHtml(site.domain)} ${chip(site.status)}</h2>
      <p class="muted">${escapeHtml(site.name)}${site.niche ? " · " + escapeHtml(site.niche) : ""} · canonical: ${escapeHtml(canonicalHost)}</p>
      ${site.status === "active" ? `<a class="btn" href="https://${escapeAttr(canonicalHost)}/" target="_blank">Open site ↗</a>
        <a class="btn ghost" href="/app/sites/${escapeAttr(siteId)}/drafts">Drafts &amp; quality gate</a>
        <a class="btn ghost" href="/app/sites/${escapeAttr(siteId)}/insights">Internal linking</a>
        <a class="btn ghost" href="/app/sites/${escapeAttr(siteId)}/pseo">Programmatic SEO</a>
        <a class="btn ghost" href="/app/sites/${escapeAttr(siteId)}/performance">Performance</a>
        ${site.repo_full_name ? `<a class="btn ghost" href="https://github.com/${escapeAttr(site.repo_full_name)}" target="_blank">Repository ↗</a>` : ""}` : ""}
    </div>
    ${buildHtml}
    <div class="card">
      <h2 style="margin:0 0 12px;font-size:16px">Setup progress</h2>
      <ul class="steps">${stepsHtml}</ul>
      ${failed ? `<form method="POST" action="/app/sites/${escapeAttr(siteId)}/retry" style="margin-top:14px">
        <button class="btn" type="submit">Retry from the failed step</button>
      </form>` : ""}
      ${inProgress ? `<p class="muted" style="margin-top:12px" id="poll-note">Working… this page refreshes automatically.</p>
        <script>setTimeout(function(){location.reload()}, 8000)</script>` : ""}
    </div>`

  return c.html(renderSaasLayout({ title: site.domain, active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

// ─────────────────────── prompt / genesis / rollback actions ───────────────────────

async function loadOwnedSite(c: Context<AppEnv>, siteId: string): Promise<CustomerSiteRow | null> {
  const customer = c.get("customer") as Customer
  const db = await masterDb(c)
  const r = await db.execute({
    sql: "SELECT * FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [siteId, customer.id],
  })
  return r.rows.length ? (r.rows[0] as unknown as CustomerSiteRow) : null
}

function siteRedirect(siteId: string, params?: Record<string, string>): Response {
  const qs = params ? "?" + new URLSearchParams(params).toString() : ""
  return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}${qs}` } })
}

export async function sitePromptHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const site = await loadOwnedSite(c, siteId)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  if (planGate(customer, nowSqlite()) === "read_only") {
    return siteRedirect(siteId, { error: "Your trial has ended — prompt-edits are paused until you subscribe." })
  }
  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return siteRedirect(siteId, { error: "That form didn't come through — please try again." })
  }
  const prompt = String(form.get("prompt") || "").trim()
  const mode = String(form.get("mode") || "preview") === "direct" ? "direct" : "preview"
  if (!prompt) return siteRedirect(siteId, { error: "Describe what you'd like changed." })

  const db = await masterDb(c)
  const result = await dispatchPrompt(db, c.env, site, prompt, mode)
  return result.ok
    ? siteRedirect(siteId, { notice: "Claude is on it — status updates below." })
    : siteRedirect(siteId, { error: result.problem ?? "Couldn't start the run." })
}

export async function siteGenesisHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const site = await loadOwnedSite(c, siteId)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  if (planGate(customer, nowSqlite()) === "read_only") {
    return siteRedirect(siteId, { error: "Your trial has ended — prompt-edits are paused until you subscribe." })
  }
  const db = await masterDb(c)
  const result = await dispatchPrompt(db, c.env, site, genesisPrompt(site.name, site.niche ?? "", site.kind ?? "content"), "direct", "genesis")
  return result.ok
    ? siteRedirect(siteId, { notice: "Genesis started — design plus 10 seed articles. This usually finishes within 15 minutes." })
    : siteRedirect(siteId, { error: result.problem ?? "Couldn't start genesis." })
}

export async function siteRollbackHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const site = await loadOwnedSite(c, siteId)
  if (!site || !site.repo_full_name) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  if (planGate(customer, nowSqlite()) === "read_only") {
    return siteRedirect(siteId, { error: "Your trial has ended — changes are paused until you subscribe." })
  }
  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return siteRedirect(siteId, { error: "That form didn't come through — please try again." })
  }
  const sha = String(form.get("sha") || "")
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return siteRedirect(siteId, { error: "That doesn't look like a valid version." })

  const db = await masterDb(c)
  try {
    const github = await getConnection(db, customer.id, "github")
    const installationId = Number((JSON.parse(github?.meta || "{}") as { installationId?: number }).installationId ?? 0)
    if (!installationId) return siteRedirect(siteId, { error: "GitHub isn't connected — reconnect it in Connections." })
    const token = await installationToken(c.env, installationId)
    await rollbackToCommit(token, site.repo_full_name, sha)
    await audit(db, customer.id, "site.rollback", site.domain, { sha })
    return siteRedirect(siteId, { notice: "Rolling back — the restored version is building and will be live in a couple of minutes." })
  } catch (err) {
    console.error("rollback failed:", err instanceof Error ? err.message : err)
    return siteRedirect(siteId, { error: "Couldn't roll back just now — please try again." })
  }
}

export async function siteRetryHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const db = await masterDb(c)
  const r = await db.execute({
    sql: "SELECT id FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [siteId, customer.id],
  })
  if (r.rows.length && (await retryProvisioning(db, siteId))) {
    c.executionCtx.waitUntil(
      runProvisioning(db, c.env, siteId).catch((err) => console.error("provisioning retry crashed:", err))
    )
  }
  return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}` } })
}
