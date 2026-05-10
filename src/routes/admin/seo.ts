// src/routes/admin/seo.ts
// /admin/seo — global SEO defaults (title template, OG image, verification codes, robots).

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import { renderAdminLayout } from "../../views/admin/Layout"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { loadSettings, setSetting } from "../../lib/defaults"
import { purgeEverything } from "../../lib/revalidate"

export const seoAdminRoute = new Hono<AppEnv>()

const SEO_KEYS = [
  "seo_default_title",
  "seo_default_description",
  "seo_default_og_image",
  "seo_twitter_handle",
  "seo_google_verification",
  "seo_bing_verification",
  "seo_robots_default",
  "seo_title_separator",
] as const

seoAdminRoute.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const user = c.get("user")
  const settings = await loadSettings(siteDb)
  const saved = new URL(c.req.url).searchParams.get("saved")

  const body = `
    ${saved ? `<div class="banner success">SEO settings saved.</div>` : ""}
    <form method="POST" action="/admin/seo/save" style="max-width:720px">
      <div class="card">
        <h2>Defaults</h2>
        <div class="form-row">
          <label>Default page title</label>
          <input type="text" name="seo_default_title" value="${escapeAttr(settings.seo_default_title || "")}" placeholder="${escapeAttr(hostname)}">
          <div class="hint">Used on the homepage and as a fallback for any page without its own SEO title.</div>
        </div>
        <div class="form-row">
          <label>Default meta description</label>
          <textarea name="seo_default_description">${escapeHtml(settings.seo_default_description || "")}</textarea>
          <div class="hint">Used when a post or category doesn't supply its own.</div>
        </div>
        <div class="form-row">
          <label>Title separator</label>
          <input type="text" name="seo_title_separator" value="${escapeAttr(settings.seo_title_separator || "—")}" maxlength="3" style="max-width:80px">
          <div class="hint">e.g. <code>—</code>, <code>|</code>, <code>·</code> — joins post title and site name.</div>
        </div>
        <div class="form-row">
          <label>Default Open Graph image URL</label>
          <input type="url" name="seo_default_og_image" value="${escapeAttr(settings.seo_default_og_image || "")}" placeholder="https://…/og.png">
          <div class="hint">1200×630 recommended. Used when a post has no cover image.</div>
        </div>
      </div>

      <div class="card">
        <h2>Social</h2>
        <div class="form-row">
          <label>Twitter handle</label>
          <input type="text" name="seo_twitter_handle" value="${escapeAttr(settings.seo_twitter_handle || "")}" placeholder="@yoursite">
        </div>
      </div>

      <div class="card">
        <h2>Search engines</h2>
        <div class="form-row">
          <label>Google site verification</label>
          <input type="text" name="seo_google_verification" value="${escapeAttr(settings.seo_google_verification || "")}" placeholder="paste content value only">
          <div class="hint">From <code>&lt;meta name="google-site-verification" content="…"&gt;</code> — paste only the content value.</div>
        </div>
        <div class="form-row">
          <label>Bing site verification</label>
          <input type="text" name="seo_bing_verification" value="${escapeAttr(settings.seo_bing_verification || "")}">
        </div>
        <div class="form-row">
          <label>Default robots directive</label>
          <select name="seo_robots_default">
            <option value="index,follow" ${(settings.seo_robots_default || "index,follow") === "index,follow" ? "selected" : ""}>index, follow (default)</option>
            <option value="noindex,follow" ${settings.seo_robots_default === "noindex,follow" ? "selected" : ""}>noindex, follow</option>
            <option value="index,nofollow" ${settings.seo_robots_default === "index,nofollow" ? "selected" : ""}>index, nofollow</option>
            <option value="noindex,nofollow" ${settings.seo_robots_default === "noindex,nofollow" ? "selected" : ""}>noindex, nofollow</option>
          </select>
          <div class="hint">Applies site-wide; individual posts can override.</div>
        </div>
      </div>

      <button class="btn primary" type="submit" style="padding:10px 24px">Save SEO settings</button>
    </form>
  `

  return c.html(
    renderAdminLayout({
      title: `SEO — ${hostname}`,
      hostname,
      user,
      active: "seo",
      bodyHtml: body,
      pageHeading: "SEO settings",
    }),
    200,
    { "Cache-Control": "no-store, private" }
  )
})

seoAdminRoute.post("/save", async (c) => {
  const siteDb = c.get("siteDb")
  const form = await c.req.formData()
  for (const key of SEO_KEYS) {
    const v = form.get(key)
    if (v !== null) await setSetting(siteDb, key, String(v))
  }
  c.executionCtx.waitUntil(purgeEverything(c.env, c.get("hostname")))
  return c.redirect("/admin/seo?saved=1")
})
