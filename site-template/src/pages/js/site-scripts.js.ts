// /js/site-scripts.js (V1.3 script controls) — the ONE local loader for vetted
// scripts that need a bootstrap (GA4) or must wait for first interaction
// (Crisp). Generated at build with the enabled config baked in; when no
// loader-mode script is enabled this endpoint 404s and the file is never
// emitted — the site stays byte-identical zero-JS.
//
// Everything injected here comes from the closed TEMPLATE_SCRIPT_CATALOG with
// pattern-validated config — no arbitrary code can flow through.
import type { APIRoute } from "astro"
import { loadConfig, fetchSeoSettings, validScripts } from "../../lib/cms"

export const GET: APIRoute = async () => {
  const config = loadConfig()
  const settings = await fetchSeoSettings(config)
  const enabled = validScripts(settings)
  const parts: string[] = []

  const ga4 = enabled.find((e) => e.entry.id === "ga4")
  if (ga4) {
    // Standard gtag bootstrap, deferred with the page (analytics never blocks
    // content). Config is pattern-validated (G-XXXXXXXX).
    parts.push(
      `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${ga4.config}');` +
        `(function(){var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id=${ga4.config}';document.head.appendChild(s);})();`
    )
  }

  const crisp = enabled.find((e) => e.entry.id === "crisp")
  if (crisp) {
    // Delay-until-interaction: the chat widget (~35KB) loads only after the
    // visitor first scrolls, touches, or presses a key.
    parts.push(
      `(function(){var loaded=false;function load(){if(loaded)return;loaded=true;` +
        `window.$crisp=[];window.CRISP_WEBSITE_ID='${crisp.config}';` +
        `var s=document.createElement('script');s.async=true;s.src='https://client.crisp.chat/l.js';document.head.appendChild(s);` +
        `['scroll','pointerdown','keydown','touchstart'].forEach(function(ev){window.removeEventListener(ev,load);});}` +
        `['scroll','pointerdown','keydown','touchstart'].forEach(function(ev){window.addEventListener(ev,load,{once:true,passive:true});});})();`
    )
  }

  if (!parts.length) return new Response(null, { status: 404 })
  return new Response(parts.join("\n"), {
    headers: { "Content-Type": "application/javascript; charset=utf-8" },
  })
}
