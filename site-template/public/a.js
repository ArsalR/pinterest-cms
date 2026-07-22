/* SiteNetwork first-party analytics beacon (Amendment 4a).
   Cookieless, no localStorage, no fingerprinting, no IP. Honors DNT + GPC.
   Config comes from this tag's data-* attributes (data-ingest, data-site) so
   the FILE is byte-identical across sites — the zero-JS gate allows it by hash.
   Reports stable data-ev attributes + outbound hosts only, never coordinates. */
(function () {
  try {
    if (navigator.doNotTrack === "1" || window.doNotTrack === "1" || navigator.globalPrivacyControl) return;
    var s = document.currentScript;
    if (!s) return;
    var ingest = s.getAttribute("data-ingest"), site = s.getAttribute("data-site");
    if (!ingest || !site) return;
    var sent = {};
    function send(t, a) {
      try {
        var ref = "";
        if (document.referrer) { try { ref = new URL(document.referrer).origin; } catch (e) {} }
        navigator.sendBeacon(ingest, JSON.stringify({ s: site, t: t, p: location.pathname, r: ref, a: a || "" }));
      } catch (e) {}
    }
    send("pv");
    var maxb = 0;
    addEventListener("scroll", function () {
      var h = document.documentElement, top = h.scrollTop || document.body.scrollTop, max = h.scrollHeight - h.clientHeight;
      var p = max > 0 ? (top / max) * 100 : 100;
      var b = p >= 100 ? 100 : p >= 75 ? 75 : p >= 50 ? 50 : p >= 25 ? 25 : 0;
      if (b > maxb) { maxb = b; if (b && !sent["s" + b]) { sent["s" + b] = 1; send("sd", "" + b); } }
    }, { passive: true });
    addEventListener("click", function (e) {
      var el = e.target;
      while (el && el.getAttribute) {
        var ev = el.getAttribute("data-ev");
        if (ev) { send("cl", ev); return; }
        if (el.tagName === "A" && el.host && el.host !== location.host) { send("ob", el.host); return; }
        el = el.parentNode;
      }
    }, { passive: true, capture: true });
    var start = Date.now(), eng = 0, vis = !document.hidden;
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { eng += Date.now() - start; vis = false; } else { start = Date.now(); vis = true; }
    });
    addEventListener("pagehide", function () {
      if (vis) eng += Date.now() - start;
      send("te", "" + Math.round(eng / 1000));
    });
  } catch (e) {}
})();
