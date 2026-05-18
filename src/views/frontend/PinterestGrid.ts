// src/views/frontend/PinterestGrid.ts
// CSS multi-column masonry — no JS library needed.

import type { Settings, Category } from "../../lib/types"
import { escapeHtml, escapeAttr, formatDate, plainExcerpt } from "../../lib/utils"

export interface PinPost {
  id: string
  title: string
  slug: string
  url: string
  cover_image: string | null
  excerpt: string | null
  content: string
  published_at: string | null
  image_count: number
  category: { name: string; slug: string } | null
}

export function renderPinterestGrid(posts: PinPost[], settings: Settings): string {
  if (!posts.length) {
    return `<div class="container empty">
      <h2>No posts yet</h2>
      <p>Check back soon — new pins coming.</p>
    </div>`
  }

  const cols = settings.theme_grid_columns || "auto"
  const colClass =
    cols === "2" ? "cols-2" : cols === "3" ? "cols-3" : cols === "4" ? "cols-4" : "cols-auto"

  return `<div class="container">
    <div class="pinterest-grid ${colClass}">
      ${posts.map((p, i) => renderPinCard(p, settings, i === 0)).join("\n")}
    </div>
  </div>`
}

export function renderPinCard(post: PinPost, settings: Settings, eager = false): string {
  const showDate = settings.theme_show_post_dates === "true"
  const showBadge = settings.theme_show_category_badge === "true"
  const showCount = settings.theme_show_image_count === "true"
  const showExcerpt = settings.theme_show_excerpt === "true"
  const hover = settings.theme_pin_hover_effect || "slide-up"

  const excerpt = post.excerpt || plainExcerpt(post.content, 120)

  return `<article class="pin-card hover-${escapeAttr(hover)}">
    <a href="${escapeAttr(post.url)}">
      ${
        post.cover_image
          ? `<div class="pin-image-wrap">
              <img src="${escapeAttr(post.cover_image)}" alt="${escapeAttr(post.title)}" loading="${eager ? "eager" : "lazy"}"${eager ? ' fetchpriority="high"' : ""} decoding="async" />
              ${
                showCount && post.image_count > 1
                  ? `<span class="image-count-badge">${post.image_count} photos</span>`
                  : ""
              }
            </div>`
          : ""
      }
      <div class="pin-content">
        ${
          showBadge && post.category
            ? `<span class="category-badge">${escapeHtml(post.category.name)}</span>`
            : ""
        }
        <h2 class="pin-title">${escapeHtml(post.title)}</h2>
        ${
          showExcerpt && excerpt
            ? `<p class="pin-excerpt">${escapeHtml(excerpt)}</p>`
            : ""
        }
        <div class="pin-meta">
          ${showDate && post.published_at ? `<time>${escapeHtml(formatDate(post.published_at, settings.timezone || undefined))}</time>` : ""}
        </div>
      </div>
    </a>
  </article>`
}
