// src/routes/frontend/category.ts
// Category archive page: full-width banner hero, name + description, Pinterest grid.

import type { Context } from "hono"
import type { AppEnv, Category } from "../../lib/types"
import { loadSettings } from "../../lib/defaults"
import { renderLayout } from "../../views/frontend/Layout"
import { renderPinterestGrid } from "../../views/frontend/PinterestGrid"
import {
  fetchMenus,
  fetchCategories,
  fetchPostsForGrid,
} from "../../views/frontend/helpers"
import { buildPageHead, buildBreadcrumbJsonLd, buildCategoryPath } from "../../lib/seo"
import { escapeHtml, escapeAttr } from "../../lib/utils"

/** Render a category archive — hit by the slug router in routes/frontend/index.ts. */
export async function renderCategoryPage(
  c: Context<AppEnv>,
  category: Category
): Promise<Response> {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const settings = await loadSettings(siteDb)

  const perPage = Math.max(1, parseInt(settings.posts_per_page || "12", 10))

  const url = new URL(c.req.url)
  const pageParam = parseInt(url.searchParams.get("page") || "1", 10)
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1
  const offset = (page - 1) * perPage

  const [menus, categories, posts, totalRow] = await Promise.all([
    fetchMenus(siteDb, settings),
    fetchCategories(siteDb),
    fetchPostsForGrid(siteDb, settings, {
      categoryId: category.id,
      limit: perPage,
      offset,
    }),
    siteDb.execute({
      sql: "SELECT COUNT(*) AS n FROM posts WHERE category_id = ? AND published = 1 AND no_index = 0",
      args: [category.id],
    }),
  ])
  const total = Number(totalRow.rows[0]?.n ?? 0)
  const totalPages = Math.max(1, Math.ceil(total / perPage))

  const catPath = buildCategoryPath(category.slug, settings)
  const canonical = `https://${hostname}${catPath}`
  const firstPostImage = (posts[0] as { cover_image?: string | null } | undefined)?.cover_image ?? undefined
  const head = buildPageHead({ type: "category", category, url: canonical, firstPostImage }, settings)

  // Paginated pages: update canonical, title, and OG title.
  if (page > 1) {
    head.canonical = `${canonical}?page=${page}`
    const sep = settings.seo_title_separator || "|"
    const siteName = settings.seo_site_name || settings.site_name || ""
    const base = category.seo_title || category.name
    head.title = siteName ? `${base} — Page ${page} ${sep} ${siteName}` : `${base} — Page ${page}`
    head.ogTitle = head.title
  }

  const breadcrumbItems = [
    { name: "Home", url: `https://${hostname}/` },
    { name: category.name, url: canonical },
  ]

  const prevHref = page > 1 ? `${canonical}${page - 1 > 1 ? `?page=${page - 1}` : ""}` : null
  const nextHref = page < totalPages ? `${canonical}?page=${page + 1}` : null
  const extraHead = [
    prevHref ? `<link rel="prev" href="${escapeAttr(prevHref)}" />` : "",
    nextHref ? `<link rel="next" href="${escapeAttr(nextHref)}" />` : "",
    `<script type="application/ld+json">${JSON.stringify(
      buildBreadcrumbJsonLd(breadcrumbItems)
    ).replace(/</g, "\\u003c")}</script>`,
  ].filter(Boolean).join("\n  ")

  const heroBg = category.cover_image
    ? `style="--bg-image:url('${escapeAttr(category.cover_image)}')"`
    : ""

  const heroHtml = `<section class="category-hero ${
    category.cover_image ? "has-image" : ""
  }" ${heroBg}>
    <h1>${escapeHtml(category.name)}</h1>
    ${category.description ? `<p>${escapeHtml(category.description)}</p>` : ""}
  </section>`

  const paginationHtml = renderPagination(page, totalPages, catPath)

  const bodyHtml = `${heroHtml}
    ${renderPinterestGrid(posts, settings)}
    ${paginationHtml}`

  const html = renderLayout({
    head,
    settings,
    hostname,
    menus,
    categories,
    bodyHtml,
    extraHead,
    bodyClass: "page-category",
  })

  return c.html(html, 200, {
    "Cache-Control": "public, max-age=60, s-maxage=300",
  })
}

function renderPagination(page: number, totalPages: number, basePath: string): string {
  if (totalPages <= 1) return ""
  const prev = page > 1
    ? `<a class="pg-btn" href="${escapeAttr(basePath)}${page - 1 > 1 ? `?page=${page - 1}` : ""}">← Previous</a>`
    : ""
  const next = page < totalPages
    ? `<a class="pg-btn" href="${escapeAttr(basePath)}?page=${page + 1}">Next →</a>`
    : ""
  return `<nav class="pagination container" aria-label="Pagination" style="display:flex;justify-content:space-between;gap:12px;padding:32px 24px;">
    <div>${prev}</div>
    <span style="color:var(--color-muted);align-self:center;">Page ${page} of ${totalPages}</span>
    <div>${next}</div>
  </nav>
  <style>.pg-btn{display:inline-block;padding:10px 18px;border-radius:999px;background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-border);font-weight:500;}.pg-btn:hover{background:var(--color-primary);color:#fff;border-color:var(--color-primary);}</style>`
}
