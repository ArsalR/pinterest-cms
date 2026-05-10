// src/routes/admin/appearance.ts
// /admin/appearance — theme customizer with split-pane iframe preview.
// Left pane: form. Right pane: <iframe> showing the homepage with live theme updates
// via postMessage. Save persists settings + invalidates caches.

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import { renderAdminLayout } from "../../views/admin/Layout"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { loadSettings, setSetting } from "../../lib/defaults"
import { GOOGLE_FONTS, PALETTE_PRESETS } from "../../lib/theme"
import { purgeEverything } from "../../lib/revalidate"

export const appearanceAdminRoute = new Hono<AppEnv>()

const THEME_KEYS = [
  // colors
  "theme_primary_color",
  "theme_secondary_color",
  "theme_accent_color",
  "theme_background_color",
  "theme_surface_color",
  "theme_text_color",
  "theme_text_muted_color",
  "theme_border_color",
  // typography
  "theme_heading_font",
  "theme_body_font",
  "theme_font_size_base",
  "theme_line_height",
  // layout
  "theme_border_radius",
  "theme_container_width",
  "theme_header_layout",
  "theme_footer_layout",
  // grid & cards
  "theme_grid_columns",
  "theme_card_style",
  "theme_pin_hover_effect",
  // display options
  "theme_show_post_dates",
  "theme_show_author",
  "theme_show_reading_time",
  "theme_show_category_badge",
  "theme_show_excerpt",
  "theme_show_image_count",
  "theme_show_share_buttons",
  "theme_show_related_posts",
  "theme_enable_lightbox",
  // custom
  "theme_custom_css",
] as const

appearanceAdminRoute.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const user = c.get("user")
  const settings = await loadSettings(siteDb)
  const saved = new URL(c.req.url).searchParams.get("saved")

  const fontOpts = (selected: string) =>
    GOOGLE_FONTS.map((f) => `<option value="${escapeAttr(f)}" ${f === selected ? "selected" : ""}>${escapeHtml(f)}</option>`).join("")

  const presetButtons = PALETTE_PRESETS.map(
    (p) => `<button type="button" class="palette" data-preset="${escapeAttr(p.id)}" title="${escapeAttr(p.name)}">
      <span style="background:${escapeAttr(p.vars.theme_primary_color)}"></span>
      <span style="background:${escapeAttr(p.vars.theme_background_color)}"></span>
      <span style="background:${escapeAttr(p.vars.theme_text_color)}"></span>
      <span style="background:${escapeAttr(p.vars.theme_accent_color)}"></span>
      <em>${escapeHtml(p.name)}</em>
    </button>`
  ).join("")

  // JSON of preset map for client-side application.
  const presetsJson = JSON.stringify(
    Object.fromEntries(PALETTE_PRESETS.map((p) => [p.id, p.vars]))
  )

  const body = `
    ${saved ? `<div class="banner success">Theme saved.</div>` : ""}
    <div class="customizer">
      <aside class="customizer-form">
        <form method="POST" action="/admin/appearance/save" id="theme-form">

          <details open>
            <summary>Color palette</summary>
            <div class="palette-grid">${presetButtons}</div>
            ${["theme_primary_color","theme_secondary_color","theme_accent_color","theme_background_color","theme_surface_color","theme_text_color","theme_text_muted_color","theme_border_color"]
              .map((k) => colorRow(k, settings[k] || "#000000")).join("")}
          </details>

          <details open>
            <summary>Typography</summary>
            <div class="form-row">
              <label>Heading font</label>
              <select name="theme_heading_font" data-live>${fontOpts(settings.theme_heading_font || "Playfair Display")}</select>
            </div>
            <div class="form-row">
              <label>Body font</label>
              <select name="theme_body_font" data-live>${fontOpts(settings.theme_body_font || "DM Sans")}</select>
            </div>
            ${rangeRow("theme_font_size_base", "Base font size", settings.theme_font_size_base || "16px", 12, 22, "px")}
            ${rangeRow("theme_line_height", "Line height", settings.theme_line_height || "1.7", 1.2, 2.0, "", 0.1)}
          </details>

          <details>
            <summary>Layout</summary>
            ${rangeRow("theme_border_radius", "Border radius", settings.theme_border_radius || "16px", 0, 32, "px")}
            ${rangeRow("theme_container_width", "Container width", settings.theme_container_width || "1200px", 800, 1600, "px", 20)}
            ${selectRow("theme_header_layout", "Header layout", settings.theme_header_layout || "split", [
              { v: "split", l: "Split" },
              { v: "centered", l: "Centered" },
              { v: "left", l: "Left-aligned" },
            ])}
            ${selectRow("theme_footer_layout", "Footer layout", settings.theme_footer_layout || "columns", [
              { v: "columns", l: "Columns" },
              { v: "minimal", l: "Minimal" },
            ])}
          </details>

          <details>
            <summary>Grid &amp; cards</summary>
            ${selectRow("theme_grid_columns", "Grid columns", settings.theme_grid_columns || "auto", [
              { v: "auto", l: "Auto (responsive)" },
              { v: "2", l: "2 columns" },
              { v: "3", l: "3 columns" },
              { v: "4", l: "4 columns" },
            ])}
            ${selectRow("theme_card_style", "Card style", settings.theme_card_style || "rounded", [
              { v: "rounded", l: "Rounded" },
              { v: "floating", l: "Floating shadow" },
              { v: "outlined", l: "Outlined" },
              { v: "sharp", l: "Sharp / square" },
            ])}
            ${selectRow("theme_pin_hover_effect", "Pin hover effect", settings.theme_pin_hover_effect || "slide-up", [
              { v: "slide-up", l: "Slide-up overlay" },
              { v: "darken", l: "Darken" },
              { v: "scale", l: "Scale" },
              { v: "none", l: "None" },
            ])}
          </details>

          <details>
            <summary>Display options</summary>
            ${["theme_show_post_dates","theme_show_author","theme_show_reading_time","theme_show_category_badge","theme_show_excerpt","theme_show_image_count","theme_show_share_buttons","theme_show_related_posts","theme_enable_lightbox"]
              .map((k) => toggleRow(k, settings[k] !== "false")).join("")}
          </details>

          <details>
            <summary>Custom CSS</summary>
            <textarea name="theme_custom_css" rows="10" style="font-family:var(--mono);font-size:12px">${escapeHtml(settings.theme_custom_css || "")}</textarea>
            <p class="hint" style="color:var(--muted-2);font-size:12px;margin-top:6px">Saved to <code>:root</code>'s style block. Will be re-rendered on next save.</p>
          </details>

          <div style="position:sticky;bottom:0;background:var(--surface);padding:12px 0;border-top:1px solid var(--border);margin-top:16px;display:flex;gap:8px">
            <button type="submit" class="btn primary" style="flex:1;justify-content:center;padding:10px">Save changes</button>
            <a href="/admin/appearance" class="btn">Reset</a>
          </div>
        </form>
      </aside>

      <div class="customizer-preview">
        <div class="preview-bar">
          <span style="font-family:var(--mono);font-size:12px;color:var(--muted)">https://${escapeHtml(hostname)}/</span>
          <div style="display:flex;gap:6px">
            <button type="button" class="btn sm" data-vp="desktop">🖥</button>
            <button type="button" class="btn sm" data-vp="tablet">📱</button>
            <button type="button" class="btn sm" data-vp="mobile">📱</button>
          </div>
        </div>
        <div class="preview-frame-wrap" id="preview-wrap">
          <iframe id="preview-iframe" src="/?_preview=1" sandbox="allow-scripts allow-same-origin"></iframe>
        </div>
      </div>
    </div>

    <style>
      .customizer{display:grid;grid-template-columns:380px 1fr;gap:0;height:calc(100vh - 130px);min-height:600px}
      @media(max-width:1100px){.customizer{grid-template-columns:1fr;height:auto}}
      .customizer-form{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;overflow-y:auto}
      .customizer-preview{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:var(--radius);margin-left:16px;overflow:hidden;background:var(--bg)}
      @media(max-width:1100px){.customizer-preview{margin-left:0;margin-top:16px;height:600px}}
      .preview-bar{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--surface);border-bottom:1px solid var(--border)}
      .preview-frame-wrap{flex:1;display:flex;justify-content:center;align-items:flex-start;background:#262626;overflow:auto;padding:14px}
      #preview-iframe{width:100%;height:100%;border:none;background:#fff;border-radius:6px;box-shadow:0 8px 30px rgba(0,0,0,0.5);transition:width 0.2s ease,max-width 0.2s ease}
      .preview-frame-wrap.tablet #preview-iframe{max-width:768px}
      .preview-frame-wrap.mobile #preview-iframe{max-width:380px}

      .palette-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:14px}
      .palette{display:flex;align-items:center;gap:6px;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;color:var(--text);font-family:inherit}
      .palette span{width:14px;height:14px;border-radius:4px;display:inline-block}
      .palette em{font-style:normal;font-size:12px;font-weight:500;margin-left:4px}
      .palette:hover{border-color:var(--primary)}

      .color-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
      .color-row label{flex:1;font-size:13px;color:var(--muted)}
      .color-row input[type=color]{width:34px;height:34px;border-radius:6px;border:1px solid var(--border-2);padding:2px;background:var(--bg);cursor:pointer}
      .color-row input[type=text]{width:100px;font-family:var(--mono);font-size:12px;background:var(--bg);border:1px solid var(--border-2);border-radius:var(--radius-sm);padding:6px 8px;color:var(--text)}

      .range-row{margin-bottom:12px}
      .range-row label{display:flex;justify-content:space-between;font-size:13px;color:var(--muted);margin-bottom:6px}
      .range-row label .v{color:var(--text);font-family:var(--mono);font-size:12px}
      .range-row input[type=range]{width:100%;accent-color:var(--primary)}

      details summary{padding:10px 0;cursor:pointer;font-weight:600;font-size:13px;border-bottom:1px solid var(--border);text-transform:uppercase;letter-spacing:0.04em;color:var(--muted)}
      details[open] summary{margin-bottom:14px;color:var(--text)}
    </style>

    <script>
    (function(){
      var presets = ${presetsJson};
      var iframe = document.getElementById('preview-iframe');
      var form = document.getElementById('theme-form');
      var previewWrap = document.getElementById('preview-wrap');

      function send(){
        var vars = {};
        // Match buildThemeCssVars in lib/theme.ts:
        vars['--color-primary'] = byName('theme_primary_color').value;
        vars['--color-secondary'] = byName('theme_secondary_color').value;
        vars['--color-accent'] = byName('theme_accent_color').value;
        vars['--color-bg'] = byName('theme_background_color').value;
        vars['--color-surface'] = byName('theme_surface_color').value;
        vars['--color-text'] = byName('theme_text_color').value;
        vars['--color-muted'] = byName('theme_text_muted_color').value;
        vars['--color-border'] = byName('theme_border_color').value;
        vars['--font-heading'] = "'" + byName('theme_heading_font').value + "', serif";
        vars['--font-body'] = "'" + byName('theme_body_font').value + "', sans-serif";
        vars['--font-size-base'] = byName('theme_font_size_base').value;
        vars['--line-height'] = byName('theme_line_height').value;
        vars['--radius'] = byName('theme_border_radius').value;
        vars['--container-width'] = byName('theme_container_width').value;
        try { iframe.contentWindow.postMessage({ type: 'THEME_UPDATE', vars: vars }, '*'); } catch(e){}
      }

      function byName(n){ return form.querySelector('[name="' + n + '"]'); }

      // Wire color inputs.
      form.querySelectorAll('.color-row').forEach(function(row){
        var pick = row.querySelector('input[type=color]');
        var text = row.querySelector('input[type=text]');
        if (pick && text) {
          pick.addEventListener('input', function(){ text.value = pick.value; send(); });
          text.addEventListener('input', function(){
            if (/^#[0-9a-f]{6}$/i.test(text.value)) { pick.value = text.value; send(); }
          });
        }
      });

      // Wire ranges.
      form.querySelectorAll('input[type=range]').forEach(function(r){
        r.addEventListener('input', function(){
          var disp = r.parentNode.querySelector('.v');
          if (disp) disp.textContent = r.value + (r.dataset.unit || '');
          var hidden = byName(r.dataset.target);
          if (hidden) hidden.value = r.value + (r.dataset.unit || '');
          send();
        });
      });

      // Wire selects.
      form.querySelectorAll('select[data-live]').forEach(function(s){
        s.addEventListener('change', send);
      });

      // Palette presets.
      form.querySelectorAll('.palette').forEach(function(btn){
        btn.addEventListener('click', function(){
          var preset = presets[btn.dataset.preset];
          if (!preset) return;
          Object.keys(preset).forEach(function(k){
            var inp = byName(k);
            if (inp) inp.value = preset[k];
            var pick = form.querySelector('input[type=color][data-target="' + k + '"]');
            if (pick) pick.value = preset[k];
          });
          send();
        });
      });

      // Viewport switch.
      document.querySelectorAll('[data-vp]').forEach(function(b){
        b.addEventListener('click', function(){
          previewWrap.classList.remove('tablet','mobile');
          if (b.dataset.vp !== 'desktop') previewWrap.classList.add(b.dataset.vp);
        });
      });

      window.addEventListener('message', function(e){
        if (e.data && e.data.type === 'PREVIEW_READY') send();
      });

      // Send once on iframe load (in case PREVIEW_READY missed).
      iframe.addEventListener('load', function(){ setTimeout(send, 200); });
    })();
    </script>
  `

  return c.html(
    renderAdminLayout({
      title: `Appearance — ${hostname}`,
      hostname,
      user,
      active: "appearance",
      bodyHtml: body,
      pageHeading: "Appearance",
      fullWidth: true,
    }),
    200,
    { "Cache-Control": "no-store, private" }
  )
})

appearanceAdminRoute.post("/save", async (c) => {
  const siteDb = c.get("siteDb")
  const form = await c.req.formData()

  for (const key of THEME_KEYS) {
    const v = form.get(key)
    if (v === null) continue
    await setSetting(siteDb, key, String(v))
  }
  // Toggles: if absent, treat as "false".
  for (const key of [
    "theme_show_post_dates","theme_show_author","theme_show_reading_time",
    "theme_show_category_badge","theme_show_excerpt","theme_show_image_count",
    "theme_show_share_buttons","theme_show_related_posts","theme_enable_lightbox",
  ]) {
    const v = form.get(key)
    await setSetting(siteDb, key, v === null ? "false" : "true")
  }

  c.executionCtx.waitUntil(purgeEverything(c.env, c.get("hostname")))
  return c.redirect("/admin/appearance?saved=1")
})

// ─────────────── Form helpers ───────────────

function colorRow(name: string, value: string): string {
  const safe = /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"
  const labels: Record<string, string> = {
    theme_primary_color: "Primary",
    theme_secondary_color: "Secondary",
    theme_accent_color: "Accent",
    theme_background_color: "Background",
    theme_surface_color: "Surface (cards)",
    theme_text_color: "Text",
    theme_text_muted_color: "Muted text",
    theme_border_color: "Border",
  }
  return `<div class="color-row">
    <label>${escapeHtml(labels[name] ?? name)}</label>
    <input type="color" data-target="${escapeAttr(name)}" value="${escapeAttr(safe)}">
    <input type="text" name="${escapeAttr(name)}" value="${escapeAttr(value)}" placeholder="#000000">
  </div>`
}

function rangeRow(
  name: string,
  label: string,
  value: string,
  min: number,
  max: number,
  unit: string,
  step: number = 1
): string {
  const numeric = parseFloat(value) || min
  return `<div class="range-row">
    <label>${escapeHtml(label)} <span class="v">${escapeHtml(value)}</span></label>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${numeric}" data-target="${escapeAttr(name)}" data-unit="${escapeAttr(unit)}">
    <input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(value)}">
  </div>`
}

function selectRow(
  name: string,
  label: string,
  value: string,
  opts: Array<{ v: string; l: string }>
): string {
  return `<div class="form-row">
    <label>${escapeHtml(label)}</label>
    <select name="${escapeAttr(name)}" data-live>
      ${opts.map((o) => `<option value="${escapeAttr(o.v)}" ${o.v === value ? "selected" : ""}>${escapeHtml(o.l)}</option>`).join("")}
    </select>
  </div>`
}

function toggleRow(name: string, on: boolean): string {
  const labels: Record<string, string> = {
    theme_show_post_dates: "Show post dates",
    theme_show_author: "Show author",
    theme_show_reading_time: "Show reading time",
    theme_show_category_badge: "Show category badge",
    theme_show_excerpt: "Show excerpt",
    theme_show_image_count: "Show image count",
    theme_show_share_buttons: "Show share buttons",
    theme_show_related_posts: "Show related posts",
    theme_enable_lightbox: "Enable lightbox",
  }
  return `<div class="toggle">
    <input type="checkbox" name="${escapeAttr(name)}" id="${escapeAttr(name)}" ${on ? "checked" : ""}>
    <label for="${escapeAttr(name)}">${escapeHtml(labels[name] ?? name)}</label>
  </div>`
}
