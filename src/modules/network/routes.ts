// src/modules/network/routes.ts
// The network brain UI (Phase 7): a cross-site dashboard plus per-site Search
// Console, decay-radar, and AEO pages, and the GSC OAuth connect flow.
//
// Everything degrades gracefully: GSC is a platform-owned OAuth app still in
// verification (OAUTH_SETUP.md), so googleConfigured() is false until its
// secrets are set. When it's off, or a customer hasn't connected, the pages
// render honest empty states instead of erroring. All data fetches are
// best-effort (service.ts) — same discipline as the Phase 6 performance page.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { signJwt, verifyJwt } from "../../lib/auth"
import { audit, type Customer } from "../customers"
import { saveConnection } from "../connections"
import {
  googleConfigured, gscAuthUrl, gscRedirectUri, exchangeGscCode, siteUrlForDomain, submitSitemap,
} from "./gsc"
import {
  loadCustomerSite, loadCustomerSites, gscConnected, gscAccessToken,
  fetchSiteSearchData, readSitePosts, type SiteSearchData,
} from "./service"
import { evaluateAeo } from "./aeo"
import type { DecayReport, DecayStatus } from "./decay"

const NO_STORE = { "Cache-Control": "no-store, private" }

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}

function nowMs(): number {
  return Date.now()
}

function statusColor(s: DecayStatus): string {
  return s === "decayed" ? "#fca5a5" : s === "slipping" ? "#fcd34d" : s === "growing" ? "#86efac" : "#a3a3a3"
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

// ─────────────────────── cross-site dashboard ───────────────────────

export async function brainPageHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const sites = await loadCustomerSites(master, customer.id)
  const connected = await gscConnected(master, customer.id)
  const url = new URL(c.req.url)
  const done = url.searchParams.get("done")
  const error = url.searchParams.get("error")

  const gscBox = connected
    ? `<div class="card" style="border-color:#14532d"><p style="margin:0;color:#86efac">✓ Google Search Console connected — search &amp; decay data is live across your sites.</p></div>`
    : googleConfigured(c.env)
      ? `<div class="card">
          <h2 style="margin:0 0 4px;font-size:16px">Connect Google Search Console</h2>
          <p class="muted" style="font-size:13px">See clicks, impressions, indexing status, and content-decay alerts for every site in one place.</p>
          <a class="btn" href="/app/connections/gsc/start" style="margin-top:10px">Connect Search Console</a>
        </div>`
      : `<div class="card">
          <h2 style="margin:0 0 4px;font-size:16px">Search Console — available soon</h2>
          <p class="muted" style="font-size:13px">Cross-site search analytics and decay alerts switch on automatically once our Google verification clears.</p>
        </div>`

  const rows = sites.length
    ? sites
        .map(
          (s) => `<tr>
            <td><a href="/app/sites/${escapeAttr(s.id)}" style="color:#fafafa">${escapeHtml(s.name || s.domain)}</a><div class="muted" style="font-size:12px">${escapeHtml(s.domain)}</div></td>
            <td style="text-align:right">
              <a class="linklike" href="/app/sites/${escapeAttr(s.id)}/search">Search</a>
              <a class="linklike" href="/app/sites/${escapeAttr(s.id)}/decay">Decay</a>
              <a class="linklike" href="/app/sites/${escapeAttr(s.id)}/aeo">AEO</a>
            </td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="2" class="muted">No sites yet — <a href="/app/sites" style="color:#93c5fd">add your first site</a>.</td></tr>`

  const body = `
    <style>
      table.sites{width:100%;border-collapse:collapse;font-size:14px}
      table.sites td{border-top:1px solid #262626;padding:12px 4px;vertical-align:top}
      a.linklike{color:#93c5fd;text-decoration:none;margin-left:14px;font-size:13px}
      a.linklike:hover{text-decoration:underline}
    </style>
    ${error ? `<div class="banner" style="border-color:#7f1d1d;color:#fca5a5;background:#1c1212">${escapeHtml(error)}</div>` : ""}
    ${done === "gsc" ? `<div class="banner" style="border-color:#14532d;color:#86efac;background:#0f1a14">Google Search Console connected.</div>` : ""}
    <div class="card">
      <h2 style="margin:0 0 4px;font-size:16px">Network brain</h2>
      <p class="muted" style="font-size:13px">Search performance, indexing, content decay, and AI-visibility across every site you run.</p>
    </div>
    ${gscBox}
    <div class="card">
      <h2 style="margin:0 0 12px;font-size:16px">Your sites</h2>
      <table class="sites"><tbody>${rows}</tbody></table>
    </div>`
  return c.html(renderSaasLayout({ title: "Network", active: "network", customer, bodyHtml: body }), 200, NO_STORE)
}

// ─────────────────────── per-site Search Console ───────────────────────

export async function siteSearchPageHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadCustomerSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })

  const url = new URL(c.req.url)
  const notice = url.searchParams.get("done")

  let data: SiteSearchData | null = null
  let connected = false
  const token = await gscAccessToken(master, c.env, customer.id).catch(() => null)
  if (token) {
    connected = true
    data = await fetchSiteSearchData(token, site.domain, nowMs()).catch(() => null)
  }

  const header = `
    <div class="card">
      <p><a href="/app/sites/${escapeAttr(siteId)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Search Console</h2>
      <p class="muted" style="font-size:13px">Clicks, impressions, top queries, and indexing — from Google Search Console (last 4 weeks).</p>
    </div>`

  if (!connected) {
    const cta = googleConfigured(c.env)
      ? `<a class="btn" href="/app/connections/gsc/start">Connect Search Console</a>`
      : `<p class="muted">Search Console connection switches on once our Google verification clears.</p>`
    return c.html(
      renderSaasLayout({
        title: "Search Console", active: "sites", customer,
        bodyHtml: `${header}<div class="card"><p class="muted">Connect Google Search Console to see this site's search data.</p>${cta}</div>`,
      }),
      200, NO_STORE
    )
  }

  const totals = data?.totals ?? { clicks: 0, impressions: 0 }
  const queryRows = (data?.topQueries ?? [])
    .map(
      (q) => `<tr>
        <td>${escapeHtml(q.keys[0] ?? "")}</td>
        <td style="text-align:right">${q.clicks}</td>
        <td style="text-align:right">${q.impressions}</td>
        <td style="text-align:right">${pct(q.ctr)}</td>
        <td style="text-align:right">${q.position.toFixed(1)}</td>
      </tr>`
    )
    .join("")

  const sitemapRows = (data?.sitemaps ?? [])
    .map(
      (s) => `<tr>
        <td>${escapeHtml(s.path)}</td>
        <td style="text-align:right">${s.submitted}</td>
        <td style="text-align:right">${s.indexed}</td>
        <td style="text-align:right">${s.errors ? `<span style="color:#fca5a5">${s.errors}</span>` : "0"}</td>
      </tr>`
    )
    .join("")

  const decayCount = (data?.decay ?? []).filter((d) => d.status === "decayed" || d.status === "slipping").length

  const body = `
    ${header}
    ${notice === "sitemap" ? `<div class="banner" style="border-color:#14532d;color:#86efac;background:#0f1a14">Sitemap submitted to Google.</div>` : ""}
    <div class="card" style="display:flex;gap:32px">
      <div><div class="muted" style="font-size:12px">Clicks (4w)</div><div style="font-size:26px;font-weight:700">${totals.clicks}</div></div>
      <div><div class="muted" style="font-size:12px">Impressions (4w)</div><div style="font-size:26px;font-weight:700">${totals.impressions}</div></div>
      <div><div class="muted" style="font-size:12px">Pages decaying</div><div style="font-size:26px;font-weight:700">${decayCount ? `<a href="/app/sites/${escapeAttr(siteId)}/decay" style="color:#fcd34d">${decayCount}</a>` : "0"}</div></div>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h3 style="margin:0;font-size:15px">Sitemaps &amp; indexing</h3>
        <form method="POST" action="/app/sites/${escapeAttr(siteId)}/search/sitemap" style="margin:0">
          <button class="btn ghost" type="submit">Submit sitemap to Google</button>
        </form>
      </div>
      ${
        (data?.sitemaps ?? []).length
          ? `<table style="width:100%;font-size:13px;border-collapse:collapse"><tr style="color:#a3a3a3"><th style="text-align:left">Sitemap</th><th style="text-align:right">Submitted</th><th style="text-align:right">Indexed</th><th style="text-align:right">Errors</th></tr>${sitemapRows}</table>`
          : `<p class="muted" style="font-size:13px">No sitemaps submitted yet. Click "Submit sitemap" to register <code>https://${escapeHtml(site.domain)}/sitemap.xml</code> with Google.</p>`
      }
    </div>
    <div class="card">
      <h3 style="margin:0 0 10px;font-size:15px">Top queries</h3>
      ${
        queryRows
          ? `<table style="width:100%;font-size:13px;border-collapse:collapse"><tr style="color:#a3a3a3"><th style="text-align:left">Query</th><th style="text-align:right">Clicks</th><th style="text-align:right">Impr.</th><th style="text-align:right">CTR</th><th style="text-align:right">Pos.</th></tr>${queryRows}</table>`
          : `<p class="muted" style="font-size:13px">No query data yet — Search Console needs some traffic history first.</p>`
      }
    </div>`
  await audit(master, customer.id, "site.search_viewed", site.domain).catch(() => {})
  return c.html(renderSaasLayout({ title: "Search Console", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

/** Auto-submit the site's sitemap to Google (K3). */
export async function submitSitemapHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadCustomerSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })

  const back = (params: Record<string, string>) =>
    new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/search?${new URLSearchParams(params)}` } })

  const token = await gscAccessToken(master, c.env, customer.id).catch(() => null)
  if (!token) return back({ error: "Connect Google Search Console first." })

  const ok = await submitSitemap(token, siteUrlForDomain(site.domain), `https://${site.domain}/sitemap.xml`)
  await audit(master, customer.id, "site.sitemap_submitted", site.domain, { ok }).catch(() => {})
  return back(ok ? { done: "sitemap" } : { error: "Google couldn't accept the sitemap right now — try again shortly." })
}

// ─────────────────────── decay radar (K4) ───────────────────────

export async function siteDecayPageHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadCustomerSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })

  const header = `
    <div class="card">
      <p><a href="/app/sites/${escapeAttr(siteId)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Content decay radar</h2>
      <p class="muted" style="font-size:13px">Pages losing search clicks vs. the previous 4 weeks — refresh these before rankings slip further.</p>
    </div>`

  const token = await gscAccessToken(master, c.env, customer.id).catch(() => null)
  if (!token) {
    const cta = googleConfigured(c.env)
      ? `<a class="btn" href="/app/connections/gsc/start">Connect Search Console</a>`
      : `<p class="muted">This switches on once our Google verification clears.</p>`
    return c.html(
      renderSaasLayout({
        title: "Decay radar", active: "sites", customer,
        bodyHtml: `${header}<div class="card"><p class="muted">Connect Google Search Console to detect decaying pages.</p>${cta}</div>`,
      }),
      200, NO_STORE
    )
  }

  const data = await fetchSiteSearchData(token, site.domain, nowMs()).catch(() => null)
  const decaying = (data?.decay ?? []).filter((d) => d.status === "decayed" || d.status === "slipping")

  const rows = decaying.length
    ? decaying.map((d) => decayRow(siteId, site.domain, d)).join("")
    : `<div class="card"><p class="muted">No decaying pages detected. ${data ? "Everything's holding or growing 🎉" : "No data yet."}</p></div>`

  await audit(master, customer.id, "site.decay_viewed", site.domain).catch(() => {})
  return c.html(renderSaasLayout({ title: "Decay radar", active: "sites", customer, bodyHtml: header + rows }), 200, NO_STORE)
}

function pagePath(page: string, domain: string): string {
  try {
    return new URL(page).pathname
  } catch {
    return page.replace(`https://${domain}`, "") || page
  }
}

function decayRow(siteId: string, domain: string, d: DecayReport): string {
  const path = pagePath(d.page, domain)
  const prompt = `Refresh and expand the article at ${path}. Its search traffic has dropped ${pct(d.dropRatio)} — update it with current information, add depth and useful detail, improve the title and meta description, and update the date.`
  return `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:start;gap:16px">
      <div>
        <div style="font-weight:600;font-size:14px">${escapeHtml(path)}</div>
        <div class="muted" style="font-size:12px;margin-top:2px">
          <span style="color:${statusColor(d.status)};font-weight:600;text-transform:uppercase">${d.status}</span>
          · ${d.priorClicks} → ${d.recentClicks} clicks (−${pct(d.dropRatio)})${d.positionDelta > 0 ? ` · fell ${d.positionDelta.toFixed(1)} positions` : ""}
        </div>
      </div>
      <form method="POST" action="/app/sites/${escapeAttr(siteId)}/prompt" style="margin:0;flex-shrink:0">
        <input type="hidden" name="prompt" value="${escapeAttr(prompt)}">
        <input type="hidden" name="mode" value="preview">
        <button class="btn ghost" type="submit">Refresh with Claude</button>
      </form>
    </div>
  </div>`
}

// ─────────────────────── AEO checklist (K8) ───────────────────────

export async function siteAeoPageHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadCustomerSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })

  const header = `
    <div class="card">
      <p><a href="/app/sites/${escapeAttr(siteId)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">AI visibility (AEO)</h2>
      <p class="muted" style="font-size:13px">How easily AI assistants can find, understand, and cite each post. Your site also ships <code>llms.txt</code> and structured data automatically.</p>
    </div>`

  const posts = site.cms_site_id ? await readSitePosts(master, site.cms_site_id).catch(() => []) : []
  if (!posts.length) {
    return c.html(
      renderSaasLayout({
        title: "AI visibility", active: "sites", customer,
        bodyHtml: `${header}<div class="card"><p class="muted">No published posts yet. Publish content, then check its AI-visibility here.</p></div>`,
      }),
      200, NO_STORE
    )
  }

  const now = nowMs()
  const scored = posts.map((p) => ({ p, r: evaluateAeo(p.post, now) }))
  const avg = Math.round(scored.reduce((n, s) => n + s.r.score, 0) / scored.length)

  const cards = scored
    .sort((a, b) => a.r.score - b.r.score) // worst first — what to fix
    .map(({ p, r }) => {
      const failed = r.checks.filter((ck) => !ck.passed)
      const scoreColor = r.score >= 70 ? "#86efac" : r.score >= 40 ? "#fcd34d" : "#fca5a5"
      const fixList = failed.length
        ? `<ul style="margin:8px 0 0;padding-left:18px">${failed.map((ck) => `<li class="muted" style="font-size:13px"><strong style="color:#d4d4d4">${escapeHtml(ck.label)}</strong> — ${escapeHtml(ck.hint)}</li>`).join("")}</ul>`
        : `<p class="muted" style="font-size:13px;margin:8px 0 0">All checks pass — great AI-citation shape.</p>`
      return `<div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
          <div style="font-weight:600;font-size:14px">${escapeHtml(p.title || p.slug)}</div>
          <div style="font-weight:700;color:${scoreColor};font-size:15px">${r.score}<span class="muted" style="font-size:11px">/100</span></div>
        </div>
        ${fixList}
      </div>`
    })
    .join("")

  const body = `
    ${header}
    <div class="card" style="display:flex;align-items:center;gap:16px">
      <div><div class="muted" style="font-size:12px">Average AEO score</div><div style="font-size:26px;font-weight:700">${avg}<span class="muted" style="font-size:12px">/100</span></div></div>
      <div class="muted" style="font-size:13px">${scored.filter((s) => s.r.passed).length} of ${scored.length} posts are AI-citation ready (≥ 70).</div>
    </div>
    ${cards}`
  await audit(master, customer.id, "site.aeo_viewed", site.domain).catch(() => {})
  return c.html(renderSaasLayout({ title: "AI visibility", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

// ─────────────────────── GSC OAuth connect flow ───────────────────────

export async function gscStartHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const home = (params: Record<string, string>) =>
    new Response(null, { status: 302, headers: { Location: `/app/network?${new URLSearchParams(params)}` } })

  if (!googleConfigured(c.env) || !c.env.SAAS_JWT_SECRET) {
    return home({ error: "Search Console connection isn't available yet — our Google verification is still in review." })
  }
  // Signed state binds the callback to THIS customer (CSRF defense, mirrors the
  // GitHub install flow).
  const state = await signJwt({ sub: customer.id, aud: "gsc-oauth" }, c.env.SAAS_JWT_SECRET, 15 * 60)
  return new Response(null, {
    status: 302,
    headers: { Location: gscAuthUrl(c.env.GOOGLE_CLIENT_ID!, gscRedirectUri(c.env), state) },
  })
}

export async function gscCallbackHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const url = new URL(c.req.url)
  const code = url.searchParams.get("code") ?? ""
  const state = url.searchParams.get("state") ?? ""
  const oauthError = url.searchParams.get("error")
  const home = (params: Record<string, string>) =>
    new Response(null, { status: 302, headers: { Location: `/app/network?${new URLSearchParams(params)}` } })

  if (oauthError) return home({ error: "You declined the Google connection — nothing was saved." })
  if (!c.env.SAAS_JWT_SECRET || !c.env.VAULT_MASTER_KEY) return home({ error: "Search Console connection isn't available right now." })

  const payload = await verifyJwt(state, c.env.SAAS_JWT_SECRET).catch(() => null)
  if (!payload || payload.aud !== "gsc-oauth" || payload.sub !== customer.id) {
    return home({ error: "That Google connection link expired or wasn't started from your account — try again." })
  }
  if (!code) return home({ error: "Google didn't return an authorization — try connecting again." })

  const tokens = await exchangeGscCode(c.env, code)
  if (!tokens?.refreshToken) {
    // No refresh token → we can't act on the customer's behalf later. This
    // happens if Google skipped the consent prompt; the start flow forces
    // prompt=consent to avoid it, so treat it as a retryable error.
    return home({ error: "Google didn't grant lasting access — please try connecting again." })
  }

  const master = await masterDb(c)
  await saveConnection(master, c.env, customer.id, "gsc", tokens.refreshToken, { scope: "webmasters" })

  // Auto-submit every active site's sitemap to Google now that we can (K3).
  // Best-effort + off the response path — a failure never blocks connecting.
  c.executionCtx.waitUntil(autoSubmitSitemaps(master, customer.id, tokens.accessToken).catch(() => {}))
  return home({ done: "gsc" })
}

async function autoSubmitSitemaps(master: Awaited<ReturnType<typeof masterDb>>, customerId: string, accessToken: string): Promise<void> {
  const sites = await loadCustomerSites(master, customerId)
  for (const s of sites) {
    if (!s.domain) continue
    await submitSitemap(accessToken, siteUrlForDomain(s.domain), `https://${s.domain}/sitemap.xml`).catch(() => false)
  }
}
