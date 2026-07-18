// src/modules/seo/merchantService.ts
// Ecommerce SEO data layer (V1.3 P3): site-level shipping/returns config on
// seo_settings.merchant_json + per-product merchant fields, direct-written to
// the site CMS DB with a covenant-gated rebuild.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { siteDbFor, dispatchRebuild } from "./service"
import { parseMerchantConfig, type MerchantConfig, type MerchantProduct } from "./merchant"

export async function loadMerchantConfig(master: Client, cmsSiteId: string): Promise<MerchantConfig> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return parseMerchantConfig(null)
  const r = await siteDb.execute({ sql: "SELECT merchant_json FROM seo_settings WHERE id = 'default' LIMIT 1", args: [] }).catch(() => null)
  return parseMerchantConfig(r?.rows.length ? r.rows[0].merchant_json : null)
}

export async function saveMerchantConfig(
  env: CloudflareEnv, customerId: string, cmsSiteId: string, repoFullName: string | null,
  cfg: MerchantConfig, master: Client
): Promise<{ ok: boolean; error?: string }> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { ok: false, error: "The content workspace is unavailable." }
  await siteDb.execute({
    sql: `INSERT INTO seo_settings (id, merchant_json, updated_at) VALUES ('default', ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET merchant_json = excluded.merchant_json, updated_at = datetime('now')`,
    args: [JSON.stringify(cfg)],
  })
  await dispatchRebuild(env, master, customerId, repoFullName, "merchant-config")
  return { ok: true }
}

/** Published products with their merchant fields, for the bulk editor. */
export async function listMerchantProducts(master: Client, cmsSiteId: string, limit = 500): Promise<MerchantProduct[]> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return []
  const r = await siteDb
    .execute({ sql: "SELECT * FROM products ORDER BY created_at DESC LIMIT ?", args: [limit] })
    .catch(() => null)
  return (r?.rows ?? []).map((row) => {
    let images: string[] = []
    try {
      const a = JSON.parse(String(row.images ?? "[]")) as unknown
      if (Array.isArray(a)) images = a.map((x) => String(x))
    } catch {
      /* ignore */
    }
    return {
      id: String(row.id),
      slug: String(row.slug ?? ""),
      title: String(row.title ?? ""),
      description: String(row.description ?? ""),
      priceCents: Number(row.price_cents ?? 0),
      currency: String(row.currency ?? "usd"),
      images,
      sku: (row.sku as string | null) ?? null,
      inStock: String(row.stock_status ?? "in_stock") === "in_stock",
      brand: (row.brand as string | null) ?? null,
      gtin: (row.gtin as string | null) ?? null,
      mpn: (row.mpn as string | null) ?? null,
      condition: (row.condition as string | null) ?? null,
      ratingValue: row.rating_value == null ? null : Number(row.rating_value),
      ratingCount: row.rating_count == null ? null : Number(row.rating_count),
    }
  })
}

export interface ProductMerchantUpdate {
  id: string
  brand: string
  gtin: string
  mpn: string
  condition: string
  ratingValue: number | null
  ratingCount: number | null
}

/** Bulk-update per-product merchant fields. Skips bad rows, never throws. */
export async function saveMerchantProducts(
  env: CloudflareEnv, customerId: string, cmsSiteId: string, repoFullName: string | null,
  updates: ProductMerchantUpdate[], master: Client
): Promise<{ updated: number; error?: string }> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { updated: 0, error: "The content workspace is unavailable." }
  let updated = 0
  for (const u of updates) {
    if (!u.id) continue
    // Honest-ratings rule: both numbers or neither.
    const bothRatings = u.ratingValue != null && u.ratingCount != null
    try {
      const res = await siteDb.execute({
        sql: `UPDATE products SET brand=?, gtin=?, mpn=?, condition=?, rating_value=?, rating_count=?, updated_at=datetime('now') WHERE id=?`,
        args: [
          u.brand.trim() || null, u.gtin.trim() || null, u.mpn.trim() || null,
          ["new", "refurbished", "used"].includes(u.condition) ? u.condition : null,
          bothRatings ? u.ratingValue : null, bothRatings ? u.ratingCount : null, u.id,
        ],
      })
      updated += Number(res.rowsAffected ?? 0)
    } catch {
      /* skip row */
    }
  }
  if (updated) await dispatchRebuild(env, master, customerId, repoFullName, "merchant-products")
  return { updated }
}
