// src/routes/frontend/page.ts
// Static-page renderer (posts where type='page'). Reuses the post layout but
// without the BlogPosting JSON-LD (uses WebPage instead, handled by buildPageHead).

import type { Context } from "hono"
import type { AppEnv, Post, Category } from "../../lib/types"
import { loadSettings } from "../../lib/defaults"
import { renderLayout } from "../../views/frontend/Layout"
import {
  fetchMenus,
  fetchCategories,
  fetchPostImages,
} from "../../views/frontend/helpers"
import { buildPageHead, buildBreadcrumbJsonLd } from "../../lib/seo"
import { escapeHtml, escapeAttr, formatDate } from "../../lib/utils"

export async function renderStaticPage(
  c: Context<AppEnv>,
  post: Post & { category?: Category | null }
): Promise<Response> {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const settings = await loadSettings(siteDb)

  const [menus, categories, images] = await Promise.all([
    fetchMenus(siteDb, settings),
    fetchCategories(siteDb),
    fetchPostImages(siteDb, post.id),
  ])

  const url = `https://${hostname}/${post.slug}/`
  const head = buildPageHead({ type: "page", post: { ...post, images }, url }, settings)

  const breadcrumbItems = [
    { name: "Home", url: `https://${hostname}/` },
    { name: post.title, url },
  ]
  const extraHead = `<script type="application/ld+json">${JSON.stringify(
    buildBreadcrumbJsonLd(breadcrumbItems)
  ).replace(/</g, "\\u003c")}</script>`

  const heroHtml = post.cover_image
    ? `<div class="post-hero">
         <img src="${escapeAttr(post.cover_image)}" alt="${escapeAttr(post.title)}" />
       </div>`
    : ""

  const bodyHtml = `
    <article class="post-article">
      <nav class="breadcrumbs" aria-label="Breadcrumb">
        <a href="/">Home</a><span>›</span><span aria-current="page">${escapeHtml(post.title)}</span>
      </nav>
      ${heroHtml}
      <h1>${escapeHtml(post.title)}</h1>
      ${
        post.published_at
          ? `<div class="post-meta"><time datetime="${escapeAttr(post.published_at)}">${escapeHtml(formatDate(post.published_at))}</time></div>`
          : ""
      }
      <div class="post-content">${post.content}</div>
    </article>
  `

  const html = renderLayout({
    head,
    settings,
    hostname,
    menus,
    categories,
    bodyHtml,
    extraHead,
    bodyClass: "page-static",
  })

  return c.html(html, 200, {
    "Cache-Control": "public, max-age=60, s-maxage=300",
  })
}
