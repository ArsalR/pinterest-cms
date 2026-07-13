# site-template — the SiteNetwork customer-site template

Astro, **zero client-side JavaScript**, with the Performance and Security
Covenants baked into CI: the deploy job runs only after the zero-JS check,
the security-header check, and the Lighthouse budget gate all pass
(**budget fail = deploy blocked** — decision E: Action-gated `wrangler deploy`,
not Workers Builds).

## One-time publish (platform owner)

This directory is developed inside `pinterest-cms` but ships as its own repo:

```bash
cd site-template
git init && git add -A && git commit -m "site-template v1"
git remote add origin https://github.com/ArsalR/site-template.git
git push -u origin main
```

Then on GitHub: **Settings → check "Template repository"** — repo-from-template
provisioning requires it.

## How a provisioned copy works

- `site.config.json` + `wrangler.toml` are overwritten by the platform during
  provisioning (name, niche, domain, canonical host, CMS API URL, owner
  details, worker name).
- Repo Actions secrets set by the platform: `CF_API_TOKEN`, `CF_ACCOUNT_ID`,
  `CMS_API_KEY` (+ optional `ANTHROPIC_API_KEY`).
- Content is pulled at **build time** from the CMS public API
  (`GET /v1/posts`, read key) — fully static at serve time: no origin
  database, no server rendering (Security Covenant S1).
- Publishing in the CMS fires a webhook → the platform converts it to a
  `repository_dispatch` (`content-updated`) → this repo rebuilds + redeploys.
- The canonical-host redirect (apex ↔ www 301) is emitted into
  `dist/_redirects` at build time from the config.
- The `*.workers.dev` URL is disabled by the platform after the first deploy
  (SEO duplicate-content protection).
