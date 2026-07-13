# OAUTH_SETUP.md — platform-owned OAuth apps (Google/GSC + Pinterest)

One-time setup done by the platform owner (you), in parallel with Phases 1–6.
Verification lead time is **weeks** — start both submissions now. Nothing here blocks
Phases 1–6; the credentials are consumed in Phase 7 (GSC) and Phase 8 (Pinterest).

Redirect URLs assume the dashboard hostname `arsal.app` (decision #10).

---

## 1. Google — Search Console OAuth (used by Phase 7: Network brain)

### 1.1 Create the project + consent screen

1. https://console.cloud.google.com → create project, e.g. `sitenetwork-os` (any org/no org).
2. **APIs & Services → Library** → enable **"Google Search Console API"**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**.
   - App name: your product name (shown to customers on the consent screen).
   - User support email: your email; Developer contact: your email.
   - **App domain**: homepage `https://arsal.app`, privacy policy `https://arsal.app/privacy`, terms `https://arsal.app/terms` — these three pages must exist and be public before verification review (Phase 1 dashboard shell can host static versions; put real copy there before submitting).
   - **Authorized domains**: `arsal.app`.
4. **Scopes**: add `https://www.googleapis.com/auth/webmasters.readonly` (read GSC data) and `https://www.googleapis.com/auth/webmasters` (needed for sitemap submit). Both are **sensitive scopes** → verification required.

### 1.2 Create the OAuth client

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Type: **Web application**, name `sitenetwork-dashboard`.
3. Authorized redirect URI: `https://arsal.app/app/connections/gsc/callback`
   (add `http://localhost:8787/app/connections/gsc/callback` for wrangler dev if you want local testing).
4. Save the **Client ID** and **Client Secret**.

### 1.3 Store the credentials (Phase 7 consumes them)

```bash
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

### 1.4 Verification submission checklist (sensitive scopes)

Google reviews apps requesting `webmasters` scopes. Submit from the OAuth consent screen → **Publish app** → **Prepare for verification**:

- [ ] Homepage `https://arsal.app` live, describes the product, links privacy policy.
- [ ] Privacy policy + terms URLs live on `arsal.app` (same domain as authorized domain).
- [ ] Domain ownership verified in **Google Search Console** for `arsal.app` (add it as a property; DNS TXT record).
- [ ] Scope justification text: explain the app reads Search Console performance data and submits sitemaps **on behalf of the site owner, at their request**, to power an SEO dashboard. One paragraph, plain language.
- [ ] **Demo video** (screen recording, YouTube unlisted): show the OAuth consent flow from `arsal.app`, then the data being used in the dashboard. Until Phase 7 UI exists, record the wizard mockup flow — Google accepts staged demos, but the redirect URI and branding shown must match the submission. If review stalls on this, resubmit once Phase 7 is real.
- [ ] Expect 2–6 weeks; app works for up to 100 test users meanwhile (**Audience → Test users** — add your own Google account now so development is never blocked).

**While unverified**: keep the app in *Testing* mode; customers you add as test users can connect; everyone else sees the "unverified app" wall. Plan launch marketing after verification clears.

---

## 2. Pinterest — OAuth app (used by Phase 8: Pinterest traffic engine)

### 2.1 Create the app

1. https://developers.pinterest.com → **My apps → Create app** (log in with the Pinterest **business account** that will own the platform app — convert your account to business first if needed: free, instant).
2. App name + description: what customers see on the consent screen; describe pin scheduling for site owners.
3. Redirect URI: `https://arsal.app/app/connections/pinterest/callback`.

### 2.2 Trial access → standard access

Pinterest grants **Trial access** immediately (rate-limited, sandbox-ish; enough for all Phase 8 development against your own boards). **Standard access** requires review:

- [ ] In the app dashboard, request **Standard access**.
- [ ] Scopes to request: `boards:read`, `boards:write`, `pins:read`, `pins:write`, `user_accounts:read`.
- [ ] Use-case write-up: customers connect their own Pinterest business accounts; the platform creates pins from their own blog posts on a schedule they control. Emphasize: user-initiated, own-content, no scraping, no bulk follow/engagement automation.
- [ ] Working demo of the OAuth flow + pin creation (trial access is enough to record this).
- [ ] Pinterest checks the app's website (`arsal.app`) — same privacy/terms pages as Google review.
- [ ] Expect 1–4 weeks. Pin **scheduling** (publish_date on pins) requires standard access.

### 2.3 Store the credentials

```bash
wrangler secret put PINTEREST_APP_ID
wrangler secret put PINTEREST_APP_SECRET
```

---

## 3. Resend (decision A — needed by Phase 1, do this FIRST)

Not an OAuth review, no lead time, but it gates Phase 1's verification/reset emails:

1. https://resend.com → sign up → **Domains → Add domain** → `arsal.app`.
2. Add the DNS records Resend shows you, on the `arsal.app` zone in Cloudflare:
   - **SPF**: TXT record (Resend provides the exact value, e.g. `v=spf1 include:amazonses.com ~all` on the sending subdomain).
   - **DKIM**: three CNAME records (Resend provides).
   - Optional but recommended: **DMARC** TXT `_dmarc.arsal.app` → `v=DMARC1; p=none; rua=mailto:you@...` to start collecting reports.
3. Wait for "Verified" status (usually minutes), then create an API key (**Sending access** only, not full):
```bash
wrangler secret put RESEND_API_KEY
```
4. Suggested sender identities: `login@arsal.app` (auth emails), `alerts@arsal.app` (monitoring), `forms@arsal.app` (contact-form relay).

---

## Summary of what lands where

| Credential | Secret name | Consumed by |
|---|---|---|
| Google OAuth client | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Phase 7 (`src/lib/saas/gsc.ts`) |
| Pinterest app | `PINTEREST_APP_ID` / `PINTEREST_APP_SECRET` | Phase 8 (`src/lib/saas/pinterest.ts`) |
| Resend key | `RESEND_API_KEY` | Phase 1 (`src/lib/saas/email.ts`) |

Timeline: do §3 (Resend) today — Phase 1 needs it. Submit §1 and §2 for review this week; both reviews run while Phases 1–6 are built.
