// src/routes/admin/apiKeys.ts
// /admin/api-keys — manage API keys for the public REST API.
// Newly created keys are revealed once and only once; we store only the hash + last 4 chars.

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import { renderAdminLayout } from "../../views/admin/Layout"
import { escapeHtml, escapeAttr, formatDate, cuid } from "../../lib/utils"
import { generateApiKey, hashPassword } from "../../lib/auth"
import { parseCookies, buildSetCookie } from "../../lib/cookies"

export const apiKeysAdminRoute = new Hono<AppEnv>()

apiKeysAdminRoute.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const user = c.get("user")

  // Read the one-time flash cookie set by the create POST, then clear it immediately.
  const cookies = parseCookies(c.req.header("cookie"))
  let revealed: string | null = null
  let revealedName = ""
  try {
    if (cookies["cms_key_flash"]) {
      const flash = JSON.parse(cookies["cms_key_flash"])
      revealed = flash.raw ?? null
      revealedName = flash.name ?? ""
    }
  } catch { /* malformed cookie — ignore */ }

  const keys = await siteDb.execute(`
    SELECT k.*,
      (SELECT COUNT(*) FROM api_logs l WHERE l.api_key_id = k.id) AS log_count,
      (SELECT MAX(created_at) FROM api_logs l WHERE l.api_key_id = k.id) AS last_used
    FROM api_keys k
    ORDER BY k.created_at DESC
  `)

  const banner = revealed
    ? `<div class="banner warn" style="font-size:14px">
        <strong>Save this key now — you won't see it again.</strong>
        <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
          <code id="reveal-key" style="flex:1;background:var(--bg);padding:10px 12px;border-radius:6px;font-family:var(--mono);font-size:13px;word-break:break-all;border:1px solid var(--border-2)">${escapeHtml(revealed)}</code>
          <button class="btn sm primary" type="button" onclick="navigator.clipboard.writeText(document.getElementById('reveal-key').innerText);this.textContent='Copied ✓'">Copy</button>
        </div>
        <div style="margin-top:8px;color:var(--muted);font-size:12px">Key for "<strong>${escapeHtml(revealedName)}</strong>" — store it in your secrets manager. The CMS only keeps a hash.</div>
      </div>`
    : ""

  const tableHtml = keys.rows.length
    ? `<table>
        <thead><tr><th>Name</th><th>Preview</th><th>Permissions</th><th>Used</th><th>Last used</th><th>Created</th><th></th></tr></thead>
        <tbody>${keys.rows.map((k) => {
          const isActive = (k.active as number) === 1
          return `<tr style="${isActive ? "" : "opacity:0.5"}">
            <td><strong>${escapeHtml(k.name as string)}</strong></td>
            <td><code style="font-family:var(--mono);font-size:12px">cms_live_…${escapeHtml(k.key_preview as string)}</code></td>
            <td><span class="pill api">${escapeHtml(k.permissions as string)}</span></td>
            <td>${Number(k.log_count ?? 0).toLocaleString()}</td>
            <td>${k.last_used ? escapeHtml(formatDate(k.last_used as string)) : "—"}</td>
            <td>${escapeHtml(formatDate(k.created_at as string))}</td>
            <td class="row-actions">
              ${isActive
                ? `<form method="POST" action="/admin/api-keys/${escapeAttr(k.id as string)}/revoke" style="display:inline" onsubmit="return confirm('Revoke this key? Active integrations will stop working.')">
                    <button class="btn sm danger" type="submit">Revoke</button>
                  </form>`
                : `<span class="pill draft">Revoked</span>`}
            </td>
          </tr>`
        }).join("")}</tbody>
      </table>`
    : `<p class="empty-state">No API keys yet. Create one below to start using the REST API.</p>`

  const body = `
    ${banner}

    <div class="card">
      <h2>Create new key</h2>
      <form method="POST" action="/admin/api-keys/create" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div class="form-row" style="flex:1;min-width:200px;margin-bottom:0">
          <label>Name</label>
          <input type="text" name="name" required placeholder="e.g. GitHub Action - automation">
        </div>
        <div class="form-row" style="margin-bottom:0">
          <label>Permissions</label>
          <select name="permissions">
            <option value="read,write">Read + Write</option>
            <option value="read">Read only</option>
            <option value="write">Write only</option>
          </select>
        </div>
        <button class="btn primary" type="submit" style="padding:10px 20px">Generate key</button>
      </form>
    </div>

    <div class="card">
      <h2>Existing keys</h2>
      ${tableHtml}
    </div>

    <div class="card">
      <h2>Using the API</h2>
      <p style="color:var(--muted);margin-bottom:12px">Authenticate with a Bearer token:</p>
      <pre style="background:var(--bg);padding:14px;border-radius:var(--radius-sm);font-family:var(--mono);font-size:12px;overflow-x:auto;border:1px solid var(--border)">curl https://${escapeHtml(hostname)}/api/public/v1/posts \\
  -H "Authorization: Bearer cms_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Hello","content":"&lt;p&gt;World&lt;/p&gt;"}'</pre>
      <p style="color:var(--muted);margin-top:12px;font-size:13px">Endpoints: <code>/v1/status</code>, <code>/v1/upload</code>, <code>/v1/posts</code>, <code>/v1/categories</code></p>
    </div>
  `

  const response = c.html(
    renderAdminLayout({
      title: `API Keys — ${hostname}`,
      hostname,
      user,
      active: "api-keys",
      bodyHtml: body,
      pageHeading: "API keys",
    }),
    200,
    { "Cache-Control": "no-store, private" }
  )
  // Clear the flash cookie after reading it so it can never be replayed.
  if (revealed) {
    response.headers.append(
      "Set-Cookie",
      buildSetCookie("cms_key_flash", "", { maxAge: 0, path: "/admin/api-keys", sameSite: "Strict" })
    )
  }
  return response
})

apiKeysAdminRoute.post("/create", async (c) => {
  const siteDb = c.get("siteDb")
  const form = await c.req.formData()
  const name = String(form.get("name") || "").trim()
  const permissions = String(form.get("permissions") || "read,write")
  if (!name) return c.html("Name required", 400)

  const raw = generateApiKey()                       // cms_live_<32hex>
  const hash = await hashPassword(raw)
  const preview = raw.slice(-4)
  const id = cuid()

  await siteDb.execute({
    sql: `INSERT INTO api_keys (id, name, key_hash, key_preview, permissions, active)
          VALUES (?, ?, ?, ?, ?, 1)`,
    args: [id, name, hash, preview, permissions],
  })

  // One-time reveal via a short-lived HttpOnly flash cookie so the key never
  // appears in the URL, browser history, or server access logs.
  const flashCookie = buildSetCookie(
    "cms_key_flash",
    JSON.stringify({ raw, name }),
    { maxAge: 120, path: "/admin/api-keys", sameSite: "Strict" }
  )
  return new Response(null, {
    status: 302,
    headers: { "Location": "/admin/api-keys", "Set-Cookie": flashCookie },
  })
})

apiKeysAdminRoute.post("/:id/revoke", async (c) => {
  const siteDb = c.get("siteDb")
  const id = c.req.param("id"); if (!id) return c.text("id required", 400)
  await siteDb.execute({ sql: "UPDATE api_keys SET active = 0 WHERE id = ?", args: [id] })
  return c.redirect("/admin/api-keys")
})
