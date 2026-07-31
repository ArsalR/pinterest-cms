# SiteNetwork — Full Session Log (Go-Live Troubleshooting)

A chronological record of the whole chat while getting the platform live on
`freecoinslink.de` and provisioning the first customer site. Each entry is the
problem raised, the diagnosis, and exactly what was done. Newest at the bottom.

> This is a readable reconstruction of the conversation for your records. Code
> fixes referenced here live on branch `claude/debug-workers-cms-Omn5b` (draft
> **PR #103**). Companion docs: `PROJECT_EXPLAINED.md` / `SiteNetwork_Explained.pdf`.

---

## 0. Context at the start
- Platform = `pinterest-cms`: a multi-tenant "website factory" on Cloudflare
  Workers + Hono + Turso + R2 + a GitHub App, deploying customer sites into the
  customers' own GitHub/Cloudflare accounts.
- Owner: **ArsalR**, domain **freecoinslink.de**, email arsalriaz34@gmail.com.
- The full V1.5 platform was already built/merged; this session was about
  **getting it live and creating the first real site end-to-end**.

---

## 1. "Worker error mentioning `'execute'`; sign up/in not working"
**Cause:** the SaaS layer was off.
**Fix:** set `SAAS_MODE = "1"` and `SAAS_APP_HOSTNAME`. Signup/login gated on
`saasActive()` which needs both.

## 2. "Site can't be reached / no DNS propagation"
**Cause:** the domain's Cloudflare nameservers were still activating; the
dashboard was temporarily pointed at the workers.dev admin host.
**Fix:** waited for `freecoinslink.de` to go **Active**, then moved the
dashboard to **`app.freecoinslink.de`**.

## 3. 404 "network admin panel — does not serve tenant sites"
**Cause:** `SAAS_APP_HOSTNAME` had been set to the same host as
`NETWORK_ADMIN_HOSTNAME` (the workers.dev host), which is admin-only.
**Fix:** `SAAS_APP_HOSTNAME = "app.freecoinslink.de"` (must differ from the
network-admin host).

## 4. Signup: "Something went wrong creating your account"
**Cause (from logs):** `Pbkdf2 failed: iteration counts above 100000 are not
supported (requested 600000)`. Cloudflare Workers caps PBKDF2 at 100k.
**Fix:** capped `customerIterations()` at 100,000 in code (**PR #100**) and set
`SAAS_PBKDF2_ITERATIONS = "100000"`. (Later left empty — code default is 100k.)

## 5. GitHub connect + no verification email
- **GitHub "Temporarily unavailable" / callback went to old `arsal.app`:**
  the GitHub **App Setup URL** (not just the Callback URL) controls the
  post-install redirect. Pointed both at
  `https://app.freecoinslink.de/app/connections/github/callback`.
- **No verification email:** `RESEND_API_KEY` unset → emails only log. Made the
  "from" address configurable (`SAAS_EMAIL_FROM`, default
  `SiteNetwork <login@freecoinslink.de>`) and, to unblock, set customers'
  `email_verified = 1` in the DB.

## 6. Housekeeping fixes (PR #102)
- Design presets weren't clickable → rewrote the picker JS.
- Replaced every remaining **`arsal.app`** placeholder with
  **`freecoinslink.de`** across `src/`.

## 7. Security: live tokens pasted in chat
Twice, real tokens were pasted (a Turso master token, a GitHub PAT).
**Action:** rotate/revoke immediately; **never paste secrets into chat** — set
them only via `wrangler secret put`'s hidden prompt.

---

## 8. The big blocker: the template repo `ArsalR/site-template`
Provisioning clones every site from a **template repo** via GitHub's
`/repos/ArsalR/site-template/generate`. That repo **didn't exist** → `404`.

### 8a. Why it can't be auto-created
The template is a **one-time platform asset** (the master everything is copied
from). This session's GitHub access is locked to the `pinterest-cms` repo only
(the egress proxy replied *"sessions are bound to their configured
repositories"*), so the template had to be created from the owner's Mac.

### 8b. `gh` not installed → website + PAT push path
Provided a no-`gh` path: create the empty repo, push the local
`~/site-template-repo` with a token, flag it as a **Template repository**.

### 8c. zsh scripting pitfalls (several rounds)
- `read -s -p` is **bash** syntax; zsh broke on it → switched to a token set on
  its own line, no `read`.
- Multi-line pastes with `\` continuations + blank lines scrambled in zsh →
  switched to **single-line commands, run one at a time**.
- Placeholder text (`ghp_YOUR_...`) got pasted literally → added an
  `echo ${TOKEN:0:4}` sanity check.

### 8d. The real push blocker: missing `workflow` scope
Push kept failing: *"refusing to allow a Personal Access Token to create or
update workflow `.github/workflows/claude.yml` without `workflow` scope."*
The template contains GitHub Actions files, which a PAT can't write without the
**`workflow`** scope. The token only had `repo`.
**Fix:** create the token with **both** scopes pre-ticked via
`github.com/settings/tokens/new?scopes=repo,workflow`, then re-push → landed.

### 8e. Config that kept getting wiped (PR #103)
`GITHUB_APP_SLUG` reset to `""` on every `git pull` (vars in `wrangler.toml`
overwrite deployed values). Baked `GITHUB_APP_SLUG = "sitenetwork-os"` into the
file so deploys stop wiping it.

---

## 9. Provisioning, step by step (once the template existed)
Order of the pipeline and what got fixed as each surfaced:

1. **Create content workspace** — ✅
2. **Spam protection** — SKIPPED (Turnstile not configured; contact form falls
   back to email — by design).
3. **Create the site repository** — ✅ (after 8).
4. **Write the site configuration → `409`**
   **Cause:** GitHub's `/generate` is **asynchronous**; writing
   `site.config.json` into a still-empty repo returns 409.
   **Fix (PR #103):** `waitForRepoReady()` polls the commits endpoint before the
   first file write.
5. **Store deploy credentials** — ✅
6. **Start the first build** — ✅
7. **Confirm the site built and deployed → FAILED**
   - First improved the message to distinguish "still building" from a real
     **build failure**, with a link to the run (PR #103).
   - The build log showed: `getaddrinfo ENOTFOUND
     f30imask-com.cms.freecoinslink.de` — the site couldn't fetch its content
     because the **CMS hostname didn't resolve**.

---

## 10. The CMS hostname (`*.cms.freecoinslink.de`) — the last infra piece
Every site's CMS lives at `<slug>.cms.freecoinslink.de`, served by the platform
Worker via Host-header tenant resolution. That family of addresses was never
turned on.

- First tried a **proxied `*.cms` wildcard DNS + Worker route** — but
  **proxied wildcard records are Cloudflare Enterprise-only**, so on the
  free/pro plan the route never fires → "can't be reached."
- Correct approach: a **Custom Domain per CMS host** (works on every plan,
  auto-creates proxied DNS + certificate).

### Fixes
- **This site (manual, one-time):** Workers → pinterest-cms → Domains →
  **Add Domain** → `f30imask-com.cms.freecoinslink.de`. Blocked by the leftover
  `*.cms.freecoinslink.de/*` **route** — deleting that route (and the `*.cms`
  DNS record) unblocks it. Verified in code that **nothing depends on the
  wildcard route/record**; the dashboard (`app.`) and apex have their own
  separate custom domains and are untouched.
- **All future sites (automatic, PR #103):** provisioning now calls
  `attachWorkersDomain()` in the `cms_site` step to attach each CMS hostname as
  a Custom Domain on the platform Worker. Added `SAAS_WORKER_NAME`
  (default `pinterest-cms`).
- **Retry actually rebuilds (PR #103):** `verify_deploy` now re-dispatches the
  build when the last run failed, instead of only re-checking a dead run.

---

## 11. Code changes made this session (branch `claude/debug-workers-cms-Omn5b`)
| Area | Change |
|---|---|
| `wrangler.toml` | `GITHUB_APP_SLUG = "sitenetwork-os"`, `SAAS_WORKER_NAME = "pinterest-cms"` |
| `connections/github.ts` | `waitForRepoReady()` (poll until template repo has content) |
| `provisioning/provisionSite.ts` | wait-for-ready before first write; build-failure vs still-building reporting; auto re-dispatch build on retry; auto-attach CMS Custom Domain |
| `lib/types.ts` | `SAAS_WORKER_NAME` env typing |
| earlier PRs | #100 PBKDF2 cap, #101/#102 email-from + arsal.app cleanup + design picker, #103 the above |

**To make all fixes live:**
```bash
cd ~/pinterest-cms
git fetch origin claude/debug-workers-cms-Omn5b
git merge origin/claude/debug-workers-cms-Omn5b
npm run deploy
```

---

## 12. Where things stand
- Platform live, SaaS on, dashboard at `app.freecoinslink.de`. ✅
- GitHub App + Cloudflare connected. ✅
- `ArsalR/site-template` created, populated, flagged as template. ✅
- Provisioning reaches **"Confirm the site built and deployed"**; the remaining
  manual step for `f30imask.com` is adding the CMS **Custom Domain** (after
  deleting the leftover `*.cms` route/record), then re-running the build.
- After deploying PR #103, **new** sites attach their CMS domain automatically.

**Next:** delete the `*.cms` route + `*.cms` DNS record → Add Domain
`f30imask-com.cms.freecoinslink.de` → re-run the build (green) → Retry →
"Connect your domain" → done. Then confirm the customer Cloudflare token carries
the full 9-permission set for the deploy/domain steps.

---

## Recurring lessons
- Never paste secrets into chat — rotate anything that leaks.
- `wrangler.toml` `[vars]` overwrite deployed values every deploy — change them
  in the file, not by hand.
- On this Cloudflare plan, use **Custom Domains**, not proxied wildcards.
- Read the failing step's actual log line — it names the real cause (`404` =
  missing, `409` = exists-but-not-ready, `403` = permission, `ENOTFOUND` = DNS).
