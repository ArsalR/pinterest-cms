// src/routes/public/v1/posts.ts
// CRUD + read endpoints for posts via API key.

import { Hono } from "hono"
import type { AppEnv, Category } from "../../../lib/types"
import { validateApiKey, logApiRequest } from "../../../lib/apiAuth"
import { apiError } from "../../../lib/errors"
import { cuid, slugify, nowIso, plainExcerpt } from "../../../lib/utils"
import { loadSettings } from "../../../lib/defaults"
import { buildPostPath } from "../../../lib/seo"
import { purgePostCache } from "../../../lib/revalidate"
import { ensureUniqueSlug } from "../../../lib/slugs"
import { fireWebhooks } from "../../../lib/webhooks"

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
  scheduledAt?: string                      // ISO-8601 — publish at this UTC time (published must be false)
}

export const postRoutes = new Hono<AppEnv>()

// ─────────────── GET /v1/posts ───────────────
// Query params: slug, limit (1-100, default 20), offset (default 0),
//   published ("true"|"false"|"all", default "true"),
//   type ("post"|"page"), category (category slug)
postRoutes.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")

  const auth = await validateApiKey(siteDb, c.req.raw, "read")
  if (auth.error) return apiError(c, auth.status, auth.code, auth.error)

  const q = c.req.query()
  const slug = (q.slug ?? "").trim()
  const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? "20", 10) || 20))
  const offset = Math.max(0, parseInt(q.offset ?? "0", 10) || 0)
  const publishedParam = q.published ?? "true"
  const typeParam = q.type ?? ""
  const categorySlug = (q.category ?? "").trim()

  const where: string[] = []
  const args: Array<string | number | null> = []

  if (slug) {
    where.push("p.slug = ?")
    args.push(slug)
  }

  if (publishedParam === "false") {
    where.push("p.published = 0")
  } else if (publishedParam !== "all") {
    where.push("p.published = 1")
  }

  if (typeParam === "post" || typeParam === "page") {
    where.push("p.type = ?")
    args.push(typeParam)
  }

  if (categorySlug) {
    where.push("c.slug = ?")
    args.push(categorySlug)
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const [countResult, rowsResult] = await Promise.all([
    siteDb.execute({
      sql: `SELECT COUNT(*) AS n FROM posts p
            LEFT JOIN categories c ON c.id = p.category_id ${whereClause}`,
      args,
    }),
    siteDb.execute({
      sql: `SELECT p.*,
                   c.id AS c_id, c.slug AS c_slug, c.name AS c_name
            FROM posts p
            LEFT JOIN categories c ON c.id = p.category_id
            ${whereClause}
            ORDER BY p.published_at DESC, p.created_at DESC
            LIMIT ? OFFSET ?`,
      args: [...args, limit, offset],
    }),
  ])

  const total = Number(countResult.rows[0]?.n ?? 0)
  const settings = await loadSettings(siteDb)

  const posts = rowsResult.rows.map((r) => {
    const cat = r.c_id
      ? { id: r.c_id as string, slug: r.c_slug as string, name: r.c_name as string }
      : null
    const path = buildPostPath(
      { slug: r.slug as string, published_at: r.published_at as string | null, created_at: r.created_at as string },
      cat ? ({ slug: cat.slug } as Category) : null,
      settings
    )
    return serializePost(r, cat, `https://${hostname}${path}`)
  })

  await logApiRequest(siteDb, auth.keyId, "/v1/posts", "GET", 200)
  return c.json({ success: true, posts, total, limit, offset })
})

// ─────────────── GET /v1/posts/:id ───────────────
postRoutes.get("/:id", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")

  const auth = await validateApiKey(siteDb, c.req.raw, "read")
  if (auth.error) return apiError(c, auth.status, auth.code, auth.error)

  const id = c.req.param("id")
  const result = await siteDb.execute({
    sql: `SELECT p.*,
                 c.id AS c_id, c.slug AS c_slug, c.name AS c_name
          FROM posts p
          LEFT JOIN categories c ON c.id = p.category_id
          WHERE p.id = ? LIMIT 1`,
    args: [id],
  })
  if (!result.rows.length) {
    await logApiRequest(siteDb, auth.keyId, `/v1/posts/${id}`, "GET", 404)
    return apiError(c, 404, "not_found", "Post not found", { id })
  }

  const r = result.rows[0]
  const cat = r.c_id
    ? { id: r.c_id as string, slug: r.c_slug as string, name: r.c_name as string }
    : null

  const imageRows = await siteDb.execute({
    sql: "SELECT url, alt, caption, ord FROM post_images WHERE post_id = ? ORDER BY ord ASC",
    args: [id],
  })

  const settings = await loadSettings(siteDb)
  const path = buildPostPath(
    { slug: r.slug as string, published_at: r.published_at as string | null, created_at: r.created_at as string },
    cat ? ({ slug: cat.slug } as Category) : null,
    settings
  )

  const post = {
    ...serializePost(r, cat, `https://${hostname}${path}`),
    images: imageRows.rows.map((img) => ({
      url: img.url,
      alt: img.alt ?? null,
      caption: img.caption ?? null,
      order: img.ord,
    })),
  }

  await logApiRequest(siteDb, auth.keyId, `/v1/posts/${id}`, "GET", 200)
  return c.json({ success: true, post })
})

// ─────────────── shared serializer ───────────────
function serializePost(
  r: Record<string, unknown>,
  category: { id: string; slug: string; name: string } | null,
  url: string
) {
  return {
    id: r.id,
    title: r.title,
    slug: r.slug,
    content: r.content,
    excerpt: r.excerpt ?? null,
    coverImage: r.cover_image ?? null,
    published: (r.published as number) === 1,
    publishedAt: r.published_at ?? null,
    scheduledAt: r.scheduled_at ?? null,
    type: r.type,
    source: r.source,
    category,
    seoTitle: r.seo_title ?? null,
    seoDescription: r.seo_description ?? null,
    seoKeywords: r.seo_keywords ?? null,
    ogTitle: r.og_title ?? null,
    ogDescription: r.og_description ?? null,
    ogImage: r.og_image ?? null,
    twitterCard: r.twitter_card ?? null,
    canonicalUrl: r.canonical_url ?? null,
    noIndex: (r.no_index as number) === 1,
    structuredData: r.structured_data ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    url,
  }
}

// ─────────────── POST /v1/posts/batch ───────────────
// Accepts up to 50 posts in one request. Each item is processed independently —
// a single item failure does not abort the batch.
// Behind FEATURE_BATCH_POSTS flag (disabled by default).
postRoutes.post("/batch", async (c) => {
  const enabled = c.env.FEATURE_BATCH_POSTS
  if (!enabled || enabled === "0" || enabled === "false") {
    return apiError(c, 404, "not_found", "Batch endpoint not enabled. Set FEATURE_BATCH_POSTS=1.")
  }

  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")

  const auth = await validateApiKey(siteDb, c.req.raw, "write")
  if (auth.error) return apiError(c, auth.status, auth.code, auth.error)

  let body: { posts?: unknown[] }
  try {
    body = await c.req.json()
  } catch {
    return apiError(c, 400, "validation_invalid_value", "Invalid JSON body")
  }

  if (!Array.isArray(body.posts) || !body.posts.length) {
    return apiError(c, 400, "validation_required_field", "posts array is required", { field: "posts" })
  }
  if (body.posts.length > 50) {
    return apiError(c, 400, "validation_invalid_value", "Maximum 50 posts per batch", { max: 50, sent: body.posts.length })
  }

  const settings = await loadSettings(siteDb)
  const results: Array<{
    index: number
    id?: string
    slug?: string
    url?: string
    status: "created" | "error"
    error?: string
    code?: string
  }> = []

  const webhookPromises: Promise<void>[] = []

  for (let i = 0; i < body.posts.length; i++) {
    const item = body.posts[i] as CreatePostBody
    try {
      const title = (item.title ?? "").trim()
      const content = (item.content ?? "").trim()
      if (!title) { results.push({ index: i, status: "error", error: "title is required", code: "validation_required_field" }); continue }
      if (!content) { results.push({ index: i, status: "error", error: "content is required", code: "validation_required_field" }); continue }

      // Resolve category.
      let categoryId: string | null = null
      let category: Category | null = null
      if (item.category) {
        const slug = slugify(item.category)
        const existing = await siteDb.execute({ sql: "SELECT * FROM categories WHERE slug = ? LIMIT 1", args: [slug] })
        if (existing.rows.length) {
          category = existing.rows[0] as unknown as Category
          categoryId = category.id
        } else {
          categoryId = cuid()
          const name = item.category.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())
          await siteDb.execute({ sql: "INSERT INTO categories (id, name, slug) VALUES (?, ?, ?)", args: [categoryId, name, slug] })
          category = { id: categoryId, name, slug, description: null, cover_image: null, seo_title: null, seo_desc: null, created_at: nowIso() }
        }
      }

      const desiredSlug = item.slug ? slugify(item.slug) : slugify(title)
      const finalSlug = await ensureUniqueSlug(siteDb, desiredSlug)
      const excerpt = (item.excerpt ?? "").trim() || plainExcerpt(content, 200)
      const seoKeywords = item.seoKeywords ?? (Array.isArray(item.tags) ? item.tags.join(", ") : "")
      const postId = cuid()
      const published = item.published ? 1 : 0
      const publishedAt = published ? item.publishedAt ?? nowIso() : null
      const scheduledAt = !published && item.scheduledAt ? item.scheduledAt : null

      await siteDb.execute({
        sql: `INSERT INTO posts (
                id, title, slug, content, excerpt, cover_image,
                published, published_at, scheduled_at, type, category_id, source,
                seo_title, seo_description, seo_keywords,
                og_title, og_description, og_image,
                twitter_card, canonical_url, no_index,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        args: [
          postId, title, finalSlug, content, excerpt, item.coverImage ?? null,
          published, publishedAt, scheduledAt,
          item.type === "page" ? "page" : "post", categoryId,
          item.seoTitle ?? null, item.seoDescription ?? null, seoKeywords || null,
          item.ogTitle ?? null, item.ogDescription ?? null, item.ogImage ?? null,
          item.twitterCard ?? "summary_large_image", item.canonicalUrl ?? null, item.noIndex ? 1 : 0,
        ],
      })

      const path = buildPostPath({ slug: finalSlug, published_at: publishedAt, created_at: nowIso() }, category, settings)
      const url = `https://${hostname}${path}`

      webhookPromises.push(
        fireWebhooks(siteDb, c.env.FEATURE_WEBHOOKS, hostname,
          published ? "post.published" : "post.created",
          { id: postId, title, slug: finalSlug, url, published: Boolean(published) })
      )

      results.push({ index: i, id: postId, slug: finalSlug, url, status: "created" })
    } catch (err) {
      results.push({ index: i, status: "error", error: err instanceof Error ? err.message : "Unknown error", code: "internal_error" })
    }
  }

  // Register all webhook deliveries + cache purge as a single waitUntil.
  c.executionCtx.waitUntil(
    Promise.all([
      Promise.all(webhookPromises),
      purgePostCache(c.env, hostname, ["/", "/sitemap.xml", "/feed.xml"]),
    ]).then(() => undefined)
  )

  await logApiRequest(siteDb, auth.keyId, "/v1/posts/batch", "POST", 200)
  const created = results.filter((r) => r.status === "created").length
  return c.json({ success: true, created, total: results.length, results })
})

// ─────────────── POST /v1/posts ───────────────
postRoutes.post("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")

  const auth = await validateApiKey(siteDb, c.req.raw, "write")
  if (auth.error) return apiError(c, auth.status, auth.code, auth.error)

  let body: CreatePostBody
  try {
    body = await c.req.json<CreatePostBody>()
  } catch {
    await logApiRequest(siteDb, auth.keyId, "/v1/posts", "POST", 400)
    return apiError(c, 400, "validation_invalid_value", "Invalid JSON body")
  }

  const title = (body.title ?? "").trim()
  const content = (body.content ?? "").trim()
  if (!title) {
    await logApiRequest(siteDb, auth.keyId, "/v1/posts", "POST", 400)
    return apiError(c, 400, "validation_required_field", "title is required", { field: "title" })
  }
  if (!content) {
    await logApiRequest(siteDb, auth.keyId, "/v1/posts", "POST", 400)
    return apiError(c, 400, "validation_required_field", "content is required", { field: "content" })
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
  // scheduled_at only applies when the post is a draft (published=0)
  const scheduledAt = !published && body.scheduledAt ? body.scheduledAt : null

  await siteDb.execute({
    sql: `INSERT INTO posts (
      id, title, slug, content, excerpt, cover_image,
      published, published_at, scheduled_at, type, category_id, source,
      seo_title, seo_description, seo_keywords,
      og_title, og_description, og_image,
      twitter_card, canonical_url, no_index,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    args: [
      postId,
      title,
      finalSlug,
      content,
      excerpt,
      body.coverImage ?? null,
      published,
      publishedAt,
      scheduledAt,
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

  // Fetch the DB-stored created_at so the permalink URL is always accurate.
  const createdRow = await siteDb.execute({ sql: "SELECT created_at FROM posts WHERE id = ?", args: [postId] })
  const createdAt = (createdRow.rows[0]?.created_at as string | null) ?? nowIso()

  // Build canonical URL using current settings.
  const settings = await loadSettings(siteDb)
  const path = buildPostPath(
    { slug: finalSlug, published_at: publishedAt, created_at: createdAt },
    category,
    settings
  )
  const url = `https://${hostname}${path}`

  // Cache invalidation + webhooks (best-effort, fire-and-forget).
  c.executionCtx.waitUntil(
    Promise.all([
      purgePostCache(c.env, hostname, [path, "/", "/sitemap.xml", "/feed.xml"]),
      fireWebhooks(siteDb, c.env.FEATURE_WEBHOOKS, hostname,
        published ? "post.published" : "post.created",
        { id: postId, title, slug: finalSlug, url, published: Boolean(published) }),
    ]).then(() => undefined)
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
      scheduled: scheduledAt !== null,
      scheduledAt: scheduledAt,
      type: body.type === "page" ? "page" : "post",
      category: category ? { id: category.id, slug: category.slug, name: category.name } : null,
      createdAt,
    },
  })
})

// ─────────────── PUT /v1/posts/:id ───────────────
postRoutes.put("/:id", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")

  const auth = await validateApiKey(siteDb, c.req.raw, "write")
  if (auth.error) return apiError(c, auth.status, auth.code, auth.error)

  const id = c.req.param("id")
  const existing = await siteDb.execute({
    sql: "SELECT * FROM posts WHERE id = ? LIMIT 1",
    args: [id],
  })
  if (!existing.rows.length) {
    await logApiRequest(siteDb, auth.keyId, `/v1/posts/${id}`, "PUT", 404)
    return apiError(c, 404, "not_found", "Post not found", { id })
  }

  let body: CreatePostBody
  try {
    body = await c.req.json<CreatePostBody>()
  } catch {
    return apiError(c, 400, "validation_invalid_value", "Invalid JSON body")
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

  if (body.scheduledAt !== undefined) {
    set("scheduled_at", body.scheduledAt || null)
  }

  if (body.published !== undefined) {
    set("published", body.published ? 1 : 0)
    const wasPublished = (existing.rows[0].published as number) === 1
    if (body.published && !wasPublished) {
      set("published_at", body.publishedAt ?? nowIso())
      // clear scheduled_at when explicitly publishing
      set("scheduled_at", null)
    }
  }

  if (!updates.length && !body.images) {
    return apiError(c, 400, "validation_required_field", "No fields to update")
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
  const wasPublished = (existing.rows[0].published as number) === 1
  const isNowPublished = (row.published as number) === 1
  const whEvent = !wasPublished && isNowPublished ? "post.published" : "post.updated"
  c.executionCtx.waitUntil(
    fireWebhooks(siteDb, c.env.FEATURE_WEBHOOKS, hostname, whEvent,
      { id, slug: row.slug, title: row.title, published: isNowPublished })
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
  if (auth.error) return apiError(c, auth.status, auth.code, auth.error)

  const id = c.req.param("id")
  const existing = await siteDb.execute({
    sql: `SELECT p.*, c.slug AS category_slug FROM posts p
          LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ? LIMIT 1`,
    args: [id],
  })
  if (!existing.rows.length) {
    return apiError(c, 404, "not_found", "Post not found", { id })
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

  c.executionCtx.waitUntil(
    fireWebhooks(siteDb, c.env.FEATURE_WEBHOOKS, hostname, "post.deleted",
      { id, slug: row.slug as string })
  )

  await logApiRequest(siteDb, auth.keyId, `/v1/posts/${id}`, "DELETE", 200, id)
  return c.json({ success: true, deleted: id })
})

