// src/routes/admin/pages.ts
// /admin/pages — same as posts but for type='page'. Reuses the post handlers.

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import {
  renderPostsList,
  renderEditorPage,
  savePost,
  deletePost,
  bulkAction,
  togglePublish,
} from "./posts"
import { renderPostPage } from "../frontend/post"
import type { Post, Category } from "../../lib/types"
import { escapeAttr } from "../../lib/utils"

export const pagesAdminRoute = new Hono<AppEnv>()

pagesAdminRoute.get("/", (c) => renderPostsList(c, "page"))
pagesAdminRoute.get("/new", (c) => renderEditorPage(c, null, "page"))
pagesAdminRoute.get("/:id", (c) => renderEditorPage(c, c.req.param("id") ?? null, "page"))
pagesAdminRoute.post("/save", (c) => savePost(c, "page"))
pagesAdminRoute.post("/bulk-action", (c) => bulkAction(c, "page"))
pagesAdminRoute.post("/:id/toggle-publish", (c) => togglePublish(c))
pagesAdminRoute.post("/:id/delete", (c) => deletePost(c))

pagesAdminRoute.get("/:id/preview", async (c) => {
  const siteDb = c.get("siteDb")
  const id = c.req.param("id")
  const r = await siteDb.execute({
    sql: `SELECT p.*, c.id AS cat_id, c.name AS cat_name, c.slug AS cat_slug
          FROM posts p LEFT JOIN categories c ON c.id = p.category_id
          WHERE p.id = ? LIMIT 1`,
    args: [id],
  })
  if (!r.rows.length) return c.html("Page not found", 404)
  const row = r.rows[0]
  const post = {
    ...(row as unknown as Post),
    category: row.cat_id
      ? { id: row.cat_id as string, name: row.cat_name as string, slug: row.cat_slug as string } as Category
      : null,
  }
  const backHref = escapeAttr(`/admin/pages/${id}`)
  const banner = `<div style="position:fixed;top:0;left:0;right:0;z-index:9999;background:#e60023;color:#fff;text-align:center;padding:9px 16px;font-size:13px;font-weight:600;line-height:1.4">PREVIEW${post.published ? "" : " — not published"} · <a href="${backHref}" style="color:#fff;text-decoration:underline">← Back to editor</a></div><div style="height:40px"></div>`
  const response = await renderPostPage(c, post as Post & { category?: Category | null })
  const html = await response.text()
  const withBanner = html.replace(/(<body[^>]*>)/i, `$1${banner}`)
  return new Response(withBanner, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, private",
      "X-Robots-Tag": "noindex",
    },
  })
})
