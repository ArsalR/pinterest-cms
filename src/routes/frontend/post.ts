// src/routes/frontend/post.ts
// Post detail page: hero image, content, gallery + lightbox, share, related, breadcrumbs.

import type { Context } from "hono"
import type { AppEnv, Post, Category } from "../../lib/types"
import { loadSettings } from "../../lib/defaults"
import { renderLayout } from "../../views/frontend/Layout"
import { renderPinterestGrid } from "../../views/frontend/PinterestGrid"
import type { PinPost } from "../../views/frontend/PinterestGrid"
import {
  fetchMenus,
  fetchCategories,
  fetchPostImages,
  fetchRelatedPosts,
} from "../../views/frontend/helpers"
import {
  buildPageHead,
  buildPostPath,
  buildCategoryPath,
  buildBreadcrumbJsonLd,
} from "../../lib/seo"
import {
  escapeHtml,
  escapeAttr,
  formatDate,
  readingTime,
  sanitizePostHtml,
} from "../../lib/utils"

export {}

/** Render a single post — hit by the slug router in routes/frontend/index.ts. */
export async function renderPostPage(
  c: Context<AppEnv>,
  post: Post & { category?: Category | null }
): Promise<Response> {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const settings = await loadSettings(siteDb)

  const [menus, categories, images, related, safeContent] = await Promise.all([
    fetchMenus(siteDb, settings),
    fetchCategories(siteDb),
    fetchPostImages(siteDb, post.id),
    settings.theme_show_related_posts === "true"
      ? fetchRelatedPosts(siteDb, settings, post, 6)
      : Promise.resolve<PinPost[]>([]),
    sanitizePostHtml(post.content || ""),
  ])

  const path = buildPostPath(post, post.category ?? null, settings)
  const url = `https://${hostname}${path}`

  const head = buildPageHead(
    {
      type: post.type === "page" ? "page" : "post",
      post: { ...post, images },
      url,
    },
    settings
  )

  // Breadcrumbs JSON-LD added as extra <script> tag in head.
  const breadcrumbItems = [
    { name: "Home", url: `https://${hostname}/` },
    ...(post.category
      ? [
          {
            name: post.category.name,
            url: `https://${hostname}${buildCategoryPath(post.category.slug, settings)}`,
          },
        ]
      : []),
    { name: post.title, url },
  ]
  const breadcrumbJsonLd = buildBreadcrumbJsonLd(breadcrumbItems)
  const extraHead = `<script type="application/ld+json">${JSON.stringify(
    breadcrumbJsonLd
  ).replace(/</g, "\\u003c")}</script>`

  const lightboxEnabled = settings.theme_enable_lightbox === "true"
  const showShare = settings.theme_show_share_buttons === "true"
  const showAuthor = settings.theme_show_author === "true"
  const showReadingTime = settings.theme_show_reading_time === "true"
  const showDate = settings.theme_show_post_dates === "true"

  const bodyHtml = renderPostBody({
    post,
    safeContent,
    images,
    related,
    settings,
    hostname,
    url,
    breadcrumbs: breadcrumbItems,
    showShare,
    showAuthor,
    showReadingTime,
    showDate,
    lightboxEnabled,
  })

  const inlineScript = lightboxEnabled && images.length > 0
    ? buildLightboxScript()
    : ""

  const html = renderLayout({
    head,
    settings,
    hostname,
    menus,
    categories,
    bodyHtml,
    post,
    extraHead,
    bodyClass: "page-post",
    inlineScript,
  })

  return c.html(html, 200, {
    "Cache-Control": "public, max-age=60, s-maxage=300",
  })
}

interface PostBodyInput {
  post: Post & { category?: Category | null }
  safeContent: string
  images: Array<{ url: string; alt: string; caption: string | null }>
  related: PinPost[]
  settings: Record<string, string>
  hostname: string
  url: string
  breadcrumbs: Array<{ name: string; url: string }>
  showShare: boolean
  showAuthor: boolean
  showReadingTime: boolean
  showDate: boolean
  lightboxEnabled: boolean
}

function renderPostBody(input: PostBodyInput): string {
  const {
    post,
    safeContent,
    images,
    related,
    settings,
    url,
    breadcrumbs,
    showShare,
    showAuthor,
    showReadingTime,
    showDate,
    lightboxEnabled,
  } = input

  const minutes = readingTime(post.content)
  const breadcrumbsHtml = renderBreadcrumbs(breadcrumbs)
  const galleryHtml = renderGallery(images, lightboxEnabled)
  const shareHtml = showShare
    ? renderShareButtons(url, post.title, post.cover_image ?? "")
    : ""
  const relatedHtml = related.length
    ? `<section class="related-section">
         <div class="container">
           <h2>You might also like</h2>
           ${renderPinterestGrid(related, settings)}
         </div>
       </section>`
    : ""

  const heroHtml = post.cover_image
    ? `<div class="post-hero">
         <img src="${escapeAttr(post.cover_image)}" alt="${escapeAttr(post.title)}" loading="eager" fetchpriority="high" decoding="async" />
       </div>`
    : ""

  const metaParts: string[] = []
  if (post.category) {
    metaParts.push(
      `<a href="${escapeAttr(buildCategoryPath(post.category.slug, input.settings))}" class="post-category-link">${escapeHtml(post.category.name)}</a>`
    )
  }
  if (showDate && post.published_at) {
    metaParts.push(`<time datetime="${escapeAttr(post.published_at)}">${escapeHtml(formatDate(post.published_at))}</time>`)
  }
  if (showAuthor && settings.site_name) {
    metaParts.push(`<span>By ${escapeHtml(settings.site_name)}</span>`)
  }
  if (showReadingTime) {
    metaParts.push(`<span>${minutes} min read</span>`)
  }

  return `
    <article class="post-article">
      ${breadcrumbsHtml}
      ${heroHtml}
      <h1>${escapeHtml(post.title)}</h1>
      <div class="post-meta">${metaParts.join("<span>·</span>")}</div>
      <div class="post-content">${safeContent}</div>
      ${galleryHtml}
      ${shareHtml}
    </article>
    ${relatedHtml}
  `
}

function renderBreadcrumbs(items: Array<{ name: string; url: string }>): string {
  if (items.length < 2) return ""
  const parts = items.map((it, i) => {
    const isLast = i === items.length - 1
    return isLast
      ? `<span aria-current="page">${escapeHtml(it.name)}</span>`
      : `<a href="${escapeAttr(it.url)}">${escapeHtml(it.name)}</a>`
  })
  return `<nav class="breadcrumbs" aria-label="Breadcrumb">${parts.join('<span>›</span>')}</nav>`
}

function renderGallery(
  images: Array<{ url: string; alt: string; caption: string | null }>,
  lightboxEnabled: boolean
): string {
  if (!images.length) return ""
  const items = images
    .map(
      (img, i) =>
        `<div class="gallery-item" ${
          lightboxEnabled ? `data-lb-index="${i}"` : ""
        }>
          <img src="${escapeAttr(img.url)}" alt="${escapeAttr(img.alt || "")}" loading="lazy" decoding="async" />
          ${img.caption ? `<figcaption>${escapeHtml(img.caption)}</figcaption>` : ""}
        </div>`
    )
    .join("")
  return `<div class="post-gallery">${items}</div>
    ${lightboxEnabled ? buildLightboxMarkup() : ""}`
}

function buildLightboxMarkup(): string {
  return `<div class="lightbox" id="cms-lightbox" role="dialog" aria-modal="true" aria-hidden="true">
    <button class="lb-close" aria-label="Close">&times;</button>
    <button class="lb-prev" aria-label="Previous">&larr;</button>
    <img id="cms-lightbox-img" alt="" />
    <button class="lb-next" aria-label="Next">&rarr;</button>
    <div class="lb-count" id="cms-lightbox-count"></div>
  </div>`
}

function buildLightboxScript(): string {
  return `<script>
(function(){
  var items = Array.prototype.slice.call(document.querySelectorAll('.gallery-item[data-lb-index]'));
  if (!items.length) return;
  var lb = document.getElementById('cms-lightbox');
  if (!lb) return;
  var img = document.getElementById('cms-lightbox-img');
  var count = document.getElementById('cms-lightbox-count');
  var prev = lb.querySelector('.lb-prev');
  var next = lb.querySelector('.lb-next');
  var close = lb.querySelector('.lb-close');
  var srcs = items.map(function(it){
    var i = it.querySelector('img');
    return { src: i.getAttribute('src'), alt: i.getAttribute('alt') || '' };
  });
  var idx = 0;
  function show(i){
    idx = (i + srcs.length) % srcs.length;
    img.src = srcs[idx].src;
    img.alt = srcs[idx].alt;
    count.textContent = (idx + 1) + ' / ' + srcs.length;
  }
  function open(i){ show(i); lb.classList.add('open'); lb.setAttribute('aria-hidden','false'); document.body.style.overflow = 'hidden'; }
  function shut(){ lb.classList.remove('open'); lb.setAttribute('aria-hidden','true'); document.body.style.overflow = ''; }
  items.forEach(function(it, i){ it.addEventListener('click', function(){ open(i); }); });
  prev.addEventListener('click', function(e){ e.stopPropagation(); show(idx - 1); });
  next.addEventListener('click', function(e){ e.stopPropagation(); show(idx + 1); });
  close.addEventListener('click', shut);
  lb.addEventListener('click', function(e){ if (e.target === lb) shut(); });
  document.addEventListener('keydown', function(e){
    if (!lb.classList.contains('open')) return;
    if (e.key === 'Escape') shut();
    if (e.key === 'ArrowLeft') show(idx - 1);
    if (e.key === 'ArrowRight') show(idx + 1);
  });
})();
</script>`
}

function renderShareButtons(url: string, title: string, image: string): string {
  const u = encodeURIComponent(url)
  const t = encodeURIComponent(title)
  const i = encodeURIComponent(image)
  return `<div class="share-row">
    <a class="share-btn" target="_blank" rel="noopener" href="https://www.pinterest.com/pin/create/button/?url=${u}&description=${t}&media=${i}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.5 2 2 6.5 2 12c0 4.2 2.6 7.8 6.3 9.3-.1-.8-.2-2 0-2.9.2-.7 1.2-4.5 1.2-4.5s-.3-.6-.3-1.5c0-1.4.8-2.5 1.9-2.5.9 0 1.3.7 1.3 1.5 0 .9-.6 2.3-.9 3.6-.3 1.1.5 2 1.6 2 2 0 3.5-2.1 3.5-5.1 0-2.7-1.9-4.6-4.7-4.6-3.2 0-5 2.4-5 4.8 0 1 .4 2 .8 2.6 0 .1.1.1.1.2-.1.4-.3 1.1-.3 1.3-.1.2-.2.2-.4.1-1.5-.7-2.4-2.9-2.4-4.6 0-3.7 2.7-7.2 7.8-7.2 4.1 0 7.3 2.9 7.3 6.8 0 4.1-2.6 7.4-6.1 7.4-1.2 0-2.3-.6-2.7-1.4l-.7 2.8c-.3 1-1 2.3-1.5 3.1.9.3 1.9.4 2.9.4 5.5 0 10-4.5 10-10S17.5 2 12 2z"/></svg>
      Pinterest
    </a>
    <a class="share-btn" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?url=${u}&text=${t}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
      Twitter
    </a>
    <a class="share-btn" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=${u}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22 12c0-5.5-4.5-10-10-10S2 6.5 2 12c0 5 3.7 9.1 8.4 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.2 0-1.6.8-1.6 1.6V12h2.8l-.4 2.9h-2.3v7c4.7-.7 8.4-4.8 8.4-9.9z"/></svg>
      Facebook
    </a>
    <button class="share-btn" type="button" onclick="navigator.clipboard&amp;&amp;navigator.clipboard.writeText(location.href);this.textContent='Copied!';setTimeout(()=&gt;this.innerHTML='Copy Link',1500)">Copy Link</button>
  </div>`
}
