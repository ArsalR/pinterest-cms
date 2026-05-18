// src/routes/public/v1/posts.ts
// Create / update / delete posts via API key.

import { Hono } from "hono"
import type { AppEnv, Category } from "../../../lib/types"
import { validateApiKey, logApiRequest } from "../../../lib/apiAuth"
import { cuid, slugify, nowIso, plainExcerpt } from "../../../lib/utils"
import { loadSettings } from "../../../lib/defaults"
import { buildPostPath } from "../../../lib/seo"
import { purgePostCache } from "../../../lib/revalidate"
import { ensureUniqueSlug } from "../../../lib/slugs"

interface CreatePostBody {
  title?: string
  content?: string
  excerpt?: string
  coverImage?: string
  images?: Array<{ url: string; alt?: string; caption?: string; order?: number }>
  category?: string                         // slug — created if missing
  tags?: string[]                           // → seo_keywords
  published?: boolean
  type?: "post" | "page"
  slug?: string
  seoTitle?: string
  seoDescription?: string
  seoKeywords?: string
  ogTitle?: string
  ogDescription?: string
  ogImage?: string
  twitterCard?: string
  canonicalUrl?: string
  noIndex?: boolean
  publishedAt?: string                      // override timestamp
}

export const postRoutes = new Hono<AppEnv>()

// ─────────────── POST /v1/posts ───────────────
postRoutes.post("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")

  const auth = await validateApiKey(siteDb, c.req.raw, "write")
  if (auth.error) return c.json({ error: auth.error }, auth.status as 401 | 403)

  let body: CreatePostBody
  try {
    body = await c.req.json<CreatePostBody>()
  } catch {
    await logApiRequest(siteDb, auth.keyId, "/v1/posts", "POST", 400)
    return c.json({ error: "Invalid JSON body" }, 400)
  }

  const title = (body.title ?? "").trim()
  const content = (body.content ?? "").trim()
  if (!title) {
    await logApiRequest(siteDb, auth.keyId, "/v1/posts", "POST", 400)
    return c.json({ error: "title is required" }, 400)
  }
  if (!content) {
    await logApiRequest(siteDb, auth.keyId, "/v1/posts", "POST", 400)
    return c.json({ error: "content is required" }, 400)
  }

  // Resolve category (find by slug, else create).
  let categoryId: string | null = null
  let category: Category | null = null
  if (body.category) {
    const slug = slugify(body.category)
    const existing = await siteDb.execute({
      sql: "SELECT * FROM categories WHERE slug = ? LIMIT 1",
      args: [slug],
    })
    if (existing.rows.length) {
      category = existing.rows[0] as unknown as Category
      categoryId = category.id
    } else {
      categoryId = cuid()
      const name = body.category.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())
      await siteDb.execute({
        sql: `INSERT INTO categories (id, name, slug) VALUES (?, ?, ?)`,
        args: [categoryId, name, slug],
      })
      category = {
        id: categoryId,
        name,
        slug,
        description: null,
        cover_image: null,
        seo_title: null,
        seo_desc: null,
        created_at: nowIso(),
      }
    }
  }

  // Resolve unique slug.
  const desiredSlug = body.slug ? slugify(body.slug) : slugify(title)
  const finalSlug = await ensureUniqueSlug(siteDb, desiredSlug)

  const excerpt = (body.excerpt ?? "").trim() || plainExcerpt(content, 200)
  const seoKeywords =
    body.seoKeywords ?? (Array.isArray(body.tags) ? body.tags.join(", ") : "")

  const postId = cuid()
  const published = body.published ? 1 : 0
  const publishedAt = published ? body.publishedAt ?? nowIso() : null

  await siteDb.execute({
    sql: `INSERT INTO posts (
      id, title, slug, content, excerpt, cover_image,
      published, published_at, type, category_id, source,
      seo_title, seo_description, seo_keywords,
      og_title, og_description, og_image,
      twitter_card, canonical_url, no_index,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    args: [
      postId,
      title,
      finalSlug,
      content,
      excerpt,
      body.coverImage ?? null,
      published,
      publishedAt,
      body.type === "page" ? "page" : "post",
      categoryId,
      body.seoTitle ?? null,
      body.seoDescription ?? null,
      seoKeywords || null,
      body.ogTitle ?? null,
      body.ogDescription ?? null,
      body.ogImage ?? null,
      body.twitterCard ?? "summary_large_image",
      body.canonicalUrl ?? null,
      body.noIndex ? 1 : 0,
    ],
  })

  // Insert gallery images.
  if (Array.isArray(body.images)) {
    for (let i = 0; i < body.images.length; i++) {
      const img = body.images[i]
      if (!img?.url) continue
      await siteDb.execute({
        sql: `INSERT INTO post_images (id, post_id, url, alt, caption, ord)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          cuid(),
          postId,
          img.url,
          img.alt ?? title,
          img.caption ?? null,
          typeof img.order === "number" ? img.order : i,
        ],
      })
    }
  }

  // Build canonical URL using current settings.
  const settings = await loadSettings(siteDb)
  const path = buildPostPath(
    { slug: finalSlug, published_at: publishedAt, created_at: nowIso() },
    category,
    settings
  )
  const url = `https://${hostname}${path}`

  // Cache invalidation (best-effort, fire-and-forget).
  c.executionCtx.waitUntil(
    purgePostCache(c.env, hostname, [path, "/", "/sitemap.xml", "/feed.xml"])
  )

  await logApiRequest(siteDb, auth.keyId, "/v1/posts", "POST", 200, postId)

  return c.json({
    success: true,
    post: {
      id: postId,
      title,
      slug: finalSlug,
      url,
      published: Boolean(published),
      type: body.type === "page" ? "page" : "post",
      category: category ? { id: category.id, slug: category.slug, name: category.name } : null,
      createdAt: nowIso(),
    },
  })
})

// ─────────────── PUT /v1/posts/:id ───────────────
postRoutes.put("/:id", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")

  const auth = await validateApiKey(siteDb, c.req.raw, "write")
  if (auth.error) return c.json({ error: auth.error }, auth.status as 401 | 403)

  const id = c.req.param("id")
  const existing = await siteDb.execute({
    sql: "SELECT * FROM posts WHERE id = ? LIMIT 1",
    args: [id],
  })
  if (!existing.rows.length) {
    await logApiRequest(siteDb, auth.keyId, `/v1/posts/${id}`, "PUT", 404)
    return c.json({ error: "Post not found" }, 404)
  }

  let body: CreatePostBody
  try {
    body = await c.req.json<CreatePostBody>()
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400)
  }

  const updates: string[] = []
  const args: Array<string | number | null> = []

  function set(col: string, value: unknown) {
    updates.push(`${col} = ?`)
    if (value === null || value === undefined) {
      args.push(null)
    } else if (typeof value === "string" || typeof value === "number") {
      args.push(value)
    } else if (typeof value === "boolean") {
      args.push(value ? 1 : 0)
    } else {
      args.push(JSON.stringify(value))
    }
  }

  if (body.title !== undefined) set("title", body.title)
  if (body.content !== undefined) set("content", body.content)
  if (body.excerpt !== undefined) set("excerpt", body.excerpt)
  if (body.coverImage !== undefined) set("cover_image", body.coverImage)
  if (body.seoTitle !== undefined) set("seo_title", body.seoTitle)
  if (body.seoDescription !== undefined) set("seo_description", body.seoDescription)
  if (body.seoKeywords !== undefined) set("seo_keywords", body.seoKeywords)
  if (body.ogTitle !== undefined) set("og_title", body.ogTitle)
  if (body.ogDescription !== undefined) set("og_description", body.ogDescription)
  if (body.ogImage !== undefined) set("og_image", body.ogImage)
  if (body.twitterCard !== undefined) set("twitter_card", body.twitterCard)
  if (body.canonicalUrl !== undefined) set("canonical_url", body.canonicalUrl)
  if (body.noIndex !== undefined) set("no_index", body.noIndex ? 1 : 0)
  if (body.type !== undefined) set("type", body.type === "page" ? "page" : "post")

  if (Array.isArray(body.tags)) set("seo_keywords", body.tags.join(", "))

  if (body.slug !== undefined) {
    const newSlug = await ensureUniqueSlug(siteDb, slugify(body.slug), id)
    set("slug", newSlug)
  }

  if (body.category !== undefined) {
    const slug = slugify(body.category)
    const cat = await siteDb.execute({
      sql: "SELECT id FROM categories WHERE slug = ? LIMIT 1",
      args: [slug],
    })
    let catId: string
    if (cat.rows.length) {
      catId = cat.rows[0].id as string
    } else {
      catId = cuid()
      const name = body.category.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())
      await siteDb.execute({
        sql: "INSERT INTO categories (id, name, slug) VALUES (?, ?, ?)",
        args: [catId, name, slug],
      })
    }
    set("category_id", catId)
  }

  if (body.published !== undefined) {
    set("published", body.published ? 1 : 0)
    const wasPublished = (existing.rows[0].published as number) === 1
    if (body.published && !wasPublished) set("published_at", body.publishedAt ?? nowIso())
  }

  if (!updates.length && !body.images) {
    return c.json({ error: "No fields to update" }, 400)
  }

  if (updates.length) {
    updates.push("updated_at = datetime('now')")
    args.push(id)
    await siteDb.execute({
      sql: `UPDATE posts SET ${updates.join(", ")} WHERE id = ?`,
      args,
    })
  }

  // Replace gallery if `images` provided.
  if (Array.isArray(body.images)) {
    await siteDb.execute({ sql: "DELETE FROM post_images WHERE post_id = ?", args: [id] })
    for (let i = 0; i < body.images.length; i++) {
      const img = body.images[i]
      if (!img?.url) continue
      await siteDb.execute({
        sql: `INSERT INTO post_images (id, post_id, url, alt, caption, ord)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          cuid(),
          id,
          img.url,
          img.alt ?? "",
          img.caption ?? null,
          typeof img.order === "number" ? img.order : i,
        ],
      })
    }
  }

  // Purge cache for this post.
  const after = await siteDb.execute({
    sql: `SELECT p.*, c.slug AS category_slug FROM posts p
          LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ? LIMIT 1`,
    args: [id],
  })
  const row = after.rows[0]
  const settings = await loadSettings(siteDb)
  const path = buildPostPath(
    {
      slug: row.slug as string,
      published_at: (row.published_at as string | null) ?? null,
      created_at: row.created_at as string,
    },
    row.category_slug
      ? ({ slug: row.category_slug as string } as Category)
      : null,
    settings
  )
  c.executionCtx.waitUntil(
    purgePostCache(c.env, hostname, [path, "/", "/sitemap.xml", "/feed.xml"])
  )

  await logApiRequest(siteDb, auth.keyId, `/v1/posts/${id}`, "PUT", 200, id)
  return c.json({
    success: true,
    post: {
      id,
      title: row.title,
      slug: row.slug,
      url: `https://${hostname}${path}`,
      published: (row.published as number) === 1,
      updatedAt: row.updated_at,
    },
  })
})

// ─────────────── DELETE /v1/posts/:id ───────────────
postRoutes.delete("/:id", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")

  const auth = await validateApiKey(siteDb, c.req.raw, "write")
  if (auth.error) return c.json({ error: auth.error }, auth.status as 401 | 403)

  const id = c.req.param("id")
  const existing = await siteDb.execute({
    sql: `SELECT p.*, c.slug AS category_slug FROM posts p
          LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ? LIMIT 1`,
    args: [id],
  })
  if (!existing.rows.length) {
    return c.json({ error: "Post not found" }, 404)
  }
  const row = existing.rows[0]

  // Collect R2 keys for image cleanup (best-effort).
  const imageRows = await siteDb.execute({
    sql: "SELECT url FROM post_images WHERE post_id = ?",
    args: [id],
  })
  const imageUrls = imageRows.rows.map((r) => r.url as string)
  if (row.cover_image) imageUrls.push(row.cover_image as string)

  // Cascade deletes via FK; explicit for clarity.
  await siteDb.execute({ sql: "DELETE FROM post_images WHERE post_id = ?", args: [id] })
  await siteDb.execute({ sql: "DELETE FROM posts WHERE id = ?", args: [id] })

  // Cache purge.
  const settings = await loadSettings(siteDb)
  const path = buildPostPath(
    {
      slug: row.slug as string,
      published_at: (row.published_at as string | null) ?? null,
      created_at: row.created_at as string,
    },
    row.category_slug ? ({ slug: row.category_slug as string } as Category) : null,
    settings
  )
  c.executionCtx.waitUntil(
    (async () => {
      await purgePostCache(c.env, hostname, [path, "/", "/sitemap.xml", "/feed.xml"])
      // Don't auto-delete R2 images — they may be referenced elsewhere via media table.
      // Operators can run a sweeper to GC orphans. We do clean up when deleting from media library.
      void imageUrls
    })()
  )

  await logApiRequest(siteDb, auth.keyId, `/v1/posts/${id}`, "DELETE", 200, id)
  return c.json({ success: true, deleted: id })
})

