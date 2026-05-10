// src/routes/admin/redirects.ts
// /admin/redirects — manage 301/302/410/404 rules for the public site.
// Stored in the redirects table; consulted by the slug router on every request.

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import { renderAdminLayout } from "../../views/admin/Layout"
import { escapeHtml, escapeAttr, formatDate, cuid } from "../../lib/utils"
import { purgeEverything } from "../../lib/revalidate"

export const redirectsAdminRoute = new Hono<AppEnv>()

const VALID_KINDS = new Set(["301", "302", "410", "404"])
const VALID_MATCH_TYPES = new Set(["exact", "prefix"])

// ──────────────── List + create form ────────────────
redirectsAdminRoute.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const user = c.get("user")
  const url = new URL(c.req.url)
  const editId = url.searchParams.get("edit")
  const saved = url.searchParams.get("saved")
  const errored = url.searchParams.get("error")

  const rules = await siteDb.execute(`
    SELECT id, from_path, target, kind, match_type, message, hit_count,
           last_hit_at, active, created_at
    FROM redirects ORDER BY active DESC, created_at DESC
  `)

  let editing: Record<string, unknown> | null = null
  if (editId) {
    const r = await siteDb.execute({
      sql: "SELECT * FROM redirects WHERE id = ? LIMIT 1",
      args: [editId],
    })
    if (r.rows.length) editing = r.rows[0] as unknown as Record<string, unknown>
  }

  const tableHtml = rules.rows.length
    ? `<table>
        <thead><tr><th>From</th><th>Kind</th><th>Target</th><th>Match</th><th>Hits</th><th>Last hit</th><th>Status</th><th></th></tr></thead>
        <tbody>${rules.rows.map((r) => {
          const kind = r.kind as string
          const isRedirect = kind === "301" || kind === "302"
          const isActive = (r.active as number) === 1
          return `<tr style="${isActive ? "" : "opacity:0.5"}">
            <td><code>${escapeHtml(r.from_path as string)}</code></td>
            <td><span class="pill ${kind === "301" ? "published" : kind === "410" ? "draft" : "api"}">${kind}</span></td>
            <td>${isRedirect ? `<code>${escapeHtml((r.target as string) || "—")}</code>` : "—"}</td>
            <td><span style="font-size:11px;color:var(--muted)">${escapeHtml(r.match_type as string)}</span></td>
            <td>${Number(r.hit_count ?? 0).toLocaleString()}</td>
            <td>${r.last_hit_at ? escapeHtml(formatDate(r.last_hit_at as string)) : "—"}</td>
            <td>${isActive ? `<span class="pill published">Active</span>` : `<span class="pill draft">Disabled</span>`}</td>
            <td class="row-actions">
              <a class="btn sm" href="/admin/redirects?edit=${escapeAttr(r.id as string)}">Edit</a>
              <form method="POST" action="/admin/redirects/${escapeAttr(r.id as string)}/toggle" style="display:inline">
                <button class="btn sm" type="submit">${isActive ? "Disable" : "Enable"}</button>
              </form>
              <form method="POST" action="/admin/redirects/${escapeAttr(r.id as string)}/delete" style="display:inline" onsubmit="return confirm('Delete this rule? Visitors hitting this URL will start getting normal 404s.')">
                <button class="btn sm danger" type="submit">Delete</button>
              </form>
            </td>
          </tr>`
        }).join("")}</tbody>
      </table>`
    : `<p class="empty-state">No rules yet — create one below to redirect or remove a URL.</p>`

  const formAction = editing ? `/admin/redirects/${escapeAttr(editing.id as string)}/update` : "/admin/redirects/create"
  const formKind = (editing?.kind as string) || "301"
  const isRedirectKind = formKind === "301" || formKind === "302"

  const formHtml = `<div class="card">
    <h2>${editing ? "Edit rule" : "New rule"}</h2>
    <form method="POST" action="${formAction}" id="redirect-form">
      <div class="form-grid">
        <div class="form-row">
          <label>Type *</label>
          <select name="kind" id="kind-select">
            <option value="301" ${formKind === "301" ? "selected" : ""}>301 — Permanent redirect</option>
            <option value="302" ${formKind === "302" ? "selected" : ""}>302 — Temporary redirect</option>
            <option value="410" ${formKind === "410" ? "selected" : ""}>410 — Gone (permanently removed)</option>
            <option value="404" ${formKind === "404" ? "selected" : ""}>404 — Not found (custom)</option>
          </select>
          <div class="hint">301 for renamed URLs, 410 for content you've deleted intentionally, 404 for noisy bot URLs.</div>
        </div>
        <div class="form-row">
          <label>Match type</label>
          <select name="match_type">
            <option value="exact" ${(editing?.match_type ?? "exact") === "exact" ? "selected" : ""}>Exact path</option>
            <option value="prefix" ${editing?.match_type === "prefix" ? "selected" : ""}>Prefix (/old/* → /new/*)</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <label>From path *</label>
        <input type="text" name="from_path" value="${escapeAttr((editing?.from_path as string) ?? "")}" placeholder="/old-post-url/" required>
        <div class="hint">Must start with <code>/</code>. Don't include the domain or query string.</div>
      </div>
      <div class="form-row" id="target-row" style="${isRedirectKind ? "" : "display:none"}">
        <label>Target URL *</label>
        <input type="text" name="target" value="${escapeAttr((editing?.target as string) ?? "")}" placeholder="/new-post-url/ or https://other-site.com/page">
        <div class="hint">Internal path (with leading <code>/</code>) or full external URL.</div>
      </div>
      <div class="form-row" id="message-row" style="${isRedirectKind ? "display:none" : ""}">
        <label>Custom message (optional)</label>
        <textarea name="message" placeholder="HTML allowed. Leave blank to use the built-in page.">${escapeHtml((editing?.message as string) ?? "")}</textarea>
        <div class="hint">Shown to visitors instead of the default 410/404 page.</div>
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn primary" type="submit">${editing ? "Save changes" : "Create rule"}</button>
        ${editing ? `<a class="btn" href="/admin/redirects">Cancel</a>` : ""}
      </div>
    </form>
    <script>
    (function(){
      var sel = document.getElementById('kind-select');
      sel.addEventListener('change', function(){
        var isRedirect = sel.value === '301' || sel.value === '302';
        document.getElementById('target-row').style.display = isRedirect ? '' : 'none';
        document.getElementById('message-row').style.display = isRedirect ? 'none' : '';
      });
    })();
    </script>
  </div>`

  const banner =
    saved === "1" ? `<div class="banner success">Rule saved. Caches purged.</div>` :
    errored ? `<div class="banner error">${escapeHtml(decodeURIComponent(errored))}</div>` : ""

  const intro = `<div class="card" style="background:var(--surface-2)">
    <h2>How redirects work</h2>
    <ul style="margin:0;padding-left:20px;color:var(--muted);font-size:13px;line-height:1.7">
      <li><strong>301 / 302</strong> — when a URL changes, send visitors and search engines to the new location. Use 301 unless the change is temporary.</li>
      <li><strong>410 Gone</strong> — when content is permanently deleted. This is the SEO-correct way to drop a page (Google removes it faster than 404).</li>
      <li><strong>404 (custom)</strong> — for URLs you want to explicitly mark as not-found with a custom message.</li>
      <li>Rules are checked <em>before</em> the slug router, so admin overrides always win.</li>
      <li>You can also set a <strong>custom 404 page</strong> in <a href="/admin/settings" style="color:var(--primary)">Settings</a> for the site-wide fallback.</li>
    </ul>
  </div>`

  return c.html(
    renderAdminLayout({
      title: `Redirects — ${hostname}`,
      hostname,
      user,
      active: "redirects",
      bodyHtml: banner + intro + formHtml + `<div class="card"><h2>Existing rules (${rules.rows.length})</h2>${tableHtml}</div>`,
      pageHeading: "Redirects & Gone pages",
    }),
    200,
    { "Cache-Control": "no-store, private" }
  )
})

// ──────────────── Create ────────────────
redirectsAdminRoute.post("/create", async (c) => {
  const siteDb = c.get("siteDb")
  const form = await c.req.formData()
  const fromPath = normalizePath(String(form.get("from_path") || ""))
  const kind = String(form.get("kind") || "301")
  const matchType = String(form.get("match_type") || "exact")
  const target = (String(form.get("target") || "").trim()) || null
  const message = (String(form.get("message") || "").trim()) || null

  const err = validate(fromPath, kind, matchType, target)
  if (err) {
    return c.redirect(`/admin/redirects?error=${encodeURIComponent(err)}`)
  }

  // Reject duplicates on from_path (unique index would throw, but a friendlier message helps).
  const dup = await siteDb.execute({
    sql: "SELECT id FROM redirects WHERE from_path = ? LIMIT 1",
    args: [fromPath],
  })
  if (dup.rows.length) {
    return c.redirect(
      `/admin/redirects?error=${encodeURIComponent("A rule for " + fromPath + " already exists. Edit the existing rule instead.")}`
    )
  }

  await siteDb.execute({
    sql: `INSERT INTO redirects (id, from_path, target, kind, match_type, message, active)
          VALUES (?, ?, ?, ?, ?, ?, 1)`,
    args: [cuid(), fromPath, target, kind, matchType, message],
  })

  c.executionCtx.waitUntil(purgeEverything(c.env, c.get("hostname")))
  return c.redirect("/admin/redirects?saved=1")
})

// ──────────────── Update ────────────────
redirectsAdminRoute.post("/:id/update", async (c) => {
  const siteDb = c.get("siteDb")
  const id = c.req.param("id")
  if (!id) return c.text("id required", 400)

  const form = await c.req.formData()
  const fromPath = normalizePath(String(form.get("from_path") || ""))
  const kind = String(form.get("kind") || "301")
  const matchType = String(form.get("match_type") || "exact")
  const target = (String(form.get("target") || "").trim()) || null
  const message = (String(form.get("message") || "").trim()) || null

  const err = validate(fromPath, kind, matchType, target)
  if (err) {
    return c.redirect(`/admin/redirects?edit=${id}&error=${encodeURIComponent(err)}`)
  }

  // Slug uniqueness (exclude self).
  const dup = await siteDb.execute({
    sql: "SELECT id FROM redirects WHERE from_path = ? AND id != ? LIMIT 1",
    args: [fromPath, id],
  })
  if (dup.rows.length) {
    return c.redirect(
      `/admin/redirects?edit=${id}&error=${encodeURIComponent("A different rule already uses that from-path.")}`
    )
  }

  await siteDb.execute({
    sql: `UPDATE redirects SET from_path=?, target=?, kind=?, match_type=?, message=? WHERE id=?`,
    args: [fromPath, target, kind, matchType, message, id],
  })

  c.executionCtx.waitUntil(purgeEverything(c.env, c.get("hostname")))
  return c.redirect("/admin/redirects?saved=1")
})

// ──────────────── Toggle active ────────────────
redirectsAdminRoute.post("/:id/toggle", async (c) => {
  const siteDb = c.get("siteDb")
  const id = c.req.param("id")
  if (!id) return c.text("id required", 400)
  await siteDb.execute({
    sql: "UPDATE redirects SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE id = ?",
    args: [id],
  })
  c.executionCtx.waitUntil(purgeEverything(c.env, c.get("hostname")))
  return c.redirect("/admin/redirects")
})

// ──────────────── Delete ────────────────
redirectsAdminRoute.post("/:id/delete", async (c) => {
  const siteDb = c.get("siteDb")
  const id = c.req.param("id")
  if (!id) return c.text("id required", 400)
  await siteDb.execute({ sql: "DELETE FROM redirects WHERE id = ?", args: [id] })
  c.executionCtx.waitUntil(purgeEverything(c.env, c.get("hostname")))
  return c.redirect("/admin/redirects")
})

// ──────────────── Helpers ────────────────
function validate(
  fromPath: string,
  kind: string,
  matchType: string,
  target: string | null
): string | null {
  if (!fromPath || !fromPath.startsWith("/")) {
    return "from_path is required and must start with /"
  }
  if (!VALID_KINDS.has(kind)) return "Invalid kind. Must be 301, 302, 410, or 404."
  if (!VALID_MATCH_TYPES.has(matchType)) return "Invalid match type."
  if ((kind === "301" || kind === "302") && !target) {
    return "target is required for redirects (301/302)."
  }
  if (target && !target.startsWith("/") && !/^https?:\/\//i.test(target)) {
    return "target must start with / (internal path) or http(s):// (external URL)."
  }
  // Self-redirect would loop forever.
  if (target && target.startsWith("/") && target.split("?")[0] === fromPath) {
    return "from_path and target are the same — that would create a redirect loop."
  }
  return null
}

function normalizePath(p: string): string {
  let s = p.trim()
  if (!s.startsWith("/")) s = "/" + s
  // Strip query/hash if user pasted them.
  s = s.split("?")[0].split("#")[0]
  return s
}
