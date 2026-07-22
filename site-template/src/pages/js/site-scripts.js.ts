// /js/site-scripts.js (V1.3 script controls + V1.5 M4 pixels) — the ONE local
// loader for vetted scripts that need a bootstrap (GA4) or must wait for first
// interaction (Crisp, all ad pixels). Generated at build with the enabled
// config baked in; when nothing loader-mode is enabled this endpoint 404s and
// the file is never emitted — the site stays byte-identical zero-JS.
//
// Everything injected here comes from the closed TEMPLATE_SCRIPT_CATALOG with
// pattern-validated config — no arbitrary code can flow through. Ad pixels
// (Amendment 4b) load ONLY here, only after first interaction, and only after
// consent when EU consent mode is on.
import type { APIRoute } from "astro"
import { loadConfig, fetchSeoSettings, validScripts, enabledPixels, pixelConsentMode } from "../../lib/cms"

// Per-pixel bootstrap + conversion snippets. `id` is pattern-validated upstream
// (digits / AW- / alnum only — no quotes possible), so interpolation is safe.
// Each returns { load, lead, purchase } JS expression strings; lead/purchase may
// be "" when the network has no baseline conversion without extra config.
function pixelSnippet(pid: string, config: string): { load: string; lead: string; purchase: string } {
  switch (pid) {
    case "meta_pixel":
      return {
        load:
          `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};` +
          `if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;` +
          `t.src='https://connect.facebook.net/en_US/fbevents.js';s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}` +
          `(window,document,'script');fbq('init','${config}');fbq('track','PageView');`,
        lead: `if(window.fbq)fbq('track','Lead');`,
        purchase: `if(window.fbq)fbq('track','Purchase');`,
      }
    case "google_ads":
      return {
        load:
          `window.dataLayer=window.dataLayer||[];if(!window.gtag){window.gtag=function(){dataLayer.push(arguments)};}` +
          `var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id=${config}';document.head.appendChild(s);` +
          `gtag('js',new Date());gtag('config','${config}');`,
        lead: `if(window.gtag)gtag('event','conversion',{send_to:'${config}'});`,
        purchase: `if(window.gtag)gtag('event','conversion',{send_to:'${config}'});`,
      }
    case "tiktok_pixel":
      return {
        load:
          `!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=['page','track','identify','instances','debug','on','off','once','ready','alias','group','enableCookie','disableCookie'];` +
          `ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);` +
          `ttq.load=function(e,n){var i='https://analytics.tiktok.com/i18n/pixel/events.js';ttq._i=ttq._i||{};ttq._i[e]=[];ttq._i[e]._u=i;ttq._t=ttq._t||{};ttq._t[e]=+new Date;ttq._o=ttq._o||{};ttq._o[e]=n||{};` +
          `var o=d.createElement('script');o.type='text/javascript';o.async=!0;o.src=i+'?sdkid='+e+'&lib='+t;var a=d.getElementsByTagName('script')[0];a.parentNode.insertBefore(o,a)};` +
          `ttq.load('${config}');ttq.page()}(window,document,'ttq');`,
        lead: `if(window.ttq)ttq.track('SubmitForm');`,
        purchase: `if(window.ttq)ttq.track('CompletePayment');`,
      }
    case "linkedin_insight":
      return {
        load:
          `window._linkedin_partner_id='${config}';window._linkedin_data_partner_ids=window._linkedin_data_partner_ids||[];window._linkedin_data_partner_ids.push('${config}');` +
          `var s=document.createElement('script');s.async=true;s.src='https://snap.licdn.com/li.lms-analytics/insight.min.js';document.head.appendChild(s);`,
        lead: ``, // LinkedIn conversions require a separate conversion id (out of baseline)
        purchase: ``,
      }
    case "pinterest_tag":
      return {
        load:
          `!function(e){if(!window.pintrk){window.pintrk=function(){window.pintrk.queue.push(Array.prototype.slice.call(arguments))};var n=window.pintrk;n.queue=[],n.version='3.0';` +
          `var t=document.createElement('script');t.async=!0,t.src=e;var r=document.getElementsByTagName('script')[0];r.parentNode.insertBefore(t,r)}}('https://s.pinimg.com/ct/core.js');` +
          `pintrk('load','${config}');pintrk('page');`,
        lead: `if(window.pintrk)pintrk('track','lead');`,
        purchase: `if(window.pintrk)pintrk('track','checkout');`,
      }
    default:
      return { load: "", lead: "", purchase: "" }
  }
}

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

  // Ad & marketing pixels (V1.5 M4). All delay-until-interaction; consent-gated
  // when EU consent mode is on. Conversions fire on the form-success (?sent=1)
  // and checkout-success (/order/success/) pages — immediately there, since
  // those are post-action pages the visitor may not scroll.
  const pixels = enabledPixels(settings)
  if (pixels.length) {
    const consent = pixelConsentMode(settings)
    const defs = pixels
      .map((p) => {
        const s = pixelSnippet(p.id, p.config)
        return `{load:function(){${s.load}},lead:function(){${s.lead}},purchase:function(){${s.purchase}}}`
      })
      .join(",")
    parts.push(
      `(function(){` +
        `var P=[${defs}];var fired=false;` +
        `function fireAll(){if(fired)return;fired=true;P.forEach(function(p){try{p.load();}catch(e){}});fireConv();}` +
        `function fireConv(){try{` +
        `if(/[?&]sent=1(?:&|$)/.test(location.search))P.forEach(function(p){try{p.lead();}catch(e){}});` +
        `if(location.pathname.indexOf('/order/success')===0)P.forEach(function(p){try{p.purchase();}catch(e){}});` +
        `}catch(e){}}` +
        `function start(){var conv=/[?&]sent=1(?:&|$)/.test(location.search)||location.pathname.indexOf('/order/success')===0;` +
        `if(conv){fireAll();return;}var evs=['scroll','pointerdown','keydown','touchstart'];` +
        `function h(){evs.forEach(function(ev){window.removeEventListener(ev,h);});fireAll();}` +
        `evs.forEach(function(ev){window.addEventListener(ev,h,{once:true,passive:true});});}` +
        `function ck(n){var m=document.cookie.match('(?:^|; )'+n+'=([^;]*)');return m?m[1]:null;}` +
        `function setC(v){document.cookie='sn_consent='+v+';path=/;max-age=31536000;samesite=lax';}` +
        `var CONSENT=${consent ? "true" : "false"};` +
        `if(!CONSENT){start();return;}` +
        `var c=ck('sn_consent');if(c==='1'){start();return;}if(c==='0'){return;}` +
        `var b=document.getElementById('sn-consent');if(!b){return;}b.removeAttribute('hidden');` +
        `var a=document.getElementById('sn-consent-accept'),d=document.getElementById('sn-consent-decline');` +
        `if(a)a.addEventListener('click',function(){setC('1');b.setAttribute('hidden','');fireAll();});` +
        `if(d)d.addEventListener('click',function(){setC('0');b.setAttribute('hidden','');});` +
        `})();`
    )
  }

  if (!parts.length) return new Response(null, { status: 404 })
  return new Response(parts.join("\n"), {
    headers: { "Content-Type": "application/javascript; charset=utf-8" },
  })
}
