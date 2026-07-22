# Build Prompt — "SiteNetwork OS" (Masterpiece Edition)

Paste this as the first message in a Claude Code session opened in `~/cms`.

---

## Context — read before writing any code

This repo is a working multi-tenant CMS on Cloudflare Workers + Turso (libsql) + R2, built with Hono. It exposes a public REST API under `/api/public/v1/*` with capabilities probe (`GET /v1/capabilities`), webhooks (`X-CMS-Signature`), idempotency (`Idempotency-Key`), rate-limit headers, and typed error codes (`slug_conflict`, `rate_limited`, `auth_*`, `validation_*`). A companion system (Content-Network-OS) publishes to it. **Nothing you build may break any existing endpoint — every existing route stays byte-identical. All new work is additive and feature-flagged behind `saas_mode`.**

Read the full repo first: routes, schema, auth, wrangler config. Take your time. Then present your plan and the "ASK ME" decisions before editing anything.

## Product goal

A SaaS for people who run networks of AI-built content sites (SEO operators, affiliate publishers, agencies with 5–50 sites):

- Sign up with email + password. Connect **their own GitHub** and **their own Cloudflare** once, through a guided wizard.
- Unlimited sites. Each site = a repo in their GitHub (from a template) + a Cloudflare Workers static-assets deployment + their custom domain — provisioned automatically via APIs, never manual instructions.
- They build and change sites by **prompting Claude** from the dashboard; every commit auto-deploys live.
- They publish and schedule content through the CMS, protected by a quality gate.

Positioning: **"Unlimited sites. You own everything. Every site scores 100. Nothing to hack."** Flat price. Customer owns repos, domains, hosting; hosting cost ~$0; platform pays for zero AI inference.

## Architecture constraints

- Stay on the existing stack: Hono + Workers + Turso + R2. Justify any addition.
- BYO-infrastructure: customer credentials (GitHub App installation, Cloudflare API token, optional Anthropic key) stored encrypted; the platform orchestrates via APIs and never hosts customer sites.
- New site deployments target **Cloudflare Workers with static assets**, NOT Cloudflare Pages (maintenance mode). Attach-only mode for customers already on Pages.
- Generated sites are **fully static at serve time**. No origin database, no server rendering, no runtime dependencies. This single decision delivers both the speed covenant and the security covenant below.

---

## THE PERFORMANCE COVENANT (non-negotiable, enforced by CI — this is the product's signature)

Every site this platform provisions must be measurably among the fastest on the internet, and stay that way forever. Not a promise — an enforced pipeline rule.

1. **Zero-JS by default.** Template framework ships **no client-side JavaScript** unless a component explicitly needs it (Astro islands). A blog post page ships HTML + CSS only.
2. **Performance budget gate in CI.** Every deploy runs Lighthouse CI in the site's GitHub Action. Budgets: Performance ≥ 98, LCP < 1.2s, CLS < 0.02, TBT < 50ms, total page weight < 300KB for a post page, HTML < 50KB. **Budget fail = deploy blocked**, with a plain-language report and a one-click "ask Claude to fix it" button in the dashboard that dispatches a fix prompt.
3. **Image pipeline, automatic.** Uploads go to R2; the build emits responsive `srcset` with AVIF/WebP + fallback, explicit width/height (zero CLS), lazy-loading below the fold, priority hints on the LCP image. Editors never think about it.
4. **Font discipline.** System font stack by default; if a custom font is chosen, auto-subset, `font-display: swap`, self-hosted (no Google Fonts requests), preloaded.
5. **CSS discipline.** Critical CSS inlined, total CSS < 20KB, unused CSS stripped at build.
6. **Edge everything.** Static assets served from Cloudflare's edge (300+ cities) with immutable cache headers + hashed filenames; HTML with `stale-while-revalidate`. Early Hints (103) enabled. HTTP/3. Brotli.
7. **Third-party script firewall.** Analytics defaults to Cloudflare Web Analytics (zero-impact). Any other third-party script requires an explicit override, must load via Workers proxy or `defer`, and its wire cost shows in the dashboard ("This will slow your site by ~180ms — add anyway?"). This UX moment sells the product by itself.
8. **Continuous real-user monitoring.** CWV from real visitors (CF Web Analytics API) per site in the dashboard, with alerts when any vital degrades. Degradation alert includes an "ask Claude to diagnose" action.
9. **Speed as marketing.** Every site footer may (optionally) carry a live "PageSpeed 100" badge linking to a public PSI result — the network becomes its own ad.

## THE SECURITY COVENANT (the "nothing to hack" pitch vs WordPress)

1. Static sites = **no attack surface**: no PHP, no plugins, no admin panel on the site, no database at the origin, nothing to inject into. Say this loudly in marketing; enforce it in the template.
2. Security headers baked into every template and verified in CI (fail = blocked): strict CSP, HSTS preload, X-Content-Type-Options, Referrer-Policy, Permissions-Policy. Target: A+ on securityheaders.com, automatically, for every customer.
3. Cloudflare in front of every site: free WAF rules, bot fight mode, DDoS protection — enabled during provisioning via API.
4. Platform side: all customer tokens encrypted at rest (per-tenant key derivation), never logged, never in error messages; GitHub App private key in Workers secrets; webhook signatures verified; prompt-dispatch endpoint rate-limited; audit log of every credential use.
5. Git as the backup system: every version of every site is in the customer's repo forever. **One-click rollback** of an entire site to any previous state, from the dashboard, in seconds. No WordPress backup plugin drama — this is a headline feature.

---

## KILLER FEATURES — what makes the market run toward it

### K1 — One-prompt site genesis
"Create a site about home espresso for my domain brewcraft.com" → Claude (in the customer's GitHub Action) generates a complete site: niche-appropriate design, homepage, 10 seed articles from a topical map, silo navigation, schema markup, sitemap, RSS — plus the full **trust-page set**, auto-generated and site-specific: About Us, Contact Us, Privacy Policy, Terms of Service, Affiliate/Advertising Disclosure, Cookie Policy, and Editorial Policy. These are E-E-A-T trust signals Google's quality raters check and hard requirements for AdSense/affiliate program approval — generate them filled in with the site's name, niche, and owner details from the wizard (never lorem ipsum), dated, and linked in the footer. The Contact page includes a working form: static sites have no backend, so the form posts to a tiny platform-provided Workers endpoint (spam-protected via Turnstile, zero performance cost) that emails the site owner — no third-party form service, no tracking scripts. Live on their domain in under 10 minutes. This is the demo video that sells the product.

### K2 — Programmatic SEO factory (with a leash)
Upload a CSV or keyword list → pick/define a page template → the platform generates hundreds of pages through the **quality gate**: minimum unique-content ratio between pages, required unique data per page, duplicate-title/meta detection, thin-content blocker. Pages that fail don't publish. Market it as "programmatic SEO that survives Google updates" — the gate is the moat, because everyone else sells uncontrolled mass generation.

### K3 — Network brain (cross-site intelligence)
One dashboard across ALL sites: traffic, indexed pages, CWV, publish cadence, decaying posts, plus **uptime checks** (Workers Cron pings each site's homepage every 5 min, alert on failure) and a **404 monitor** (top 404 paths from CF analytics, one-click "add redirect" fix). Powered by **Google Search Console OAuth integration** per site: auto-submit sitemaps, indexing status per URL, alerts for deindexed pages and manual actions, query data per post. Nobody managing 20 sites has this in one place today.

### K4 — Content decay radar + auto-refresh
Detect posts losing impressions/clicks (GSC data, rolling 28-day comparison). One click → Claude refreshes the post (updates facts, expands sections, improves title) → through quality gate → republish with `dateModified` schema. Turns the graveyard of old content into compounding traffic.

### K5 — Internal linking engine
On every publish, suggest (or auto-insert, configurable) contextual internal links to/from related posts on the same site, based on embeddings or keyword overlap. Enforce orphan-page detection: no published page with zero internal links. This is a top-3 SEO pain and almost nobody automates it well.

### K6 — Site cloning & templates marketplace
"Clone this site's structure/design to a new domain and niche" — one click, new repo, Claude re-themes and re-seeds for the new niche. Winning site → repeatable playbook. Later: customers publish their site templates to a marketplace (revenue share) — network effects.

### K7 — Pinterest traffic engine (your unfair advantage)
The CMS is already Pinterest-native. On publish, auto-generate 2–3 pin images (template-based, post title + featured image) and queue them to the customer's Pinterest boards on a drip schedule via Pinterest API. SEO + Pinterest is the classic content-site traffic double; no site builder ships it built-in.

### K8 — AI search visibility (AEO — the 2026 wave)
Every site ships `llms.txt`, clean semantic HTML, Article/FAQ/HowTo schema, and quotable summary blocks — optimized to be cited by ChatGPT/Perplexity/AI Overviews. Dashboard shows "AI visibility" checks per post. Competitors optimize for Google; you optimize for Google + AI answers.

### K9 — WordPress escape hatch
Import wizard: WXR export or live WP REST URL → posts converted to markdown, images pulled to R2, redirects map auto-generated (old URLs → new, deployed as edge redirects), site live on the same domain with zero 404s. Target the millions sick of slow, hacked, plugin-broken WordPress sites. "Leave WordPress in an afternoon; your PageSpeed goes from 60 to 100."

### K10 — Affiliate command center
Central link manager across the network: cloaked short links (`/go/product-x` via edge redirect), one place to update a link across 40 sites, automatic dead-link checker (weekly cron hits every outbound affiliate URL, alerts on 404/redirect-to-homepage), per-link click counts at the edge. Affiliate publishers will switch for this feature alone.

### K11 — Agency mode
White-label dashboard (custom logo/domain for the panel), client seats with per-site permissions, client-facing read-only reports (traffic + CWV + published posts, auto-emailed monthly). Agencies bring 10–50 sites each — highest-LTV customers, near-zero extra cost to serve.

### K12 — Rollback + preview safety net
Prompt-edits can deploy direct-to-live OR to an instant preview URL (Workers preview) with a visual before/after diff in the dashboard; approve to go live. Combined with one-click rollback, the customer literally cannot break their site — removes the #1 fear of letting AI touch production.

---

## PHASES — one branch per phase, typecheck + tests green before moving on

**Phase 0 — Read, plan, gate (no code):** deep-read the entire repo; create/update `CLAUDE.md` (stack, conventions, how to run tests/dev); write `PLAN.md` mapping every phase to concrete files/tables/routes in THIS codebase; surface all ASK ME decisions. **Stop and wait for my approval of PLAN.md before any Phase 1 code.**

**Phase 1 — Accounts & tenancy:** email/password auth (verification, reset — extend what exists), orgs → sites model, per-site API tokens, Stripe (flat plan, `unlimited_sites`), `saas_mode` flag.

**Phase 2 — Connections wizard:** GitHub App (contents RW, actions RW, administration); Cloudflare API-token guided flow (exact token template shown, validated live, stored encrypted); domain/zone picker with nameserver instructions + live verification polling; optional Anthropic key + Pinterest OAuth + GSC OAuth steps (skippable, resumable). Every step validates before advancing, plain-language errors. This wizard decides conversion — first-class UX deliverable.

**Phase 3 — Provisioning pipeline:** template repo (Astro, zero-JS default, performance + security covenants baked in) → create repo in customer GitHub → Workers static-assets project via API wired to repo (Workers Builds) → domain/route + DNS → register site in CMS with API token; build-time content pull from `/api/public/v1/posts`. DNS details: handle apex AND `www` (one canonical, 301 the other — ask customer which in the wizard), and **disable the default `*.workers.dev` URL on production sites** — a live workers.dev duplicate of the customer's site is an SEO duplicate-content bug. Idempotent + resumable via `provisioning_runs` table (per-step status, retry from failure).

**Phase 4 — Prompt-to-edit + K1 genesis + K12 preview/rollback:** per-site prompt box; GitHub Actions workflow in template runs Claude with guardrails (no force-push, protected content dir, PR/preview mode); CMS dispatches via `workflow_dispatch`, streams status (queued → running → committed → building → deployed); diff summary + live link on completion; one-click rollback (revert commit → redeploy). **Cost guardrails (required):** Action job timeout 15 min, `concurrency` group per site (one Claude run at a time, queued not parallel), platform-side cap on dispatches per site per hour, and a visible "this run used ~X minutes" line in the dashboard so customers never get surprise GitHub/API bills.

**Phase 5 — Publishing engine + quality gate + K2 + K5:** scheduler (Workers Cron → publish → trigger rebuild); quality gate (word count, title/meta, duplicate detection, thin-content, unique-content ratio for programmatic batches) default ON, visible in UI; programmatic CSV → template → gated pages; internal linking suggestions + orphan detection.

**Phase 6 — Performance & security enforcement:** Lighthouse CI budgets in template Action (deploy-blocking) — **run against a representative page set (homepage + one post + one programmatic page + heaviest template), not every page**, so a 500-page site still deploys in minutes; image pipeline (R2 + AVIF/WebP + srcset + dimensions); font/CSS discipline in template; security headers + CI check; CF WAF/bot protection via API at provisioning; Turnstile site key created per site via CF API during provisioning; CWV RUM ingestion + alerts; third-party script cost warning UX.

**Phase 7 — Network brain: K3 GSC integration + K4 decay radar + K8 AEO checks.** Cross-site dashboard, sitemap auto-submit, index monitoring, decay detection + refresh flow, llms.txt + schema in template, AI-visibility checklist per post.

**Phase 8 — Growth features: K7 Pinterest engine, K9 WordPress import, K10 affiliate command center.** Pin generation + drip queue; WXR/REST import → markdown + R2 + edge redirects map; link manager + weekly dead-link cron + edge click counting.

**Phase 9 — K6 cloning + K11 agency mode.** Clone flow (new repo, Claude re-theme/re-seed); white-label panel, client seats, monthly auto-reports.

**Phase 10 — Audit (do not skip):** full existing-API regression pass (zero changes); provisioning dry-run + failure-resume tests for every step against mocked GitHub/CF APIs; performance covenant test (template must pass its own budgets from a cold clone); security review (credential encryption, no token logging, signature verification, rate limits, Action guardrails); `/security-review` on the final branch.

## Decisions to surface (ASK ME, don't guess)
1. Anthropic auth in Actions: customer API key as repo secret vs. subscription OAuth.
2. Template framework confirmation: Astro (recommended) vs. alternative.
3. Stripe price + trial length; whether agency mode is a higher tier.
4. Prompt-edits default: direct-to-live or preview-then-approve.
5. Embeddings provider for internal linking (local/Workers AI vs customer key).
6. GSC + Pinterest OAuth app ownership (platform-owned apps need verification — start process early).
7. Transactional email provider (signup verification, password reset, contact-form delivery, alerts): Resend vs MailChannels vs SES — pick one, used platform-wide.
8. Where the site template repo lives: platform GitHub org name.

## Non-negotiables
- Existing endpoints byte-identical; all new behavior behind `saas_mode`.
- Performance covenant and security covenant are deploy-blocking, not advisory.
- Idempotent, resumable provisioning. No plaintext secrets anywhere.
- Quality gate ON by default — this product must never be the reason a customer's network gets hit by a spam update.
- Plain-language errors everywhere; the user is semi-technical, not DevOps.

## AMENDMENT 2 — Site kinds + Ecommerce (K13)
Template system is multi-kind. Every kind shares the same core (both covenants,
seven trust pages, full SEO file set) and differs in layout/content model.
Launch kinds: content/blog, ecommerce, local-business, portfolio/services.
Genesis (K1) asks the kind first.
Ecommerce, static-first — covenants stay deploy-blocking:
- Products are a CMS content collection (price, images, variants, stock flag);
  product + category pages statically generated with Product/Offer JSON-LD,
  clean URLs, OG images.
- Cart is the ONLY JavaScript island. Checkout = Stripe Checkout on the
  CUSTOMER'S OWN Stripe account (BYO-Stripe; key vault-encrypted; optional
  wizard step — distinct from Phase 9 platform billing). A small Workers
  endpoint creates checkout sessions server-side (price math never client-side);
  a webhook records orders back to the CMS (per-site orders table).
- Launch scope: digital + simple physical goods. No inventory sync, tax engine,
  or multi-currency — flagged post-launch.

## AMENDMENT 3 — Code structure covenant (deploy-blocking, like P and S)
Platform: strict modular organization adapted to THIS stack (Workers/Hono/
Turso — no Docker/K8s/nginx/terraform). src/modules/<name>/ (auth, customers,
vault, provisioning, sites, publishing, quality-gate, ecommerce, webhooks,
billing, analytics), each owning routes + service + schema + tests;
src/shared/ for cross-module utilities; cross-module imports only via a
module's public index; no circular deps (lint rule in CI); STRUCTURE.md
documents the rules. Migrate incrementally, tests green each step, existing
API byte-identical.
Generated sites: repos a professional developer would respect — src/content/,
src/components/, src/layouts/, src/pages/, public/, clean naming, zero dead
code, per-repo README. Every site ships the full SEO file set verified by a
deploy-blocking CI check: sitemap, robots.txt, RSS, llms.txt, canonical tags,
OG + Twitter meta, JSON-LD, favicon set + manifest, custom 404, redirects
file. Missing any = deploy blocked.

## AMENDMENT 4 — Business platform: one analytics beacon + pixels via allowlist (V1.5)
Two narrow, deliberate exceptions to the zero-JS performance covenant, recorded
here the way the Turnstile script exception was — the gate learns exactly these
and nothing else.

- **A4a — First-party analytics beacon.** EXACTLY ONE first-party analytics
  script is permitted on customer sites: self-hosted, **≤ 2 KB gzipped**,
  `defer`-loaded, **cookie-less** (no cookies, no localStorage), no
  fingerprinting, **no raw IP stored** (country derived at the edge then
  dropped), and it **honors DNT and Sec-GPC** (no-ops when either is set). It is
  **OFF by default per site** (owner opt-in). The zero-JS deploy gate is taught
  to allow **this one file by its content hash** — any other script, or a
  modified beacon whose hash doesn't match, still blocks the deploy. It reports
  stable `data-*` attributes only (never coordinates/heatmaps).
- **A4b — Ad & marketing pixels.** Third-party ad/marketing pixels load ONLY
  through the existing vetted-script allowlist path (V1.3) with its
  defer/delay-until-interaction rules and **budget accounting** — a pixel that
  busts the Lighthouse budget blocks the deploy with the plain-language report.
  **No new script mechanism is introduced.** A CSS-only baseline consent banner
  may gate "requires-consent" pixels; its tiny inline set-cookie snippet is
  counted within the allowlist accounting, not exempt.

Both remain subordinate to the covenants: the performance budget and the SEO
file set stay deploy-blocking, and `saas_mode` still gates every new surface.
