// src/routes/admin/posts.ts
// /admin/posts — list, create, edit, update, delete posts (and pages, see /admin/pages).

import { Hono } from "hono"
import type { Context } from "hono"
import type { AppEnv, Post, Category } from "../../lib/types"
import { renderAdminLayout } from "../../views/admin/Layout"
import { renderPostEditor } from "../../views/admin/PostEditor"
import { escapeHtml, escapeAttr, formatDate, slugify, cuid, nowIso, plainExcerpt } from "../../lib/utils"
import { loadSettings } from "../../lib/defaults"
import { buildPostPath } from "../../lib/seo"
import { purgePostCache } from "../../lib/revalidate"

export const postsAdminRoute = new Hono<AppEnv>()

// Type='post' — actual blog posts. /admin/pages handles type='page' the same way.
postsAdminRoute.get("/", async (c) => {
  return renderPostsList(c, "post")
})

postsAdminRoute.get("/new", async (c) => {
  return renderEditorPage(c, null, "post")
})

postsAdminRoute.get("/:id", async (c) => {
  const id = c.req.param("id") ?? null
  return renderEditorPage(c, id, "post")
})

// Save — accepts both new (no id) and existing.
postsAdminRoute.post("/save", async (c) => {
  return savePost(c, "post")
})

postsAdminRoute.post("/:id/delete", async (c) => {
  return deletePost(c)
})

// Quick toggle publish — used from list page.
postsAdminRoute.post("/:id/toggle-publish", async (c) => {
  const siteDb = c.get("siteDb")
  const id = c.req.param("id")
  if (!id) return c.json({ error: "id required" }, 400)
  const r = await siteDb.execute({
    sql: "SELECT published, published_at FROM posts WHERE id = ?",
    args: [id],
  })
  if (!r.rows.length) return c.json({ error: "Not found" }, 404)
  const cur = r.rows[0].published as number
  const next = cur ? 0 : 1
  await siteDb.execute({
    sql: `UPDATE posts SET published = ?,
            published_at = COALESCE(published_at, CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END),
            updated_at = datetime('now')
          WHERE id = ?`,
    args: [next, next, id],
  })
  c.executionCtx.waitUntil(
    purgePostCache(c.env, c.get("hostname"), ["/", "/sitemap.xml", "/feed.xml"])
  )
  return c.redirect("/admin/posts")
})

// ──────────────── Helpers exposed for /admin/pages ────────────────
export { renderPostsList, renderEditorPage, savePost, deletePost }

async function renderPostsList(
  c: Context<AppEnv>,
  type: "post" | "page"
): Promise<Response> {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const user = c.get("user")
  const settings = await loadSettings(siteDb)

  const url = new URL(c.req.url)
  const q = (url.searchParams.get("q") || "").trim()
  const status = url.searchParams.get("status") || ""
  const limit = 50

  const filters: string[] = ["p.type = ?"]
  const args: Array<string | number | null> = [type]
  if (q) {
    filters.push("(p.title LIKE ? OR p.slug LIKE ?)")
    args.push(`%${q}%`, `%${q}%`)
  }
  if (status === "published") filters.push("p.published = 1")
  if (status === "draft") filters.push("p.published = 0")
  args.push(limit)

  const rows = await siteDb.execute({
    sql: `SELECT p.id, p.title, p.slug, p.published, p.published_at, p.created_at,
                 p.source, c.slug AS cat_slug, c.name AS cat_name
          FROM posts p LEFT JOIN categories c ON c.id = p.category_id
          WHERE ${filters.join(" AND ")}
          ORDER BY p.created_at DESC
          LIMIT ?`,
    args,
  })

  const tableRows = rows.rows.map((r) => {
    const path =
      type === "page"
        ? `/${r.slug}/`
        : buildPostPath(
            {
              slug: r.slug as string,
              published_at: (r.published_at as string | null) ?? null,
              created_at: r.created_at as string,
            },
            r.cat_slug ? ({ slug: r.cat_slug as string } as never) : null,
            settings
          )
    return `<tr>
      <td><a href="/admin/${type === "page" ? "pages" : "posts"}/${escapeAttr(r.id as string)}"><strong>${escapeHtml(r.title as string)}</strong></a><br><span style="color:var(--muted-2);font-size:12px;font-family:var(--mono)">${escapeHtml(r.slug as string)}</span></td>
      <td>${r.cat_name ? escapeHtml(r.cat_name as string) : "—"}</td>
      <td><span class="pill ${r.published ? "published" : "draft"}">${r.published ? "Published" : "Draft"}</span></td>
      <td><span class="pill ${r.source === "api" ? "api" : "manual"}">${escapeHtml((r.source as string) ?? "manual")}</span></td>
      <td>${escapeHtml(formatDate(r.created_at as string))}</td>
      <td class="row-actions">
        ${r.published ? `<a class="btn sm ghost" href="${escapeAttr(path)}" target="_blank">View ↗</a>` : ""}
        <form method="POST" action="/admin/posts/${escapeAttr(r.id as string)}/toggle-publish" style="display:inline">
          <button class="btn sm" type="submit">${r.published ? "Unpublish" : "Publish"}</button>
        </form>
        <a class="btn sm primary" href="/admin/${type === "page" ? "pages" : "posts"}/${escapeAttr(r.id as string)}">Edit</a>
        <form method="POST" action="/admin/${type === "page" ? "pages" : "posts"}/${escapeAttr(r.id as string)}/delete" style="display:inline" onsubmit="return confirm('Delete &quot;${escapeAttr((r.title as string).replace(/"/g, ""))}&quot;? This cannot be undone.')">
          <button class="btn sm danger" type="submit">Delete</button>
        </form>
      </td>
    </tr>`
  }).join("")

  const heading = type === "page" ? "Pages" : "Posts"
  const newHref = type === "page" ? "/admin/pages/new" : "/admin/posts/new"

  const body = `
    <form method="GET" style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
      <input class="search" type="search" name="q" value="${escapeAttr(q)}" placeholder="Search by title or slug…" style="flex:1;min-width:200px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 12px;color:var(--text)">
      <select name="status" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 12px;color:var(--text)">
        <option value="">All</option>
        <option value="published" ${status === "published" ? "selected" : ""}>Published</option>
        <option value="draft" ${status === "draft" ? "selected" : ""}>Drafts</option>
      </select>
      <button class="btn" type="submit">Filter</button>
    </form>
    ${rows.rows.length ? `<table>
      <thead><tr><th>${heading.replace(/s$/, "")}</th><th>Category</th><th>Status</th><th>Source</th><th>Created</th><th></th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>` : `<div class="empty-state"><p>No ${heading.toLowerCase()} yet.</p><a class="btn primary" href="${newHref}">+ New ${type}</a></div>`}
  `

  return c.html(
    renderAdminLayout({
      title: `${heading} — ${hostname}`,
      hostname,
      user,
      active: type === "page" ? "pages" : "posts",
      bodyHtml: body,
      pageHeading: heading,
      pageActions: `<a class="btn primary" href="${newHref}">+ New ${type}</a>`,
    }),
    200,
    { "Cache-Control": "no-store, private" }
  )
}

async function renderEditorPage(
  c: Context<AppEnv>,
  id: string | null,
  type: "post" | "page"
): Promise<Response> {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const user = c.get("user")

  let post: Post | null = null
  let images: Array<{ url: string; alt: string; caption: string | null; ord: number }> = []
  if (id) {
    const r = await siteDb.execute({
      sql: "SELECT * FROM posts WHERE id = ? LIMIT 1",
      args: [id],
    })
    if (!r.rows.length) {
      return c.html(notFound(hostname, user), 404)
    }
    post = r.rows[0] as unknown as Post
    if (post.type !== type) {
      // Wrong list — redirect.
      return c.redirect(post.type === "page" ? `/admin/pages/${id}` : `/admin/posts/${id}`)
    }
    const ir = await siteDb.execute({
      sql: "SELECT url, alt, caption, ord FROM post_images WHERE post_id = ? ORDER BY ord ASC",
      args: [id],
    })
    images = ir.rows.map((x) => ({
      url: x.url as string,
      alt: (x.alt as string | null) ?? "",
      caption: (x.caption as string | null) ?? null,
      ord: Number(x.ord ?? 0),
    }))
  }

  const cats = await siteDb.execute("SELECT id, name, slug FROM categories ORDER BY name ASC")
  const categories: Pick<Category, "id" | "name" | "slug">[] = cats.rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    slug: r.slug as string,
  }))

  const editor = renderPostEditor({ post, images, categories, type })

  const body = editor.html
  return c.html(
    renderAdminLayout({
      title: `${post ? "Edit" : "New"} ${type} — ${hostname}`,
      hostname,
      user,
      active: type === "page" ? "pages" : "posts",
      bodyHtml: body,
      extraHead: editor.headHtml,
      inlineScript: editor.scriptHtml,
      pageHeading: post ? `Edit ${type}` : `New ${type}`,
      pageActions: post
        ? `<a class="btn ghost" href="/admin/${type === "page" ? "pages" : "posts"}">← Back</a>`
        : `<a class="btn ghost" href="/admin/${type === "page" ? "pages" : "posts"}">← Back</a>`,
      fullWidth: true,
    }),
    200,
    { "Cache-Control": "no-store, private" }
  )
}

async function savePost(
  c: Context<AppEnv>,
  type: "post" | "page"
): Promise<Response> {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const form = await c.req.formData()

  const id = String(form.get("id") || "") || null
  const title = String(form.get("title") || "").trim()
  const content = String(form.get("content") || "").trim()
  const slugIn = String(form.get("slug") || "").trim()
  const excerptIn = String(form.get("excerpt") || "").trim()
  const cover = String(form.get("cover_image") || "").trim() || null
  const categoryId = String(form.get("category_id") || "") || null
  const published = form.get("published") ? 1 : 0
  const noIndex = form.get("no_index") ? 1 : 0
  const seoTitle = String(form.get("seo_title") || "").trim() || null
  const seoDesc = String(form.get("seo_description") || "").trim() || null
  const seoKeywords = String(form.get("seo_keywords") || "").trim() || null
  const ogTitle = String(form.get("og_title") || "").trim() || null
  const ogDesc = String(form.get("og_description") || "").trim() || null
  const ogImage = String(form.get("og_image") || "").trim() || null
  const twitterCard = String(form.get("twitter_card") || "summary_large_image")
  const canonical = String(form.get("canonical_url") || "").trim() || null

  if (!title || !content) {
    return c.html("<p>Title and content required.</p>", 400)
  }

  const slug = slugify(slugIn || title)
  const excerpt = excerptIn || plainExcerpt(content, 200)

  if (id) {
    const existing = await siteDb.execute({
      sql: "SELECT published FROM posts WHERE id = ? LIMIT 1",
      args: [id],
    })
    if (!existing.rows.length) return c.html("Not found", 404)
    const wasPublished = (existing.rows[0].published as number) === 1
    const finalSlug = await ensureUniqueSlug(siteDb, slug, id)
    await siteDb.execute({
      sql: `UPDATE posts SET title=?, slug=?, content=?, excerpt=?, cover_image=?,
              category_id=?, published=?, type=?, no_index=?,
              seo_title=?, seo_description=?, seo_keywords=?,
              og_title=?, og_description=?, og_image=?,
              twitter_card=?, canonical_url=?,
              published_at = CASE WHEN ?=1 AND ?=0 THEN datetime('now')
                                  WHEN ?=0 THEN NULL ELSE published_at END,
              updated_at = datetime('now')
            WHERE id=?`,
      args: [
        title, finalSlug, content, excerpt, cover,
        categoryId, published, type, noIndex,
        seoTitle, seoDesc, seoKeywords,
        ogTitle, ogDesc, ogImage,
        twitterCard, canonical,
        published, wasPublished ? 1 : 0, published,
        id,
      ],
    })
    await replaceImages(siteDb, id, form)
    c.executionCtx.waitUntil(purgePostCache(c.env, hostname, ["/", "/sitemap.xml", "/feed.xml"]))
    return c.redirect(`/admin/${type === "page" ? "pages" : "posts"}/${id}?saved=1`)
  } else {
    const newId = cuid()
    const finalSlug = await ensureUniqueSlug(siteDb, slug)
    await siteDb.execute({
      sql: `INSERT INTO posts (id,title,slug,content,excerpt,cover_image,
              published,published_at,type,category_id,source,no_index,
              seo_title,seo_description,seo_keywords,
              og_title,og_description,og_image,twitter_card,canonical_url,
              created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,'manual',?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
      args: [
        newId, title, finalSlug, content, excerpt, cover,
        published, published ? nowIso() : null,
        type, categoryId, noIndex,
        seoTitle, seoDesc, seoKeywords,
        ogTitle, ogDesc, ogImage, twitterCard, canonical,
      ],
    })
    await replaceImages(siteDb, newId, form)
    c.executionCtx.waitUntil(purgePostCache(c.env, hostname, ["/", "/sitemap.xml", "/feed.xml"]))
    return c.redirect(`/admin/${type === "page" ? "pages" : "posts"}/${newId}?saved=1`)
  }
}

async function replaceImages(
  siteDb: AppEnv["Variables"]["siteDb"],
  postId: string,
  form: FormData
): Promise<void> {
  // images[] is a repeated JSON-encoded field per image: {url, alt, caption}
  const all = form.getAll("image_data[]")
  await siteDb.execute({ sql: "DELETE FROM post_images WHERE post_id = ?", args: [postId] })
  for (let i = 0; i < all.length; i++) {
    let parsed: { url?: string; alt?: string; caption?: string } | null = null
    try {
      parsed = JSON.parse(String(all[i]))
    } catch {
      continue
    }
    if (!parsed?.url) continue
    await siteDb.execute({
      sql: "INSERT INTO post_images (id, post_id, url, alt, caption, ord) VALUES (?, ?, ?, ?, ?, ?)",
      args: [cuid(), postId, parsed.url, parsed.alt ?? "", parsed.caption ?? null, i],
    })
  }
}

async function deletePost(
  c: Context<AppEnv>
): Promise<Response> {
  const siteDb = c.get("siteDb")
  const id = c.req.param("id")
  if (!id) return c.redirect("/admin/posts")
  const r = await siteDb.execute({ sql: "SELECT type FROM posts WHERE id = ?", args: [id] })
  if (!r.rows.length) return c.redirect("/admin/posts")
  const type = (r.rows[0].type as string) === "page" ? "pages" : "posts"
  await siteDb.execute({ sql: "DELETE FROM post_images WHERE post_id = ?", args: [id] })
  await siteDb.execute({ sql: "DELETE FROM posts WHERE id = ?", args: [id] })
  c.executionCtx.waitUntil(
    purgePostCache(c.env, c.get("hostname"), ["/", "/sitemap.xml", "/feed.xml"])
  )
  return c.redirect(`/admin/${type}`)
}

async function ensureUniqueSlug(
  siteDb: AppEnv["Variables"]["siteDb"],
  base: string,
  excludeId?: string
): Promise<string> {
  let slug = base
  let i = 2
  while (true) {
    const sql = excludeId
      ? "SELECT id FROM posts WHERE slug = ? AND id != ? LIMIT 1"
      : "SELECT id FROM posts WHERE slug = ? LIMIT 1"
    const args = excludeId ? [slug, excludeId] : [slug]
    const r = await siteDb.execute({ sql, args })
    if (!r.rows.length) return slug
    slug = `${base}-${i++}`
    if (i > 1000) throw new Error("Could not generate unique slug")
  }
}

function notFound(hostname: string, user: AppEnv["Variables"]["user"] | undefined): string {
  return renderAdminLayout({
    title: "Not found",
    hostname,
    user: user ?? null,
    active: "posts",
    bodyHtml: `<div class="empty-state"><h2>Post not found</h2><a class="btn" href="/admin/posts">← Back to posts</a></div>`,
    pageHeading: "Not found",
  })
}
