// src/views/frontend/helpers.ts
// Data-fetch helpers shared by frontend routes.

import type { Client } from "@libsql/client/web"
import type { MenuItem, Category, Settings, Post } from "../../lib/types"
import { buildPostPath, buildCategoryPath } from "../../lib/seo"
import type { PinPost } from "./PinterestGrid"

export async function fetchMenus(siteDb: Client, settings: Settings): Promise<{
  header: MenuItem[]
  footer: MenuItem[]
}> {
  const all = await siteDb.execute(
    "SELECT * FROM menu_items ORDER BY ord ASC, created_at ASC"
  )
  const items = all.rows as unknown as MenuItem[]

  // Resolve URLs for items that point to a post via post_id.
  const postIds = items.filter((i) => i.post_id && !i.url).map((i) => i.post_id as string)
  const postUrlMap = new Map<string, string>()
  if (postIds.length) {
    const placeholders = postIds.map(() => "?").join(",")
    const rows = await siteDb.execute({
      sql: `SELECT p.id, p.slug, p.published_at, p.created_at, c.slug AS cat_slug
            FROM posts p LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.id IN (${placeholders})`,
      args: postIds,
    })
    for (const r of rows.rows) {
      const path = buildPostPath(
        {
          slug: r.slug as string,
          published_at: (r.published_at as string | null) ?? null,
          created_at: r.created_at as string,
        },
        r.cat_slug ? ({ slug: r.cat_slug as string } as Category) : null,
        settings
      )
      postUrlMap.set(r.id as string, path)
    }
  }

  const resolved = items.map((it) => ({
    ...it,
    url: it.url ?? (it.post_id ? postUrlMap.get(it.post_id) ?? "#" : "#"),
  }))

  return {
    header: resolved.filter((i) => i.location === "header"),
    footer: resolved.filter((i) => i.location === "footer"),
  }
}

export async function fetchCategories(siteDb: Client): Promise<Category[]> {
  const r = await siteDb.execute("SELECT * FROM categories ORDER BY name ASC")
  return r.rows as unknown as Category[]
}

export async function fetchPostsForGrid(
  siteDb: Client,
  settings: Settings,
  options: {
    categoryId?: string
    limit?: number
    offset?: number
    type?: "post" | "page"
  } = {}
): Promise<PinPost[]> {
  const { categoryId, limit = 12, offset = 0, type = "post" } = options

  const filters: string[] = ["p.published = 1", "p.type = ?", "p.no_index = 0"]
  const args: Array<string | number | null> = [type]
  if (categoryId) {
    filters.push("p.category_id = ?")
    args.push(categoryId)
  }

  args.push(limit, offset)

  const rows = await siteDb.execute({
    sql: `SELECT p.id, p.title, p.slug, p.cover_image, p.excerpt, p.content, p.published_at, p.created_at,
                 c.id AS cat_id, c.name AS cat_name, c.slug AS cat_slug,
                 (SELECT COUNT(*) FROM post_images pi WHERE pi.post_id = p.id) AS image_count
          FROM posts p
          LEFT JOIN categories c ON c.id = p.category_id
          WHERE ${filters.join(" AND ")}
          ORDER BY p.published_at DESC, p.created_at DESC
          LIMIT ? OFFSET ?`,
    args,
  })

  return rows.rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    slug: r.slug as string,
    cover_image: (r.cover_image as string | null) ?? null,
    excerpt: (r.excerpt as string | null) ?? null,
    content: (r.content as string) ?? "",
    published_at: (r.published_at as string | null) ?? null,
    image_count: Number(r.image_count ?? 0),
    category: r.cat_id
      ? { name: r.cat_name as string, slug: r.cat_slug as string }
      : null,
    url: buildPostPath(
      {
        slug: r.slug as string,
        published_at: (r.published_at as string | null) ?? null,
        created_at: r.created_at as string,
      },
      r.cat_slug ? ({ slug: r.cat_slug as string } as Category) : null,
      settings
    ),
  }))
}

export async function fetchRelatedPosts(
  siteDb: Client,
  settings: Settings,
  post: Post,
  limit = 6
): Promise<PinPost[]> {
  // Same-category posts preferred; fall back to recent posts for uncategorised content.
  const rows = await siteDb.execute(
    post.category_id
      ? {
          sql: `SELECT p.id, p.title, p.slug, p.cover_image, p.excerpt, p.content, p.published_at, p.created_at,
                       c.id AS cat_id, c.name AS cat_name, c.slug AS cat_slug,
                       (SELECT COUNT(*) FROM post_images pi WHERE pi.post_id = p.id) AS image_count
                FROM posts p LEFT JOIN categories c ON c.id = p.category_id
                WHERE p.category_id = ? AND p.id != ? AND p.published = 1 AND p.no_index = 0 AND p.type = 'post'
                ORDER BY p.published_at DESC LIMIT ?`,
          args: [post.category_id, post.id, limit],
        }
      : {
          sql: `SELECT p.id, p.title, p.slug, p.cover_image, p.excerpt, p.content, p.published_at, p.created_at,
                       c.id AS cat_id, c.name AS cat_name, c.slug AS cat_slug,
                       (SELECT COUNT(*) FROM post_images pi WHERE pi.post_id = p.id) AS image_count
                FROM posts p LEFT JOIN categories c ON c.id = p.category_id
                WHERE p.id != ? AND p.published = 1 AND p.no_index = 0 AND p.type = 'post'
                ORDER BY p.published_at DESC LIMIT ?`,
          args: [post.id, limit],
        }
  )
  return rows.rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    slug: r.slug as string,
    cover_image: (r.cover_image as string | null) ?? null,
    excerpt: (r.excerpt as string | null) ?? null,
    content: (r.content as string) ?? "",
    published_at: (r.published_at as string | null) ?? null,
    image_count: Number(r.image_count ?? 0),
    category: r.cat_id
      ? { name: r.cat_name as string, slug: r.cat_slug as string }
      : null,
    url: buildPostPath(
      {
        slug: r.slug as string,
        published_at: (r.published_at as string | null) ?? null,
        created_at: r.created_at as string,
      },
      r.cat_slug ? ({ slug: r.cat_slug as string } as Category) : null,
      settings
    ),
  }))
}

export async function fetchPostImages(
  siteDb: Client,
  postId: string
): Promise<Array<{ url: string; alt: string; caption: string | null }>> {
  const rows = await siteDb.execute({
    sql: "SELECT url, alt, caption FROM post_images WHERE post_id = ? ORDER BY ord ASC",
    args: [postId],
  })
  return rows.rows.map((r) => ({
    url: r.url as string,
    alt: (r.alt as string | null) ?? "",
    caption: (r.caption as string | null) ?? null,
  }))
}

export { buildCategoryPath }
