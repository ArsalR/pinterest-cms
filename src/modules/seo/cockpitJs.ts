// src/modules/seo/cockpitJs.ts
// The SEO cockpit's client script, served verbatim from a dashboard route (no
// build step — the dashboard has none). Hand-written vanilla JS: 3 tabs, live
// SERP + social previews (pixel-width truncation mirrored from analyze.ts),
// FAQ builder, fetch-based save with an undo-less success toast, and the
// slug→redirect offer. Keyboard-navigable (native inputs + focusable tabs).

export const SEO_COCKPIT_JS = String.raw`(function () {
  var root = document.getElementById("seo-cockpit");
  var seedEl = document.getElementById("seo-seed");
  if (!root || !seedEl) return;
  var d = JSON.parse(seedEl.textContent || "{}");
  var TITLE_PX = 600, DESC_PX = 920;
  var WIDE = "mwMWGOQ@", NARROW = " iljftrI!.,'";
  function px(s){var w=0;for(var i=0;i<s.length;i++){var c=s[i];if(NARROW.indexOf(c)>=0)w+=4;else if(WIDE.indexOf(c)>=0)w+=12;else if(c>="A"&&c<="Z")w+=9;else w+=7;}return w;}
  function trunc(s,max){s=(s||"").trim();if(px(s)<=max)return{t:s,cut:false,px:px(s)};var out="";var parts=s.split(/(\s+)/);for(var i=0;i<parts.length;i++){if(px(out+parts[i])+4>max)break;out+=parts[i];}out=out.replace(/\s+$/,"");return{t:out+"…",cut:true,px:px(out)+4};}
  function esc(s){return (s||"").replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}

  function field(label,id,val,ph,ta){
    return '<label style="display:block;font-size:13px;margin:10px 0 4px">'+esc(label)+'</label>'+
      (ta?'<textarea id="'+id+'" rows="2" placeholder="'+esc(ph)+'" style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:9px;color:#fafafa;font-size:13px">'+esc(val)+'</textarea>'
         :'<input id="'+id+'" value="'+esc(val)+'" placeholder="'+esc(ph)+'" style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:9px;color:#fafafa;font-size:13px">');
  }
  function bar(id){return '<div style="height:4px;background:#262626;border-radius:2px;margin-top:5px"><div id="'+id+'" style="height:100%;border-radius:2px;background:#86efac;width:0%"></div></div><div id="'+id+'-t" class="muted" style="font-size:11px;margin-top:3px"></div>';}
  var schemaOpts = '<option value="">Default (Article)</option>' + (document.getElementById("schema-types")?document.getElementById("schema-types").innerHTML:"");

  root.innerHTML =
    '<div class="card"><div id="seo-tabs" style="display:flex;gap:6px;border-bottom:1px solid #262626;margin-bottom:14px">'+
      ['Snippet','Social','Advanced'].map(function(t,i){return '<button type="button" class="seo-tab" data-tab="'+i+'" style="background:none;border:none;border-bottom:2px solid '+(i===0?'#fafafa':'transparent')+';color:'+(i===0?'#fafafa':'#a3a3a3')+';padding:8px 10px;font-size:13px;cursor:pointer;font-family:inherit">'+t+'</button>';}).join("")+'</div>'+
      // Snippet
      '<div class="seo-pane" data-pane="0">'+
        field("Meta title","f-metaTitle",d.metaTitle,"Defaults to “"+esc(d.title)+" — "+esc(d.siteName)+"”")+bar("b-title")+
        field("Meta description","f-metaDescription",d.metaDescription,"Defaults to the excerpt",true)+bar("b-desc")+
        field("Slug","f-slug",d.slug,"url-slug")+
        '<div id="slug-redirect" style="display:none;margin-top:6px"><label style="font-size:12px"><input type="checkbox" id="f-addRedirect" checked> Add a 301 from the old URL (recommended for a published page)</label></div>'+
        '<div style="margin-top:14px;background:#fff;border-radius:8px;padding:12px;color:#202124;font-family:arial,sans-serif">'+
          '<div style="color:#202124;font-size:14px">'+esc(d.siteName)+'</div>'+
          '<div style="color:#4d5156;font-size:12px">'+esc(d.url)+'</div>'+
          '<div id="serp-title" style="color:#1a0dab;font-size:18px;line-height:1.3;margin:2px 0"></div>'+
          '<div id="serp-desc" style="color:#4d5156;font-size:13px;line-height:1.4"></div>'+
        '</div>'+
      '</div>'+
      // Social
      '<div class="seo-pane" data-pane="1" style="display:none">'+
        field("Social title","f-ogTitle",d.ogTitle,"Falls back to meta/title")+
        field("Social description","f-ogDescription",d.ogDescription,"Falls back to meta/excerpt",true)+
        field("Social image URL","f-ogImage",d.ogImage,"Falls back to the cover image")+
        '<div style="margin-top:14px;border:1px solid #262626;border-radius:10px;overflow:hidden;max-width:420px">'+
          '<div id="og-img" style="height:180px;background:#0a0a0a center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:#555;font-size:13px">no image</div>'+
          '<div style="padding:10px 12px;background:#171717"><div class="muted" style="font-size:11px;text-transform:uppercase">'+esc((d.url.split("/")[2])||"")+'</div><div id="og-title" style="font-weight:600;font-size:14px"></div><div id="og-desc" class="muted" style="font-size:12px"></div></div>'+
        '</div>'+
      '</div>'+
      // Advanced
      '<div class="seo-pane" data-pane="2" style="display:none">'+
        '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:8px 0"><input type="checkbox" id="f-noIndex" '+(d.noIndex?"checked":"")+'> No-index this page <span class="muted">(hides it from search)</span></label>'+
        '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:8px 0"><input type="checkbox" id="f-nofollow" '+(d.nofollow?"checked":"")+'> No-follow this page’s links</label>'+
        '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:8px 0"><input type="checkbox" id="f-sitemapExclude" '+(d.sitemapExclude?"checked":"")+'> Exclude from sitemap</label>'+
        field("Canonical URL override","f-canonicalUrl",d.canonicalUrl,"https://… (leave blank for the default)")+
        '<label style="display:block;font-size:13px;margin:10px 0 4px">Schema type</label><select id="f-schemaType" style="background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:9px;color:#fafafa;font-size:13px">'+schemaOpts+'</select>'+
        '<div style="margin-top:14px"><div style="font-size:13px;margin-bottom:6px">FAQ (emits FAQPage schema)</div><div id="faq-list"></div><button type="button" id="faq-add" class="btn ghost" style="margin-top:6px">+ Add question</button></div>'+
      '</div>'+
      '<div style="display:flex;align-items:center;gap:12px;margin-top:16px;border-top:1px solid #262626;padding-top:12px"><button type="button" id="seo-save" class="btn">Save</button><span id="seo-toast" class="muted" style="font-size:13px"></span></div>'+
    '</div>';

  var $=function(id){return document.getElementById(id);};
  if(d.schemaType)$("f-schemaType").value=d.schemaType;

  // tabs
  root.querySelectorAll(".seo-tab").forEach(function(b){b.addEventListener("click",function(){
    root.querySelectorAll(".seo-tab").forEach(function(x){x.style.borderBottomColor="transparent";x.style.color="#a3a3a3";});
    b.style.borderBottomColor="#fafafa";b.style.color="#fafafa";
    root.querySelectorAll(".seo-pane").forEach(function(p){p.style.display=p.getAttribute("data-pane")===b.getAttribute("data-tab")?"block":"none";});
  });});

  function refresh(){
    var t=trunc($("f-metaTitle").value|| (d.title+" — "+d.siteName),TITLE_PX);
    $("serp-title").textContent=t.t; $("b-title").style.width=Math.min(100,t.px/TITLE_PX*100)+"%"; $("b-title").style.background=t.cut?"#fca5a5":"#86efac";
    $("b-title-t").textContent=Math.round(t.px)+" / "+TITLE_PX+"px"+(t.cut?" — will be cut":"");
    var ds=trunc($("f-metaDescription").value||d.excerpt,DESC_PX);
    $("serp-desc").textContent=ds.t; $("b-desc").style.width=Math.min(100,ds.px/DESC_PX*100)+"%"; $("b-desc").style.background=ds.cut?"#fca5a5":"#86efac";
    $("b-desc-t").textContent=Math.round(ds.px)+" / "+DESC_PX+"px"+(ds.cut?" — will be cut":"");
    $("og-title").textContent=$("f-ogTitle").value||$("f-metaTitle").value||d.title;
    $("og-desc").textContent=$("f-ogDescription").value||$("f-metaDescription").value||d.excerpt;
    var img=$("f-ogImage").value||d.coverImage;
    if(img){$("og-img").style.backgroundImage='url("'+img.replace(/"/g,'')+'")';$("og-img").textContent="";}else{$("og-img").style.backgroundImage="";$("og-img").textContent="no image";}
    $("slug-redirect").style.display=(d.published && $("f-slug").value!==d.slug)?"block":"none";
  }
  ["f-metaTitle","f-metaDescription","f-slug","f-ogTitle","f-ogDescription","f-ogImage"].forEach(function(id){$(id).addEventListener("input",refresh);});

  // FAQ builder
  function faqRow(q,a){var row=document.createElement("div");row.className="faq-row";row.style.cssText="display:flex;gap:6px;margin:5px 0";
    row.innerHTML='<input class="faq-q" placeholder="Question" value="'+esc(q)+'" style="flex:1;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:7px;color:#fafafa;font-size:12px"><input class="faq-a" placeholder="Answer" value="'+esc(a)+'" style="flex:2;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:7px;color:#fafafa;font-size:12px"><button type="button" class="faq-x" style="background:none;border:none;color:#737373;cursor:pointer">✕</button>';
    row.querySelector(".faq-x").addEventListener("click",function(){row.remove();});return row;}
  (d.faq||[]).forEach(function(f){$("faq-list").appendChild(faqRow(f.question,f.answer));});
  $("faq-add").addEventListener("click",function(){$("faq-list").appendChild(faqRow("",""));});

  $("seo-save").addEventListener("click",function(){
    var btn=$("seo-save");btn.disabled=true;$("seo-toast").textContent="Saving…";
    var faq=[].map.call($("faq-list").querySelectorAll(".faq-row"),function(r){return{question:r.querySelector(".faq-q").value,answer:r.querySelector(".faq-a").value};});
    var payload={metaTitle:$("f-metaTitle").value,metaDescription:$("f-metaDescription").value,slug:$("f-slug").value,
      ogTitle:$("f-ogTitle").value,ogDescription:$("f-ogDescription").value,ogImage:$("f-ogImage").value,
      canonicalUrl:$("f-canonicalUrl").value,noIndex:$("f-noIndex").checked,nofollow:$("f-nofollow").checked,
      sitemapExclude:$("f-sitemapExclude").checked,schemaType:$("f-schemaType").value,faq:faq,
      addRedirect:$("f-addRedirect")?$("f-addRedirect").checked:false};
    fetch(root.getAttribute("data-save"),{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify(payload)})
      .then(function(r){return r.json();}).then(function(res){
        btn.disabled=false;
        if(res.ok){d.slug=payload.slug;$("slug-redirect").style.display="none";$("seo-toast").textContent="Saved — rebuilding your site"+(res.redirectAdded?" (301 added)":"")+".";$("seo-toast").style.color="#86efac";}
        else{$("seo-toast").textContent=res.error||"Couldn’t save.";$("seo-toast").style.color="#fca5a5";}
      }).catch(function(){btn.disabled=false;$("seo-toast").textContent="Network error — try again.";$("seo-toast").style.color="#fca5a5";});
  });

  refresh();
})();`
