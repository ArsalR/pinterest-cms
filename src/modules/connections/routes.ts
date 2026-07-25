// src/modules/connections/routes.ts
// The connections wizard — "this wizard decides conversion" (spec Phase 2).
// Steps: 1 GitHub App install → 2 Cloudflare token (exact template shown,
// validated live) → 3 domain/zone activation (nameserver instructions + live
// polling) → 4 optional (Anthropic key now; Pinterest/GSC slots pending
// platform-app verification). Every step validates before advancing; state is
// derived from the connections table, so the wizard is resumable by
// construction. All errors are plain-language.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared/masterMigrate"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { renderSaasLayout } from "../../shared/ui"
import { signJwt, verifyJwt } from "../../lib/auth"
import { audit, type Customer } from "../customers"
import { allowRate, AUTH_LIMITS, RATE_LIMIT_MESSAGE } from "../../shared/rateLimit"
import {
  saveConnection, listConnections, deleteConnection, getConnectionSecret,
  type ConnectionProvider, type ConnectionView,
} from "./connections"
import { githubAppConfigured, githubInstallUrl, getInstallation } from "./github"
import { CF_TOKEN_TEMPLATE, verifyCfToken, listCfZones, type CfZone } from "./cloudflare"
import { verifyAnthropicKey } from "./anthropic"
import { verifyStripeKey, createWebhookEndpoint } from "./stripe"
import { credentialPreview } from "../vault"

const NO_STORE = { "Cache-Control": "no-store, private" }

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}

function back(params?: Record<string, string>): Response {
  const qs = params ? "?" + new URLSearchParams(params).toString() : ""
  return new Response(null, { status: 302, headers: { Location: `/app/connections${qs}` } })
}

// ─────────────────────── wizard page ───────────────────────

export async function connectionsPageHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const url = new URL(c.req.url)
  const error = url.searchParams.get("error")
  const done = url.searchParams.get("done")

  const db = await masterDb(c)
  const conns = await listConnections(db, customer.id)
  const byProvider = new Map(conns.map((v) => [v.provider, v]))

  // Zones for step 3 (live, only when CF is connected).
  let zones: CfZone[] | null = null
  if (byProvider.get("cloudflare")?.status === "active") {
    try {
      const token = await getConnectionSecret(db, c.env, customer.id, "cloudflare", "wizard:list-zones")
      if (token) zones = await listCfZones(token)
    } catch (err) {
      console.error("wizard: zone list failed:", err instanceof Error ? err.message : err)
    }
  }

  const body = `
    ${wizardStyles()}
    ${error ? `<div class="banner" style="border-color:#7f1d1d;color:#fca5a5;background:#1c1212">${escapeHtml(error)}</div>` : ""}
    ${done ? `<div class="banner" style="border-color:#14532d;color:#86efac;background:#0f1a14">${escapeHtml(doneMessage(done))}</div>` : ""}
    ${stepGithub(c, byProvider.get("github"))}
    ${stepCloudflare(byProvider.get("cloudflare"))}
    ${stepDomains(byProvider.get("cloudflare"), zones)}
    ${stepOptional(
      byProvider,
      !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
      !!(c.env.PINTEREST_APP_ID && c.env.PINTEREST_APP_SECRET)
    )}
  `
  return c.html(
    renderSaasLayout({ title: "Connections", active: "connections", customer, bodyHtml: body }),
    200,
    NO_STORE
  )
}

function doneMessage(done: string): string {
  switch (done) {
    case "github": return "GitHub connected — your sites will live in your own account."
    case "cloudflare": return "Cloudflare connected — token verified and stored encrypted."
    case "anthropic": return "Anthropic key saved — prompt-powered building is ready to enable."
    case "stripe": return "Stripe connected — your store can take payments on your own account."
    case "disconnected": return "Disconnected."
    default: return "Saved."
  }
}

function wizardStyles(): string {
  return `<style>
    .step{background:#171717;border:1px solid #262626;border-radius:12px;padding:20px;margin-bottom:16px}
    .step h2{margin:0 0 4px;font-size:16px;display:flex;align-items:center;gap:10px}
    .step .why{color:#a3a3a3;font-size:13px;margin:0 0 14px}
    .chip{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;border-radius:999px;padding:2px 10px}
    .chip.done{background:rgba(34,197,94,.15);color:#86efac}
    .chip.todo{background:rgba(115,115,115,.2);color:#a3a3a3}
    .chip.soon{background:rgba(59,130,246,.15);color:#93c5fd}
    .chip.pending{background:rgba(245,158,11,.15);color:#fcd34d}
    table.tmpl{border-collapse:collapse;font-size:13px;margin:10px 0}
    table.tmpl td,table.tmpl th{border:1px solid #262626;padding:6px 12px;text-align:left}
    table.tmpl th{color:#a3a3a3;font-weight:600}
    input.wide{width:100%;max-width:520px;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px 12px;color:#fafafa;font-size:14px;font-family:inherit}
    input.wide:focus{outline:none;border-color:#fafafa}
    .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
    .zone{display:flex;justify-content:space-between;align-items:center;border:1px solid #262626;border-radius:8px;padding:10px 14px;margin-top:8px;font-size:14px}
    .ns{background:#0a0a0a;border-radius:8px;padding:12px;margin-top:8px;font-size:13px;color:#d4d4d4}
    .ns code{display:block;padding:2px 0;color:#93c5fd}
    .muted-sm{color:#737373;font-size:12px}
    form.inline{display:inline}
    button.linkish{background:none;border:none;color:#737373;font-size:12px;cursor:pointer;text-decoration:underline;font-family:inherit;padding:0}
  </style>`
}

function disconnectForm(provider: string): string {
  return `<form class="inline" method="POST" action="/app/connections/${provider}/delete"
            onsubmit="return confirm('Disconnect ${provider}? Existing sites keep working; you just can\\'t provision or manage until you reconnect.')">
            <button class="linkish" type="submit">Disconnect</button>
          </form>`
}

function stepGithub(c: Context<AppEnv>, conn: ConnectionView | undefined): string {
  const configured = githubAppConfigured(c.env)
  const connected = conn?.status === "active"
  const account = connected ? String(conn?.meta?.account ?? "") : ""
  return `<div class="step">
    <h2>1. GitHub <span class="chip ${connected ? "done" : "todo"}">${connected ? "Connected" : "Required"}</span></h2>
    <p class="why">Your sites live as repositories in <strong>your own</strong> GitHub account — you own every line, forever.</p>
    ${
      connected
        ? `<p style="font-size:14px">Installed on <strong>${escapeHtml(account)}</strong>. ${disconnectForm("github")}</p>`
        : configured
          ? `<a class="btn" href="/app/connections/github/start">Connect GitHub</a>
             <p class="muted-sm" style="margin-top:8px">You'll approve our GitHub App on your account — you can limit it to selected repositories later.</p>`
          : `<p style="font-size:14px;color:#fcd34d">Temporarily unavailable — the platform's GitHub App is still being set up. Check back shortly.</p>`
    }
  </div>`
}

function stepCloudflare(conn: ConnectionView | undefined): string {
  const connected = conn?.status === "active"
  const accountName = connected ? String(conn?.meta?.accountName ?? "") : ""
  const preview = connected ? String(conn?.meta?.preview ?? "") : ""
  const rows = CF_TOKEN_TEMPLATE.map(
    (r) => `<tr><td>${escapeHtml(r.scope)}</td><td>${escapeHtml(r.permission)}</td><td>${escapeHtml(r.access)}</td></tr>`
  ).join("")
  return `<div class="step">
    <h2>2. Cloudflare <span class="chip ${connected ? "done" : "todo"}">${connected ? "Connected" : "Required"}</span></h2>
    <p class="why">Your sites deploy to <strong>your own</strong> Cloudflare account — hosting stays free and stays yours.</p>
    ${
      connected
        ? `<p style="font-size:14px">Account <strong>${escapeHtml(accountName)}</strong> · token ${escapeHtml(preview)} (stored encrypted). ${disconnectForm("cloudflare")}</p>`
        : `<p style="font-size:13px;color:#d4d4d4">Create a token at
             <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" style="color:#93c5fd">dash.cloudflare.com/profile/api-tokens</a>
             → <em>Create Token → Create Custom Token</em>, with exactly these permissions
             (Account: your account · Zone Resources: All zones):</p>
           <table class="tmpl"><tr><th>Scope</th><th>Permission</th><th>Access</th></tr>${rows}</table>
           <form method="POST" action="/app/connections/cloudflare">
             <div class="row">
               <input class="wide" type="password" name="token" placeholder="Paste your Cloudflare API token" required autocomplete="off">
               <button class="btn" type="submit">Verify &amp; connect</button>
             </div>
           </form>
           <p class="muted-sm" style="margin-top:8px">We check the token live against Cloudflare before saving it, and store it encrypted with a key derived only for your account.</p>`
    }
  </div>`
}

function stepDomains(cf: ConnectionView | undefined, zones: CfZone[] | null): string {
  const cfConnected = cf?.status === "active"
  if (!cfConnected) {
    return `<div class="step">
      <h2>3. Your domains <span class="chip todo">After step 2</span></h2>
      <p class="why">Connect Cloudflare first — then we'll check your domains are ready for sites.</p>
    </div>`
  }
  if (zones === null) {
    return `<div class="step">
      <h2>3. Your domains <span class="chip pending">Check failed</span></h2>
      <p class="why">We couldn't list your domains just now — refresh this page to retry.</p>
    </div>`
  }
  const anyActive = zones.some((z) => z.status === "active" && !z.paused)
  const zoneRows = zones
    .map((z) => {
      const active = z.status === "active" && !z.paused
      const ns = !active && z.nameServers.length
        ? `<div class="ns">Point your domain's nameservers (at your registrar) to:
             ${z.nameServers.map((n) => `<code>${escapeHtml(n)}</code>`).join("")}
             <span class="muted-sm">Registrar changes can take a little while — this page checks automatically.</span></div>`
        : ""
      return `<div class="zone" data-zone="${escapeAttr(z.id)}">
        <span>${escapeHtml(z.name)}</span>
        <span class="chip ${active ? "done" : "pending"}" data-zone-status>${active ? "Active" : escapeHtml(z.status)}</span>
      </div>${ns}`
    })
    .join("")
  return `<div class="step">
    <h2>3. Your domains <span class="chip ${anyActive ? "done" : "pending"}">${anyActive ? "Ready" : "Waiting for DNS"}</span></h2>
    <p class="why">Each site needs a domain on your Cloudflare account. Add domains at
      <a href="https://dash.cloudflare.com" target="_blank" style="color:#93c5fd">dash.cloudflare.com</a> → Add a domain, then follow the nameserver step below.</p>
    ${zones.length ? zoneRows : `<p style="font-size:14px;color:#fcd34d">No domains on this Cloudflare account yet — add one, then come back (this page updates automatically).</p>`}
    <p class="muted-sm" id="zone-poll-note" style="margin-top:10px">${anyActive ? "" : "Checking automatically every 15 seconds…"}</p>
    ${anyActive ? "" : zonePollScript()}
  </div>`
}

function zonePollScript(): string {
  return `<script>
  (function () {
    var timer = setInterval(function () {
      fetch("/api/saas/v1/cloudflare/zones", { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (data) {
          if (!data || !data.zones) return
          var allDone = true
          data.zones.forEach(function (z) {
            var el = document.querySelector('[data-zone="' + z.id + '"] [data-zone-status]')
            var active = z.status === "active" && !z.paused
            if (el) {
              el.textContent = active ? "Active" : z.status
              el.className = "chip " + (active ? "done" : "pending")
            }
            if (!active) allDone = false
          })
          if (data.zones.length && allDone) { clearInterval(timer); location.reload() }
        })
        .catch(function () {})
    }, 15000)
  })()
  </script>`
}

function stepOptional(byProvider: Map<string, ConnectionView>, gscAvailable: boolean, pinterestAvailable: boolean): string {
  const anthropic = byProvider.get("anthropic")
  const aConnected = anthropic?.status === "active"
  const aPreview = aConnected ? String(anthropic?.meta?.preview ?? "") : ""
  return `<div class="step">
    <h2>4. Optional — connect any time <span class="chip todo">Skippable</span></h2>
    <p class="why">These unlock extra powers. Skip freely; the wizard remembers where you left off.</p>

    <h3 style="font-size:14px;margin:12px 0 4px">Anthropic API key ${aConnected ? `<span class="chip done">Connected</span>` : ""}</h3>
    ${
      aConnected
        ? `<p style="font-size:13px">Key ${escapeHtml(aPreview)} stored encrypted. Used inside <em>your</em> GitHub Actions to build and edit your sites, and for ✨ AI suggestions in the dashboard (your key, your bill — suggestions are never logged). ${disconnectForm("anthropic")}</p>`
        : `<p class="muted-sm">Powers "build my site by prompting Claude" — runs in your GitHub Actions with your key; we never spend it server-side.</p>
           <form method="POST" action="/app/connections/anthropic">
             <div class="row">
               <input class="wide" type="password" name="key" placeholder="sk-ant-…" autocomplete="off" required>
               <button class="btn ghost" type="submit">Verify &amp; save</button>
             </div>
           </form>`
    }

    <h3 style="font-size:14px;margin:18px 0 4px">Stripe ${stripeChip(byProvider)}</h3>
    ${stripeBlock(byProvider)}

    <h3 style="font-size:14px;margin:18px 0 4px">Pinterest ${pinterestChip(byProvider, pinterestAvailable)}</h3>
    ${pinterestBlock(byProvider, pinterestAvailable)}

    <h3 style="font-size:14px;margin:14px 0 4px">Google Search Console ${gscChip(byProvider, gscAvailable)}</h3>
    ${gscBlock(byProvider, gscAvailable)}
  </div>`
}

function stripeChip(byProvider: Map<string, ConnectionView>): string {
  return byProvider.get("stripe")?.status === "active" ? `<span class="chip done">Connected</span>` : ""
}

function pinterestChip(byProvider: Map<string, ConnectionView>, available: boolean): string {
  if (byProvider.get("pinterest")?.status === "active") return `<span class="chip done">Connected</span>`
  return available ? "" : `<span class="chip soon">Available soon</span>`
}

function pinterestBlock(byProvider: Map<string, ConnectionView>, available: boolean): string {
  if (byProvider.get("pinterest")?.status === "active") {
    return `<p style="font-size:13px">Connected — schedule pins from any site's <a href="/app/sites" style="color:#93c5fd">Pinterest</a> tab. ${disconnectForm("pinterest")}</p>`
  }
  if (available) {
    // OAuth start lives in the pinterest module; link only to avoid a cycle.
    return `<p class="muted-sm">Auto-pin your posts on a drip schedule to your own boards.</p>
      <a class="btn ghost" href="/app/connections/pinterest/start">Connect Pinterest</a>`
  }
  return `<p class="muted-sm">Auto-pin your posts on a drip schedule. Our Pinterest app is in review — this switches on automatically once approved.</p>`
}

function gscChip(byProvider: Map<string, ConnectionView>, available: boolean): string {
  if (byProvider.get("gsc")?.status === "active") return `<span class="chip done">Connected</span>`
  return available ? "" : `<span class="chip soon">Available soon</span>`
}

function gscBlock(byProvider: Map<string, ConnectionView>, available: boolean): string {
  if (byProvider.get("gsc")?.status === "active") {
    return `<p style="font-size:13px">Connected — search analytics, indexing, and decay alerts are live on the
      <a href="/app/network" style="color:#93c5fd">Network</a> page. ${disconnectForm("gsc")}</p>`
  }
  if (available) {
    // The OAuth start lives in the network module (gscStartHandler); we only
    // render the link here to avoid a connections → network import cycle.
    return `<p class="muted-sm">Indexing status, query data, and content-decay alerts per site.</p>
      <a class="btn ghost" href="/app/connections/gsc/start">Connect Search Console</a>`
  }
  return `<p class="muted-sm">Indexing status, query data, decay alerts per site. Our Google verification is in review — this switches on automatically once approved.</p>`
}

function stripeBlock(byProvider: Map<string, ConnectionView>): string {
  const stripe = byProvider.get("stripe")
  if (stripe?.status === "active") {
    const name = String(stripe.meta?.accountName ?? "")
    const mode = stripe.meta?.livemode ? "live" : "test"
    return `<p style="font-size:13px">Connected${name ? ` — <strong>${escapeHtml(name)}</strong>` : ""} (${mode} mode), key ${escapeHtml(String(stripe.meta?.preview ?? ""))} stored encrypted. ${disconnectForm("stripe")}</p>`
  }
  return `<p class="muted-sm">Needed only for <strong>online store</strong> sites — checkout runs on <em>your</em> Stripe account, your payouts. (This is separate from your SiteNetwork subscription.)</p>
    <form method="POST" action="/app/connections/stripe">
      <div class="row">
        <input class="wide" type="password" name="key" placeholder="sk_live_…" autocomplete="off" required>
        <button class="btn ghost" type="submit">Verify &amp; save</button>
      </div>
    </form>`
}

// ─────────────────────── GitHub install flow ───────────────────────

export async function githubStartHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  if (!githubAppConfigured(c.env) || !c.env.SAAS_JWT_SECRET) {
    return back({ error: "GitHub connection isn't available yet — the platform app is still being set up." })
  }
  // Signed state binds the upcoming installation to THIS signed-in customer
  // (blocks CSRF-linking someone else's installation to a victim account).
  const state = await signJwt({ sub: customer.id, aud: "gh-install" }, c.env.SAAS_JWT_SECRET, 15 * 60)
  return new Response(null, { status: 302, headers: { Location: githubInstallUrl(c.env, state) } })
}

export async function githubCallbackHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const url = new URL(c.req.url)
  const installationId = url.searchParams.get("installation_id") ?? ""
  const state = url.searchParams.get("state") ?? ""

  if (!c.env.SAAS_JWT_SECRET) return back({ error: "GitHub connection isn't available right now." })

  const payload = await verifyJwt(state, c.env.SAAS_JWT_SECRET).catch(() => null)
  if (!payload || payload.aud !== "gh-install" || payload.sub !== customer.id) {
    return back({ error: "That GitHub connection link expired or wasn't started from your account — click Connect GitHub and try again." })
  }

  const installation = await getInstallation(c.env, installationId)
  if (!installation) {
    return back({ error: "GitHub didn't confirm the installation — try Connect GitHub again." })
  }

  const db = await masterDb(c)
  await saveConnection(db, c.env, customer.id, "github", null, {
    installationId: installation.id,
    account: installation.accountLogin,
    accountType: installation.accountType,
    repositorySelection: installation.repositorySelection,
  })
  return back({ done: "github" })
}

// ─────────────────────── Cloudflare token ───────────────────────

export async function cloudflareConnectHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return back({ error: "That form didn't come through — please paste the token again." })
  }
  const token = String(form.get("token") || "").trim()

  const db = await masterDb(c)
  if (!(await allowRate(db, `connverify:customer:${customer.id}`, AUTH_LIMITS.connectionVerify))) {
    return back({ error: RATE_LIMIT_MESSAGE })
  }
  if (!c.env.VAULT_MASTER_KEY) {
    console.error("connections: VAULT_MASTER_KEY is not set")
    return back({ error: "Credential storage isn't available right now — please try again later." })
  }

  const check = await verifyCfToken(token)
  if (!check.valid) {
    await audit(db, customer.id, "connection.verify_failed", "cloudflare")
    return back({ error: check.problem ?? "Cloudflare rejected that token." })
  }

  await saveConnection(db, c.env, customer.id, "cloudflare", token, {
    accountId: check.accountId,
    accountName: check.accountName,
    zoneCount: check.zoneCount,
    preview: credentialPreview(token),
  })
  return back({ done: "cloudflare" })
}

// ─────────────────────── Anthropic key ───────────────────────

export async function anthropicConnectHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return back({ error: "That form didn't come through — please paste the key again." })
  }
  const key = String(form.get("key") || "").trim()

  const db = await masterDb(c)
  if (!(await allowRate(db, `connverify:customer:${customer.id}`, AUTH_LIMITS.connectionVerify))) {
    return back({ error: RATE_LIMIT_MESSAGE })
  }
  if (!c.env.VAULT_MASTER_KEY) {
    console.error("connections: VAULT_MASTER_KEY is not set")
    return back({ error: "Credential storage isn't available right now — please try again later." })
  }

  const check = await verifyAnthropicKey(key)
  if (!check.valid) {
    await audit(db, customer.id, "connection.verify_failed", "anthropic")
    return back({ error: check.problem ?? "That key didn't validate." })
  }

  await saveConnection(db, c.env, customer.id, "anthropic", key, {
    preview: credentialPreview(key),
  })
  return back({ done: "anthropic" })
}

// ─────────────────────── Stripe key (BYO — ecommerce) ───────────────────────

export async function stripeConnectHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return back({ error: "That form didn't come through — please paste the key again." })
  }
  const key = String(form.get("key") || "").trim()

  const db = await masterDb(c)
  if (!(await allowRate(db, `connverify:customer:${customer.id}`, AUTH_LIMITS.connectionVerify))) {
    return back({ error: RATE_LIMIT_MESSAGE })
  }
  if (!c.env.VAULT_MASTER_KEY) {
    console.error("connections: VAULT_MASTER_KEY is not set")
    return back({ error: "Credential storage isn't available right now — please try again later." })
  }

  const check = await verifyStripeKey(key)
  if (!check.valid) {
    await audit(db, customer.id, "connection.verify_failed", "stripe")
    return back({ error: check.problem ?? "That key didn't validate." })
  }

  // Register a webhook on the customer's Stripe account so paid orders get
  // recorded (checkout.session.completed → /api/saas/stripe-webhook/:customerId).
  // Store the key + webhook signing secret together as the encrypted payload.
  const hookUrl = `https://${c.env.SAAS_APP_HOSTNAME || "app.freecoinslink.de"}/api/saas/stripe-webhook/${customer.id}`
  const wh = await createWebhookEndpoint(key, hookUrl)
  if (!wh.endpoint) {
    await audit(db, customer.id, "connection.verify_failed", "stripe")
    return back({ error: wh.error ? `Stripe connected but the order webhook couldn't be set up (${wh.error}). Please retry.` : "Couldn't finish the Stripe setup — please retry." })
  }

  const payload = JSON.stringify({ secretKey: key, webhookSecret: wh.endpoint.secret, webhookId: wh.endpoint.id })
  await saveConnection(db, c.env, customer.id, "stripe", payload, {
    accountName: check.accountName,
    livemode: check.livemode,
    preview: credentialPreview(key),
  })
  return back({ done: "stripe" })
}

// ─────────────────────── disconnect ───────────────────────

const DISCONNECTABLE: ReadonlySet<string> = new Set(["github", "cloudflare", "anthropic", "pinterest", "gsc", "stripe"])

export async function disconnectHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const provider = c.req.param("provider") ?? ""
  if (!DISCONNECTABLE.has(provider)) {
    return back({ error: "Unknown connection." })
  }
  const db = await masterDb(c)
  await deleteConnection(db, customer.id, provider as ConnectionProvider)
  return back({ done: "disconnected" })
}
