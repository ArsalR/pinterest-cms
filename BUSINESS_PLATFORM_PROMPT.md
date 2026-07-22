# V1.5 — BUSINESS PLATFORM: MAILBOX · INTEGRATIONS · ANALYTICS · PIXELS · SUB-SITES · ALWAYS-OPTIMIZED

Six stages M1–M6, one branch/PR each, then a verification pass. Standing rails apply verbatim: tenant API byte-identical, `saas_mode` discipline, additive schema, covenant gates deploy-blocking, plain-language errors, tests every stage (including at least one guardrail-fires test), surface-don't-guess. Read the existing modules each stage touches before coding (vault, provisioning, forms/inbox, seo profiles, script allowlist, analytics/uptime, redirects, publishing).

## Declared covenant amendments (record in SAAS_BUILD_PROMPT.md as Amendment 4, like Turnstile was)
- A4a: ONE first-party analytics beacon script is permitted on customer sites — ≤2KB gzipped, self-hosted, deferred, cookie-less, no fingerprinting, respects DNT/GPC; per-site OFF switch. The zero-JS gate learns to allow exactly this file by hash, nothing else.
- A4b: ad pixels load ONLY via the existing vetted-script allowlist path with its budget accounting — no new mechanism.

## M1 — SITE MAILBOX (receiving native on Cloudflare; sending via connected provider)

Architecture (build exactly this shape):
- **Receiving:** per site, an Email Worker deployed into the CUSTOMER'S Cloudflare account (provisioning already deploys workers there) + Email Routing enabled on the zone via API, catch-all routed to that worker. The worker parses inbound mail (postal-mime or equivalent bundled parser — no external service), posts it signed (existing HMAC scheme) to the platform CMS API; platform stores envelope+body in the site's DB, attachments in R2 (size cap, type allowlist, virus-pattern rejection of executables). New provisioning steps, resumable like all others: enable routing → deploy email worker → create routes → verify.
- **Addresses:** dashboard "Mailbox" section per site: create/disable addresses (sales@, support@…) = routing rules via CF API. Catch-all toggle with default-address choice.
- **Mailbox UI:** threads grouped by conversation (References/In-Reply-To headers), unread badges, search, archive, spam folder (honor Email Routing's spam verdict headers; simple sender-block list). Reuse the forms-inbox UI patterns/components — one inbox design language.
- **Sending/replies:** compose + reply FROM any of the site's addresses, sent via the site's connected sending provider. Resend = default path (domain verification wizard already exists — extend it to also print the Email Routing MX + SPF/DKIM records as ONE combined DNS table, live-verified). **Brevo and SendGrid connectors:** provider adapter interface (send(from,to,subject,html,attachments), verifyDomain(), getStatus()) with the customer's API key vault-encrypted; picking a provider is a dropdown, not a project. Outbound stored to the same thread.
- Honest constraints, surfaced in UI: Cloudflare receives, providers send (say it plainly); deliverability depends on their DNS records being verified — block sending until green; attachment cap stated.

## M2 — INTEGRATIONS: n8n / GoHighLevel / anything (API + events, formalized)

- **Per-site API keys with scopes** (read-posts, write-posts, read-forms, read-mail-meta, read-analytics, manage-redirects…), created/revoked in dashboard, prefixed (`sk_site_…`), hashed at rest, last-used shown.
- **Event webhooks, site-wide:** one subscriptions UI — pick events (form.submitted, mail.received, order.created, post.published, site.deployed, analytics.daily) → URL + secret (existing HMAC + retries + delivery log + test-fire). This IS the n8n/GHL integration: n8n Webhook node or GHL inbound webhook consumes these directly.
- **Recipes page:** copy-paste guides in the dashboard — "Site → n8n" (webhook trigger + example workflow JSON), "Site → GHL" (lead from form.submitted into GHL contact via their inbound webhook), "n8n → Site" (create a post via the public API with a scoped key). Ship a small importable n8n workflow JSON per recipe as static assets.
- **OpenAPI spec** generated for the public site API (additive doc endpoint) so any platform's HTTP node autocompletes it.

## M3 — BUILT-IN ANALYTICS (first-party, consent-free by design)

- **Beacon (per A4a):** page view, referrer (origin only), scroll depth buckets (25/50/75/100), time-engaged (visibility-aware), clicks on tagged elements — every CTA block, nav link, form submit button, and outbound link gets a stable data-attr automatically at build; the beacon reports the attr, never coordinates. sendBeacon on unload; no cookies, no localStorage, no IP stored (country derived at edge then dropped).
- **Ingest:** platform endpoint → Workers Analytics Engine (built for this: high-volume, cheap) with per-site tags; nightly rollups to the site DB for the dashboard.
- **Dashboard "Insights" per site:** traffic over time, top pages, referrers, device class; per-page: scroll-depth funnel, element click table ranked ("where users clicked; what they skipped"), outbound clicks; simple SVG/CSS charts server-rendered (no chart JS on customer sites; dashboard may use its existing UI stack). Honest framing in UI: element-level insight, not surveillance heatmaps; sampled at high volume.
- Feeds existing features: decay radar and SEO hub may read engagement to flag "high traffic, low engagement" pages.

## M4 — AD & MARKETING PIXELS (through the allowlist, guided)

- Catalog entries with guided fields (paste the ID, we render the correct snippet): Meta Pixel, Google Ads tag / GA4, TikTok Pixel, LinkedIn Insight, Pinterest Tag. Each: defer/delay-until-interaction per the allowlist rules, wire-cost shown before enable, budget gate binds (a pixel that busts the Lighthouse budget blocks deploy with the plain-language report).
- **Consent:** a lightweight CSS-only consent banner option (accept/decline stored in a first-party cookie set by inline no-lib snippet within the allowlist accounting); pixels marked "requires consent" don't fire until accepted; per-site toggle "EU consent mode" ON by default when any pixel is enabled. Say honestly in UI: this is baseline consent, not a full CMP.
- Conversion wiring: form submissions and ecommerce checkout success can fire pixel conversion events (config per form/product flow). Server-side conversions API = explicitly out (note as future).

## M5 — SUB-SITES: SUBDOMAINS & SUBDIRECTORIES

- **Subdomain site** (blog.domain.com): "Add site → on an existing domain's subdomain" — provisioning reuses the zone (DNS record + worker route on the customer's zone), skips domain-purchase steps. Full separate site (own repo, preset, content).
- **Subdirectory site** (domain.com/blog): separate site worker mounted via path-pattern route (`domain.com/blog/*`) on the parent zone; template gains base-path-aware build (Astro `base`), all internal links/sitemaps/canonicals/OG URLs honor it (test exhaustively — path bugs here poison SEO). Parent site's sitemap index references the child's sitemap; robots.txt served by parent merges child entries (define the merge contract explicitly).
- Dashboard shows site relationships (parent/children) on the sites list; deleting a parent warns about children.

## M6 — ALWAYS-OPTIMIZED BY DEFAULT (every page, every engine)

- **Kind→profile auto-activation completed:** creating/importing any site activates the right SEO profiles automatically (local business → Local; shop → Ecommerce; all → AEO/AI-SEO baseline) — zero-touch = fully optimized. Verify V1.3 defaults actually fire on every creation path (wizard, genesis, WP import, clone, sub-sites).
- **Bing/DuckDuckGo:** IndexNow extended from news-only to ALL publishes/updates (key provisioned per site automatically); Bing Webmaster verification step in the SEO hub (meta-tag method, guided); DDG rides Bing — say so in UI to close the question.
- **Per-page Optimization Report:** one panel on every page/post: every check (SEO, AEO/GEO-LLMO quotability, local schema when active, image SEO, speed budget, index status) as green/amber with the fixing tool linked. This is the assurance surface for "every page is optimized by default" — the customer SEES it, and the quality gate remains the enforcement.
- Genesis/prompt-edit art-direction updated so AI-created pages emit the optimization-relevant structures by default (already largely true — close any gaps the report reveals).

## VERIFICATION PASS (after M6)
Full standing battery (typecheck, tests, cycles, cold build, byte-identical flag on/off, preset matrix, break-each-gate) PLUS: email worker E2E against a stubbed inbound payload (parse→store→thread→reply via mocked provider); beacon page-weight + hash-allowlist test (any other script still blocks); sub-directory link/canonical/sitemap correctness suite; pixel consent-gating test; IndexNow ping on publish test; cross-tenant checks on every new route (mailbox, keys, insights, subsites). Update AUDIT_REPORT.md + LAUNCH_CHECKLIST.md (new owner steps: none should exist beyond per-customer DNS — flag anything that does). Print the checklist delta in chat.
