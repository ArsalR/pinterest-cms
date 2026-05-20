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
import { ensureUniqueSlug } from "../../lib/slugs"
import { renderPostPage } from "../frontend/post"

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

postsAdminRoute.post("/bulk-action", async (c) => {
  return bulkAction(c, "post")
})

// Preview — renders the frontend post view for any post (published or draft).
postsAdminRoute.get("/:id/preview", async (c) => {
  const siteDb = c.get("siteDb")
  const id = c.req.param("id")
  const r = await siteDb.execute({
    sql: `SELECT p.*, c.id AS cat_id, c.name AS cat_name, c.slug AS cat_slug
          FROM posts p LEFT JOIN categories c ON c.id = p.category_id
          WHERE p.id = ? LIMIT 1`,
    args: [id],
  })
  if (!r.rows.length) return c.html("Post not found", 404)
  const row = r.rows[0]
  const post = {
    ...(row as unknown as Post),
    category: row.cat_id
      ? { id: row.cat_id as string, name: row.cat_name as string, slug: row.cat_slug as string } as Category
      : null,
  }
  const backHref = escapeAttr(`/admin/${post.type === "page" ? "pages" : "posts"}/${id}`)
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

postsAdminRoute.post("/:id/delete", async (c) => {
  return deletePost(c)
})

postsAdminRoute.post("/:id/toggle-publish", (c) => togglePublish(c))

// ──────────────── Helpers exposed for /admin/pages ────────────────
export { renderPostsList, renderEditorPage, savePost, deletePost, bulkAction, togglePublish }

async function togglePublish(c: Context<AppEnv>): Promise<Response> {
  const siteDb = c.get("siteDb")
  const id = c.req.param("id")
  if (!id) return c.json({ error: "id required" }, 400)
  const r = await siteDb.execute({
    sql: "SELECT published, published_at, type FROM posts WHERE id = ?",
    args: [id],
  })
  if (!r.rows.length) return c.json({ error: "Not found" }, 404)
  const cur = r.rows[0].published as number
  const postType = r.rows[0].type as string
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
  return c.redirect(postType === "page" ? "/admin/pages" : "/admin/posts")
}

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
  if (status === "draft") filters.push("p.published = 0 AND p.scheduled_at IS NULL")
  if (status === "scheduled") filters.push("p.published = 0 AND p.scheduled_at IS NOT NULL")
  args.push(limit)

  const rows = await siteDb.execute({
    sql: `SELECT p.id, p.title, p.slug, p.published, p.published_at, p.scheduled_at, p.created_at,
                 p.source, c.slug AS cat_slug, c.name AS cat_name
          FROM posts p LEFT JOIN categories c ON c.id = p.category_id
          WHERE ${filters.join(" AND ")}
          ORDER BY p.created_at DESC
          LIMIT ?`,
    args,
  })

  const section = type === "page" ? "pages" : "posts"
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
      <td style="width:32px;padding:8px 4px"><input type="checkbox" class="bulk-check" data-id="${escapeAttr(r.id as string)}" style="width:16px;height:16px"></td>
      <td><a href="/admin/${section}/${escapeAttr(r.id as string)}"><strong>${escapeHtml(r.title as string)}</strong></a><br><span style="color:var(--muted-2);font-size:12px;font-family:var(--mono)">${escapeHtml(r.slug as string)}</span></td>
      <td>${r.cat_name ? escapeHtml(r.cat_name as string) : "—"}</td>
      <td>${
        r.published
          ? `<span class="pill published">Published</span>`
          : r.scheduled_at
          ? `<span class="pill scheduled" title="Scheduled for ${escapeAttr(r.scheduled_at as string)}">Scheduled</span>`
          : `<span class="pill draft">Draft</span>`
      }</td>
      <td><span class="pill ${r.source === "api" ? "api" : "manual"}">${escapeHtml((r.source as string) ?? "manual")}</span></td>
      <td>${escapeHtml(formatDate(r.created_at as string))}</td>
      <td class="row-actions">
        ${r.published ? `<a class="btn sm ghost" href="${escapeAttr(path)}" target="_blank">View ↗</a>` : ""}
        <form method="POST" action="/admin/${section}/${escapeAttr(r.id as string)}/toggle-publish" style="display:inline">
          <button class="btn sm" type="submit">${r.published ? "Unpublish" : "Publish"}</button>
        </form>
        <a class="btn sm primary" href="/admin/${section}/${escapeAttr(r.id as string)}">Edit</a>
        <form method="POST" action="/admin/${section}/${escapeAttr(r.id as string)}/delete" style="display:inline" onsubmit="return confirm('Delete &quot;${escapeAttr((r.title as string).replace(/"/g, ""))}&quot;? This cannot be undone.')">
          <button class="btn sm danger" type="submit">Delete</button>
        </form>
      </td>
    </tr>`
  }).join("")

  const heading = type === "page" ? "Pages" : "Posts"
  const newHref = type === "page" ? "/admin/pages/new" : "/admin/posts/new"
  const bulkUrl = `/admin/${section}/bulk-action`

  const body = `
    <form method="GET" style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
      <input class="search" type="search" name="q" value="${escapeAttr(q)}" placeholder="Search by title or slug…" style="flex:1;min-width:200px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 12px;color:var(--text)">
      <select name="status" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 12px;color:var(--text)">
        <option value="">All</option>
        <option value="published" ${status === "published" ? "selected" : ""}>Published</option>
        <option value="draft" ${status === "draft" ? "selected" : ""}>Drafts</option>
        <option value="scheduled" ${status === "scheduled" ? "selected" : ""}>Scheduled</option>
      </select>
      <button class="btn" type="submit">Filter</button>
    </form>
    ${rows.rows.length ? `
    <div id="bulk-toolbar" style="display:none;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;margin-bottom:12px">
      <span id="bulk-count" style="font-size:13px;color:var(--muted)">0 selected</span>
      <select id="bulk-action-sel" style="background:var(--bg);border:1px solid var(--border-2);border-radius:var(--radius-sm);padding:6px 10px;color:var(--text);font-size:13px">
        <option value="">— Action —</option>
        <option value="publish">Publish</option>
        <option value="unpublish">Unpublish</option>
        <option value="delete">Delete</option>
      </select>
      <button type="button" id="bulk-apply" class="btn sm">Apply</button>
    </div>
    <table>
      <thead><tr>
        <th style="width:32px"><input type="checkbox" id="bulk-select-all" style="width:16px;height:16px"></th>
        <th>${heading.replace(/s$/, "")}</th><th>Category</th><th>Status</th><th>Source</th><th>Created</th><th></th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
    <script>
    (function(){
      var checks = document.querySelectorAll('.bulk-check');
      var selectAll = document.getElementById('bulk-select-all');
      var toolbar = document.getElementById('bulk-toolbar');
      var countEl = document.getElementById('bulk-count');
      var actionSel = document.getElementById('bulk-action-sel');
      var applyBtn = document.getElementById('bulk-apply');
      function updateToolbar(){
        var n = document.querySelectorAll('.bulk-check:checked').length;
        toolbar.style.display = n ? 'flex' : 'none';
        countEl.textContent = n + ' selected';
      }
      checks.forEach(function(cb){ cb.addEventListener('change', updateToolbar); });
      selectAll.addEventListener('change', function(){
        checks.forEach(function(cb){ cb.checked = selectAll.checked; });
        updateToolbar();
      });
      applyBtn.addEventListener('click', function(){
        var action = actionSel.value;
        if (!action) { alert('Choose an action first.'); return; }
        var checked = Array.from(document.querySelectorAll('.bulk-check:checked'));
        if (!checked.length) return;
        if (action === 'delete' && !confirm('Delete ' + checked.length + ' item(s)? This cannot be undone.')) return;
        var form = document.createElement('form');
        form.method = 'POST';
        form.action = '${bulkUrl}';
        [['type','${type}'],['bulk_action',action]].forEach(function(pair){
          var inp = document.createElement('input');
          inp.type = 'hidden'; inp.name = pair[0]; inp.value = pair[1];
          form.appendChild(inp);
        });
        checked.forEach(function(cb){
          var inp = document.createElement('input');
          inp.type = 'hidden'; inp.name = 'post_ids[]'; inp.value = cb.dataset.id;
          form.appendChild(inp);
        });
        document.body.appendChild(form);
        form.submit();
      });
    })();
    </script>` : `<div class="empty-state"><p>No ${heading.toLowerCase()} yet.</p><a class="btn primary" href="${newHref}">+ New ${type}</a></div>`}
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
  // scheduled_at: only kept when saving as draft; cleared when publishing
  const scheduledAtRaw = String(form.get("scheduled_at") || "").trim()
  const scheduledAt = !published && scheduledAtRaw ? scheduledAtRaw.replace("T", " ") : null
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
              scheduled_at=?,
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
        scheduledAt,
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
              published,published_at,scheduled_at,type,category_id,source,no_index,
              seo_title,seo_description,seo_keywords,
              og_title,og_description,og_image,twitter_card,canonical_url,
              created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,'manual',?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
      args: [
        newId, title, finalSlug, content, excerpt, cover,
        published, published ? nowIso() : null, scheduledAt,
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
  const all = form.getAll("image_data[]")
  await siteDb.execute({ sql: "DELETE FROM post_images WHERE post_id = ?", args: [postId] })
  const stmts: Array<{ sql: string; args: (string | number | null)[] }> = []
  for (let i = 0; i < all.length; i++) {
    let parsed: { url?: string; alt?: string; caption?: string } | null = null
    try { parsed = JSON.parse(String(all[i])) } catch { continue }
    if (!parsed?.url) continue
    stmts.push({
      sql: "INSERT INTO post_images (id, post_id, url, alt, caption, ord) VALUES (?, ?, ?, ?, ?, ?)",
      args: [cuid(), postId, parsed.url, parsed.alt ?? "", parsed.caption ?? null, i],
    })
  }
  if (stmts.length) await siteDb.batch(stmts, "write")
}

async function bulkAction(
  c: Context<AppEnv>,
  type: "post" | "page"
): Promise<Response> {
  const siteDb = c.get("siteDb")
  const form = await c.req.formData()
  const action = String(form.get("bulk_action") || "")
  const ids = form.getAll("post_ids[]").map(String).filter(Boolean)
  const backUrl = type === "page" ? "/admin/pages" : "/admin/posts"

  if (!ids.length || !action) return c.redirect(backUrl)

  const placeholders = ids.map(() => "?").join(",")

  if (action === "publish") {
    await siteDb.execute({
      sql: `UPDATE posts SET published = 1,
              published_at = COALESCE(published_at, datetime('now')),
              updated_at = datetime('now')
            WHERE id IN (${placeholders}) AND type = ?`,
      args: [...ids, type],
    })
  } else if (action === "unpublish") {
    await siteDb.execute({
      sql: `UPDATE posts SET published = 0, updated_at = datetime('now')
            WHERE id IN (${placeholders}) AND type = ?`,
      args: [...ids, type],
    })
  } else if (action === "delete") {
    await siteDb.execute({
      sql: `DELETE FROM post_images WHERE post_id IN (${placeholders})`,
      args: ids,
    })
    await siteDb.execute({
      sql: `DELETE FROM posts WHERE id IN (${placeholders}) AND type = ?`,
      args: [...ids, type],
    })
  }

  c.executionCtx.waitUntil(
    purgePostCache(c.env, c.get("hostname"), ["/", "/sitemap.xml", "/feed.xml"])
  )
  return c.redirect(backUrl)
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
