// src/modules/pinterest/routes.ts
// Pinterest UI (K7): OAuth connect flow + a per-site page to pick a board, set a
// drip cadence, queue pins from published posts, and watch the queue. Degrades
// gracefully — inert with an honest empty state until the platform's Pinterest
// app has standard access and the customer connects.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { signJwt, verifyJwt } from "../../lib/auth"
import { audit, type Customer } from "../customers"
import { saveConnection, getConnection } from "../connections"
import {
  pinterestConfigured, pinterestAuthUrl, pinterestRedirectUri, exchangePinterestCode, listBoards,
} from "./pins"
import { pinterestAccessToken, loadPinnablePosts, enqueuePins, listPins } from "./service"
import { DEFAULT_CADENCE, type PinCadence } from "./schedule"

const NO_STORE = { "Cache-Control": "no-store, private" }

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}

interface SiteRow { id: string; customer_id: string; cms_site_id: string | null; domain: string; name: string }

async function loadSite(c: Context<AppEnv>, master: Awaited<ReturnType<typeof masterDb>>, customerId: string): Promise<SiteRow | null> {
  const siteId = c.req.param("id") ?? ""
  const r = await master.execute({
    sql: "SELECT id, customer_id, cms_site_id, domain, name FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [siteId, customerId],
  })
  return r.rows.length ? (r.rows[0] as unknown as SiteRow) : null
}

// ─────────────────────── per-site Pinterest page ───────────────────────

export async function pinterestPageHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const url = new URL(c.req.url)
  const done = url.searchParams.get("done")
  const error = url.searchParams.get("error")

  const header = `
    <div class="card">
      <p><a href="/app/sites/${escapeAttr(site.id)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Pinterest</h2>
      <p class="muted" style="font-size:13px">Auto-pin your posts on a drip schedule to your own Pinterest boards — steady referral traffic, no bursts.</p>
    </div>`

  const conn = await getConnection(master, customer.id, "pinterest")
  const connected = conn?.status === "active"

  if (!connected) {
    const cta = pinterestConfigured(c.env)
      ? `<a class="btn" href="/app/connections/pinterest/start">Connect Pinterest</a>`
      : `<p class="muted">Pinterest connection switches on once our app clears Pinterest's review.</p>`
    return c.html(
      renderSaasLayout({
        title: "Pinterest", active: "sites", customer,
        bodyHtml: `${header}<div class="card"><p class="muted">Connect your Pinterest business account to start pinning.</p>${cta}</div>`,
      }),
      200, NO_STORE
    )
  }

  // Connected: boards, cadence form, queue.
  const token = await pinterestAccessToken(master, c.env, customer.id).catch(() => null)
  const boards = token ? await listBoards(token).catch(() => null) : null
  const boardOptions = (boards ?? []).map((b) => `<option value="${escapeAttr(b.id)}">${escapeHtml(b.name)}</option>`).join("")
  const pins = await listPins(master, customer.id, site.id, 50)

  const queued = pins.filter((p) => p.status === "scheduled").length
  const queueRows = pins.length
    ? pins
        .map((p) => {
          const color = p.status === "done" ? "#86efac" : p.status === "failed" ? "#fca5a5" : "#93c5fd"
          return `<tr>
            <td>${escapeHtml(p.title || p.postId)}</td>
            <td style="color:${color};text-transform:uppercase;font-size:12px;font-weight:600">${escapeHtml(p.status)}</td>
            <td class="muted" style="font-size:12px">${escapeHtml(p.scheduledAt.replace("T", " ").slice(0, 16))} UTC</td>
          </tr>`
        })
        .join("")
    : `<tr><td colspan="3" class="muted">No pins queued yet.</td></tr>`

  const body = `
    ${header}
    ${done === "queued" ? `<div class="banner" style="border-color:#14532d;color:#86efac;background:#0f1a14">Pins queued — they'll post on your drip schedule.</div>` : ""}
    ${done === "pinterest" ? `<div class="banner" style="border-color:#14532d;color:#86efac;background:#0f1a14">Pinterest connected.</div>` : ""}
    ${error ? `<div class="banner" style="border-color:#7f1d1d;color:#fca5a5;background:#1c1212">${escapeHtml(error)}</div>` : ""}
    <div class="card">
      <h3 style="margin:0 0 10px;font-size:15px">Queue pins from your latest posts</h3>
      ${
        boardOptions
          ? `<form method="POST" action="/app/sites/${escapeAttr(site.id)}/pinterest/queue">
              <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end">
                <label style="font-size:13px">Board<br><select name="board" required style="margin-top:4px;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:9px;color:#fafafa">${boardOptions}</select></label>
                <label style="font-size:13px">Pins/day<br><input name="perDay" type="number" min="1" max="25" value="${DEFAULT_CADENCE.perDay}" style="margin-top:4px;width:80px;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:9px;color:#fafafa"></label>
                <label style="font-size:13px">Min gap (mins)<br><input name="gap" type="number" min="15" max="1440" value="${DEFAULT_CADENCE.minSpacingMins}" style="margin-top:4px;width:100px;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:9px;color:#fafafa"></label>
                <label style="font-size:13px">How many<br><input name="count" type="number" min="1" max="50" value="10" style="margin-top:4px;width:80px;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:9px;color:#fafafa"></label>
                <button class="btn" type="submit">Queue pins</button>
              </div>
              <p class="muted" style="font-size:12px;margin-top:8px">Only published posts with a cover image are pinned. Already-queued pins are respected when spacing new ones.</p>
            </form>`
          : `<p class="muted" style="font-size:13px">No boards found on your Pinterest account yet — create a board on Pinterest, then reload this page.</p>`
      }
    </div>
    <div class="card">
      <h3 style="margin:0 0 10px;font-size:15px">Pin queue ${queued ? `<span class="muted" style="font-size:12px">(${queued} scheduled)</span>` : ""}</h3>
      <table style="width:100%;font-size:13px;border-collapse:collapse"><tr style="color:#a3a3a3"><th style="text-align:left">Post</th><th style="text-align:left">Status</th><th style="text-align:left">When</th></tr>${queueRows}</table>
    </div>`
  await audit(master, customer.id, "site.pinterest_viewed", site.domain).catch(() => {})
  return c.html(renderSaasLayout({ title: "Pinterest", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function pinterestQueueHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (params: Record<string, string>) =>
    new Response(null, { status: 302, headers: { Location: `/app/sites/${site.id}/pinterest?${new URLSearchParams(params)}` } })

  if (!site.cms_site_id) return back({ error: "This site has no content workspace yet." })
  let form: FormData
  try { form = await c.req.formData() } catch { return back({ error: "That form didn't come through — try again." }) }

  const boardId = String(form.get("board") || "").trim()
  if (!boardId) return back({ error: "Pick a board first." })
  const cadence: PinCadence = {
    perDay: clampInt(form.get("perDay"), 1, 25, DEFAULT_CADENCE.perDay),
    minSpacingMins: clampInt(form.get("gap"), 15, 1440, DEFAULT_CADENCE.minSpacingMins),
  }
  const count = clampInt(form.get("count"), 1, 50, 10)

  const posts = await loadPinnablePosts(master, site.cms_site_id).catch(() => [])
  if (!posts.length) return back({ error: "No published posts with a cover image to pin yet." })

  const queued = await enqueuePins(master, customer.id, site.id, site.domain, boardId, posts.slice(0, count), Date.now(), cadence)
  await audit(master, customer.id, "site.pins_queued", site.domain, { queued }).catch(() => {})
  return back(queued ? { done: "queued" } : { error: "Nothing to queue." })
}

function clampInt(v: FormDataEntryValue | null, min: number, max: number, fallback: number): number {
  const n = parseInt(String(v ?? ""), 10)
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// ─────────────────────── OAuth connect flow ───────────────────────

export async function pinterestStartHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const home = (params: Record<string, string>) =>
    new Response(null, { status: 302, headers: { Location: `/app/connections?${new URLSearchParams(params)}` } })
  if (!pinterestConfigured(c.env) || !c.env.SAAS_JWT_SECRET) {
    return home({ error: "Pinterest connection isn't available yet — our app is still in Pinterest's review." })
  }
  const state = await signJwt({ sub: customer.id, aud: "pinterest-oauth" }, c.env.SAAS_JWT_SECRET, 15 * 60)
  return new Response(null, {
    status: 302,
    headers: { Location: pinterestAuthUrl(c.env.PINTEREST_APP_ID!, pinterestRedirectUri(c.env), state) },
  })
}

export async function pinterestCallbackHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const url = new URL(c.req.url)
  const code = url.searchParams.get("code") ?? ""
  const state = url.searchParams.get("state") ?? ""
  const oauthError = url.searchParams.get("error")
  const home = (params: Record<string, string>) =>
    new Response(null, { status: 302, headers: { Location: `/app/connections?${new URLSearchParams(params)}` } })

  if (oauthError) return home({ error: "You declined the Pinterest connection — nothing was saved." })
  if (!c.env.SAAS_JWT_SECRET || !c.env.VAULT_MASTER_KEY) return home({ error: "Pinterest connection isn't available right now." })

  const payload = await verifyJwt(state, c.env.SAAS_JWT_SECRET).catch(() => null)
  if (!payload || payload.aud !== "pinterest-oauth" || payload.sub !== customer.id) {
    return home({ error: "That Pinterest link expired or wasn't started from your account — try again." })
  }
  if (!code) return home({ error: "Pinterest didn't return an authorization — try connecting again." })

  const tokens = await exchangePinterestCode(c.env, code)
  if (!tokens?.refreshToken) return home({ error: "Pinterest didn't grant lasting access — please try connecting again." })

  const master = await masterDb(c)
  await saveConnection(master, c.env, customer.id, "pinterest", tokens.refreshToken, { scope: "pins:write" })
  return home({ done: "pinterest" })
}
