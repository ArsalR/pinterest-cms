# V1.2 — SEO COMMAND SUITE ("kill the plugin stack")

Branch series: `seo-suite-s1` … `seo-suite-s6`. One branch per stage, tests green before merge, existing API byte-identical, everything behind `saas_mode` as always.

## Positioning (read first — this drives every UX decision)

The target customer left WordPress, where doing SEO right means installing and configuring 8 plugins that fight each other. This suite is the pitch "everything Rank Math + Yoast + Redirection + image-SEO + script-optimizer plugins do — built in, coherent, zero setup." Two consequences:

1. **Defaults must be so good that touching nothing = perfect SEO.** Every control is an override, never a requirement. WordPress makes SEO homework; we make it optional fine-tuning.
2. **Nothing in this suite may weaken the covenants or the quality gate.** SEO controls that can hurt a site (noindex, robots blocks) get guardrails a plugin would never give.

Before coding: read the existing modules this extends — quality-gate, publishing, sites, analytics (GSC/404), the template's robots/sitemap/schema/feed generation, and the redirects + cloaked-link tables. Reuse; do not build parallel systems. Surface, don't guess, anything ambiguous.

## STAGE S1 — Per-post SEO Cockpit (the editor panel)

A right-side panel on the post/page editor, tabs: **Snippet · Social · Advanced**.

- **Snippet tab:** editable meta title + description with live Google SERP preview (desktop + mobile rendering), pixel-width truncation shown honestly (not character counts alone), slug editor with old-slug→redirect offer on change of a published post.
- **Social tab:** OG/Twitter live card preview, per-post custom OG image (falls back to featured), editable social title/description.
- **Advanced tab:** index/noindex toggle, canonical URL override, exclude-from-sitemap, nofollow, schema type override (Article/HowTo/FAQ/Product/Review) with an FAQ-block builder that emits FAQPage JSON-LD.
- **AI assists (✨):** a small button beside title, description, and social fields — drafts the value from the post content using the customer's vault-stored Anthropic key (opt-in, absent = buttons hidden). AI output always lands in the editable field, never auto-applies.
- Storage: additive columns on posts. Template consumes them at build. Absent values = current behavior exactly.

## STAGE S2 — Content analysis + image SEO

- **Analysis tab (4th tab):** live checklist AS THE USER TYPES — focus keyword presence (title, H1, first paragraph, slug), keyword-stuffing warning, readability (sentence/paragraph length, passive voice estimate), internal + external link counts, image alt coverage. CRITICAL: these are THE SAME rules the quality gate runs at publish — one shared rule module, two surfaces (live sidebar + gate). Never two drifting systems. Score = passed checks; no gamified fake-100.
- **Image SEO:** alt text prompted at upload (default-required, per-site toggle to relax); ✨ AI-suggest alt from the image (customer key); site-wide "images missing alt" finder with inline bulk-edit; filenames slugified on upload.
- WP-import respect: extend the K9 importer to map Yoast + Rank Math meta fields (title/description/canonical/noindex/focus keyword) into these columns — migrating customers keep years of SEO work. This single item closes the biggest migration objection.

## STAGE S3 — Site SEO Control Center (per-site hub, left-nav sections)

- **Crawlers & robots.txt:** guided toggle list of known bots — search (Googlebot, Bingbot), AI-training (GPTBot, CCBot, Google-Extended, PerplexityBot, Amazonbot, Bytespider), SEO tools (AhrefsBot, SemrushBot) — each with a one-line consequence ("Blocking GPTBot keeps your content out of ChatGPT training but may reduce AI-search visibility"). Advanced: raw robots.txt editor with syntax validation. HARD RAIL: blocking Googlebot/Bingbot or a sitewide `Disallow: /` requires typing the site domain to confirm, and is audit-logged.
- **Sitemap manager:** view generated entries, exclude pages/collections/kinds, auto-resubmit to GSC on change (existing integration).
- **Feeds & archives:** RSS on/off, noindex-paginated-pages toggle, tag/category archive index toggles, date archives on/off — each with a plain-language "what this does".
- **Global schema:** Organization/Person choice, logo, social profiles (→ sameAs), breadcrumbs toggle (BreadcrumbList emitted when on).
- Storage: a per-site `seo_settings` record in the CMS, injected into the template at build time. The template's generated robots/sitemap/feeds honor it; defaults reproduce today's output byte-for-byte.

## STAGE S4 — Redirects, scripts, edge bots

- **Redirects manager (extend existing table + 404 monitor):** full UI — 301/302/410, wildcard patterns, CSV import/export, per-redirect hit counts, redirect-chain detection with one-click flatten, broken-target warnings. Fold the B-3 cloaked-link manager (`/go/…`) in here as a "branded links" section with click counts.
- **Script controls (P7 extension):** per-script rules — defer, delay-until-first-interaction, load-only-on-pages — with the existing wire-cost display. RAIL UNCHANGED: a script (or rule change) that breaks the Lighthouse budget is blocked at deploy with the plain-language report; the panel shows the projected cost BEFORE saving.
- **Edge bot protection:** surface the site's Cloudflare toggles (bot-fight mode, AI-crawler block at edge) with a clear explanation of edge-block (enforced) vs robots.txt (polite request) — both in one view so customers finally understand the difference.

## STAGE S5 — Indexing operations (GSC-powered)

- Per-URL index status table (existing K3 data): indexed / crawled-not-indexed / excluded, with reason from GSC.
- "Request indexing" per URL; bulk rules ("noindex all tag pages") implemented as sitemap+meta changes through the normal rebuild pipeline.
- Deindex watch: alert (existing alerting path) when a previously-indexed URL drops out, with a diagnose panel (robots? noindex? canonical? 404? — checked automatically against the site's own current state and named in plain language).

## STAGE S6 — UX polish pass (the "never witnessed in their old CMS" bar)

- **One place per job**: everything post-level lives in the cockpit panel; everything site-level in the hub. Zero SEO settings anywhere else. A customer must never wonder "which menu was that in."
- Every control: plain-language label + one-line consequence + "Recommended" badge on the default. Dangerous actions (noindex site-wide, block search bots, delete a redirect with traffic) require typed confirmation, are audit-logged, and are reversible — say HOW in the confirm dialog ("your site's history is in git; this can be undone from Site → History").
- Toggles apply optimistically with an undo toast; saves never reload the page; the whole cockpit is keyboard-navigable.
- Empty states teach: each panel opens with one sentence of what it's for and a collapsible "learn more" — a beginner should learn SEO by using the product.
- Rebuild transparency: any change requiring a rebuild shows the standard build status chip inline (reuse the prompt-run status stream component) — never a silent "saved but site unchanged" mystery.

## SAFETY RAILS (apply to every stage — restate in each PR description)

1. All SEO changes flow through the existing pipeline: CMS/config change → rebuild → covenant gates. No bypass path, ever.
2. New SEO-safety additions to the quality gate: block a deploy that would noindex >30% of published pages or block major search engines, unless the typed override was given (override recorded in audit log).
3. `seo_settings` and post columns are additive; absent = today's exact behavior (test this: build output byte-identical for a site that touches nothing).
4. AI assists only via the customer's own key; no key = features hidden, nothing degraded.
5. Tenant API byte-identical; feature-flag discipline unchanged; every stage lands with tests including at least one "guardrail fires" test.
