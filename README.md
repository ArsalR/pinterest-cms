# Pinterest CMS

A multi-tenant, Pinterest-style CMS that runs **100 sites on a single Cloudflare Worker**, with isolated per-site databases on Turso (libSQL) and shared image storage on R2. Every site has a full theme customizer, REST API for automation, and full SEO/permalink control.

## Architecture

```
                      ┌────────────────────────────────────┐
  *.yourdomain.com → │   Cloudflare Worker (Hono)         │
  customer.com    → │   ┌────────────────────────────┐    │
                    │   │ tenantMiddleware           │    │
                    │   │  hostname → master DB      │    │
                    │   │           → siteDb         │    │
                    │   └────────────────────────────┘    │
                    │   ┌────────┐ ┌──────┐ ┌──────────┐ │
                    │   │/admin  │ │/api  │ │/frontend │ │
                    │   └────────┘ └──────┘ └──────────┘ │
                    └────────────────────────────────────┘
                              │           │            │
                              ▼           ▼            ▼
                       ┌──────────┐  ┌────────┐   ┌────────┐
                       │  Turso   │  │   R2   │   │  CF    │
                       │ master + │  │ shared │   │ Cache  │
                       │ per-site │  │ bucket │   │  API   │
                       └──────────┘  └────────┘   └────────┘
```

* **One Worker** serves every site. Hostname resolves to a `SiteConfig` row in the master Turso DB, which contains the URL + auth token for that site's own per-site Turso DB.
* **Per-site DB** isolates tenants: posts, users, settings, menus, media metadata.
* **Shared R2 bucket** stores all uploaded images, namespaced as `uploads/{hostname}/...`.
* **REST API** (`/api/public/v1/*`) lets automation create posts, upload images, and manage categories. Auth is via `Authorization: Bearer cms_live_<32hex>` keys (App-Password style: hashed at rest, last 4 chars stored as preview for lookup).
* **Admin UI** (`/admin/*`) is fully self-service — theme customizer with live iframe preview, post editor with gallery manager, menu builder, permalinks, SEO, and API keys.
* **Network admin** runs at `NETWORK_ADMIN_HOSTNAME` and bypasses tenant resolution; it's the only place that can provision new sites.

---

## Setup

### Prerequisites

* A Cloudflare account (Workers Paid plan recommended for `cpu_ms = 30000`).
* A Turso account with a database group (e.g. `default`).
* An R2 bucket and (ideally) a custom domain in front of it for clean image URLs.

### 1. Clone & install

```bash
git clone <this-repo>
cd cms
npm install
```

### 2. Configure `wrangler.toml`

Edit the `[vars]` block:

```toml
TURSO_ORG              = "your-org"
TURSO_GROUP            = "default"
NETWORK_ADMIN_HOSTNAME = "admin.yournetwork.com"
R2_PUBLIC_URL          = "https://media.yournetwork.com"
SITE_SCHEMA_URL        = "https://yournetwork.com/site.sql"
SESSION_COOKIE_NAME    = "cms_session"
```

`SITE_SCHEMA_URL` must be a **publicly fetchable URL** that returns the contents of `src/schemas/site.sql`. The simplest option: deploy `site.sql` as a static file on the same Worker, or host it on R2 with a public link, or commit it to GitHub and use the raw URL.

### 3. Create the master DB

```bash
turso db create cms-master --group default
turso db shell cms-master < src/schemas/master.sql
turso db tokens create cms-master --expiration none
```

Save the URL and token.

### 4. Set secrets

```bash
wrangler secret put TURSO_MASTER_URL       # libsql://cms-master-…turso.io
wrangler secret put TURSO_MASTER_TOKEN     # token from previous step
wrangler secret put TURSO_API_TOKEN        # from Turso dashboard
wrangler secret put CF_API_TOKEN           # has Workers + DNS permissions
wrangler secret put CF_ZONE_ID             # your Cloudflare zone ID
wrangler secret put CF_ACCOUNT_ID          # your Cloudflare account ID
wrangler secret put JWT_SECRET             # `openssl rand -hex 32`
wrangler secret put NETWORK_ADMIN_KEY      # `openssl rand -hex 32`
```

### 5. Deploy

```bash
npm run deploy
```

### 6. Set up DNS for the network admin

Add `admin.yournetwork.com` as a custom domain on the Worker (Cloudflare dashboard → Workers → your worker → Custom Domains).

Visit `https://admin.yournetwork.com/` and enter `NETWORK_ADMIN_KEY` to access the network admin UI.

---

## Provisioning a new site

### Via the network admin UI

1. Visit `https://admin.yournetwork.com/?admin_key=…`
2. Fill in the "Provision new site" form
3. The API key is shown once — copy it immediately

### Via the API

```bash
curl -X POST https://admin.yournetwork.com/api/network/sites \
  -H "x-network-admin-key: $NETWORK_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "hostname":       "newsite.com",
    "name":           "New Site",
    "admin_email":    "you@you.com",
    "admin_password": "min-8-chars",
    "create_dns":     "1"
  }'
```

The response contains `api_key` — **save it now, you can't see it again**. The CMS only stores the hash.

### DNS for the new site

The provisioning step calls Cloudflare's DNS API to add a CNAME if `create_dns=1` and `CF_ZONE_ID` is set — but this only works for hostnames inside a zone you control.

For arbitrary customer domains (`example.com`, `custom-blog.org`), set up **Cloudflare for SaaS** custom hostnames. Each customer points a CNAME at your fallback origin and Cloudflare for SaaS routes it to your Worker.

---

## Using the REST API

Every site has its own API at `https://<hostname>/api/public/v1/*`. All endpoints require `Authorization: Bearer cms_live_…`.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/v1/status` | Verify key + return site info |
| `POST` | `/v1/upload` | Multipart upload (`files[]`, max 20, ≤10MB each, image/* only) |
| `POST` | `/v1/posts` | Create a post |
| `PUT`  | `/v1/posts/:id` | Update a post |
| `DELETE` | `/v1/posts/:id` | Delete a post |
| `GET`  | `/v1/categories` | List categories with post counts |
| `POST` | `/v1/categories` | Create a category |

### Example: create a post

```bash
curl -X POST https://newsite.com/api/public/v1/posts \
  -H "Authorization: Bearer cms_live_…" \
  -H "Content-Type: application/json" \
  -d '{
    "title":       "10 cozy reading nooks",
    "content":     "<p>Curl up with…</p>",
    "category":    "interiors",
    "coverImage":  "https://media.yournetwork.com/uploads/newsite.com/123-abc-cover.jpg",
    "images":      [{"url":"…","alt":"Window seat with throw"}],
    "published":   true
  }'
```

---

## Auto-posting — `automation/post_all_sites.py`

Generates AI content + Pexels images and creates one post per site, in parallel.

### Local test

```bash
pip install aiohttp

cat > sites.json <<EOF
[
  {
    "hostname": "newsite.com",
    "api_key":  "cms_live_…",
    "categories": ["interiors", "garden", "diy"],
    "tone": "warm and inspiring"
  }
]
EOF

OPENAI_API_KEY=… PEXELS_API_KEY=… python automation/post_all_sites.py
```

### GitHub Actions cron (`.github/workflows/post-all-sites.yml`)

Set these repo secrets:

* `OPENAI_API_KEY`
* `PEXELS_API_KEY`
* `SITES_JSON_B64` — base64 of your `sites.json` (`base64 -i sites.json`)

The cron runs every 29 minutes (~50 posts/site/day).

---

## Admin UI

Visit `https://<hostname>/admin/` and sign in with the email + password you provisioned.

Pages: **Dashboard** (recent posts + API logs), **Posts**, **Pages** (static), **Categories**, **Media**, **Menus**, **Appearance** (live theme customizer with iframe preview), **SEO**, **Permalinks**, **API Keys**, **Settings**.

The theme customizer drives every visual aspect of the public site through a single `:root` CSS variable block, so theme changes never require a code redeploy.

---

## File layout

```
src/
  worker.ts                 # Hono entry — wires every router
  schemas/
    master.sql              # sites table
    site.sql                # per-site schema (run on provisioning)
  lib/
    auth.ts                 # PBKDF2 + JWT
    apiAuth.ts              # bearer-key validation + logging
    turso.ts                # master + per-site DB helpers
    r2.ts                   # uploads + cleanup
    revalidate.ts           # CF cache purge
    seo.ts                  # head metadata + JSON-LD + permalink builder
    theme.ts                # CSS variables + Google Fonts + palette presets
    defaults.ts             # default settings inserted on provisioning
    provision.ts            # the createSite pipeline
    types.ts utils.ts cookies.ts
  middleware/
    tenantMiddleware.ts     # hostname → site
    authMiddleware.ts       # admin JWT + network key
    corsMiddleware.ts
  routes/
    network/sites.ts        # /api/network/* — provisioning
    public/                 # /api/public/v1/*
    admin/                  # /admin/*
    frontend/               # public pages, sitemap, RSS, robots
  views/
    frontend/Layout.ts      # public site shell
    frontend/PinterestGrid.ts
    frontend/helpers.ts
    admin/Layout.ts         # admin shell
    admin/PostEditor.ts     # post editor view
automation/
  post_all_sites.py         # OpenAI + Pexels → all sites
.github/workflows/
  deploy.yml                # CI deploy
  post-all-sites.yml        # cron */29 * * * *
wrangler.toml package.json tsconfig.json README.md
```

---

## Operations

### Cache invalidation

Every mutation in the admin (post save, theme change, permalink change) calls `purgePostCache` or `purgeEverything`, which:

1. POSTs to the Cloudflare cache-purge API (chunked at 30 URLs per call).
2. Clears the Worker's in-memory site-config cache via `caches.default`.

Cached responses use `Cache-Control: public, max-age=60, s-maxage=300` for HTML, longer for sitemap/RSS.

### Limits

* Per-site: ~50 posts/day handled with cpu_ms=30000 and 50ms per post.
* 100 sites = ~5000 posts/day, well within Turso's free tier and R2's free egress.
* Each Worker request opens at most one site DB connection (HTTP-pooled by libSQL).

### Troubleshooting

* **404 on a hostname** → check the `sites` table in master DB (`turso db shell cms-master "SELECT * FROM sites"`); verify `active = 1`.
* **Login fails silently** → check `SESSION_COOKIE_NAME` / `JWT_SECRET` are set; Workers need both.
* **Theme preview doesn't update** → the iframe needs `same-origin`; the customizer page already sets `sandbox="allow-scripts allow-same-origin"`. Make sure the site renders on the same hostname as the admin.
* **R2 images broken** → confirm `R2_PUBLIC_URL` is set and the R2 bucket has a public custom domain.

---

## License

MIT.
