// src/routes/admin/permalinks.ts
// /admin/permalinks — choose URL structure for posts and category base.
// Saving here invalidates ALL cached URLs since the entire URL space changes.

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import { renderAdminLayout } from "../../views/admin/Layout"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { loadSettings, setSetting } from "../../lib/defaults"
import { purgeEverything } from "../../lib/revalidate"

export const permalinksAdminRoute = new Hono<AppEnv>()

const PRESETS = [
  { id: "/%slug%/", label: "Post name", example: "/my-post-title/" },
  { id: "/%category%/%slug%/", label: "Category + post name", example: "/diy/my-post-title/" },
  { id: "/%year%/%month%/%slug%/", label: "Year, month, post name", example: "/2026/05/my-post-title/" },
  { id: "/%postname%/", label: "Postname (alias of /%slug%/)", example: "/my-post-title/" },
] as const

permalinksAdminRoute.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const user = c.get("user")
  const settings = await loadSettings(siteDb)
  const saved = new URL(c.req.url).searchParams.get("saved")
  const current = settings.permalink_structure || "/%slug%/"
  const isCustom = !PRESETS.some((p) => p.id === current)

  const radios = PRESETS.map(
    (p) => `<label class="radio">
      <input type="radio" name="permalink_choice" value="${escapeAttr(p.id)}" ${(!isCustom && current === p.id) ? "checked" : ""}>
      <div>
        <strong>${escapeHtml(p.label)}</strong>
        <div class="hint" style="font-family:var(--mono);font-size:12px;color:var(--muted-2)">https://${escapeHtml(hostname)}${escapeHtml(p.example)}</div>
      </div>
    </label>`
  ).join("")

  const body = `
    ${saved ? `<div class="banner success">Permalinks saved. All caches purged.</div>` : ""}
    <div class="banner warn">⚠ Changing permalinks rewrites every post URL on your site. Old URLs will 404 unless you set up redirects.</div>

    <form method="POST" action="/admin/permalinks/save" style="max-width:720px">
      <div class="card">
        <h2>Post URL structure</h2>
        <div class="radio-list">
          ${radios}
          <label class="radio">
            <input type="radio" name="permalink_choice" value="custom" ${isCustom ? "checked" : ""}>
            <div style="flex:1">
              <strong>Custom</strong>
              <input type="text" name="permalink_custom" value="${escapeAttr(isCustom ? current : "")}" placeholder="/%category%/%year%/%slug%/" style="margin-top:6px;font-family:var(--mono);font-size:13px">
              <div class="hint">Tokens: <code>%slug%</code>, <code>%postname%</code>, <code>%category%</code>, <code>%year%</code>, <code>%month%</code>, <code>%day%</code>. Always end with a trailing slash.</div>
            </div>
          </label>
        </div>
      </div>

      <div class="card">
        <h2>Category base</h2>
        <div class="form-row">
          <label>Category URL prefix</label>
          <input type="text" name="category_base" value="${escapeAttr(settings.category_base || "")}" placeholder="(leave blank for /<slug>/)">
          <div class="hint">e.g. <code>category</code> → <code>/category/diy/</code>. Blank means category pages live at <code>/&lt;slug&gt;/</code>.</div>
        </div>
      </div>

      <button class="btn primary" type="submit" style="padding:10px 24px">Save permalinks</button>
    </form>

    <style>
      .radio-list{display:flex;flex-direction:column;gap:6px}
      .radio{display:flex;align-items:flex-start;gap:12px;padding:12px;border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;background:var(--bg)}
      .radio:has(input:checked){border-color:var(--primary);background:rgba(230,0,35,0.05)}
      .radio input[type=radio]{margin-top:3px;flex-shrink:0;accent-color:var(--primary)}
      .radio strong{display:block;margin-bottom:2px}
    </style>
  `

  return c.html(
    renderAdminLayout({
      title: `Permalinks — ${hostname}`,
      hostname,
      user,
      active: "permalinks",
      bodyHtml: body,
      pageHeading: "Permalinks",
    }),
    200,
    { "Cache-Control": "no-store, private" }
  )
})

permalinksAdminRoute.post("/save", async (c) => {
  const siteDb = c.get("siteDb")
  const form = await c.req.formData()
  const choice = String(form.get("permalink_choice") || "/%slug%/")
  let structure = choice
  if (choice === "custom") {
    structure = String(form.get("permalink_custom") || "/%slug%/").trim()
    if (!structure.startsWith("/")) structure = "/" + structure
    if (!structure.endsWith("/")) structure = structure + "/"
  }
  const categoryBase = String(form.get("category_base") || "").trim().replace(/^\/+|\/+$/g, "")

  await setSetting(siteDb, "permalink_structure", structure)
  await setSetting(siteDb, "category_base", categoryBase)

  c.executionCtx.waitUntil(purgeEverything(c.env, c.get("hostname")))
  return c.redirect("/admin/permalinks?saved=1")
})
