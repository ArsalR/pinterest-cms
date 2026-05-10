// src/routes/admin/settings.ts
// /admin/settings — general site settings (name, tagline, logo, favicon, posts per page, etc.)

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import { renderAdminLayout } from "../../views/admin/Layout"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { loadSettings, setSetting } from "../../lib/defaults"
import { purgeEverything } from "../../lib/revalidate"

export const settingsAdminRoute = new Hono<AppEnv>()

const SETTINGS_KEYS = [
  "site_name",
  "site_tagline",
  "site_url",
  "admin_email",
  "site_logo",
  "site_favicon",
  "site_og_image",
  "posts_per_page",
  "homepage_type",
] as const

settingsAdminRoute.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const user = c.get("user")
  const settings = await loadSettings(siteDb)
  const saved = new URL(c.req.url).searchParams.get("saved")

  const homepageType = settings.homepage_type || "latest"

  const body = `
    ${saved ? `<div class="banner success">Settings saved.</div>` : ""}
    <form method="POST" action="/admin/settings/save" style="max-width:720px">
      <div class="card">
        <h2>Identity</h2>
        <div class="form-row">
          <label>Site name</label>
          <input type="text" name="site_name" value="${escapeAttr(settings.site_name || "")}" placeholder="${escapeAttr(hostname)}" required>
        </div>
        <div class="form-row">
          <label>Tagline</label>
          <input type="text" name="site_tagline" value="${escapeAttr(settings.site_tagline || "")}" placeholder="A short tagline shown alongside your site name">
        </div>
        <div class="form-row">
          <label>Site URL</label>
          <input type="url" name="site_url" value="${escapeAttr(settings.site_url || "https://" + hostname)}">
          <div class="hint">Canonical base URL. Used for absolute links in feeds, sitemaps, and structured data.</div>
        </div>
        <div class="form-row">
          <label>Admin email</label>
          <input type="email" name="admin_email" value="${escapeAttr(settings.admin_email || "")}">
          <div class="hint">Used for password resets (when implemented) and notification preferences.</div>
        </div>
      </div>

      <div class="card">
        <h2>Branding</h2>
        <div class="form-row">
          <label>Logo URL</label>
          <input type="url" name="site_logo" value="${escapeAttr(settings.site_logo || "")}" placeholder="https://…/logo.svg">
          <div class="hint">If set, replaces the text site name in the header.</div>
          ${settings.site_logo ? `<img src="${escapeAttr(settings.site_logo)}" style="max-height:40px;margin-top:8px;background:#fff;padding:6px;border-radius:6px">` : ""}
        </div>
        <div class="form-row">
          <label>Favicon URL</label>
          <input type="url" name="site_favicon" value="${escapeAttr(settings.site_favicon || "")}" placeholder="https://…/favicon.ico">
        </div>
        <div class="form-row">
          <label>Default Open Graph image</label>
          <input type="url" name="site_og_image" value="${escapeAttr(settings.site_og_image || "")}" placeholder="https://…/og.png">
          <div class="hint">1200×630 recommended. Used as the social-card image when a post has no cover.</div>
        </div>
      </div>

      <div class="card">
        <h2>Content</h2>
        <div class="form-row">
          <label>Posts per page</label>
          <input type="number" name="posts_per_page" min="6" max="100" value="${escapeAttr(settings.posts_per_page || "24")}" style="max-width:120px">
          <div class="hint">Affects the homepage and category archives. Pinterest-style grids look best with 24–48.</div>
        </div>
        <div class="form-row">
          <label>Homepage shows</label>
          <select name="homepage_type">
            <option value="latest" ${homepageType === "latest" ? "selected" : ""}>Latest posts (Pinterest grid)</option>
            <option value="static" ${homepageType === "static" ? "selected" : ""}>A static page (configure below)</option>
          </select>
        </div>
        <div class="form-row" id="static-page-row" style="${homepageType === "static" ? "" : "display:none"}">
          <label>Homepage static page slug</label>
          <input type="text" name="homepage_static_slug" value="${escapeAttr(settings.homepage_static_slug || "")}" placeholder="welcome">
          <div class="hint">Slug of the page (type=page) to render at <code>/</code>.</div>
        </div>
        <div class="form-row">
          <label>Custom 404 page slug</label>
          <input type="text" name="custom_404_slug" value="${escapeAttr(settings.custom_404_slug || "")}" placeholder="(leave blank for default 404)">
          <div class="hint">Slug of a static page to render whenever a URL isn't found. Leave blank for the built-in 404. For per-URL rules, use <a href="/admin/redirects" style="color:var(--primary)">Redirects</a>.</div>
        </div>
      </div>

      <button class="btn primary" type="submit" style="padding:10px 24px">Save settings</button>
    </form>

    <script>
    document.querySelector('select[name="homepage_type"]').addEventListener('change', function(e){
      document.getElementById('static-page-row').style.display = e.target.value === 'static' ? '' : 'none';
    });
    </script>
  `

  return c.html(
    renderAdminLayout({
      title: `Settings — ${hostname}`,
      hostname,
      user,
      active: "settings",
      bodyHtml: body,
      pageHeading: "General settings",
    }),
    200,
    { "Cache-Control": "no-store, private" }
  )
})

settingsAdminRoute.post("/save", async (c) => {
  const siteDb = c.get("siteDb")
  const form = await c.req.formData()
  for (const key of SETTINGS_KEYS) {
    const v = form.get(key)
    if (v !== null) await setSetting(siteDb, key, String(v))
  }
  // Optional homepage_static_slug + custom_404_slug.
  for (const k of ["homepage_static_slug", "custom_404_slug"]) {
    const v = form.get(k)
    if (v !== null) await setSetting(siteDb, k, String(v))
  }

  c.executionCtx.waitUntil(purgeEverything(c.env, c.get("hostname")))
  return c.redirect("/admin/settings?saved=1")
})
