// src/views/admin/PostEditor.ts
// Renders the post-editor UI used for both posts and pages.
// Returns { html, headHtml, scriptHtml } so the admin Layout can stitch them in.

import type { Post, Category } from "../../lib/types"
import { escapeHtml, escapeAttr } from "../../lib/utils"

export interface EditorInput {
  post: Post | null
  images: Array<{ url: string; alt: string; caption: string | null; ord: number }>
  categories: Pick<Category, "id" | "name" | "slug">[]
  type: "post" | "page"
}

export interface EditorOutput {
  html: string
  headHtml: string
  scriptHtml: string
}

export function renderPostEditor(input: EditorInput): EditorOutput {
  const { post, images, categories, type } = input
  const title = post?.title ?? ""
  const slug = post?.slug ?? ""
  const content = post?.content ?? ""
  const excerpt = post?.excerpt ?? ""
  const cover = post?.cover_image ?? ""
  const categoryId = post?.category_id ?? ""
  const published = post?.published === 1
  const noIndex = post?.no_index === 1
  // scheduled_at stored as "YYYY-MM-DD HH:MM:SS"; datetime-local input wants "YYYY-MM-DDTHH:MM"
  const scheduledAtRaw = post?.scheduled_at ?? ""
  const scheduledAt = scheduledAtRaw ? scheduledAtRaw.slice(0, 16).replace(" ", "T") : ""

  const optsHtml = categories
    .map(
      (c) =>
        `<option value="${escapeAttr(c.id)}" ${c.id === categoryId ? "selected" : ""}>${escapeHtml(c.name)}</option>`
    )
    .join("")

  const imagesJson = JSON.stringify(images.map(i => ({ url: i.url, alt: i.alt, caption: i.caption ?? "" })))

  const action = type === "page" ? "/admin/pages/save" : "/admin/posts/save"

  const headHtml = `
<style>
.editor-shell{display:grid;grid-template-columns:1fr 320px;gap:24px;align-items:flex-start}
@media(max-width:1024px){.editor-shell{grid-template-columns:1fr}}
.editor-main{display:flex;flex-direction:column;gap:14px;min-width:0}
.editor-sidebar{display:flex;flex-direction:column;gap:14px;position:sticky;top:24px}
.title-input{font-size:24px;font-weight:700;background:transparent;border:none;border-bottom:1px solid var(--border);padding:8px 0;color:var(--text);width:100%;letter-spacing:-0.02em}
.title-input:focus{outline:none;border-bottom-color:var(--primary)}
.tt-toolbar{display:flex;gap:2px;flex-wrap:wrap;padding:8px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius) var(--radius) 0 0;border-bottom:none}
.tt-btn{padding:5px 9px;background:transparent;border:none;color:var(--muted);border-radius:4px;cursor:pointer;font-size:13px;font-weight:600}
.tt-btn:hover{background:var(--surface-2);color:var(--text)}
.tt-btn.active{background:var(--primary);color:#fff}
.tt-divider{width:1px;background:var(--border);margin:2px 4px}
.tt-editor{background:var(--surface);border:1px solid var(--border);border-radius:0 0 var(--radius) var(--radius);padding:16px;min-height:300px;color:var(--text);font-size:15px;line-height:1.7}
.tt-editor:focus{outline:none;border-color:var(--primary)}
.tt-editor h1,.tt-editor h2,.tt-editor h3{margin:1em 0 0.4em;font-weight:700}
.tt-editor h1{font-size:1.6em} .tt-editor h2{font-size:1.35em} .tt-editor h3{font-size:1.15em}
.tt-editor p{margin:0 0 0.8em} .tt-editor ul,.tt-editor ol{padding-left:1.4em;margin:0 0 0.8em}
.tt-editor blockquote{border-left:3px solid var(--primary);padding-left:14px;color:var(--muted);font-style:italic;margin:0.8em 0}
.tt-editor img{max-width:100%;border-radius:6px;margin:8px 0}
.tt-editor a{color:var(--primary);text-decoration:underline}
.tt-editor pre{background:#000;padding:12px;border-radius:6px;overflow-x:auto}

.gallery-mgr{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
.gimg{position:relative;aspect-ratio:1;background:var(--surface-2);border-radius:6px;overflow:hidden;cursor:move;border:1px solid var(--border)}
.gimg img{width:100%;height:100%;object-fit:cover}
.gimg .gx{position:absolute;top:4px;right:4px;width:22px;height:22px;border-radius:999px;background:rgba(0,0,0,0.7);color:#fff;border:none;cursor:pointer;font-size:14px;line-height:1}
.gimg .gx:hover{background:#dc2626}
.gimg .galt{position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,0.85));padding:14px 6px 4px;font-size:11px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.section-title{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:10px}

details summary{cursor:pointer;padding:10px 0;border-bottom:1px solid var(--border);font-weight:600;font-size:13px}
details[open] summary{margin-bottom:12px}

.upload-zone{border:1.5px dashed var(--border-2);border-radius:var(--radius);padding:20px;text-align:center;color:var(--muted);font-size:13px;cursor:pointer}
.upload-zone:hover{border-color:var(--primary);color:var(--text)}
.upload-zone.drag{border-color:var(--primary);background:rgba(230,0,35,0.05)}

.toggle{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)}
.toggle:last-child{border-bottom:none}
.toggle label{flex:1;cursor:pointer;font-weight:500}
.toggle .toggle-hint{font-size:12px;color:var(--muted-2);margin-top:2px}
</style>
`

  const html = `
<form id="post-form" method="POST" action="${escapeAttr(action)}" class="editor-shell" onsubmit="return prepareSave(this)">
  <input type="hidden" name="id" value="${escapeAttr(post?.id ?? "")}">

  <div class="editor-main">
    <input class="title-input" type="text" name="title" placeholder="${type === "page" ? "Page title" : "Post title"}" value="${escapeAttr(title)}" required autofocus>

    <div class="form-row">
      <label>Slug <span class="hint" style="color:var(--muted-2);font-weight:400">(auto from title if blank)</span></label>
      <input type="text" name="slug" value="${escapeAttr(slug)}" placeholder="my-post-slug">
    </div>

    <div>
      <div class="tt-toolbar" id="tt-toolbar">
        <button type="button" class="tt-btn" data-cmd="heading" data-level="1" title="H1">H1</button>
        <button type="button" class="tt-btn" data-cmd="heading" data-level="2" title="H2">H2</button>
        <button type="button" class="tt-btn" data-cmd="heading" data-level="3" title="H3">H3</button>
        <span class="tt-divider"></span>
        <button type="button" class="tt-btn" data-cmd="bold" title="Bold"><b>B</b></button>
        <button type="button" class="tt-btn" data-cmd="italic" title="Italic"><i>I</i></button>
        <button type="button" class="tt-btn" data-cmd="strike" title="Strike"><s>S</s></button>
        <span class="tt-divider"></span>
        <button type="button" class="tt-btn" data-cmd="bulletList">• List</button>
        <button type="button" class="tt-btn" data-cmd="orderedList">1. List</button>
        <button type="button" class="tt-btn" data-cmd="blockquote">Quote</button>
        <button type="button" class="tt-btn" data-cmd="code">‹›</button>
        <span class="tt-divider"></span>
        <button type="button" class="tt-btn" data-cmd="link">Link</button>
        <button type="button" class="tt-btn" data-cmd="image">Img</button>
        <button type="button" class="tt-btn" data-cmd="hr">Hr</button>
        <span class="tt-divider"></span>
        <button type="button" class="tt-btn" data-cmd="undo">↶</button>
        <button type="button" class="tt-btn" data-cmd="redo">↷</button>
      </div>
      <div id="tt-editor" class="tt-editor" contenteditable="true">${content}</div>
      <textarea name="content" id="content-input" style="display:none">${escapeHtml(content)}</textarea>
    </div>

    <div class="form-row">
      <label>Excerpt <span class="hint" style="color:var(--muted-2);font-weight:400">(auto from content if blank)</span></label>
      <textarea name="excerpt" placeholder="Short summary for listings…">${escapeHtml(excerpt)}</textarea>
    </div>

    <div class="card">
      <h2>Gallery</h2>
      <p style="color:var(--muted);font-size:13px;margin-bottom:12px">Drag to reorder. Click an image to edit alt text.</p>
      <div id="gallery" class="gallery-mgr"></div>
      <div class="upload-zone" id="upload-zone" style="margin-top:12px">
        <input type="file" id="upload-files" multiple accept="image/*" style="display:none">
        <p>Drop images here or <a href="#" id="browse-link" style="color:var(--primary)">browse</a></p>
        <p style="font-size:11px;color:var(--muted-2);margin-top:4px">Max 10MB per image</p>
      </div>
      <div id="upload-status" style="margin-top:8px;font-size:12px;color:var(--muted)"></div>
    </div>
  </div>

  <aside class="editor-sidebar">
    <div class="card">
      <div class="toggle">
        <input type="checkbox" name="published" id="published" ${published ? "checked" : ""}>
        <label for="published">Published <div class="toggle-hint">${published ? "Live on the site" : scheduledAt ? "Will publish automatically" : "Save as draft"}</div></label>
      </div>
      <div id="schedule-row" style="margin-top:10px;${published ? "display:none" : ""}">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Schedule publish (optional)</label>
        <input type="datetime-local" name="scheduled_at" id="scheduled_at" value="${escapeAttr(scheduledAt)}"
          style="width:100%;background:var(--bg);border:1px solid var(--border-2);border-radius:var(--radius-sm);padding:7px 9px;color:var(--text);font-size:13px">
        <div style="font-size:11px;color:var(--muted-2);margin-top:4px">Leave blank to keep as draft. Time is UTC.</div>
      </div>
      ${
        type === "post"
          ? `<div class="form-row" style="margin-top:14px">
        <label>Category</label>
        <select name="category_id" id="cat-select">
          <option value="">— Uncategorized —</option>
          ${optsHtml}
        </select>
        <div style="display:flex;gap:6px;margin-top:6px">
          <input type="text" id="new-cat-input" placeholder="New category name…" style="flex:1;background:var(--bg);border:1px solid var(--border-2);border-radius:var(--radius-sm);padding:6px 9px;color:var(--text);font-size:13px">
          <button type="button" id="new-cat-btn" class="btn sm">+ Add</button>
        </div>
      </div>`
          : ""
      }
      <div style="display:flex;gap:6px;margin-top:10px">
        <button type="submit" class="btn primary" style="flex:1;justify-content:center;padding:10px">Save ${type}</button>
        ${post?.id ? `<a href="/admin/${type === "page" ? "pages" : "posts"}/${escapeAttr(post.id)}/preview" target="_blank" class="btn" style="padding:10px 14px" title="Preview">👁</a>` : ""}
      </div>
    </div>

    <div class="card">
      <div class="section-title">Cover image</div>
      <input type="text" name="cover_image" id="cover-input" value="${escapeAttr(cover)}" placeholder="https://…" style="background:var(--bg);border:1px solid var(--border-2);border-radius:var(--radius-sm);padding:9px 11px;color:var(--text);width:100%;margin-bottom:8px">
      ${cover ? `<img src="${escapeAttr(cover)}" id="cover-preview" style="width:100%;border-radius:var(--radius-sm);margin-bottom:8px">` : `<img src="" id="cover-preview" style="display:none;width:100%;border-radius:var(--radius-sm);margin-bottom:8px">`}
      <button type="button" class="btn sm" id="cover-pick">Pick from gallery</button>
    </div>

    <div class="card">
      <details>
        <summary>SEO</summary>
        <div class="form-row"><label>SEO title</label><input type="text" name="seo_title" value="${escapeAttr(post?.seo_title ?? "")}"></div>
        <div class="form-row"><label>Meta description</label><textarea name="seo_description">${escapeHtml(post?.seo_description ?? "")}</textarea></div>
        <div class="form-row"><label>Keywords</label><input type="text" name="seo_keywords" value="${escapeAttr(post?.seo_keywords ?? "")}" placeholder="comma, separated"></div>
        <div class="form-row"><label>Canonical URL</label><input type="url" name="canonical_url" value="${escapeAttr(post?.canonical_url ?? "")}"></div>
        <div class="toggle"><input type="checkbox" name="no_index" id="no_index" ${noIndex ? "checked" : ""}><label for="no_index">No-index <div class="toggle-hint">Hide from search engines</div></label></div>
      </details>
    </div>

    <div class="card">
      <details>
        <summary>Social (Open Graph)</summary>
        <div class="form-row"><label>OG title</label><input type="text" name="og_title" value="${escapeAttr(post?.og_title ?? "")}"></div>
        <div class="form-row"><label>OG description</label><textarea name="og_description">${escapeHtml(post?.og_description ?? "")}</textarea></div>
        <div class="form-row"><label>OG image URL</label><input type="url" name="og_image" value="${escapeAttr(post?.og_image ?? "")}"></div>
        <div class="form-row"><label>Twitter card</label>
          <select name="twitter_card">
            <option value="summary_large_image" ${(post?.twitter_card ?? "summary_large_image") === "summary_large_image" ? "selected" : ""}>summary_large_image</option>
            <option value="summary" ${post?.twitter_card === "summary" ? "selected" : ""}>summary</option>
          </select>
        </div>
      </details>
    </div>
  </aside>
</form>
`

  const scriptHtml = `
<script>
window.__GALLERY = ${imagesJson};

(function(){
  // ── Tiptap-style WYSIWYG using contenteditable + execCommand fallback.
  // Tiptap proper requires bundling; for a Worker artifact we use a slimmer
  // execCommand-based editor that produces the same HTML shape.
  var ed = document.getElementById('tt-editor');
  var ci = document.getElementById('content-input');
  function sync(){ ci.value = ed.innerHTML; }
  ed.addEventListener('input', sync); sync();

  document.querySelectorAll('#tt-toolbar .tt-btn').forEach(function(btn){
    btn.addEventListener('click', function(e){
      e.preventDefault();
      var cmd = btn.dataset.cmd;
      ed.focus();
      if (cmd === 'bold') document.execCommand('bold');
      else if (cmd === 'italic') document.execCommand('italic');
      else if (cmd === 'strike') document.execCommand('strikeThrough');
      else if (cmd === 'bulletList') document.execCommand('insertUnorderedList');
      else if (cmd === 'orderedList') document.execCommand('insertOrderedList');
      else if (cmd === 'undo') document.execCommand('undo');
      else if (cmd === 'redo') document.execCommand('redo');
      else if (cmd === 'hr') document.execCommand('insertHorizontalRule');
      else if (cmd === 'heading') document.execCommand('formatBlock', false, 'H' + btn.dataset.level);
      else if (cmd === 'blockquote') document.execCommand('formatBlock', false, 'BLOCKQUOTE');
      else if (cmd === 'code') {
        var sel = window.getSelection().toString();
        if (sel) document.execCommand('insertHTML', false, '<code>' + sel.replace(/[<>&]/g, function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c];}) + '</code>');
      }
      else if (cmd === 'link') {
        var url = prompt('URL:');
        if (url) document.execCommand('createLink', false, url);
      }
      else if (cmd === 'image') {
        var url = prompt('Image URL:');
        if (url) document.execCommand('insertImage', false, url);
      }
      sync();
    });
  });

  // ── Gallery manager ──
  var galleryEl = document.getElementById('gallery');
  function renderGallery(){
    galleryEl.innerHTML = '';
    window.__GALLERY.forEach(function(img, i){
      var el = document.createElement('div');
      el.className = 'gimg';
      el.draggable = true;
      el.dataset.idx = String(i);
      el.innerHTML = '<img src="' + escAttr(img.url) + '" alt="' + escAttr(img.alt || '') + '">'
        + '<button type="button" class="gx" title="Remove">×</button>'
        + (img.alt ? '<div class="galt">' + escHtml(img.alt) + '</div>' : '');
      el.querySelector('.gx').addEventListener('click', function(e){
        e.stopPropagation();
        window.__GALLERY.splice(i, 1);
        renderGallery();
      });
      el.addEventListener('click', function(){
        var alt = prompt('Alt text:', img.alt || '');
        if (alt !== null) { img.alt = alt; renderGallery(); }
      });
      el.addEventListener('dragstart', function(e){ e.dataTransfer.setData('text/plain', i); });
      el.addEventListener('dragover', function(e){ e.preventDefault(); });
      el.addEventListener('drop', function(e){
        e.preventDefault();
        var src = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (isNaN(src) || src === i) return;
        var moved = window.__GALLERY.splice(src, 1)[0];
        window.__GALLERY.splice(i, 0, moved);
        renderGallery();
      });
      galleryEl.appendChild(el);
    });
  }
  renderGallery();

  // ── Uploads ──
  var input = document.getElementById('upload-files');
  var zone = document.getElementById('upload-zone');
  var status = document.getElementById('upload-status');
  document.getElementById('browse-link').addEventListener('click', function(e){ e.preventDefault(); input.click(); });
  zone.addEventListener('click', function(e){ if (e.target === zone || e.target.tagName === 'P') input.click(); });
  ['dragenter','dragover'].forEach(function(ev){ zone.addEventListener(ev, function(e){ e.preventDefault(); zone.classList.add('drag'); }); });
  ['dragleave','drop'].forEach(function(ev){ zone.addEventListener(ev, function(e){ e.preventDefault(); zone.classList.remove('drag'); }); });
  zone.addEventListener('drop', function(e){
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', function(){ handleFiles(input.files); input.value = ''; });

  async function handleFiles(files){
    if (!files || !files.length) return;
    status.textContent = 'Uploading ' + files.length + ' file(s)…';
    var fd = new FormData();
    for (var i = 0; i < files.length; i++) fd.append('files[]', files[i]);
    try {
      var resp = await fetch('/admin/media/upload', { method: 'POST', body: fd });
      var data = await resp.json();
      if (data.success && Array.isArray(data.files)) {
        data.files.forEach(function(f){
          window.__GALLERY.push({ url: f.url, alt: f.filename || '', caption: '' });
        });
        renderGallery();
        // Auto-set cover if none.
        var cover = document.getElementById('cover-input');
        if (!cover.value && data.files[0]) {
          cover.value = data.files[0].url;
          var prev = document.getElementById('cover-preview');
          prev.src = data.files[0].url; prev.style.display = 'block';
        }
        status.textContent = 'Uploaded ' + data.files.length + ' file(s).';
      } else {
        status.textContent = 'Upload failed: ' + (data.error || 'unknown');
      }
    } catch (err) {
      status.textContent = 'Upload error: ' + err.message;
    }
  }

  // ── Cover from gallery ──
  document.getElementById('cover-pick').addEventListener('click', function(){
    if (!window.__GALLERY.length) { alert('Add images to the gallery first.'); return; }
    var url = window.__GALLERY[0].url;
    document.getElementById('cover-input').value = url;
    var prev = document.getElementById('cover-preview');
    prev.src = url; prev.style.display = 'block';
  });
  document.getElementById('cover-input').addEventListener('input', function(e){
    var prev = document.getElementById('cover-preview');
    if (e.target.value) { prev.src = e.target.value; prev.style.display = 'block'; }
    else prev.style.display = 'none';
  });

  // ── Save: serialize gallery into hidden inputs ──
  window.prepareSave = function(form){
    sync();
    // Remove old hidden gallery inputs.
    Array.prototype.slice.call(form.querySelectorAll('input[name="image_data[]"]'))
      .forEach(function(n){ n.remove(); });
    window.__GALLERY.forEach(function(img){
      var inp = document.createElement('input');
      inp.type = 'hidden';
      inp.name = 'image_data[]';
      inp.value = JSON.stringify({ url: img.url, alt: img.alt || '', caption: img.caption || '' });
      form.appendChild(inp);
    });
    return true;
  };

  function escAttr(s){return String(s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function escHtml(s){return String(s||'').replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}

  // ── Quick-create category ──
  var catSelect = document.getElementById('cat-select');
  var newCatInput = document.getElementById('new-cat-input');
  var newCatBtn = document.getElementById('new-cat-btn');
  if (catSelect && newCatInput && newCatBtn) {
    async function createCategory(){
      var name = newCatInput.value.trim();
      if (!name) return;
      newCatBtn.disabled = true; newCatBtn.textContent = '…';
      try {
        var resp = await fetch('/admin/categories/create-quick', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name })
        });
        var data = await resp.json();
        if (data.id) {
          var opt = document.createElement('option');
          opt.value = data.id; opt.textContent = data.name; opt.selected = true;
          catSelect.appendChild(opt);
          newCatInput.value = '';
        } else {
          alert(data.error || 'Failed to create category');
        }
      } catch(e){ alert(e.message); }
      finally { newCatBtn.disabled = false; newCatBtn.textContent = '+ Add'; }
    }
    newCatBtn.addEventListener('click', createCategory);
    newCatInput.addEventListener('keydown', function(e){
      if (e.key === 'Enter'){ e.preventDefault(); createCategory(); }
    });
  }

  // Toggle schedule row visibility based on Published checkbox.
  var pubCheck = document.getElementById('published');
  var schedRow = document.getElementById('schedule-row');
  if (pubCheck && schedRow) {
    pubCheck.addEventListener('change', function(){
      schedRow.style.display = pubCheck.checked ? 'none' : '';
    });
  }

  // Warn before navigating away if the form has unsaved changes.
  var dirty = false;
  var titleInput = document.querySelector('#post-form [name="title"]');
  if (ed) ed.addEventListener('input', function(){ dirty = true; });
  if (titleInput) titleInput.addEventListener('input', function(){ dirty = true; });
  window.addEventListener('beforeunload', function(e){
    if (dirty){ e.preventDefault(); e.returnValue = ''; }
  });

  // ── Autosave to localStorage ──
  var draftKey = 'cms_draft_${type}_${post?.id ?? "new"}';
  function saveDraft(){
    try {
      sync();
      var t = document.querySelector('#post-form [name="title"]');
      var ex = document.querySelector('#post-form [name="excerpt"]');
      localStorage.setItem(draftKey, JSON.stringify({
        title: t ? t.value : '',
        content: ci.value,
        excerpt: ex ? ex.value : '',
        ts: Date.now()
      }));
    } catch(e){}
  }
  try {
    var _raw = localStorage.getItem(draftKey);
    if (_raw) {
      var _draft = JSON.parse(_raw);
      if (_draft && _draft.ts) {
        var _age = Math.round((Date.now() - _draft.ts) / 60000);
        var _banner = document.createElement('div');
        _banner.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#1e293b;color:#fff;padding:12px 20px;border-radius:8px;font-size:13px;z-index:9999;display:flex;gap:12px;align-items:center;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
        _banner.innerHTML = '<span>Unsaved draft found (' + (_age < 1 ? 'just now' : _age + ' min ago') + ')</span>'
          + '<button type="button" style="background:#e60023;color:#fff;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px" id="restore-draft">Restore</button>'
          + '<button type="button" style="background:transparent;color:#94a3b8;border:none;cursor:pointer;font-size:18px;line-height:1" id="dismiss-draft">&times;</button>';
        document.body.appendChild(_banner);
        (function(draft, banner){
          document.getElementById('restore-draft').addEventListener('click', function(){
            var t = document.querySelector('#post-form [name="title"]');
            var ex = document.querySelector('#post-form [name="excerpt"]');
            if (t && draft.title !== undefined) t.value = draft.title;
            if (draft.content !== undefined){ ed.innerHTML = draft.content; sync(); }
            if (ex && draft.excerpt !== undefined) ex.value = draft.excerpt;
            dirty = true;
            banner.remove();
          });
          document.getElementById('dismiss-draft').addEventListener('click', function(){
            try { localStorage.removeItem(draftKey); } catch(e){}
            banner.remove();
          });
        })(_draft, _banner);
      }
    }
  } catch(e){}
  setInterval(saveDraft, 30000);
  document.getElementById('post-form').addEventListener('submit', function(){
    dirty = false;
    try { localStorage.removeItem(draftKey); } catch(e){}
  });
})();
</script>
`

  return { html, headHtml, scriptHtml }
}
