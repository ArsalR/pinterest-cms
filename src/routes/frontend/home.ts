// src/routes/frontend/home.ts
// GET / — Pinterest-style grid of latest posts, OR a static page (settings.homepage_type),
//          OR a search results page when ?s=<query> is present.

import { Hono } from "hono"
import type { Context } from "hono"
import type { AppEnv, Post } from "../../lib/types"
import { loadSettings } from "../../lib/defaults"
import { renderLayout } from "../../views/frontend/Layout"
import { renderPinterestGrid } from "../../views/frontend/PinterestGrid"
import { buildPageHead, buildPostPath } from "../../lib/seo"
import { escapeHtml } from "../../lib/utils"
import {
  fetchMenus,
  fetchCategories,
  fetchPostsForGrid,
} from "../../views/frontend/helpers"
import { renderStaticPage } from "./page"

export const homeRoute = new Hono<AppEnv>()

homeRoute.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const settings = await loadSettings(siteDb)
  const url = new URL(c.req.url)

  // Search? Handle here so the header search form actually works.
  const search = (url.searchParams.get("s") || "").trim()
  if (search) {
    return renderSearchResults(c, search, settings)
  }

  // Static page homepage?
  if (settings.homepage_type === "static" && settings.homepage_static_slug) {
    const r = await siteDb.execute({
      sql: "SELECT * FROM posts WHERE slug = ? AND type = 'page' AND published = 1 LIMIT 1",
      args: [settings.homepage_static_slug],
    })
    if (r.rows.length) {
      return renderStaticPage(c, r.rows[0] as unknown as Post)
    }
    // If configured slug doesn't resolve, fall through to latest posts.
  }

  // Default: latest posts grid.
  const perPage = Math.max(1, parseInt(settings.posts_per_page || "24", 10))

  const [menus, categories, posts] = await Promise.all([
    fetchMenus(siteDb, settings),
    fetchCategories(siteDb),
    fetchPostsForGrid(siteDb, settings, { limit: perPage, offset: 0 }),
  ])

  const firstPostImage = (posts[0] as { cover_image?: string | null } | undefined)?.cover_image ?? undefined
  const head = buildPageHead({ type: "home", url: `https://${hostname}/`, firstPostImage }, settings)

  const html = renderLayout({
    head,
    settings,
    hostname,
    menus,
    categories,
    bodyHtml: renderPinterestGrid(posts, settings),
    bodyClass: "page-home",
  })

  return c.html(html, 200, {
    "Cache-Control": "public, max-age=60, s-maxage=300",
  })
})

// ──────────────── Search results ────────────────
async function renderSearchResults(
  c: Context<AppEnv>,
  query: string,
  settings: Record<string, string>
): Promise<Response> {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")

  const like = `%${query.replace(/[%_\\]/g, "\\$&")}%`
  const [menus, categories, hits] = await Promise.all([
    fetchMenus(siteDb, settings),
    fetchCategories(siteDb),
    siteDb.execute({
      sql: `SELECT p.id, p.title, p.slug, p.cover_image, p.excerpt, p.content,
                   p.published_at, p.created_at,
                   c.id AS cat_id, c.name AS cat_name, c.slug AS cat_slug,
                   (SELECT COUNT(*) FROM post_images pi WHERE pi.post_id = p.id) AS image_count
            FROM posts p LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.type = 'post' AND p.published = 1 AND p.no_index = 0
              AND (p.title LIKE ? ESCAPE '\\' OR p.excerpt LIKE ? ESCAPE '\\' OR p.content LIKE ? ESCAPE '\\')
            ORDER BY p.published_at DESC LIMIT 60`,
      args: [like, like, like],
    }),
  ])

  const posts = hits.rows.map((r) => {
    const slug = r.slug as string
    const catSlug = r.cat_slug as string | null
    const publishedAt = (r.published_at as string | null) ?? null
    const created = r.created_at as string
    return {
      id: r.id as string,
      title: r.title as string,
      slug,
      url: buildPostPath(
        { slug, published_at: publishedAt, created_at: created },
        catSlug ? ({ slug: catSlug } as never) : null,
        settings
      ),
      cover_image: r.cover_image as string | null,
      excerpt: r.excerpt as string | null,
      content: r.content as string,
      published_at: publishedAt,
      image_count: Number(r.image_count ?? 0),
      category: r.cat_id
        ? { name: r.cat_name as string, slug: catSlug as string }
        : null,
    }
  })

  const head = buildPageHead({ type: "home", url: `https://${hostname}/?s=${encodeURIComponent(query)}` }, settings)
  // Override title and force noindex for search results.
  head.title = `Search: ${query} — ${settings.site_name || hostname}`
  head.robots = "noindex,follow"

  const heading = `<div class="container" style="padding-top:24px;padding-bottom:8px">
    <h1 style="font-family:var(--font-heading);font-size:32px;letter-spacing:-0.02em">Search results for &ldquo;${escapeHtml(query)}&rdquo;</h1>
    <p style="color:var(--color-muted);margin-top:6px">${posts.length} result${posts.length === 1 ? "" : "s"}</p>
  </div>`

  const grid = posts.length
    ? renderPinterestGrid(posts, settings)
    : `<div class="container" style="padding:60px 0;text-align:center;color:var(--color-muted)">No posts match your search. <a href="/" style="color:var(--color-primary)">← Back home</a></div>`

  return c.html(
    renderLayout({
      head,
      settings,
      hostname,
      menus,
      categories,
      bodyHtml: heading + grid,
      bodyClass: "page-search",
    }),
    200,
    { "Cache-Control": "public, max-age=30, s-maxage=60" }
  )
}
