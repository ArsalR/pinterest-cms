// src/routes/admin/media.ts
// /admin/media — image library with upload, bulk delete (with R2 cleanup).

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import { renderAdminLayout } from "../../views/admin/Layout"
import { escapeHtml, escapeAttr, formatDate, sanitizeFilename, cuid } from "../../lib/utils"
import { uploadToR2, deleteFromR2 } from "../../lib/r2"
import { stripJpegExif, imageProfileOn, isJpeg } from "../../lib/imageMeta"

export const mediaAdminRoute = new Hono<AppEnv>()

const MAX_BYTES = 10 * 1024 * 1024

mediaAdminRoute.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const user = c.get("user")
  const url = new URL(c.req.url)
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10))
  const q = (url.searchParams.get("q") || "").trim()
  const perPage = 48
  const offset = (page - 1) * perPage

  const [items, totalRow] = await Promise.all([
    q
      ? siteDb.execute({
          sql: "SELECT * FROM media WHERE filename LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
          args: [`%${q}%`, perPage, offset],
        })
      : siteDb.execute({
          sql: "SELECT * FROM media ORDER BY created_at DESC LIMIT ? OFFSET ?",
          args: [perPage, offset],
        }),
    q
      ? siteDb.execute({ sql: "SELECT COUNT(*) AS n FROM media WHERE filename LIKE ?", args: [`%${q}%`] })
      : siteDb.execute("SELECT COUNT(*) AS n FROM media"),
  ])
  const total = Number(totalRow.rows[0]?.n ?? 0)
  const totalPages = Math.max(1, Math.ceil(total / perPage))

  const searchBox = `<form method="GET" style="margin-bottom:16px;display:flex;gap:8px">
    <input type="search" name="q" value="${escapeAttr(q)}" placeholder="Search by filename…" style="flex:1;background:var(--bg);border:1px solid var(--border-2);border-radius:var(--radius-sm);padding:8px 11px;color:var(--text)">
    <button class="btn" type="submit">Search</button>
    ${q ? `<a class="btn ghost" href="/admin/media">Clear</a>` : ""}
  </form>`

  const grid = items.rows.length
    ? `${searchBox}<form method="POST" action="/admin/media/bulk-delete" id="bulk-form" onsubmit="return confirm('Delete the selected items? Files will be removed from storage.')">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
        <label><input type="checkbox" id="select-all"> Select all</label>
        <button class="btn danger sm" type="submit">Delete selected</button>
        <span style="color:var(--muted);font-size:13px;margin-left:auto">${total.toLocaleString()} item(s)</span>
      </div>
      <div class="media-grid">
        ${items.rows.map((r) => `
          <label class="media-item">
            <input type="checkbox" name="ids[]" value="${escapeAttr(r.id as string)}">
            <img src="${escapeAttr(r.url as string)}" loading="lazy" alt="${escapeAttr((r.alt as string) ?? "")}">
            <div class="media-meta">
              <div class="media-name">${escapeHtml((r.filename as string) ?? "")}</div>
              <div class="media-sub">${formatBytes(Number(r.size ?? 0))} · ${escapeHtml(formatDate(r.created_at as string))}</div>
            </div>
          </label>`).join("")}
      </div>
    </form>
    <style>
      .media-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
      .media-item{position:relative;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;cursor:pointer;display:block}
      .media-item:hover{border-color:var(--primary)}
      .media-item input[type=checkbox]{position:absolute;top:8px;left:8px;z-index:1;width:18px;height:18px}
      .media-item img{width:100%;aspect-ratio:1;object-fit:cover}
      .media-meta{padding:8px 10px}
      .media-name{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .media-sub{font-size:11px;color:var(--muted-2);margin-top:2px}
    </style>
    <script>
    document.getElementById('select-all').addEventListener('change', function(e){
      document.querySelectorAll('input[name="ids[]"]').forEach(function(b){ b.checked = e.target.checked; });
    });
    </script>
    `
    : `${searchBox}<div class="empty-state"><h2>${q ? `No results for &ldquo;${escapeHtml(q)}&rdquo;` : "No media yet"}</h2><p>${q ? "Try a different search term." : "Upload images via the post editor or the upload zone above."}</p></div>`

  const pagination = totalPages > 1
    ? `<nav style="display:flex;justify-content:center;gap:6px;margin:24px 0">
        ${page > 1 ? `<a class="btn sm" href="?page=${page - 1}">← Prev</a>` : ""}
        <span style="color:var(--muted);align-self:center;padding:0 8px;font-size:13px">Page ${page} / ${totalPages}</span>
        ${page < totalPages ? `<a class="btn sm" href="?page=${page + 1}">Next →</a>` : ""}
      </nav>`
    : ""

  const uploadCard = `<div class="card">
    <h2>Upload</h2>
    <div class="upload-zone" id="upload-zone">
      <input type="file" id="upload-files" multiple accept="image/*" style="display:none">
      <p>Drop images or <a href="#" id="browse" style="color:var(--primary)">browse</a></p>
      <p style="font-size:11px;color:var(--muted-2);margin-top:4px">Max 10MB each</p>
    </div>
    <div id="upload-status" style="margin-top:8px;font-size:12px;color:var(--muted)"></div>
    <style>
      .upload-zone{border:1.5px dashed var(--border-2);border-radius:var(--radius);padding:30px;text-align:center;color:var(--muted);font-size:13px;cursor:pointer}
      .upload-zone:hover,.upload-zone.drag{border-color:var(--primary);background:rgba(230,0,35,0.05)}
    </style>
    <script>
    (function(){
      var input = document.getElementById('upload-files');
      var zone = document.getElementById('upload-zone');
      var status = document.getElementById('upload-status');
      document.getElementById('browse').addEventListener('click', function(e){ e.preventDefault(); input.click(); });
      zone.addEventListener('click', function(e){ if (e.target === zone || e.target.tagName === 'P') input.click(); });
      ['dragenter','dragover'].forEach(function(ev){ zone.addEventListener(ev, function(e){ e.preventDefault(); zone.classList.add('drag'); }); });
      ['dragleave','drop'].forEach(function(ev){ zone.addEventListener(ev, function(e){ e.preventDefault(); zone.classList.remove('drag'); }); });
      zone.addEventListener('drop', function(e){ e.preventDefault(); upload(e.dataTransfer.files); });
      input.addEventListener('change', function(){ upload(input.files); input.value = ''; });
      async function upload(files){
        if (!files.length) return;
        status.textContent = 'Uploading…';
        var fd = new FormData();
        for (var i = 0; i < files.length; i++) fd.append('files[]', files[i]);
        try {
          var resp = await fetch('/admin/media/upload', { method: 'POST', body: fd });
          var data = await resp.json();
          if (data.success) { location.reload(); }
          else { status.textContent = data.error || 'Upload failed.'; }
        } catch (err) { status.textContent = err.message; }
      }
    })();
    </script>
  </div>`

  return c.html(
    renderAdminLayout({
      title: `Media — ${hostname}`,
      hostname,
      user,
      active: "media",
      bodyHtml: uploadCard + pagination + grid + pagination,
      pageHeading: "Media library",
    }),
    200,
    { "Cache-Control": "no-store, private" }
  )
})

// POST /admin/media/upload — used by editor + media page.
mediaAdminRoute.post("/upload", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ error: "Invalid multipart body" }, 400)
  }
  const files = form.getAll("files[]").filter((f): f is File => f instanceof File)
  if (!files.length) return c.json({ error: "No files provided" }, 400)
  if (files.length > 20) return c.json({ error: "Max 20 files per upload" }, 400)

  for (const f of files) {
    if (f.size > MAX_BYTES) return c.json({ error: `${f.name} exceeds 10MB` }, 413)
    if (!f.type.startsWith("image/")) return c.json({ error: `${f.name} is not an image` }, 415)
  }

  // V1.3 Image SEO profile: strip EXIF/GPS from JPEGs at the door.
  const stripExif = await imageProfileOn(siteDb)
  const results = await Promise.all(
    files.map(async (f) => {
      let buf = await f.arrayBuffer()
      if (stripExif && isJpeg(new Uint8Array(buf))) buf = stripJpegExif(buf)
      const safeName = sanitizeFilename(f.name)
      const { url, key } = await uploadToR2(c.env, hostname, safeName, buf, f.type)
      return { id: cuid(), url, key, filename: safeName, size: f.size }
    })
  )

  const stmts = results.map((r) => ({
    sql: `INSERT INTO media (id, url, filename, size, source, r2_key) VALUES (?, ?, ?, ?, 'manual', ?)`,
    args: [r.id, r.url, r.filename, r.size, r.key] as (string | number | null)[],
  }))
  if (stmts.length) await siteDb.batch(stmts, "write")

  const out = results.map(({ id, url, filename, size }) => ({ id, url, filename, size }))
  return c.json({ success: true, files: out })
})

// POST /admin/media/bulk-delete — body: ids[]=...&ids[]=...
mediaAdminRoute.post("/bulk-delete", async (c) => {
  const siteDb = c.get("siteDb")
  const form = await c.req.formData()
  const ids = form.getAll("ids[]").map(String).filter(Boolean)
  if (!ids.length) return c.redirect("/admin/media")

  // Lookup R2 keys before deleting rows so we can clean up storage.
  const placeholders = ids.map(() => "?").join(",")
  const r = await siteDb.execute({
    sql: `SELECT id, r2_key FROM media WHERE id IN (${placeholders})`,
    args: ids,
  })
  const keys = r.rows.map((row) => row.r2_key as string | null).filter((k): k is string => Boolean(k))

  await siteDb.execute({
    sql: `DELETE FROM media WHERE id IN (${placeholders})`,
    args: ids,
  })

  // Best-effort R2 cleanup.
  c.executionCtx.waitUntil(
    Promise.all(keys.map((k) => deleteFromR2(c.env, k))).then(() => undefined)
  )

  return c.redirect("/admin/media")
})

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + " " + units[i]
}
