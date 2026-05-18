// src/routes/admin/categories.ts
// /admin/categories — CRUD for categories.

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import { renderAdminLayout } from "../../views/admin/Layout"
import { escapeHtml, escapeAttr, slugify, cuid } from "../../lib/utils"
import { purgeEverything } from "../../lib/revalidate"

export const categoriesAdminRoute = new Hono<AppEnv>()

categoriesAdminRoute.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const user = c.get("user")
  const url = new URL(c.req.url)
  const editId = url.searchParams.get("edit")
  const saved = url.searchParams.get("saved")

  const cats = await siteDb.execute(`
    SELECT c.*, COUNT(p.id) AS n
    FROM categories c
    LEFT JOIN posts p ON p.category_id = c.id
    GROUP BY c.id
    ORDER BY c.name ASC
  `)

  let editing: Record<string, unknown> | null = null
  if (editId) {
    const r = await siteDb.execute({ sql: "SELECT * FROM categories WHERE id = ? LIMIT 1", args: [editId] })
    if (r.rows.length) editing = r.rows[0] as unknown as Record<string, unknown>
  }

  const tableHtml = cats.rows.length
    ? `<table>
        <thead><tr><th>Name</th><th>Slug</th><th>Posts</th><th></th></tr></thead>
        <tbody>${cats.rows.map((r) =>
          `<tr>
            <td><strong>${escapeHtml(r.name as string)}</strong>${r.description ? `<br><span style="color:var(--muted-2);font-size:12px">${escapeHtml(r.description as string)}</span>` : ""}</td>
            <td><code>${escapeHtml(r.slug as string)}</code></td>
            <td>${Number(r.n ?? 0)}</td>
            <td class="row-actions">
              <a class="btn sm" href="/admin/categories?edit=${escapeAttr(r.id as string)}">Edit</a>
              <form method="POST" action="/admin/categories/${escapeAttr(r.id as string)}/delete" style="display:inline" onsubmit="return confirm('Delete category? Posts will be uncategorized.')">
                <button class="btn sm danger" type="submit">Delete</button>
              </form>
            </td>
          </tr>`
        ).join("")}</tbody>
      </table>`
    : `<p class="empty-state">No categories yet — create one below.</p>`

  const formAction = editing ? `/admin/categories/${escapeAttr(editing.id as string)}/update` : "/admin/categories/create"
  const formHtml = `<div class="card" style="max-width:520px">
    <h2>${editing ? "Edit category" : "New category"}</h2>
    <form method="POST" action="${formAction}">
      <div class="form-row"><label>Name</label><input type="text" name="name" value="${escapeAttr((editing?.name as string) ?? "")}" required></div>
      <div class="form-row"><label>Slug <span class="hint">(auto from name)</span></label><input type="text" name="slug" value="${escapeAttr((editing?.slug as string) ?? "")}"></div>
      <div class="form-row"><label>Description</label><textarea name="description">${escapeHtml((editing?.description as string) ?? "")}</textarea></div>
      <div class="form-row"><label>Cover image URL</label><input type="url" name="cover_image" value="${escapeAttr((editing?.cover_image as string) ?? "")}"></div>
      <div class="form-row"><label>SEO title</label><input type="text" name="seo_title" value="${escapeAttr((editing?.seo_title as string) ?? "")}"></div>
      <div class="form-row"><label>SEO description</label><textarea name="seo_desc">${escapeHtml((editing?.seo_desc as string) ?? "")}</textarea></div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn primary" type="submit">${editing ? "Save changes" : "Create category"}</button>
        ${editing ? `<a class="btn" href="/admin/categories">Cancel</a>` : ""}
      </div>
    </form>
  </div>`

  const banner = saved
    ? `<div class="banner success">Category saved.</div>`
    : ""

  return c.html(
    renderAdminLayout({
      title: `Categories — ${hostname}`,
      hostname,
      user,
      active: "categories",
      bodyHtml: `${banner}<div style="display:grid;grid-template-columns:1fr 540px;gap:24px;align-items:flex-start"><div>${tableHtml}</div>${formHtml}</div>
      <style>@media(max-width:1024px){.admin-main > .page-body > div[style*='grid-template']{grid-template-columns:1fr !important}}</style>`,
      pageHeading: "Categories",
    }),
    200,
    { "Cache-Control": "no-store, private" }
  )
})

// JSON endpoint for quick-create from post editor (returns { id, name, slug }).
categoriesAdminRoute.post("/create-quick", async (c) => {
  const siteDb = c.get("siteDb")
  let body: { name?: string } = {}
  try { body = await c.req.json() } catch { return c.json({ error: "Invalid JSON" }, 400) }
  const name = (body.name ?? "").trim()
  if (!name) return c.json({ error: "name required" }, 400)
  const slug = slugify(name)
  const dup = await siteDb.execute({ sql: "SELECT id FROM categories WHERE slug = ?", args: [slug] })
  if (dup.rows.length) return c.json({ error: `Slug "${slug}" already exists` }, 409)
  const id = cuid()
  await siteDb.execute({
    sql: "INSERT INTO categories (id, name, slug) VALUES (?, ?, ?)",
    args: [id, name, slug],
  })
  c.executionCtx.waitUntil(purgeEverything(c.env, c.get("hostname")))
  return c.json({ id, name, slug })
})

categoriesAdminRoute.post("/create", async (c) => {
  const siteDb = c.get("siteDb")
  const form = await c.req.formData()
  const name = String(form.get("name") || "").trim()
  if (!name) return c.html("Name required", 400)
  const slug = slugify(String(form.get("slug") || "") || name)

  // Check uniqueness.
  const dup = await siteDb.execute({ sql: "SELECT id FROM categories WHERE slug = ?", args: [slug] })
  if (dup.rows.length) {
    return c.html(`<p>Slug <code>${escapeHtml(slug)}</code> already exists. <a href="/admin/categories">← Back</a></p>`, 409)
  }

  await siteDb.execute({
    sql: `INSERT INTO categories (id, name, slug, description, cover_image, seo_title, seo_desc)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      cuid(),
      name,
      slug,
      String(form.get("description") || "") || null,
      String(form.get("cover_image") || "") || null,
      String(form.get("seo_title") || "") || null,
      String(form.get("seo_desc") || "") || null,
    ],
  })
  c.executionCtx.waitUntil(purgeEverything(c.env, c.get("hostname")))
  return c.redirect("/admin/categories?saved=1")
})

categoriesAdminRoute.post("/:id/update", async (c) => {
  const siteDb = c.get("siteDb")
  const id = c.req.param("id"); if (!id) return c.text("id required", 400)
  const form = await c.req.formData()
  const name = String(form.get("name") || "").trim()
  if (!name) return c.html("Name required", 400)
  const slug = slugify(String(form.get("slug") || "") || name)

  // Slug uniqueness (exclude self).
  const dup = await siteDb.execute({
    sql: "SELECT id FROM categories WHERE slug = ? AND id != ?",
    args: [slug, id],
  })
  if (dup.rows.length) {
    return c.html(`<p>Slug already used. <a href="/admin/categories?edit=${id}">← Back</a></p>`, 409)
  }

  await siteDb.execute({
    sql: `UPDATE categories SET name=?, slug=?, description=?, cover_image=?, seo_title=?, seo_desc=? WHERE id=?`,
    args: [
      name, slug,
      String(form.get("description") || "") || null,
      String(form.get("cover_image") || "") || null,
      String(form.get("seo_title") || "") || null,
      String(form.get("seo_desc") || "") || null,
      id,
    ],
  })
  c.executionCtx.waitUntil(purgeEverything(c.env, c.get("hostname")))
  return c.redirect("/admin/categories?saved=1")
})

categoriesAdminRoute.post("/:id/delete", async (c) => {
  const siteDb = c.get("siteDb")
  const id = c.req.param("id"); if (!id) return c.text("id required", 400)
  // Posts.category_id has ON DELETE SET NULL — no orphans.
  await siteDb.execute({ sql: "DELETE FROM categories WHERE id = ?", args: [id] })
  c.executionCtx.waitUntil(purgeEverything(c.env, c.get("hostname")))
  return c.redirect("/admin/categories")
})
