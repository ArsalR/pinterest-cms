// src/views/frontend/Layout.ts
// Layout wrapper used by all public-facing pages.
// Returns a complete HTML document as a string (Workers-friendly, no JSX runtime).

import type { Settings, MenuItem, Category, Post } from "../../lib/types"
import { renderThemeStyleTag, buildGoogleFontsUrl } from "../../lib/theme"
import { renderHeadHtml, type PageHead, buildCategoryPath } from "../../lib/seo"
import { escapeHtml, escapeAttr } from "../../lib/utils"

export interface LayoutInput {
  head: PageHead
  settings: Settings
  hostname: string
  menus: { header: MenuItem[]; footer: MenuItem[] }
  categories: Category[]
  bodyHtml: string
  /** Post for article meta tags (article:published_time etc.) */
  post?: Post
  /** Optional extra <head> tags (e.g. category RSS link). */
  extraHead?: string
  /** Optional body classes. */
  bodyClass?: string
  /** Inject a <script> tag at end of body — used by lightbox/customizer preview. */
  inlineScript?: string
}

export function renderLayout(input: LayoutInput): string {
  const { head, settings, menus, categories, bodyHtml, hostname, post } = input
  const fontsUrl = buildGoogleFontsUrl(settings)
  const themeTag = renderThemeStyleTag(settings)
  const headTags = renderHeadHtml(head, settings, post)
  const headerHtml = renderHeader(settings, menus.header, categories)
  const footerHtml = renderFooter(settings, menus.footer, categories)
  const baseStyles = renderBaseStyles()

  // Favicon: explicit setting wins, else generate an SVG with the brand initial
  // so /favicon.ico requests don't 404 (Google Search Console flags those).
  const faviconHref = settings.site_favicon
    ? settings.site_favicon
    : `data:image/svg+xml,${encodeURIComponent(buildBrandFaviconSvg(settings))}`
  const appleTouchIcon = settings.site_logo || faviconHref

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="generator" content="Pinterest CMS" />
  ${headTags}
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="${escapeAttr(fontsUrl)}" />
  <link rel="icon" href="${escapeAttr(faviconHref)}" />
  <link rel="apple-touch-icon" href="${escapeAttr(appleTouchIcon)}" />
  <link rel="alternate" type="application/rss+xml" title="RSS" href="https://${escapeAttr(hostname)}/feed.xml" />
  <link rel="sitemap" type="application/xml" href="https://${escapeAttr(hostname)}/sitemap.xml" />
  ${baseStyles}
  ${themeTag}
  ${input.extraHead ?? ""}
</head>
<body class="${escapeAttr(input.bodyClass ?? "")}">
  ${headerHtml}
  <main class="site-main">
    ${bodyHtml}
  </main>
  ${footerHtml}
  ${input.inlineScript ?? ""}
  ${renderPreviewListener()}
</body>
</html>`
}

function renderBaseStyles(): string {
  return `<style id="cms-base">
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-body);
  font-size: var(--font-size-base);
  line-height: var(--line-height);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
a { color: inherit; text-decoration: none; }
img, svg, video { display: block; max-width: 100%; height: auto; }
h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-heading);
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.01em;
  margin: 0 0 0.5em;
  color: var(--color-text);
}
h1 { font-size: clamp(2rem, 5vw, 3.25rem); letter-spacing: -0.025em; }
h2 { font-size: clamp(1.5rem, 3vw, 2rem); }
h3 { font-size: 1.375rem; }
p { margin: 0 0 1em; }
.container {
  max-width: var(--container-width);
  margin: 0 auto;
  padding: 0 24px;
}

/* ── Header ───────────────────────────── */
.site-header {
  position: sticky; top: 0; z-index: 50;
  background: color-mix(in srgb, var(--color-surface) 85%, transparent);
  backdrop-filter: saturate(180%) blur(12px);
  -webkit-backdrop-filter: saturate(180%) blur(12px);
  border-bottom: 1px solid var(--color-border);
}
.site-header-inner {
  display: flex; align-items: center; justify-content: space-between;
  gap: 24px; padding: 16px 24px; max-width: var(--container-width); margin: 0 auto;
}
.site-header.split .site-header-inner > .site-nav { flex: 1; justify-content: center; }
.site-header.centered .site-header-inner { flex-direction: column; gap: 12px; }
.site-header.left .site-header-inner > .site-nav { justify-content: flex-start; }
.site-brand {
  font-family: var(--font-heading);
  font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em;
  color: var(--color-secondary);
  display: flex; align-items: center; gap: 10px;
}
.site-brand img { max-height: 36px; width: auto; }
.site-nav { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.site-nav a {
  padding: 8px 14px; border-radius: 999px;
  font-size: 0.95rem; font-weight: 500;
  color: var(--color-text);
  transition: background 0.15s ease, color 0.15s ease;
}
.site-nav a:hover { background: var(--color-bg); color: var(--color-primary); }
.site-search {
  display: flex; align-items: center; gap: 8px;
  background: var(--color-bg); border-radius: 999px;
  padding: 8px 14px; min-width: 220px;
}
.site-search input {
  border: none; background: transparent; outline: none; flex: 1;
  font-family: inherit; font-size: 0.9rem; color: var(--color-text);
}

/* ── Pinterest grid ───────────────────── */
.pinterest-grid {
  --col-gap: 16px;
  column-gap: var(--col-gap);
  padding: 32px 0;
}
.pinterest-grid.cols-auto { columns: 220px; }
.pinterest-grid.cols-2 { columns: 2; }
.pinterest-grid.cols-3 { columns: 3; }
.pinterest-grid.cols-4 { columns: 4; }
@media (max-width: 900px) {
  .pinterest-grid.cols-3, .pinterest-grid.cols-4 { columns: 2; }
}
@media (max-width: 540px) {
  .pinterest-grid { columns: 2; }
  .pinterest-grid.cols-auto { columns: 160px; }
}

/* ── Pin card ─────────────────────────── */
.pin-card {
  break-inside: avoid;
  margin-bottom: var(--col-gap);
  background: var(--color-surface);
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--card-shadow);
  position: relative;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.pin-card:hover { transform: translateY(-2px); box-shadow: 0 12px 30px rgba(0,0,0,0.12); }
.pin-card a { display: block; color: inherit; }
.pin-image-wrap { position: relative; overflow: hidden; }
.pin-card img { width: 100%; display: block; }
.image-count-badge {
  position: absolute; top: 12px; right: 12px;
  background: rgba(0,0,0,0.65); color: #fff;
  padding: 4px 10px; border-radius: 999px;
  font-size: 0.75rem; font-weight: 600;
  backdrop-filter: blur(6px);
}
.category-badge {
  display: inline-block;
  background: var(--color-primary); color: #fff;
  padding: 4px 10px; border-radius: 999px;
  font-size: 0.7rem; font-weight: 600; letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: 8px;
}
.pin-content { padding: 16px; }
.pin-title {
  font-family: var(--font-heading);
  font-size: 1.125rem; font-weight: 700; line-height: 1.3;
  margin: 0 0 8px; color: var(--color-secondary);
}
.pin-meta { display: flex; gap: 12px; font-size: 0.8rem; color: var(--color-muted); }
.pin-excerpt { font-size: 0.9rem; color: var(--color-muted); margin: 8px 0 0; }
.read-more-btn {
  display: inline-block; margin-top: 12px;
  font-size: 0.85rem; font-weight: 600; color: var(--color-primary);
}

/* Hover effects */
.hover-slide-up .pin-image-wrap::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(transparent 50%, rgba(0,0,0,0.55));
  opacity: 0; transition: opacity 0.3s ease;
  pointer-events: none;
}
.hover-slide-up:hover .pin-image-wrap::after { opacity: 1; }
.hover-darken .pin-image-wrap img { transition: filter 0.3s ease; }
.hover-darken:hover .pin-image-wrap img { filter: brightness(0.7); }
.hover-scale .pin-image-wrap { overflow: hidden; }
.hover-scale .pin-image-wrap img { transition: transform 0.4s cubic-bezier(.2,.7,.2,1); }
.hover-scale:hover .pin-image-wrap img { transform: scale(1.06); }

/* ── Post page ────────────────────────── */
.post-article { max-width: 760px; margin: 0 auto; padding: 32px 24px; }
.post-article .post-hero {
  width: calc(100% + 48px); margin-left: -24px; margin-right: -24px;
  max-height: 600px; overflow: hidden; border-radius: var(--radius);
  margin-bottom: 24px;
}
.post-article .post-hero img { width: 100%; height: auto; max-height: 600px; object-fit: cover; }
.post-article h1 { font-size: clamp(2rem, 4vw, 3rem); margin-bottom: 12px; }
.post-article .post-meta {
  display: flex; gap: 12px; flex-wrap: wrap; align-items: center;
  font-size: 0.9rem; color: var(--color-muted); margin-bottom: 24px;
  padding-bottom: 24px; border-bottom: 1px solid var(--color-border);
}
.post-article .post-content { font-size: 1.08rem; }
.post-article .post-content img { border-radius: 12px; margin: 24px auto; }
.post-article .post-content blockquote {
  border-left: 4px solid var(--color-primary);
  padding: 12px 20px; margin: 24px 0;
  font-family: var(--font-heading); font-style: italic;
  color: var(--color-secondary);
}
.post-article .post-content code {
  background: var(--color-bg); padding: 2px 6px; border-radius: 4px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9em;
}
.post-article .post-content pre {
  background: var(--color-secondary); color: #fafafa;
  padding: 20px; border-radius: 12px; overflow-x: auto;
}
.post-article .post-content pre code { background: transparent; padding: 0; color: inherit; }
.post-article .post-content a { color: var(--color-primary); text-decoration: underline; text-underline-offset: 3px; }

.breadcrumbs { font-size: 0.85rem; color: var(--color-muted); margin-bottom: 16px; }
.breadcrumbs a { color: var(--color-muted); text-decoration: none; }
.breadcrumbs a:hover { color: var(--color-primary); }
.breadcrumbs span { margin: 0 6px; }

.share-row {
  display: flex; gap: 10px; flex-wrap: wrap;
  margin: 32px 0; padding: 20px 0;
  border-top: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
}
.share-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 14px; border-radius: 999px;
  background: var(--color-bg); color: var(--color-text);
  font-size: 0.85rem; font-weight: 500;
  border: 1px solid var(--color-border);
  cursor: pointer;
}
.share-btn:hover { background: var(--color-primary); color: #fff; border-color: var(--color-primary); }

/* Gallery */
.post-gallery {
  margin: 32px 0;
  columns: 200px; column-gap: 12px;
}
.post-gallery .gallery-item {
  break-inside: avoid; margin-bottom: 12px;
  border-radius: 12px; overflow: hidden;
  cursor: zoom-in;
  transition: transform 0.2s ease;
}
.post-gallery .gallery-item:hover { transform: scale(0.98); }
.post-gallery img { width: 100%; display: block; }

/* Lightbox */
.lightbox {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(0,0,0,0.92);
  display: none; align-items: center; justify-content: center;
}
.lightbox.open { display: flex; }
.lightbox img { max-width: 90vw; max-height: 90vh; object-fit: contain; border-radius: 6px; }
.lightbox button {
  position: absolute; background: rgba(255,255,255,0.1); color: #fff;
  border: none; border-radius: 999px; width: 48px; height: 48px;
  font-size: 22px; cursor: pointer;
}
.lightbox button:hover { background: rgba(255,255,255,0.2); }
.lightbox .lb-prev { left: 20px; top: 50%; transform: translateY(-50%); }
.lightbox .lb-next { right: 20px; top: 50%; transform: translateY(-50%); }
.lightbox .lb-close { top: 20px; right: 20px; }
.lightbox .lb-count {
  position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
  color: #fff; background: rgba(0,0,0,0.5); padding: 4px 12px; border-radius: 999px;
  font-size: 0.85rem;
}

/* Category banner */
.category-hero {
  position: relative; padding: 80px 24px 60px;
  text-align: center;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
}
.category-hero.has-image { color: #fff; }
.category-hero.has-image::before {
  content: ""; position: absolute; inset: 0;
  background: var(--bg-image) center/cover no-repeat;
  z-index: 0;
}
.category-hero.has-image::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.55));
  z-index: 1;
}
.category-hero > * { position: relative; z-index: 2; }
.category-hero h1 { font-size: clamp(2.5rem, 6vw, 4rem); margin: 0 0 12px; }
.category-hero p { max-width: 640px; margin: 0 auto; color: var(--color-muted); font-size: 1.05rem; }
.category-hero.has-image p { color: rgba(255,255,255,0.85); }

/* Footer */
.site-footer {
  margin-top: 80px; padding: 60px 24px 30px;
  background: var(--color-secondary);
  color: rgba(255,255,255,0.85);
}
.site-footer-inner {
  max-width: var(--container-width); margin: 0 auto;
  display: grid; gap: 40px;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}
.site-footer h3 {
  color: #fff; font-size: 1rem; letter-spacing: 0.05em;
  text-transform: uppercase; margin-bottom: 16px;
}
.site-footer ul { list-style: none; padding: 0; margin: 0; }
.site-footer li { margin-bottom: 10px; }
.site-footer a { color: rgba(255,255,255,0.7); transition: color 0.15s; }
.site-footer a:hover { color: #fff; }
.site-footer.minimal .site-footer-inner { grid-template-columns: 1fr; text-align: center; }
.site-footer-bottom {
  max-width: var(--container-width); margin: 40px auto 0;
  padding-top: 24px;
  border-top: 1px solid rgba(255,255,255,0.1);
  font-size: 0.85rem; color: rgba(255,255,255,0.6);
  display: flex; justify-content: space-between; flex-wrap: wrap; gap: 12px;
}

/* Related posts */
.related-section { padding: 60px 0; border-top: 1px solid var(--color-border); }
.related-section h2 { text-align: center; margin-bottom: 32px; }

/* Empty state */
.empty {
  text-align: center; padding: 80px 24px; color: var(--color-muted);
}
</style>`
}

function renderHeader(
  settings: Settings,
  menuItems: MenuItem[],
  categories: Category[]
): string {
  const layout = settings.theme_header_layout || "split"
  const brand = settings.site_logo
    ? `<img src="${escapeAttr(settings.site_logo)}" alt="${escapeAttr(settings.site_name)}" />`
    : escapeHtml(settings.site_name || "Site")

  // If no menu items configured, fall back to top categories.
  const items: Array<{ label: string; url: string }> = menuItems.length
    ? menuItems
        .filter((m) => !m.parent_id)
        .map((m) => ({
          label: m.label,
          url: m.url ?? "#",
        }))
    : categories.slice(0, 6).map((c) => ({ label: c.name, url: buildCategoryPath(c.slug, settings) }))

  return `<header class="site-header ${escapeAttr(layout)}">
    <div class="site-header-inner">
      <a class="site-brand" href="/">${brand}</a>
      <nav class="site-nav">
        ${items.map((it) => `<a href="${escapeAttr(it.url)}">${escapeHtml(it.label)}</a>`).join("")}
      </nav>
      <form class="site-search" role="search" action="/" method="get">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
        <input name="s" placeholder="Search…" />
      </form>
    </div>
  </header>`
}

function renderFooter(
  settings: Settings,
  menuItems: MenuItem[],
  categories: Category[]
): string {
  const layout = settings.theme_footer_layout || "columns"
  const items = menuItems.filter((m) => !m.parent_id)

  if (layout === "minimal") {
    return `<footer class="site-footer minimal">
      <div class="site-footer-inner">
        <p>© ${new Date().getFullYear()} ${escapeHtml(settings.site_name || "")}. All rights reserved.</p>
      </div>
    </footer>`
  }

  return `<footer class="site-footer ${escapeAttr(layout)}">
    <div class="site-footer-inner">
      <div>
        <h3>${escapeHtml(settings.site_name || "")}</h3>
        <p style="color: rgba(255,255,255,0.7); margin: 0;">${escapeHtml(settings.site_tagline || "")}</p>
      </div>
      <div>
        <h3>Explore</h3>
        <ul>
          ${categories
            .slice(0, 8)
            .map(
              (c) =>
                `<li><a href="${escapeAttr(buildCategoryPath(c.slug, settings))}">${escapeHtml(c.name)}</a></li>`
            )
            .join("")}
        </ul>
      </div>
      ${
        items.length
          ? `<div>
              <h3>Links</h3>
              <ul>
                ${items
                  .map(
                    (it) =>
                      `<li><a href="${escapeAttr(it.url ?? "#")}">${escapeHtml(it.label)}</a></li>`
                  )
                  .join("")}
              </ul>
            </div>`
          : ""
      }
      <div>
        <h3>Subscribe</h3>
        <ul>
          <li><a href="/feed.xml">RSS Feed</a></li>
          <li><a href="/sitemap.xml">Sitemap</a></li>
        </ul>
      </div>
    </div>
    <div class="site-footer-bottom">
      <span>© ${new Date().getFullYear()} ${escapeHtml(settings.site_name || "")}. All rights reserved.</span>
      <span>Built on Cloudflare · Powered by Pinterest CMS</span>
    </div>
  </footer>`
}

/** Live theme preview listener — only runs inside an iframe. */
function renderPreviewListener(): string {
  return `<script>
(function(){
  if (window.self === window.top) return;
  window.addEventListener('message', function(e){
    if (!e.data || e.data.type !== 'THEME_UPDATE' || !e.data.vars) return;
    var root = document.documentElement;
    Object.keys(e.data.vars).forEach(function(k){
      try { root.style.setProperty(k, String(e.data.vars[k])); } catch(_) {}
    });
  });
  // Notify parent we're ready.
  try { parent.postMessage({ type: 'PREVIEW_READY' }, '*'); } catch(_) {}
})();
</script>`
}

/** Build a tiny SVG favicon from the site's primary color and first letter of its name.
 *  Used as a fallback so /favicon.ico requests don't 404 (Google Search Console flag). */
function buildBrandFaviconSvg(settings: Settings): string {
  const bg = (settings.theme_primary_color && /^#[0-9a-f]{3,6}$/i.test(settings.theme_primary_color))
    ? settings.theme_primary_color
    : "#e60023"
  const initial = (settings.site_name || "C").trim().charAt(0).toUpperCase()
  const safe = initial.replace(/[<>&"']/g, "")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${bg}"/><text x="50%" y="50%" font-family="system-ui,sans-serif" font-size="36" font-weight="700" fill="#fff" text-anchor="middle" dominant-baseline="central">${safe}</text></svg>`
}
