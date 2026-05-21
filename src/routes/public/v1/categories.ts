// src/routes/public/v1/categories.ts
import { Hono } from "hono"
import type { AppEnv } from "../../../lib/types"
import { validateApiKey, logApiRequest } from "../../../lib/apiAuth"
import { apiError } from "../../../lib/errors"
import { cuid, slugify } from "../../../lib/utils"

export const categoryRoutes = new Hono<AppEnv>()

// GET — list all categories with post counts.
categoryRoutes.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const auth = await validateApiKey(siteDb, c.req.raw, "read")
  if (auth.error) return apiError(c, auth.status!, auth.code!, auth.error)

  const rows = await siteDb.execute(`
    SELECT c.*, COUNT(p.id) AS post_count
    FROM categories c
    LEFT JOIN posts p ON p.category_id = c.id AND p.published = 1
    GROUP BY c.id
    ORDER BY c.name ASC
  `)

  await logApiRequest(siteDb, auth.keyId, "/v1/categories", "GET", 200)
  return c.json({
    success: true,
    categories: rows.rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      description: r.description,
      coverImage: r.cover_image,
      postCount: Number(r.post_count ?? 0),
    })),
  })
})

// POST — create a new category.
categoryRoutes.post("/", async (c) => {
  const siteDb = c.get("siteDb")
  const auth = await validateApiKey(siteDb, c.req.raw, "write")
  if (auth.error) return apiError(c, auth.status!, auth.code!, auth.error)

  let body: { name?: string; slug?: string; description?: string; coverImage?: string }
  try {
    body = await c.req.json()
  } catch {
    return apiError(c, 400, "validation_invalid_value", "Invalid JSON body")
  }
  const name = (body.name ?? "").trim()
  if (!name) {
    return apiError(c, 400, "validation_required_field", "name is required", { field: "name" })
  }
  const slug = slugify(body.slug || name)

  const existing = await siteDb.execute({
    sql: "SELECT id FROM categories WHERE slug = ? LIMIT 1",
    args: [slug],
  })
  if (existing.rows.length) {
    return apiError(c, 409, "slug_conflict", "Category slug already exists", { slug })
  }

  const id = cuid()
  await siteDb.execute({
    sql: `INSERT INTO categories (id, name, slug, description, cover_image)
          VALUES (?, ?, ?, ?, ?)`,
    args: [id, name, slug, body.description ?? null, body.coverImage ?? null],
  })

  await logApiRequest(siteDb, auth.keyId, "/v1/categories", "POST", 200)
  return c.json({
    success: true,
    category: { id, name, slug, description: body.description ?? null },
  })
})
