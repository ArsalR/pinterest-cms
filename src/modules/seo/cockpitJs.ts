// src/modules/seo/cockpitJs.ts
// The SEO cockpit's client script, served verbatim from a dashboard route (no
// build step — the dashboard has none). Hand-written vanilla JS: 4 tabs, live
// SERP + social previews (pixel-width truncation mirrored from analyze.ts), a
// live Content-analysis tab (S2 — mirrors content.ts + the quality gate's own
// rules), FAQ builder, fetch-based save with one-click undo (S6), the rail-#2
// typed-override flow, and the slug→redirect offer. Keyboard-navigable: native
// inputs, focusable tabs, Left/Right arrows switch tabs.

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

  function field(label,id,val,ph,ta,assistTask){
    // ✨ assist buttons render only when the customer's key is connected.
    var assistBtn=(assistTask&&d.assist)?' <button type="button" class="assist-btn" data-task="'+assistTask+'" data-target="'+id+'" style="background:none;border:1px solid #404040;border-radius:6px;color:#fcd34d;font-size:11px;padding:1px 7px;cursor:pointer;vertical-align:1px">✨ Suggest</button>':'';
    return '<label style="display:block;font-size:13px;margin:10px 0 4px">'+esc(label)+assistBtn+'</label>'+
      (ta?'<textarea id="'+id+'" rows="2" placeholder="'+esc(ph)+'" style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:9px;color:#fafafa;font-size:13px">'+esc(val)+'</textarea>'
         :'<input id="'+id+'" value="'+esc(val)+'" placeholder="'+esc(ph)+'" style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:9px;color:#fafafa;font-size:13px">');
  }
  function bar(id){return '<div style="height:4px;background:#262626;border-radius:2px;margin-top:5px"><div id="'+id+'" style="height:100%;border-radius:2px;background:#86efac;width:0%"></div></div><div id="'+id+'-t" class="muted" style="font-size:11px;margin-top:3px"></div>';}
  var schemaOpts = '<option value="">Default (Article)</option>' + (document.getElementById("schema-types")?document.getElementById("schema-types").innerHTML:"");

  root.innerHTML =
    '<div class="card"><div id="seo-tabs" style="display:flex;gap:6px;border-bottom:1px solid #262626;margin-bottom:14px">'+
      ['Snippet','Social','Advanced','Content'].map(function(t,i){return '<button type="button" class="seo-tab" data-tab="'+i+'" style="background:none;border:none;border-bottom:2px solid '+(i===0?'#fafafa':'transparent')+';color:'+(i===0?'#fafafa':'#a3a3a3')+';padding:8px 10px;font-size:13px;cursor:pointer;font-family:inherit">'+t+'</button>';}).join("")+'</div>'+
      // Snippet
      '<div class="seo-pane" data-pane="0">'+
        field("Meta title","f-metaTitle",d.metaTitle,"Defaults to “"+esc(d.title)+" — "+esc(d.siteName)+"”",false,"meta_title")+bar("b-title")+
        field("Meta description","f-metaDescription",d.metaDescription,"Defaults to the excerpt",true,"meta_description")+bar("b-desc")+
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
        (d.aiProfile?'<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:8px 0"><input type="checkbox" id="f-llmsExclude" '+(d.llmsExclude?"checked":"")+'> Keep out of llms-full.txt <span class="muted">(the full-content file AI assistants read)</span></label>':'')+
        field("Canonical URL override","f-canonicalUrl",d.canonicalUrl,"https://… (leave blank for the default)")+
        '<label style="display:block;font-size:13px;margin:10px 0 4px">Schema type</label><select id="f-schemaType" style="background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:9px;color:#fafafa;font-size:13px">'+schemaOpts+'</select>'+
        '<label style="display:block;font-size:13px;margin:10px 0 4px">Author <span class="muted">(byline + Person schema — manage authors in SEO → Authors)</span></label><select id="f-authorId" style="background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:9px;color:#fafafa;font-size:13px"><option value="">No author</option>'+((d.authors||[]).map(function(a){return '<option value="'+esc(a.id)+'">'+esc(a.name)+'</option>';}).join(""))+'</select>'+
        '<div style="margin-top:14px"><div style="font-size:13px;margin-bottom:6px">FAQ (emits FAQPage schema)'+(d.assist?' <button type="button" class="assist-btn" data-task="faq" data-target="faq" style="background:none;border:1px solid #404040;border-radius:6px;color:#fcd34d;font-size:11px;padding:1px 7px;cursor:pointer">✨ Suggest from content</button>':'')+'</div><div id="faq-list"></div><button type="button" id="faq-add" class="btn ghost" style="margin-top:6px">+ Add question</button></div>'+
      '</div>'+
      // Content — live analysis sharing the quality gate's rules (S2).
      '<div class="seo-pane" data-pane="3" style="display:none">'+
        field("Focus keyword","f-focusKeyword",d.focusKeyword||"","The phrase you want this post to rank for (optional)")+
        '<div style="display:flex;align-items:center;gap:10px;margin:12px 0 4px"><div id="ca-score" style="font-weight:700;font-size:22px">–</div><div class="muted" style="font-size:12px">Live check — same rules as the publish quality gate.</div></div>'+
        '<div id="content-checks"></div>'+
        (d.aiProfile?'<h4 style="margin:14px 0 4px;font-size:13px">AI visibility</h4><div class="muted" style="font-size:11px;margin-bottom:6px">Will AI answers quote this page? (mirrors the server checklist)</div><div id="ai-checks"></div>':'')+
      '</div>'+
      '<div id="seo-override" style="display:none;margin-top:12px;border:1px solid #b45309;border-radius:8px;padding:10px;background:#1c1104">'+
        '<div id="seo-override-msg" style="font-size:13px;color:#fcd34d;margin-bottom:6px"></div>'+
        '<input id="f-typedOverride" placeholder="NOINDEX ANYWAY" style="width:100%;background:#0a0a0a;border:1px solid #b45309;border-radius:8px;padding:9px;color:#fafafa;font-size:13px">'+
      '</div>'+
      '<div style="display:flex;align-items:center;gap:12px;margin-top:16px;border-top:1px solid #262626;padding-top:12px"><button type="button" id="seo-save" class="btn">Save</button><button type="button" id="seo-undo" class="btn ghost" style="display:none">Undo</button><span id="seo-toast" class="muted" style="font-size:13px"></span></div>'+
    '</div>';

  var $=function(id){return document.getElementById(id);};
  if(d.schemaType)$("f-schemaType").value=d.schemaType;
  if(d.authorId)$("f-authorId").value=d.authorId;

  // tabs — click + Left/Right arrow-key navigation (S6 keyboard nav)
  var tabs=[].slice.call(root.querySelectorAll(".seo-tab"));
  function selectTab(b){
    tabs.forEach(function(x){x.style.borderBottomColor="transparent";x.style.color="#a3a3a3";});
    b.style.borderBottomColor="#fafafa";b.style.color="#fafafa";
    root.querySelectorAll(".seo-pane").forEach(function(p){p.style.display=p.getAttribute("data-pane")===b.getAttribute("data-tab")?"block":"none";});
  }
  tabs.forEach(function(b,i){
    b.addEventListener("click",function(){selectTab(b);});
    b.addEventListener("keydown",function(e){
      if(e.key!=="ArrowRight"&&e.key!=="ArrowLeft")return;
      e.preventDefault();
      var next=tabs[(i+(e.key==="ArrowRight"?1:tabs.length-1))%tabs.length];
      next.focus();selectTab(next);
    });
  });

  // ── Content analysis (mirrors src/modules/seo/content.ts + the quality gate).
  // minWords 300 is the gate's own threshold — keep in sync with DEFAULT_GATE_CONFIG.
  function stripTags(h){return (h||"").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&[a-z]+;/gi," ").replace(/\s+/g," ").trim();}
  function wc(h){var t=stripTags(h);return t?t.split(/\s+/).length:0;}
  function count(hay,needle){if(!needle)return 0;var h=hay.toLowerCase(),n=needle.toLowerCase(),i=0,c=0,at;while((at=h.indexOf(n,i))>=0){c++;i=at+n.length;}return c;}
  function caChecks(){
    var MINW=300, out=[];
    var title=($("f-metaTitle").value||d.title||"").trim();
    var meta=($("f-metaDescription").value||d.excerpt||"").trim();
    var html=d.content||""; var text=stripTags(html); var words=wc(html);
    var kw=($("f-focusKeyword").value||"").trim();
    out.push({s:words>=MINW?"good":words>=MINW/2?"warn":"bad",l:"Content length",d:words+" words (gate minimum "+MINW+")"});
    var tt=trunc(title,TITLE_PX);
    out.push({s:!title?"bad":tt.cut?"warn":"good",l:"SEO title",d:!title?"missing title":tt.cut?"will be truncated in search":"good length"});
    out.push({s:meta.length<20?"bad":"good",l:"Meta description",d:meta.length<20?"missing or too short (needs ≥ 20 chars)":"good length"});
    var hs=(html.match(/<h[2-6][^>]*>/gi)||[]).length;
    out.push({s:hs>=1?"good":"warn",l:"Subheadings",d:hs>=1?hs+" subheading(s)":"no H2–H6 subheadings"});
    var links=(html.match(/<a\b[^>]*\bhref\s*=/gi)||[]).length;
    out.push({s:links>=1?"good":"warn",l:"Links",d:links>=1?links+" link(s)":"no links in the content"});
    var imgs=(html.match(/<img\b/gi)||[]).length;
    if(imgs>0){var miss=0;var re=/<img\b[^>]*>/gi,m;while((m=re.exec(html))){var a=/\balt\s*=\s*["']([^"']*)["']/i.exec(m[0]);if(!a||!a[1].trim())miss++;}
      out.push({s:miss===0?"good":"bad",l:"Image alt text",d:miss===0?"every image has alt text":miss+" of "+imgs+" images missing alt text"});}
    if(kw){
      out.push({s:count(title,kw)>0?"good":"warn",l:"Keyword in title",d:count(title,kw)>0?"present":"not in the title"});
      var firstP=(/<p[^>]*>([\s\S]*?)<\/p>/i.exec(html)||[])[1]||html.slice(0,500);
      out.push({s:count(stripTags(firstP),kw)>0?"good":"warn",l:"Keyword in intro",d:count(stripTags(firstP),kw)>0?"appears early":"missing from the first paragraph"});
      var occ=count(text,kw);var dens=words>0?(occ*kw.split(/\s+/).length)/words:0;var pct=Math.round(dens*1000)/10;
      out.push({s:dens===0?"warn":dens>0.035?"bad":dens<0.003?"warn":"good",l:"Keyword density",d:pct+"% ("+occ+"×) — aim for 0.3–3%"});
    }
    return out;
  }
  function aiChecks(){
    if(!d.aiProfile)return [];
    var html=d.content||"";var out=[];
    var tldr=/<div class="aeo-tldr">/i.test(html);
    var ex=($("f-metaDescription").value||d.excerpt||"").trim();
    var hasSummary=tldr||(ex.length>=40&&ex.length<=300);
    out.push({s:hasSummary?"good":"warn",l:"Quotable summary",d:hasSummary?"AI engines can lift a clean summary":"Add a TL;DR block or a 40-300 char excerpt"});
    var heads=[];var hr=/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi,hm;while((hm=hr.exec(html)))heads.push(hm[1].replace(/<[^>]+>/g," ").trim());
    var q=heads.filter(function(h){return /\?$/.test(h)||/^(how|what|why|when|where|which|who|can|do|does|is|are|should|will)\b/i.test(h);}).length;
    out.push({s:(heads.length===0||q>0)?"good":"warn",l:"Question-shaped headings",d:heads.length===0?"no subheadings to shape":q>0?q+" of "+heads.length+" answer a question":"phrase headings as the questions people ask"});
    var nums=/\d[\d,.]*\s*(%|percent|million|billion|\$)/i.test(html.replace(/<[^>]+>/g," "));
    var sourced=/<div class="aeo-stat">[\s\S]*?href/i.test(html);
    out.push({s:(!nums||sourced)?"good":"warn",l:"Stats carry sources",d:!nums?"no statistics to source":sourced?"sourced":"link a source next to each statistic"});
    var hasAuthor=$("f-authorId")&&$("f-authorId").value;
    out.push({s:hasAuthor?"good":"warn",l:"Author attributed",d:hasAuthor?"byline set":"assign an author (Advanced tab)"});
    return out;
  }
  function caRender(){
    var checks=caChecks();var w={good:1,warn:0.5,bad:0};
    var score=checks.length?Math.round(checks.reduce(function(s,c){return s+w[c.s];},0)/checks.length*100):100;
    var color=score>=80?"#86efac":score>=50?"#fcd34d":"#fca5a5";
    var se=$("ca-score");if(se){se.textContent=score;se.style.color=color;}
    var dot={good:"#86efac",warn:"#fcd34d",bad:"#fca5a5"};
    $("content-checks").innerHTML=checks.map(function(c){return '<div style="display:flex;gap:8px;align-items:baseline;padding:6px 0;border-top:1px solid #1a1a1a"><span style="color:'+dot[c.s]+'">●</span><div><div style="font-size:13px">'+esc(c.l)+'</div><div class="muted" style="font-size:12px">'+esc(c.d)+'</div></div></div>';}).join("");
    var ai=$("ai-checks");
    if(ai){ai.innerHTML=aiChecks().map(function(c){return '<div style="display:flex;gap:8px;align-items:baseline;padding:6px 0;border-top:1px solid #1a1a1a"><span style="color:'+dot[c.s]+'">●</span><div><div style="font-size:13px">'+esc(c.l)+'</div><div class="muted" style="font-size:12px">'+esc(c.d)+'</div></div></div>';}).join("");}
  }

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
    caRender();
  }
  ["f-metaTitle","f-metaDescription","f-slug","f-ogTitle","f-ogDescription","f-ogImage","f-focusKeyword"].forEach(function(id){$(id).addEventListener("input",refresh);});

  // FAQ builder
  function faqRow(q,a){var row=document.createElement("div");row.className="faq-row";row.style.cssText="display:flex;gap:6px;margin:5px 0";
    row.innerHTML='<input class="faq-q" placeholder="Question" value="'+esc(q)+'" style="flex:1;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:7px;color:#fafafa;font-size:12px"><input class="faq-a" placeholder="Answer" value="'+esc(a)+'" style="flex:2;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:7px;color:#fafafa;font-size:12px"><button type="button" class="faq-x" style="background:none;border:none;color:#737373;cursor:pointer">✕</button>';
    row.querySelector(".faq-x").addEventListener("click",function(){row.remove();});return row;}
  (d.faq||[]).forEach(function(f){$("faq-list").appendChild(faqRow(f.question,f.answer));});
  $("faq-add").addEventListener("click",function(){$("faq-list").appendChild(faqRow("",""));});

  // ✨ assists — call the platform with {task, postId}; content is loaded
  // server-side and suggestions land in the field for the human to edit/accept.
  root.querySelectorAll(".assist-btn").forEach(function(btn){
    btn.addEventListener("click",function(){
      var task=btn.getAttribute("data-task"),target=btn.getAttribute("data-target");
      var orig=btn.textContent;btn.disabled=true;btn.textContent="✨ …";
      fetch(root.getAttribute("data-assist"),{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({task:task,postId:d.postId})})
        .then(function(r){return r.json();}).then(function(res){
          btn.disabled=false;btn.textContent=orig;
          if(!res.ok){$("seo-toast").textContent=res.error||"Suggestion failed.";$("seo-toast").style.color="#fca5a5";return;}
          if(task==="faq"){
            var pairs=[];try{pairs=JSON.parse(res.text);}catch(e){}
            if(Array.isArray(pairs)){pairs.forEach(function(p){if(p&&p.question)$("faq-list").appendChild(faqRow(String(p.question),String(p.answer||"")));});}
          } else {
            var el=$(target);if(el){el.value=res.text;el.dispatchEvent(new Event("input"));}
          }
          $("seo-toast").textContent="Suggestion added — edit freely, nothing is saved until you hit Save.";$("seo-toast").style.color="#fcd34d";
        }).catch(function(){btn.disabled=false;btn.textContent=orig;$("seo-toast").textContent="Network error — try again.";$("seo-toast").style.color="#fca5a5";});
    });
  });

  // Save + typed-override (rail #2) + undo (S6). "prev" snapshots the last
  // successfully-saved payload so one click restores it.
  var prev=null;
  function payloadNow(){
    var faq=[].map.call($("faq-list").querySelectorAll(".faq-row"),function(r){return{question:r.querySelector(".faq-q").value,answer:r.querySelector(".faq-a").value};});
    return {metaTitle:$("f-metaTitle").value,metaDescription:$("f-metaDescription").value,slug:$("f-slug").value,focusKeyword:$("f-focusKeyword").value,
      ogTitle:$("f-ogTitle").value,ogDescription:$("f-ogDescription").value,ogImage:$("f-ogImage").value,
      canonicalUrl:$("f-canonicalUrl").value,noIndex:$("f-noIndex").checked,nofollow:$("f-nofollow").checked,
      sitemapExclude:$("f-sitemapExclude").checked,schemaType:$("f-schemaType").value,authorId:$("f-authorId")?$("f-authorId").value:"",llmsExclude:$("f-llmsExclude")?$("f-llmsExclude").checked:false,faq:faq,
      addRedirect:$("f-addRedirect")?$("f-addRedirect").checked:false,
      typedOverride:$("f-typedOverride")?$("f-typedOverride").value:""};
  }
  function savedSnapshot(){
    var p=payloadNow();p.typedOverride="";p.addRedirect=false;return p;
  }
  prev=savedSnapshot(); // page-load state = first undo target
  function applyPayload(p){
    $("f-metaTitle").value=p.metaTitle;$("f-metaDescription").value=p.metaDescription;$("f-slug").value=p.slug;$("f-focusKeyword").value=p.focusKeyword;
    $("f-ogTitle").value=p.ogTitle;$("f-ogDescription").value=p.ogDescription;$("f-ogImage").value=p.ogImage;
    $("f-canonicalUrl").value=p.canonicalUrl;$("f-noIndex").checked=p.noIndex;$("f-nofollow").checked=p.nofollow;
    $("f-sitemapExclude").checked=p.sitemapExclude;$("f-schemaType").value=p.schemaType;if($("f-authorId"))$("f-authorId").value=p.authorId||"";if($("f-llmsExclude"))$("f-llmsExclude").checked=!!p.llmsExclude;
    $("faq-list").innerHTML="";(p.faq||[]).forEach(function(f){$("faq-list").appendChild(faqRow(f.question,f.answer));});
    refresh();
  }
  function send(payload,after){
    var btn=$("seo-save");btn.disabled=true;$("seo-toast").textContent="Saving…";$("seo-toast").style.color="";
    fetch(root.getAttribute("data-save"),{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify(payload)})
      .then(function(r){return r.json();}).then(function(res){
        btn.disabled=false;
        if(res.ok){
          $("seo-override").style.display="none";if($("f-typedOverride"))$("f-typedOverride").value="";
          d.slug=payload.slug;$("slug-redirect").style.display="none";
          $("seo-toast").textContent="Saved — your site is rebuilding (usually ~2 minutes)"+(res.redirectAdded?", 301 added":"")+".";$("seo-toast").style.color="#86efac";
          if(after)after();
        } else if(res.needOverride){
          $("seo-override").style.display="block";
          $("seo-override-msg").textContent=res.error||"This change needs a typed confirmation.";
          $("f-typedOverride").focus();
          $("seo-toast").textContent="";
        } else {$("seo-toast").textContent=res.error||"Couldn’t save.";$("seo-toast").style.color="#fca5a5";}
      }).catch(function(){btn.disabled=false;$("seo-toast").textContent="Network error — try again.";$("seo-toast").style.color="#fca5a5";});
  }
  $("seo-save").addEventListener("click",function(){
    var snapshotBefore=prev;
    send(payloadNow(),function(){
      prev=snapshotBefore; // undo restores the state before THIS save
      $("seo-undo").style.display="inline-block";
    });
  });
  $("seo-undo").addEventListener("click",function(){
    if(!prev)return;
    applyPayload(prev);
    send(prev,function(){
      $("seo-undo").style.display="none";
      prev=savedSnapshot();
    });
  });

  refresh();
})();`
