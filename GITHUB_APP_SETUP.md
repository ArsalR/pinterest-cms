# GITHUB_APP_SETUP.md — one-time platform GitHub App creation (decision D/#4)

Done once by the platform owner. ~10 minutes. Phase 2's GitHub connection step
is non-functional until this exists and the two secrets are set.

## 1. Create the App

https://github.com/settings/apps → **New GitHub App** (under your personal
account `ArsalR` — it can be transferred to an org later without breaking
installations).

| Field | Value |
|---|---|
| GitHub App name | `SiteNetwork OS` (must be globally unique — if taken, `sitenetwork-os-arsal`; the resulting **slug** is what the code needs) |
| Homepage URL | `https://arsal.app` |
| Callback URL | `https://arsal.app/app/connections/github/callback` |
| ☑ Request user authorization (OAuth) during installation | **unchecked** |
| Setup URL | `https://arsal.app/app/connections/github/callback` |
| ☑ Redirect on update | checked |
| Webhook → Active | **unchecked for now** (Phase 3 turns it on with URL `https://arsal.app/api/saas/hooks/github` + a `GITHUB_APP_WEBHOOK_SECRET`) |

## 2. Permissions (Repository)

| Permission | Access | Why |
|---|---|---|
| Contents | **Read and write** | create/commit site files, rollback (revert commits) |
| Actions | **Read and write** | dispatch Claude/build workflows, read run status + minutes |
| Administration | **Read and write** | create repos from the template, repo settings |
| Secrets | **Read and write** | set per-repo secrets (customer CF token, CMS key, Anthropic key) |
| Workflows | **Read and write** | update `.github/workflows/*` in customer repos |
| Metadata | Read-only | mandatory default |

Organization/Account permissions: none. **Where can this app be installed:** Any account.

## 3. After creation

1. Note the **App ID** (top of the app settings page) and the **slug** (from the public link `https://github.com/apps/<slug>`).
2. **Generate a private key** → downloads a `.pem`.
3. GitHub's PEM is **PKCS#1** (`-----BEGIN RSA PRIVATE KEY-----`); Workers WebCrypto needs **PKCS#8**. Convert once:
   ```bash
   openssl pkcs8 -topk8 -inform PEM -in sitenetwork-os.*.private-key.pem -out app-pkcs8.pem -nocrypt
   ```
   (The code detects a PKCS#1 paste and tells you exactly this.)
4. Store:
   ```bash
   wrangler secret put GITHUB_APP_ID          # the numeric App ID
   wrangler secret put GITHUB_APP_PRIVATE_KEY # full contents of app-pkcs8.pem, BEGIN/END lines included
   ```
   and set the slug in `wrangler.toml` `[vars]`: `GITHUB_APP_SLUG = "<slug>"`.
5. Delete both `.pem` files from your machine once the secret is set.

Customers never see any of this — they just click "Connect GitHub" in the
wizard, which sends them to `https://github.com/apps/<slug>/installations/new`.
