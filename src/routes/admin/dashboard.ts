// src/routes/admin/dashboard.ts
// /admin/  — overview cards, recent posts, recent API activity.

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import { renderAdminLayout } from "../../views/admin/Layout"
import { escapeHtml, escapeAttr, formatDate } from "../../lib/utils"
import { loadSettings } from "../../lib/defaults"
import { buildPostPath } from "../../lib/seo"

export const dashboardRoute = new Hono<AppEnv>()

dashboardRoute.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const user = c.get("user")
  const settings = await loadSettings(siteDb)

  const [postCount, publishedCount, draftCount, apiCount, mediaCount, categoryCount, recent, apiLogs] =
    await Promise.all([
      siteDb.execute("SELECT COUNT(*) AS n FROM posts WHERE type='post'"),
      siteDb.execute("SELECT COUNT(*) AS n FROM posts WHERE type='post' AND published=1"),
      siteDb.execute("SELECT COUNT(*) AS n FROM posts WHERE type='post' AND published=0"),
      siteDb.execute("SELECT COUNT(*) AS n FROM posts WHERE source='api'"),
      siteDb.execute("SELECT COUNT(*) AS n FROM media"),
      siteDb.execute("SELECT COUNT(*) AS n FROM categories"),
      siteDb.execute(`
        SELECT p.id, p.title, p.slug, p.published, p.published_at, p.created_at,
               p.source, c.slug AS cat_slug
        FROM posts p LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.type='post'
        ORDER BY p.created_at DESC LIMIT 5
      `),
      siteDb.execute(`
        SELECT l.endpoint, l.method, l.status, l.created_at, k.name AS key_name
        FROM api_logs l LEFT JOIN api_keys k ON k.id = l.api_key_id
        ORDER BY l.created_at DESC LIMIT 8
      `),
    ])

  const stats = [
    { label: "Posts", value: Number(postCount.rows[0]?.n ?? 0) },
    { label: "Published", value: Number(publishedCount.rows[0]?.n ?? 0) },
    { label: "Drafts", value: Number(draftCount.rows[0]?.n ?? 0) },
    { label: "From API", value: Number(apiCount.rows[0]?.n ?? 0) },
    { label: "Media", value: Number(mediaCount.rows[0]?.n ?? 0) },
    { label: "Categories", value: Number(categoryCount.rows[0]?.n ?? 0) },
  ]

  const statsHtml = `<div class="stats-grid">
    ${stats
      .map(
        (s) =>
          `<div class="stat-card">
            <div class="stat-label">${escapeHtml(s.label)}</div>
            <div class="stat-value">${s.value.toLocaleString()}</div>
          </div>`
      )
      .join("")}
  </div>`

  const recentHtml = recent.rows.length
    ? `<table>
        <thead><tr><th>Title</th><th>Status</th><th>Source</th><th>Created</th><th></th></tr></thead>
        <tbody>
        ${recent.rows
          .map((r) => {
            const path = buildPostPath(
              {
                slug: r.slug as string,
                published_at: (r.published_at as string | null) ?? null,
                created_at: r.created_at as string,
              },
              r.cat_slug ? ({ slug: r.cat_slug as string } as never) : null,
              settings
            )
            return `<tr>
              <td><a href="/admin/posts/${escapeAttr(r.id as string)}">${escapeHtml(r.title as string)}</a></td>
              <td><span class="pill ${r.published ? "published" : "draft"}">${r.published ? "Published" : "Draft"}</span></td>
              <td><span class="pill ${r.source === "api" ? "api" : "manual"}">${escapeHtml((r.source as string) ?? "manual")}</span></td>
              <td>${escapeHtml(formatDate(r.created_at as string))}</td>
              <td class="row-actions">
                ${r.published ? `<a class="btn sm ghost" href="${escapeAttr(path)}" target="_blank">View ↗</a>` : ""}
                <a class="btn sm" href="/admin/posts/${escapeAttr(r.id as string)}">Edit</a>
              </td>
            </tr>`
          })
          .join("")}
        </tbody>
      </table>`
    : `<p class="empty-state">No posts yet. <a href="/admin/posts/new" class="btn primary">Create your first post</a></p>`

  const apiLogsHtml = apiLogs.rows.length
    ? `<table>
        <thead><tr><th>Endpoint</th><th>Method</th><th>Status</th><th>Key</th><th>When</th></tr></thead>
        <tbody>
        ${apiLogs.rows
          .map((r) => {
            const status = Number(r.status)
            const ok = status >= 200 && status < 300
            return `<tr>
              <td><code>${escapeHtml(r.endpoint as string)}</code></td>
              <td>${escapeHtml(r.method as string)}</td>
              <td style="color:${ok ? "#86efac" : "#fca5a5"}">${status}</td>
              <td>${escapeHtml((r.key_name as string) ?? "—")}</td>
              <td>${escapeHtml(formatDate(r.created_at as string))}</td>
            </tr>`
          })
          .join("")}
        </tbody>
      </table>`
    : `<p class="empty-state">No API activity yet.</p>`

  const body = `
    <style>
    .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
    .stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px}
    .stat-label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px}
    .stat-value{font-size:28px;font-weight:700;letter-spacing:-0.02em}
    .quick-actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px}
    </style>
    <div class="banner info">
      Welcome${user?.email ? ", <strong>" + escapeHtml(user.email) + "</strong>" : ""}.
      Site is live at <a href="https://${escapeAttr(hostname)}/" target="_blank"><strong>${escapeHtml(hostname)}</strong></a> ↗
    </div>

    ${statsHtml}

    <div class="quick-actions">
      <a class="btn primary" href="/admin/posts/new">+ New post</a>
      <a class="btn" href="/admin/categories">Manage categories</a>
      <a class="btn" href="/admin/appearance">Customize theme</a>
      <a class="btn" href="/admin/api-keys">API keys</a>
    </div>

    <div class="card">
      <h2>Recent posts</h2>
      ${recentHtml}
    </div>

    <div class="card">
      <h2>API activity</h2>
      ${apiLogsHtml}
    </div>
  `

  return c.html(
    renderAdminLayout({
      title: `Dashboard — ${hostname}`,
      hostname,
      user,
      active: "dashboard",
      bodyHtml: body,
      pageHeading: "Dashboard",
    }),
    200,
    { "Cache-Control": "no-store, private" }
  )
})
