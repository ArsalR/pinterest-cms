// src/routes/network/sites.ts
// Network admin endpoints — runs on NETWORK_ADMIN_HOSTNAME, bypasses tenant resolution.
// All routes require x-network-admin-key header (or ?admin_key= for simple browser UI).

import { Hono } from "hono"
import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { createSite, deactivateSite, deleteSiteFromMaster } from "../../lib/provision"
import { escapeHtml, escapeAttr, formatDate } from "../../lib/utils"
import { invalidateSiteConfig } from "../../lib/turso"

export const networkRoutes = new Hono<AppEnv>()

// Auth check helper. Accepts either header or ?admin_key= query (for the HTML UI).
async function checkAuth(c: Context<AppEnv>): Promise<Response | null> {
  const expected = c.env.NETWORK_ADMIN_KEY
  if (!expected) return c.json({ error: "NETWORK_ADMIN_KEY not configured" }, 500)
  const provided =
    c.req.header("x-network-admin-key") ||
    new URL(c.req.url).searchParams.get("admin_key") ||
    ""
  if (provided !== expected) {
    // For browser GET, show a small password form; for API, return JSON 401.
    const isBrowser = c.req.header("accept")?.includes("text/html")
    if (isBrowser && c.req.method === "GET") {
      return c.html(authForm(), 401)
    }
    return c.json({ error: "Unauthorized" }, 401)
  }
  return null
}

// ──────────────── HTML UI: list all sites ────────────────
networkRoutes.get("/", async (c) => {
  const fail = await checkAuth(c)
  if (fail) return fail

  const master = getMasterDb(c.env)
  const sites = await master.execute("SELECT * FROM sites ORDER BY created_at DESC")
  const adminKey = c.env.NETWORK_ADMIN_KEY

  const body = `<!doctype html>
<html><head>
<meta charset="utf-8"><title>Network admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box}
  body{font-family:ui-sans-serif,system-ui,sans-serif;background:#0a0a0a;color:#fafafa;margin:0;padding:24px;font-size:14px;line-height:1.5}
  .wrap{max-width:1100px;margin:0 auto}
  h1{font-size:24px;margin:0 0 8px;letter-spacing:-0.02em}
  .sub{color:#a3a3a3;margin-bottom:24px}
  .card{background:#171717;border:1px solid #262626;border-radius:10px;padding:20px;margin-bottom:16px}
  .card h2{margin:0 0 12px;font-size:16px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:10px 12px;border-bottom:1px solid #262626;text-align:left}
  th{color:#a3a3a3;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;font-weight:600}
  input,select{background:#0a0a0a;border:1px solid #404040;border-radius:6px;padding:8px 10px;color:#fafafa;font-size:13px;font-family:inherit}
  input:focus{outline:none;border-color:#e60023}
  .btn{display:inline-block;padding:7px 12px;border-radius:6px;background:#262626;color:#fafafa;text-decoration:none;border:none;cursor:pointer;font-size:13px;font-weight:500;font-family:inherit}
  .btn:hover{background:#404040}
  .btn.primary{background:#e60023}
  .btn.primary:hover{background:#cb001f}
  .btn.danger{color:#ef4444;background:transparent;border:1px solid rgba(239,68,68,0.4)}
  .btn.danger:hover{background:rgba(239,68,68,0.12)}
  .pill{display:inline-flex;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;text-transform:uppercase}
  .pill.active{background:rgba(34,197,94,0.15);color:#86efac}
  .pill.inactive{background:#262626;color:#a3a3a3}
  code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;background:#0a0a0a;padding:2px 6px;border-radius:4px}
  form{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}
  .row{display:flex;flex-direction:column;gap:4px}
  label{font-size:12px;color:#a3a3a3}
</style>
</head><body>
<div class="wrap">
  <h1>Network admin</h1>
  <p class="sub">${sites.rows.length} site(s) in the network</p>

  <div class="card">
    <h2>Provision new site</h2>
    <form method="POST" action="/api/network/sites?admin_key=${encodeURIComponent(adminKey)}">
      <div class="row">
        <label>Hostname</label>
        <input type="text" name="hostname" placeholder="example.com" required style="width:240px">
      </div>
      <div class="row">
        <label>Site name</label>
        <input type="text" name="name" placeholder="Example Site" required style="width:200px">
      </div>
      <div class="row">
        <label>Admin email</label>
        <input type="email" name="admin_email" required style="width:220px">
      </div>
      <div class="row">
        <label>Admin password</label>
        <input type="password" name="admin_password" required minlength="8" style="width:180px">
      </div>
      <div class="row">
        <label>DNS</label>
        <select name="create_dns">
          <option value="0">Skip</option>
          <option value="1">Create CNAME via Cloudflare</option>
        </select>
      </div>
      <button type="submit" class="btn primary">Provision</button>
    </form>
    <p style="margin:12px 0 0;color:#737373;font-size:12px">A Turso database will be created in your group. The API key is shown only once on success.</p>
  </div>

  <div class="card">
    <h2>Sites</h2>
    ${sites.rows.length ? `<table>
      <thead><tr><th>Hostname</th><th>Name</th><th>Status</th><th>Created</th><th></th></tr></thead>
      <tbody>${sites.rows.map((s) => `
        <tr>
          <td><strong>${escapeHtml(s.hostname as string)}</strong> <a href="https://${escapeAttr(s.hostname as string)}/admin" target="_blank" style="color:#a3a3a3;font-size:12px;margin-left:6px">↗</a></td>
          <td>${escapeHtml(s.name as string)}</td>
          <td><span class="pill ${(s.active as number) === 1 ? "active" : "inactive"}">${(s.active as number) === 1 ? "Active" : "Inactive"}</span></td>
          <td>${escapeHtml(formatDate(s.created_at as string))}</td>
          <td style="text-align:right">
            ${(s.active as number) === 1
              ? `<form method="POST" action="/api/network/sites/${escapeAttr(s.id as string)}/deactivate?admin_key=${encodeURIComponent(adminKey)}" style="display:inline" onsubmit="return confirm('Deactivate ${escapeAttr(s.hostname as string)}?')"><button type="submit" class="btn danger">Deactivate</button></form>`
              : `<form method="POST" action="/api/network/sites/${escapeAttr(s.id as string)}/activate?admin_key=${encodeURIComponent(adminKey)}" style="display:inline"><button type="submit" class="btn">Reactivate</button></form>
                 <form method="POST" action="/api/network/sites/${escapeAttr(s.id as string)}/delete?admin_key=${encodeURIComponent(adminKey)}" style="display:inline" onsubmit="return confirm('Permanently remove ${escapeAttr(s.hostname as string)} from master DB? (Turso DB is NOT deleted.)')"><button type="submit" class="btn danger">Remove</button></form>`}
          </td>
        </tr>`).join("")}</tbody>
    </table>` : `<p style="color:#a3a3a3">No sites yet. Provision one above.</p>`}
  </div>

  <div class="card">
    <h2>API</h2>
    <pre style="background:#0a0a0a;padding:14px;border-radius:6px;font-family:ui-monospace,Menlo,monospace;font-size:12px;overflow-x:auto;color:#a3a3a3">curl -X POST https://${escapeHtml(c.req.header("host") || "")}/api/network/sites \\
  -H "x-network-admin-key: $NETWORK_ADMIN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"hostname":"example.com","name":"Example","admin_email":"you@you.com","admin_password":"…"}'</pre>
  </div>
</div></body></html>`

  return c.html(body, 200, { "Cache-Control": "no-store, private" })
})

// ──────────────── REST: GET /sites ────────────────
networkRoutes.get("/sites", async (c) => {
  const fail = await checkAuth(c); if (fail) return fail
  const master = getMasterDb(c.env)
  const sites = await master.execute("SELECT id, hostname, name, active, created_at FROM sites ORDER BY created_at DESC")
  return c.json({ success: true, sites: sites.rows })
})

// ──────────────── REST: POST /sites — provision ────────────────
networkRoutes.post("/sites", async (c) => {
  const fail = await checkAuth(c); if (fail) return fail

  // Accept JSON or form-encoded.
  const ct = c.req.header("content-type") || ""
  let payload: Record<string, unknown> = {}
  if (ct.includes("application/json")) {
    try { payload = await c.req.json() } catch { return c.json({ error: "Invalid JSON" }, 400) }
  } else {
    const form = await c.req.formData()
    for (const k of ["hostname","name","admin_email","admin_password","create_dns"]) {
      const v = form.get(k)
      if (v !== null) payload[k] = v
    }
  }

  const hostname = String(payload.hostname || "").trim().toLowerCase()
  const name = String(payload.name || "").trim()
  const adminEmail = String(payload.admin_email || "").trim().toLowerCase()
  const adminPassword = String(payload.admin_password || "")
  const createDns = String(payload.create_dns || "0") === "1"

  if (!hostname || !name || !adminEmail || !adminPassword) {
    return c.json({ error: "hostname, name, admin_email, admin_password required" }, 400)
  }
  if (adminPassword.length < 8) {
    return c.json({ error: "admin_password must be at least 8 characters" }, 400)
  }

  try {
    const result = await createSite(c.env, {
      hostname, name, adminEmail, adminPassword, configureDns: createDns,
    })

    // Browser GET → redirect to network admin with one-time key reveal.
    const isBrowser = c.req.header("accept")?.includes("text/html")
    if (isBrowser) {
      const params = new URLSearchParams({
        admin_key: c.env.NETWORK_ADMIN_KEY,
        provisioned: hostname,
        api_key: result.apiKey,
      })
      return c.redirect(`/?${params}`)
    }

    return c.json({
      success: true,
      site: { id: result.siteId, hostname, name },
      api_key: result.apiKey,                                  // ONE-TIME
      admin_url: `https://${hostname}/admin/login`,
      message: "Save the api_key — it is only shown now.",
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Provisioning failed" }, 500)
  }
})

// ──────────────── REST: deactivate / reactivate / delete ────────────────
networkRoutes.post("/sites/:id/deactivate", async (c) => {
  const fail = await checkAuth(c); if (fail) return fail
  const id = c.req.param("id"); if (!id) return c.json({error:"id required"},400)
  const master = getMasterDb(c.env)
  const r = await master.execute({ sql: "SELECT hostname FROM sites WHERE id = ?", args: [id] })
  if (!r.rows.length) return c.json({ error: "Site not found" }, 404)
  const hostname = r.rows[0].hostname as string
  await deactivateSite(c.env, id)
  await invalidateSiteConfig(hostname)
  if (c.req.header("accept")?.includes("text/html")) {
    return c.redirect(`/?admin_key=${encodeURIComponent(c.env.NETWORK_ADMIN_KEY)}`)
  }
  return c.json({ success: true })
})

networkRoutes.post("/sites/:id/activate", async (c) => {
  const fail = await checkAuth(c); if (fail) return fail
  const id = c.req.param("id"); if (!id) return c.json({error:"id required"},400)
  const master = getMasterDb(c.env)
  await master.execute({ sql: "UPDATE sites SET active = 1 WHERE id = ?", args: [id] })
  const r = await master.execute({ sql: "SELECT hostname FROM sites WHERE id = ?", args: [id] })
  if (r.rows.length) await invalidateSiteConfig(r.rows[0].hostname as string)
  if (c.req.header("accept")?.includes("text/html")) {
    return c.redirect(`/?admin_key=${encodeURIComponent(c.env.NETWORK_ADMIN_KEY)}`)
  }
  return c.json({ success: true })
})

networkRoutes.post("/sites/:id/delete", async (c) => {
  const fail = await checkAuth(c); if (fail) return fail
  const id = c.req.param("id"); if (!id) return c.json({error:"id required"},400)
  const master = getMasterDb(c.env)
  const r = await master.execute({ sql: "SELECT hostname FROM sites WHERE id = ?", args: [id] })
  if (!r.rows.length) return c.json({ error: "Site not found" }, 404)
  const hostname = r.rows[0].hostname as string
  await deleteSiteFromMaster(c.env, id)
  await invalidateSiteConfig(hostname)
  if (c.req.header("accept")?.includes("text/html")) {
    return c.redirect(`/?admin_key=${encodeURIComponent(c.env.NETWORK_ADMIN_KEY)}`)
  }
  return c.json({ success: true, note: "Removed from master DB. Turso DB itself was NOT deleted." })
})

function authForm(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Network admin</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;background:#0a0a0a;color:#fafafa;min-height:100vh;display:grid;place-items:center;margin:0;padding:24px}
.box{background:#171717;border:1px solid #262626;border-radius:10px;padding:32px;width:100%;max-width:380px}
h1{margin:0 0 6px;font-size:22px}
p{color:#a3a3a3;margin:0 0 20px;font-size:14px}
input{width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:6px;padding:10px;color:#fafafa;font-size:14px}
input:focus{outline:none;border-color:#e60023}
button{width:100%;margin-top:16px;background:#e60023;color:#fff;border:none;border-radius:6px;padding:10px;font-weight:600;cursor:pointer;font-size:14px}
</style></head>
<body><form class="box" method="GET">
  <h1>Network admin</h1>
  <p>Enter the admin key to continue.</p>
  <input type="password" name="admin_key" placeholder="x-network-admin-key" required autofocus>
  <button type="submit">Continue</button>
</form></body></html>`
}
