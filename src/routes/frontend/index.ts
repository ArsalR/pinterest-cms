// src/routes/frontend/index.ts
// Mounts /frontend/* and dispatches dynamic slug paths to the right renderer.
//
// The slug router is the trickiest part because the permalink_structure setting
// determines what each path means. Strategy:
//   1. Reserved root paths (/sitemap.xml, /robots.txt, /feed.xml) have their own routes.
//   2. /<slug>/ → check posts.slug (any type). If it's a static page, render it.
//                 If it's a post, validate the path against the configured permalink
//                 (301-redirect to canonical if the structure expects category/date).
//                 Else, check categories.slug.
//   3. /<a>/<b>/ and longer → resolve by trying post slugs and verifying the path
//                 matches the configured permalink_structure built for that post.
// We intentionally keep this stateless and single-query-per-attempt for predictability.

import { Hono } from "hono"
import type { AppEnv, Post, Category } from "../../lib/types"
import { loadSettings } from "../../lib/defaults"
import { homeRoute } from "./home"
import { sitemapRoute } from "./sitemap"
import { robotsRoute } from "./robots"
import { feedRoute } from "./feed"
import { renderPostPage } from "./post"
import { renderCategoryPage } from "./category"
import { renderStaticPage } from "./page"
import { buildPostPath, buildCategoryPath } from "../../lib/seo"
import { lookupRedirect, applyRedirect, trackRedirectHit } from "../../lib/redirects"

export const frontendRoutes = new Hono<AppEnv>()

// Static endpoints first.
frontendRoutes.route("/sitemap.xml", sitemapRoute)
frontendRoutes.route("/robots.txt", robotsRoute)
frontendRoutes.route("/feed.xml", feedRoute)

// Homepage.
frontendRoutes.route("/", homeRoute)

// Dynamic slug router — catches everything else.
frontendRoutes.get("*", async (c) => {
  const siteDb = c.get("siteDb")
  const url = new URL(c.req.url)
  let path = url.pathname

  // Defensive: never serve /admin/* or /api/* from the frontend catch-all.
  // The worker's main router should have routed these elsewhere; this guard
  // protects us if anyone ever inadvertently mounts frontendRoutes too broadly.
  if (path.startsWith("/admin") || path.startsWith("/api/")) {
    return c.notFound()
  }

  // Skip paths that look like static files (favicon.ico, .png, .xml, etc.) —
  // we don't redirect these or try to match them as posts.
  if (/\.[a-z0-9]{2,5}$/i.test(path)) {
    return c.html(notFoundHtml(c.get("hostname"), path), 404, {
      "Cache-Control": "public, max-age=300",
    })
  }

  // ── ADMIN-MANAGED REDIRECTS (highest priority) ──────────────────────
  // Run before trailing-slash normalization so admins can match either form.
  // If a rule fires, increment its hit counter asynchronously and respond.
  const earlyRule = await lookupRedirect(siteDb, path)
  if (earlyRule) {
    c.executionCtx.waitUntil(Promise.resolve(trackRedirectHit(siteDb, earlyRule.id)))
    return applyRedirect(earlyRule, path)
  }

  // Normalize trailing slash with 301 to canonical.
  if (!path.endsWith("/")) {
    return new Response(null, {
      status: 301,
      headers: { Location: path + "/" + url.search },
    })
  }
  if (path === "/") {
    // Defer to homeRoute (already mounted). This shouldn't normally hit,
    // but guard anyway.
    return new Response("Not found", { status: 404 })
  }

  const segments = path.split("/").filter(Boolean) // ["a","b"]
  const settings = await loadSettings(siteDb)

  // ── 1. Last segment as a candidate slug. ──────────────────────────────
  const lastSlug = segments[segments.length - 1]

  // 1a. Try as a post (any path depth — verify against permalink structure).
  const postRow = await siteDb.execute({
    sql: `SELECT p.*, c.id AS c_id, c.slug AS c_slug, c.name AS c_name,
                 c.description AS c_description, c.cover_image AS c_cover,
                 c.seo_title AS c_seo_title, c.seo_desc AS c_seo_desc,
                 c.created_at AS c_created
          FROM posts p LEFT JOIN categories c ON c.id = p.category_id
          WHERE p.slug = ? AND p.published = 1
          LIMIT 1`,
    args: [lastSlug],
  })

  if (postRow.rows.length) {
    const r = postRow.rows[0]
    const post: Post & { category: Category | null } = {
      id: r.id as string,
      title: r.title as string,
      slug: r.slug as string,
      content: (r.content as string) ?? "",
      excerpt: (r.excerpt as string | null) ?? null,
      cover_image: (r.cover_image as string | null) ?? null,
      published: r.published as number,
      published_at: (r.published_at as string | null) ?? null,
      type: (r.type as string) ?? "post",
      category_id: (r.category_id as string | null) ?? null,
      source: (r.source as string) ?? "manual",
      seo_title: (r.seo_title as string | null) ?? null,
      seo_description: (r.seo_description as string | null) ?? null,
      seo_keywords: (r.seo_keywords as string | null) ?? null,
      og_title: (r.og_title as string | null) ?? null,
      og_description: (r.og_description as string | null) ?? null,
      og_image: (r.og_image as string | null) ?? null,
      twitter_card: (r.twitter_card as string | null) ?? null,
      canonical_url: (r.canonical_url as string | null) ?? null,
      no_index: r.no_index as number,
      structured_data: (r.structured_data as string | null) ?? null,
      scheduled_at: (r.scheduled_at as string | null) ?? null,
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
      category: r.c_id
        ? {
            id: r.c_id as string,
            name: r.c_name as string,
            slug: r.c_slug as string,
            description: (r.c_description as string | null) ?? null,
            cover_image: (r.c_cover as string | null) ?? null,
            seo_title: (r.c_seo_title as string | null) ?? null,
            seo_desc: (r.c_seo_desc as string | null) ?? null,
            created_at: r.c_created as string,
          }
        : null,
    }

    // Static pages always live at /<slug>/ — no category/date prefix.
    if (post.type === "page") {
      if (segments.length === 1) {
        return renderStaticPage(c, post)
      }
      // Page accessed at non-canonical path → 301 to canonical.
      return new Response(null, {
        status: 301,
        headers: { Location: `/${post.slug}/` },
      })
    }

    // For posts, build the canonical path and compare. If it matches → render.
    // If it doesn't → 301 to canonical.
    const canonical = buildPostPath(post, post.category, settings)
    if (canonical === path) {
      return renderPostPage(c, post)
    }
    return new Response(null, {
      status: 301,
      headers: { Location: canonical },
    })
  }

  // ── 2. Try as a category. ────────────────────────────────────────────
  // Category may be at /<slug>/ or /<base>/<slug>/ depending on category_base.
  const expectedCatPath = (slug: string) => buildCategoryPath(slug, settings)

  const catSlugCandidate = segments[segments.length - 1]
  const catRow = await siteDb.execute({
    sql: "SELECT * FROM categories WHERE slug = ? LIMIT 1",
    args: [catSlugCandidate],
  })
  if (catRow.rows.length) {
    const cat = catRow.rows[0] as unknown as Category
    if (expectedCatPath(cat.slug) === path) {
      return renderCategoryPage(c, cat)
    }
    return new Response(null, {
      status: 301,
      headers: { Location: expectedCatPath(cat.slug) },
    })
  }

  // ── 3. 404 ───────────────────────────────────────────────────────────
  // If admin has set a custom 404 page slug, render that page (still 404 status).
  if (settings.custom_404_slug) {
    const r = await siteDb.execute({
      sql: "SELECT * FROM posts WHERE slug = ? AND type = 'page' AND published = 1 LIMIT 1",
      args: [settings.custom_404_slug],
    })
    if (r.rows.length) {
      const page = r.rows[0] as unknown as Post
      const resp = await renderStaticPage(c, page)
      // Override status from 200 → 404 while keeping the rendered body.
      const body = await resp.text()
      return new Response(body, {
        status: 404,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=30",
        },
      })
    }
  }
  return c.html(notFoundHtml(c.get("hostname"), path), 404, {
    "Cache-Control": "public, max-age=30",
  })
})

function notFoundHtml(hostname: string, path: string): string {
  const safeHost = hostname.replace(/[<>&]/g, "")
  const safePath = path.replace(/[<>&]/g, "")
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not found · ${safeHost}</title>
<style>
  body{font-family:ui-sans-serif,system-ui,sans-serif;background:#fafafa;color:#111;
       min-height:100vh;display:grid;place-items:center;margin:0;padding:24px;}
  .card{max-width:480px;text-align:center;}
  h1{font-size:72px;margin:0 0 8px;letter-spacing:-2px;}
  p{color:#525252;margin:8px 0;}
  a{color:#e60023;text-decoration:none;font-weight:600;}
  code{background:#e5e5e5;padding:2px 6px;border-radius:4px;font-size:13px;}
</style></head>
<body><div class="card">
  <h1>404</h1>
  <p>We couldn't find <code>${safePath}</code>.</p>
  <p><a href="/">← Back to home</a></p>
</div></body></html>`
}
