// src/modules/marketing/pages.ts
// Public marketing + legal pages for the SaaS apex (arsal.app): homepage,
// privacy policy, terms of service. These are the PUBLIC face of the platform
// (indexable, no auth, no dashboard chrome) — distinct from the /app dashboard
// shell (which is noindex + session-gated).
//
// Why they exist now: Google's OAuth verification for the Search Console
// scopes (Phase 7 GSC) requires a live homepage, privacy policy, and terms on
// the authorized domain BEFORE review. Standing these up early unblocks the
// (weeks-long) verification clock. Content is plain static template strings —
// same no-framework convention as the rest of the app.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { escapeHtml } from "../../lib/utils"
import { PRESETS, LAYOUTS, type SiteKindId } from "../design"

// Four permanent live demo sites (one per kind), each provisioned through the
// REAL production pipeline on a platform subdomain and each on a different
// preset. They double as our permanent end-to-end smoke sites (see PLAN.md).
// Owner-provisioned; the gallery links kind cards to the matching demo.
const DEMOS: Record<SiteKindId, { url: string; label: string; preset: string }> = {
  content: { url: "https://demo-blog.arsal.app", label: "Blog", preset: "editorial" },
  ecommerce: { url: "https://demo-shop.arsal.app", label: "Store", preset: "modern" },
  "local-business": { url: "https://demo-local.arsal.app", label: "Local business", preset: "warm" },
  portfolio: { url: "https://demo-folio.arsal.app", label: "Portfolio", preset: "bold" },
}
const KIND_LABELS: Record<SiteKindId, string> = { content: "Blog / content", ecommerce: "Online store", "local-business": "Local business", portfolio: "Portfolio" }

const PRODUCT = "SiteNetwork OS"
const CONTACT_EMAIL = "support@arsal.app"
const LAST_UPDATED = "2026-07-15"

const STORE = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" }

/**
 * Public marketing layout — indexable (unlike the dashboard shell), self-
 * contained inline CSS, light header + footer with the legal links Google's
 * review checks for.
 */
function renderMarketingPage(title: string, description: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#fafafa;line-height:1.6}
  a{color:#93c5fd}
  header{display:flex;justify-content:space-between;align-items:center;padding:18px 24px;border-bottom:1px solid #262626;max-width:960px;margin:0 auto}
  header .brand{font-weight:700;letter-spacing:-0.02em;font-size:16px;color:#fafafa;text-decoration:none}
  header nav a{margin-left:18px;font-size:14px;color:#a3a3a3;text-decoration:none}
  header nav a:hover{color:#fafafa}
  main{max-width:760px;margin:0 auto;padding:48px 24px 72px}
  h1{font-size:30px;letter-spacing:-0.02em;margin:0 0 8px}
  h2{font-size:19px;letter-spacing:-0.01em;margin:32px 0 8px}
  p,li{color:#d4d4d4;font-size:15px}
  .lede{font-size:18px;color:#a3a3a3;margin:0 0 28px}
  .btn{display:inline-block;background:#fafafa;color:#0a0a0a;border-radius:8px;padding:11px 20px;font-size:14px;font-weight:600;text-decoration:none;margin-top:8px}
  .muted{color:#737373;font-size:13px}
  footer{border-top:1px solid #262626;max-width:960px;margin:0 auto;padding:24px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px}
  footer a{color:#a3a3a3;font-size:13px;text-decoration:none;margin-right:16px}
  footer a:hover{color:#fafafa}
  .feature{border:1px solid #262626;border-radius:12px;padding:18px;margin:10px 0}
  .feature h3{margin:0 0 4px;font-size:15px}
</style></head>
<body>
  <header>
    <a class="brand" href="/">SiteNetwork</a>
    <nav>
      <a href="/app/login">Sign in</a>
      <a href="/app/signup">Get started</a>
    </nav>
  </header>
  <main>${bodyHtml}</main>
  <footer>
    <div>
      <a href="/">Home</a>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
    </div>
    <div class="muted">© 2026 ${escapeHtml(PRODUCT)} · <a href="mailto:${CONTACT_EMAIL}">${escapeHtml(CONTACT_EMAIL)}</a></div>
  </footer>
</body></html>`
}

export async function marketingHomeHandler(c: Context<AppEnv>): Promise<Response> {
  const body = `
    <h1>Own your entire network of SEO sites.</h1>
    <p class="lede">${escapeHtml(PRODUCT)} builds, publishes, and monitors a portfolio of high-quality
      content sites — each on <strong>your own</strong> GitHub, Cloudflare, and domain. You keep every
      line of code and every reader, forever.</p>
    <a class="btn" href="/app/signup">Start free</a>

    <h2>What it does</h2>
    <div class="feature">
      <h3>Build with prompts</h3>
      <p>Describe a site; it's generated as a fast static site in a repo you own, then edited by asking
        for changes in plain language — runs in your own GitHub Actions with your own AI key.</p>
    </div>
    <div class="feature">
      <h3>A quality gate that actually says no</h3>
      <p>Every draft passes word-count, originality, and metadata checks before it can go live. Thin or
        duplicate content never publishes.</p>
    </div>
    <div class="feature">
      <h3>A network brain</h3>
      <p>Search Console data, indexing status, and content-decay alerts across every site in one place —
        so you know what to refresh before rankings slip.</p>
    </div>
    <div class="feature">
      <h3>Performance &amp; AI-visibility by default</h3>
      <p>Image optimization, Core Web Vitals monitoring, structured data, and an <code>llms.txt</code>
        summary so AI assistants can find and cite your work.</p>
    </div>

    <h2>Your infrastructure, your data</h2>
    <p>We connect to your accounts to set things up on your behalf, at your request. Credentials are
      encrypted with a key derived only for your account, and every use is logged. Read how in our
      <a href="/privacy">privacy policy</a>.</p>
    <a class="btn" href="/app/signup">Create your account</a>
  `
  return c.html(
    renderMarketingPage(
      `${PRODUCT} — own your network of SEO sites`,
      "Build, publish, and monitor a portfolio of high-quality content sites on your own GitHub, Cloudflare, and domains.",
      body
    ),
    200,
    STORE
  )
}

/** A token-accurate preview card for one preset, rendered from the REAL swatch
 *  values (no hand-drawn mockup that could drift from the template). */
function presetCard(p: (typeof PRESETS)[number]): string {
  return `<div style="border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 1px 3px rgba(0,0,0,.06)">
    <div style="background:${p.swatch.bg};padding:16px">
      <div style="font-weight:800;font-size:15px;color:${p.swatch.fg}">${escapeHtml(p.label)}</div>
      <div style="height:8px"></div>
      <div style="background:${p.swatch.surface};border:1px solid ${p.swatch.accent}22;border-radius:8px;padding:10px">
        <div style="height:8px;width:70%;background:${p.swatch.fg};opacity:.85;border-radius:4px"></div>
        <div style="height:6px;width:90%;background:${p.swatch.fg};opacity:.35;border-radius:3px;margin-top:6px"></div>
        <div style="display:inline-block;margin-top:10px;background:${p.swatch.accent};color:#fff;font-size:11px;font-weight:700;padding:4px 10px;border-radius:6px">Read more</div>
      </div>
    </div>
    <div style="padding:8px 12px;background:#fff;font-size:12px;color:#6b7280">${escapeHtml(p.mood)} · ${escapeHtml(p.font)}</div>
  </div>`
}

export async function marketingExamplesHandler(c: Context<AppEnv>): Promise<Response> {
  const kinds = Object.keys(LAYOUTS) as SiteKindId[]
  const presetGrid = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px;margin:14px 0 28px">${PRESETS.map(presetCard).join("")}</div>`

  const kindSections = kinds
    .map((k) => {
      const demo = DEMOS[k]
      return `<div class="feature">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <h3 style="margin:0">${escapeHtml(KIND_LABELS[k])}</h3>
          <a class="btn" href="${escapeHtml(demo.url)}" style="padding:8px 14px">View live demo — ${escapeHtml(demo.preset)} preset ↗</a>
        </div>
        <p class="muted" style="margin:6px 0 0">${LAYOUTS[k].map((l) => escapeHtml(l.label)).join(" · ")} layouts, any of the ${PRESETS.length} presets above.</p>
      </div>`
    })
    .join("")

  const body = `
    <h1>Every site, your way.</h1>
    <p class="lede">Pick from ${PRESETS.length} professionally-designed presets and per-kind layouts at creation — then change your mind anytime with a live preview. Every combination stays inside the same speed &amp; security guarantees.</p>
    <h2>Design presets</h2>
    <p class="muted">Real token sets — the exact colors, fonts, and spacing your site ships with.</p>
    ${presetGrid}
    <h2>By site kind</h2>
    ${kindSections}
    <a class="btn" href="/app/signup" style="margin-top:8px">Start building</a>`
  return c.html(
    renderMarketingPage(`Examples — ${PRODUCT}`, "Design presets and live demo sites for every kind of site SiteNetwork OS builds.", body),
    200,
    STORE
  )
}

export async function marketingPrivacyHandler(c: Context<AppEnv>): Promise<Response> {
  const body = `
    <h1>Privacy Policy</h1>
    <p class="muted">Last updated ${escapeHtml(LAST_UPDATED)}</p>

    <p>${escapeHtml(PRODUCT)} ("we", "us") helps you build and operate websites on infrastructure you own.
      This policy explains what we collect, why, and the third-party data we access on your behalf.</p>

    <h2>Information we collect</h2>
    <ul>
      <li><strong>Account information</strong> — your email address and (optionally) name, used to sign
        you in and send transactional email (verification, password reset, alerts).</li>
      <li><strong>Connected-account credentials</strong> — API tokens you provide for GitHub, Cloudflare,
        Anthropic, Stripe, Google Search Console, and Pinterest. These are stored <strong>encrypted</strong>
        with a key derived uniquely for your account and are used only to perform actions you request.</li>
      <li><strong>Operational metadata</strong> — non-secret information such as your connected account
        names, site domains, and job status, used to run and display your dashboard.</li>
    </ul>

    <h2>Google user data (Search Console)</h2>
    <p>If you connect Google Search Console, we request read access to your Search Console performance
      data and the ability to submit sitemaps, using the
      <code>webmasters.readonly</code> and <code>webmasters</code> scopes. We use this access solely to:</p>
    <ul>
      <li>display your search performance (clicks, impressions, queries) inside your dashboard;</li>
      <li>detect content decay and suggest pages to refresh;</li>
      <li>submit sitemaps for your sites when you ask us to.</li>
    </ul>
    <p>We access this data <strong>on your behalf, at your request</strong>, to power an SEO dashboard.
      We do not sell it, use it for advertising, or share it with third parties. Google user data is used
      and transferred in accordance with the
      <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User
      Data Policy</a>, including its Limited Use requirements. You can disconnect Google at any time from
      the Connections page, which revokes our stored token.</p>

    <h2>How we store and protect data</h2>
    <p>Secrets are encrypted at rest. Every decryption of a stored credential is written to an append-only
      audit log tied to your account. We access connected accounts only to carry out actions you initiate.</p>

    <h2>Data retention and deletion</h2>
    <p>You may disconnect any integration or delete your account at any time. Disconnecting removes the
      stored credential for that provider; deleting your account removes your account records. Sites you
      created live in your own accounts and are unaffected.</p>

    <h2>Contact</h2>
    <p>Questions about privacy? Email <a href="mailto:${CONTACT_EMAIL}">${escapeHtml(CONTACT_EMAIL)}</a>.</p>
  `
  return c.html(
    renderMarketingPage(`Privacy Policy — ${PRODUCT}`, "How SiteNetwork OS collects, uses, and protects your data, including Google Search Console data.", body),
    200,
    STORE
  )
}

export async function marketingTermsHandler(c: Context<AppEnv>): Promise<Response> {
  const body = `
    <h1>Terms of Service</h1>
    <p class="muted">Last updated ${escapeHtml(LAST_UPDATED)}</p>

    <p>By using ${escapeHtml(PRODUCT)} you agree to these terms. If you don't agree, don't use the service.</p>

    <h2>The service</h2>
    <p>${escapeHtml(PRODUCT)} builds and manages websites on infrastructure you own and control (your
      GitHub, Cloudflare, and domains). We act on your behalf using credentials you provide. You are
      responsible for your connected accounts, the content you publish, and compliance with the terms of
      the third-party services you connect.</p>

    <h2>Your content and accounts</h2>
    <p>You retain full ownership of everything created for you — code, content, and data all live in your
      accounts. You are responsible for ensuring your use and content are lawful and do not infringe
      others' rights.</p>

    <h2>Acceptable use</h2>
    <p>Don't use the service to publish spam, malware, or unlawful content, to abuse connected APIs, or to
      violate the terms of GitHub, Cloudflare, Google, Pinterest, Stripe, or Anthropic.</p>

    <h2>Third-party services</h2>
    <p>The service integrates with third parties under their own terms. We're not responsible for their
      availability, pricing, or actions. Costs you incur on your own accounts (hosting, AI usage, payment
      processing) are yours.</p>

    <h2>Warranty and liability</h2>
    <p>The service is provided "as is" without warranties of any kind. To the maximum extent permitted by
      law, we are not liable for indirect or consequential damages arising from your use of the service.</p>

    <h2>Changes</h2>
    <p>We may update these terms; material changes will be posted here. Continued use after a change means
      you accept it.</p>

    <h2>Contact</h2>
    <p>Questions? Email <a href="mailto:${CONTACT_EMAIL}">${escapeHtml(CONTACT_EMAIL)}</a>.</p>
  `
  return c.html(
    renderMarketingPage(`Terms of Service — ${PRODUCT}`, "The terms governing use of SiteNetwork OS.", body),
    200,
    STORE
  )
}
