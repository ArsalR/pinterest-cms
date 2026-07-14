// src/routes/public/v1/products.ts
// Ecommerce products (amendment 2). Same frozen-API conventions as posts:
// Bearer key auth per handler, typed errors, request logging. Additive — new
// routes only; existing shapes untouched. The static site build reads GET
// /v1/products at build time (like posts); genesis/automation writes via POST.

import { Hono } from "hono"
import type { AppEnv } from "../../../lib/types"
import { validateApiKey, logApiRequest } from "../../../lib/apiAuth"
import { apiError } from "../../../lib/errors"
import { cuid, slugify } from "../../../lib/utils"
import { ensureUniqueSlug } from "../../../lib/slugs"

export const productRoutes = new Hono<AppEnv>()

interface ProductRow {
  id: string
  slug: string
  title: string
  description: string | null
  price_cents: number
  currency: string
  images: string
  sku: string | null
  stock_status: string
  digital: number
  published: number
  category_id: string | null
  category_slug?: string | null
  seo_title: string | null
  seo_description: string | null
  created_at: string
  updated_at: string
}

/** Price integrity (pure, unit-tested): accept priceCents (int) or price
 *  (dollars), always return a non-negative integer cents value, or null if
 *  the input is invalid money. Never trust client-side price math. */
export function parsePriceCents(input: { priceCents?: number; price?: number }): number | null {
  const cents =
    typeof input.priceCents === "number"
      ? Math.round(input.priceCents)
      : typeof input.price === "number"
        ? Math.round(input.price * 100)
        : 0
  if (!Number.isFinite(cents) || cents < 0) return null
  return cents
}

export function serialize(r: ProductRow) {
  let images: string[] = []
  try {
    const parsed = JSON.parse(r.images || "[]")
    if (Array.isArray(parsed)) images = parsed.filter((x): x is string => typeof x === "string")
  } catch {
    // corrupt images JSON → empty; never breaks the build
  }
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    priceCents: Number(r.price_cents ?? 0),
    currency: r.currency,
    images,
    sku: r.sku,
    stockStatus: r.stock_status,
    digital: r.digital === 1,
    published: r.published === 1,
    categorySlug: (r.category_slug as string | null) ?? null,
    seoTitle: r.seo_title,
    seoDescription: r.seo_description,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// ─────────────── GET /v1/products ───────────────
productRoutes.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const auth = await validateApiKey(siteDb, c.req.raw, "read")
  if (auth.error) return apiError(c, auth.status, auth.code, auth.error)

  const url = new URL(c.req.url)
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1), 200)
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0", 10) || 0, 0)
  const publishedParam = url.searchParams.get("published") ?? "true"

  const where: string[] = []
  const args: Array<string | number> = []
  if (publishedParam === "true") where.push("p.published = 1")
  else if (publishedParam === "false") where.push("p.published = 0")
  // "all" → no filter

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const totalRow = await siteDb.execute({ sql: `SELECT COUNT(*) AS n FROM products p ${whereSql}`, args })
  const rows = await siteDb.execute({
    sql: `SELECT p.*, c.slug AS category_slug FROM products p
          LEFT JOIN categories c ON c.id = p.category_id
          ${whereSql} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    args: [...args, limit, offset],
  })

  await logApiRequest(siteDb, auth.keyId, "/v1/products", "GET", 200)
  return c.json({
    success: true,
    products: rows.rows.map((r) => serialize(r as unknown as ProductRow)),
    total: Number(totalRow.rows[0]?.n ?? 0),
    limit,
    offset,
  })
})

// ─────────────── GET /v1/products/:id ───────────────
productRoutes.get("/:id", async (c) => {
  const siteDb = c.get("siteDb")
  const auth = await validateApiKey(siteDb, c.req.raw, "read")
  if (auth.error) return apiError(c, auth.status, auth.code, auth.error)

  const id = c.req.param("id")
  const r = await siteDb.execute({
    sql: `SELECT p.*, c.slug AS category_slug FROM products p
          LEFT JOIN categories c ON c.id = p.category_id
          WHERE p.id = ? OR p.slug = ? LIMIT 1`,
    args: [id, id],
  })
  if (!r.rows.length) {
    await logApiRequest(siteDb, auth.keyId, `/v1/products/${id}`, "GET", 404)
    return apiError(c, 404, "not_found", "Product not found")
  }
  await logApiRequest(siteDb, auth.keyId, `/v1/products/${id}`, "GET", 200)
  return c.json({ success: true, product: serialize(r.rows[0] as unknown as ProductRow) })
})

// ─────────────── POST /v1/products ───────────────
interface CreateProductBody {
  title?: string
  slug?: string
  description?: string
  priceCents?: number
  price?: number // dollars convenience; converted to cents
  currency?: string
  images?: string[]
  sku?: string
  stockStatus?: "in_stock" | "out_of_stock"
  digital?: boolean
  published?: boolean
  category?: string // slug
  seoTitle?: string
  seoDescription?: string
}

productRoutes.post("/", async (c) => {
  const siteDb = c.get("siteDb")
  const auth = await validateApiKey(siteDb, c.req.raw, "write")
  if (auth.error) return apiError(c, auth.status, auth.code, auth.error)

  let body: CreateProductBody
  try {
    body = await c.req.json<CreateProductBody>()
  } catch {
    await logApiRequest(siteDb, auth.keyId, "/v1/products", "POST", 400)
    return apiError(c, 400, "validation_invalid_value", "Invalid JSON body")
  }

  const title = (body.title ?? "").trim()
  if (!title) {
    await logApiRequest(siteDb, auth.keyId, "/v1/products", "POST", 400)
    return apiError(c, 400, "validation_required_field", "title is required", { field: "title" })
  }
  // Price integrity: cents only, non-negative integer. Reject bad money early.
  const priceCents = parsePriceCents(body)
  if (priceCents === null) {
    await logApiRequest(siteDb, auth.keyId, "/v1/products", "POST", 400)
    return apiError(c, 400, "validation_invalid_value", "price must be a non-negative number", { field: "price" })
  }

  // Resolve category slug → id (does not auto-create; products reference existing categories).
  let categoryId: string | null = null
  if (body.category) {
    const cat = await siteDb.execute({
      sql: "SELECT id FROM categories WHERE slug = ? LIMIT 1",
      args: [slugify(body.category)],
    })
    categoryId = cat.rows.length ? (cat.rows[0].id as string) : null
  }

  const finalSlug = await ensureUniqueSlug(siteDb, body.slug ? slugify(body.slug) : slugify(title))
  const images = Array.isArray(body.images) ? body.images.filter((x) => typeof x === "string") : []
  const id = cuid()

  await siteDb.execute({
    sql: `INSERT INTO products
      (id, slug, title, description, price_cents, currency, images, sku, stock_status, digital, published, category_id, seo_title, seo_description, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', datetime('now'), datetime('now'))`,
    args: [
      id,
      finalSlug,
      title,
      body.description ?? null,
      priceCents,
      (body.currency ?? "usd").toLowerCase(),
      JSON.stringify(images),
      body.sku ?? null,
      body.stockStatus === "out_of_stock" ? "out_of_stock" : "in_stock",
      body.digital ? 1 : 0,
      body.published ? 1 : 0,
      categoryId,
      body.seoTitle ?? null,
      body.seoDescription ?? null,
    ],
  })

  await logApiRequest(siteDb, auth.keyId, "/v1/products", "POST", 201, id)
  return c.json(
    {
      success: true,
      product: {
        id,
        slug: finalSlug,
        title,
        priceCents,
        currency: (body.currency ?? "usd").toLowerCase(),
        published: Boolean(body.published),
      },
    },
    201
  )
})
