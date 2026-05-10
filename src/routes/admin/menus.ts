// src/routes/admin/menus.ts
// /admin/menus — manage header & footer navigation items.

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import { renderAdminLayout } from "../../views/admin/Layout"
import { escapeHtml, escapeAttr, cuid } from "../../lib/utils"
import { purgeEverything } from "../../lib/revalidate"

export const menusAdminRoute = new Hono<AppEnv>()

menusAdminRoute.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const user = c.get("user")
  const url = new URL(c.req.url)
  const location = url.searchParams.get("location") === "footer" ? "footer" : "header"

  const items = await siteDb.execute({
    sql: "SELECT * FROM menu_items WHERE location = ? ORDER BY ord ASC, created_at ASC",
    args: [location],
  })

  const itemsHtml = items.rows.length
    ? `<ul id="menu-list" class="menu-list">
        ${items.rows.map((r) => `
          <li class="menu-row" data-id="${escapeAttr(r.id as string)}" draggable="true">
            <span class="drag">⋮⋮</span>
            <div style="flex:1">
              <strong>${escapeHtml(r.label as string)}</strong>
              <div style="font-size:12px;color:var(--muted-2);font-family:var(--mono)">${r.url ? escapeHtml(r.url as string) : "Post: " + escapeHtml((r.post_id as string) ?? "")}</div>
            </div>
            <form method="POST" action="/admin/menus/${escapeAttr(r.id as string)}/delete" style="display:inline">
              <button class="btn sm danger" type="submit">×</button>
            </form>
          </li>`).join("")}
      </ul>`
    : `<p class="empty-state">No items yet. Add your first below.</p>`

  const otherLoc = location === "header" ? "footer" : "header"

  const body = `
    <style>
      .menu-list{list-style:none;display:flex;flex-direction:column;gap:6px;margin-bottom:20px}
      .menu-row{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;cursor:grab}
      .menu-row.dragging{opacity:0.4}
      .drag{color:var(--muted-2);font-size:18px;line-height:1;user-select:none}
    </style>
    <div style="display:flex;gap:8px;margin-bottom:16px">
      <a class="btn ${location === "header" ? "primary" : ""}" href="?location=header">Header</a>
      <a class="btn ${location === "footer" ? "primary" : ""}" href="?location=footer">Footer</a>
      <span style="margin-left:auto;color:var(--muted);align-self:center;font-size:13px">Manage <strong>${otherLoc}</strong> menu →</span>
    </div>

    <div style="display:grid;grid-template-columns:1fr 380px;gap:24px;align-items:flex-start">
      <div>
        <h2 style="font-size:14px;margin-bottom:12px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">${location} menu — drag to reorder</h2>
        ${itemsHtml}
      </div>

      <div class="card">
        <h2>Add item</h2>
        <form method="POST" action="/admin/menus/create">
          <input type="hidden" name="location" value="${escapeAttr(location)}">
          <div class="form-row"><label>Label</label><input type="text" name="label" required></div>
          <div class="form-row"><label>URL</label><input type="text" name="url" placeholder="/about/ or https://…"><div class="hint">Internal paths or external URLs.</div></div>
          <button class="btn primary" type="submit">Add to ${location}</button>
        </form>
      </div>
    </div>

    <script>
    (function(){
      var list = document.getElementById('menu-list');
      if (!list) return;
      var dragId = null;
      list.addEventListener('dragstart', function(e){
        var li = e.target.closest('.menu-row'); if (!li) return;
        dragId = li.dataset.id; li.classList.add('dragging');
      });
      list.addEventListener('dragover', function(e){
        e.preventDefault();
        var li = e.target.closest('.menu-row');
        if (!li || li.dataset.id === dragId) return;
        var rect = li.getBoundingClientRect();
        var after = (e.clientY - rect.top) > rect.height / 2;
        var src = list.querySelector('[data-id="' + dragId + '"]');
        if (!src) return;
        if (after) li.after(src); else li.before(src);
      });
      list.addEventListener('dragend', function(){
        list.querySelectorAll('.dragging').forEach(function(n){ n.classList.remove('dragging'); });
        var ids = Array.prototype.slice.call(list.querySelectorAll('.menu-row')).map(function(n){ return n.dataset.id; });
        fetch('/admin/menus/reorder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: ids })
        });
      });
    })();
    </script>
  `

  return c.html(
    renderAdminLayout({
      title: `Menus — ${hostname}`,
      hostname,
      user,
      active: "menus",
      bodyHtml: body,
      pageHeading: "Menus",
    }),
    200,
    { "Cache-Control": "no-store, private" }
  )
})

menusAdminRoute.post("/create", async (c) => {
  const siteDb = c.get("siteDb")
  const form = await c.req.formData()
  const label = String(form.get("label") || "").trim()
  const url = String(form.get("url") || "").trim()
  const location = String(form.get("location") || "header") === "footer" ? "footer" : "header"
  if (!label || !url) return c.html("Label and URL required", 400)

  // Order = current max + 1.
  const max = await siteDb.execute({
    sql: "SELECT COALESCE(MAX(ord), -1) AS m FROM menu_items WHERE location = ?",
    args: [location],
  })
  const ord = Number(max.rows[0]?.m ?? -1) + 1

  await siteDb.execute({
    sql: "INSERT INTO menu_items (id, label, url, ord, location) VALUES (?, ?, ?, ?, ?)",
    args: [cuid(), label, url, ord, location],
  })
  c.executionCtx.waitUntil(purgeEverything(c.env, c.get("hostname")))
  return c.redirect(`/admin/menus?location=${location}`)
})

menusAdminRoute.post("/:id/delete", async (c) => {
  const siteDb = c.get("siteDb")
  const id = c.req.param("id"); if (!id) return c.text("id required", 400)
  const r = await siteDb.execute({ sql: "SELECT location FROM menu_items WHERE id = ?", args: [id] })
  const location = (r.rows[0]?.location as string) || "header"
  await siteDb.execute({ sql: "DELETE FROM menu_items WHERE id = ?", args: [id] })
  c.executionCtx.waitUntil(purgeEverything(c.env, c.get("hostname")))
  return c.redirect(`/admin/menus?location=${location}`)
})

menusAdminRoute.post("/reorder", async (c) => {
  const siteDb = c.get("siteDb")
  let body: { ids?: string[] }
  try { body = await c.req.json() } catch { return c.json({ error: "bad json" }, 400) }
  if (!Array.isArray(body.ids)) return c.json({ error: "ids required" }, 400)

  for (let i = 0; i < body.ids.length; i++) {
    await siteDb.execute({
      sql: "UPDATE menu_items SET ord = ? WHERE id = ?",
      args: [i, body.ids[i]],
    })
  }
  c.executionCtx.waitUntil(purgeEverything(c.env, c.get("hostname")))
  return c.json({ success: true })
})
