// Build-time content pull from the CMS public API (confirmed decision #3).
// Runs ONLY during `astro build` in GitHub Actions — never at serve time.

import { readFileSync } from "node:fs"

export interface SiteConfig {
  name: string
  niche: string
  kind?: "content" | "ecommerce" | "local-business" | "portfolio"
  /** Design preset (V1.1) — CSS-variable token set; see src/lib/presets.ts. */
  preset?: string
  /** Homepage layout variant (V1.1) — per-kind static switch. */
  layout?: string
  domain: string
  canonicalHost: "apex" | "www"
  cmsApiUrl: string
  ownerName: string
  ownerEmail: string
  generatedAt: string
  /** Contact-form relay (set at provisioning; absent = mailto fallback). */
  turnstileSitekey?: string
  formsEndpoint?: string
  /** Ecommerce checkout relay (set at provisioning for kind='ecommerce'). */
  checkoutEndpoint?: string
}

export interface CmsProduct {
  id: string
  slug: string
  title: string
  description: string | null
  priceCents: number
  currency: string
  images: string[]
  sku: string | null
  stockStatus: string
  digital: boolean
  published: boolean
  categorySlug: string | null
  seoTitle: string | null
  seoDescription: string | null
}

export interface CmsPost {
  id: string
  title: string
  slug: string
  content: string
  excerpt: string | null
  coverImage: string | null
  publishedAt: string | null
  updatedAt: string | null
  category: { slug: string; name: string } | null
  seoTitle: string | null
  seoDescription: string | null
  // V1.2 SEO cockpit overrides. All optional — absent reproduces today's output.
  noIndex?: boolean
  canonicalUrl?: string | null
  ogTitle?: string | null
  ogDescription?: string | null
  ogImage?: string | null
  nofollow?: boolean
  schemaType?: string | null
  faq?: Array<{ question: string; answer: string }> | null
  authorId?: string | null
  llmsExclude?: boolean
  focusKeyword?: string | null
}

/** Canonical robots-directive rule (mirrors src/modules/seo/analyze.ts).
 *  Both flags false/absent ⇒ null ⇒ NO robots meta (byte-identical, rail #3). */
export function computeRobots(noIndex?: boolean, nofollow?: boolean): string | null {
  const parts: string[] = []
  if (noIndex) parts.push("noindex")
  if (nofollow) parts.push("nofollow")
  return parts.length > 0 ? parts.join(", ") : null
}

export function loadConfig(): SiteConfig {
  return JSON.parse(readFileSync(new URL("../../site.config.json", import.meta.url), "utf8")) as SiteConfig
}

// ─────────────── Site SEO Control Center settings (V1.2 S3) ───────────────
// Fetched once at build from the additive /v1/seo-settings endpoint. Defaults
// reproduce today's output exactly, so an unconfigured site is byte-identical.

export interface SeoSettings {
  blockAiBots: boolean
  blockedBots: string[]
  disallowPaths: string[]
  robotsExtra: string
  rssEnabled: boolean
  archivesEnabled: boolean
  globalSchemaEnabled: boolean
  orgName: string
  orgLogo: string
  socialProfiles: string[]
  /** V1.3 SEO profile activations (local/news/ecommerce/image/ai). [] = none. */
  profiles: string[]
  /** V1.3 vetted script enablements [{id, config}]. [] = zero-JS as today. */
  scripts: Array<{ id: string; config: string }>
  /** V1.3 P2: IndexNow key (served at /<key>.txt). "" until generated. */
  indexnowKey: string
  /** V1.3 P4: image license/creator (licensable images). null = none. */
  imageLicense: { licenseUrl?: string; acquireLicenseUrl?: string; creatorName?: string } | null
}

export const SEO_SETTINGS_DEFAULTS: SeoSettings = {
  blockAiBots: false, blockedBots: [], disallowPaths: [], robotsExtra: "",
  rssEnabled: true, archivesEnabled: true, globalSchemaEnabled: false,
  orgName: "", orgLogo: "", socialProfiles: [],
  profiles: [],
  scripts: [],
  indexnowKey: "",
  imageLicense: null,
}

// ─────────────── Vetted script catalog (V1.3, template copy) ───────────────
// The build NEVER trusts wire input for script emission: enablements from the
// API are validated against THIS closed catalog (id + config format), and only
// these exact tag shapes can be emitted. Mirrors src/modules/seo/scripts.ts.

export interface TemplateScript {
  id: string
  costKb: number
  /** "tag" = plain deferred <script>; "loader" = bootstrapped/delayed via the
   *  local /js/site-scripts.js endpoint. */
  mode: "tag" | "loader"
  scriptHosts: string[]
  connectHosts: string[]
  configPattern: RegExp
  /** Build the exact tag (mode "tag" only). config is pattern-validated. */
  tag?: (config: string) => string
}

export const TEMPLATE_SCRIPT_CATALOG: readonly TemplateScript[] = [
  {
    id: "plausible", costKb: 1, mode: "tag",
    scriptHosts: ["https://plausible.io"], connectHosts: ["https://plausible.io"],
    configPattern: /^[a-z0-9.-]+\.[a-z]{2,}$/i,
    tag: (config) => `<script defer data-domain="${config}" src="https://plausible.io/js/script.js"></script>`,
  },
  {
    id: "fathom", costKb: 2, mode: "tag",
    scriptHosts: ["https://cdn.usefathom.com"], connectHosts: ["https://cdn.usefathom.com"],
    configPattern: /^[A-Z0-9]{8}$/i,
    tag: (config) => `<script src="https://cdn.usefathom.com/script.js" data-site="${config}" defer></script>`,
  },
  {
    id: "ga4", costKb: 55, mode: "loader",
    scriptHosts: ["https://www.googletagmanager.com"],
    connectHosts: ["https://www.google-analytics.com", "https://analytics.google.com"],
    configPattern: /^G-[A-Z0-9]{6,12}$/i,
  },
  {
    id: "crisp", costKb: 35, mode: "loader",
    scriptHosts: ["https://client.crisp.chat"],
    connectHosts: ["https://client.crisp.chat", "wss://client.relay.crisp.chat"],
    configPattern: /^[a-f0-9-]{36}$/i,
  },
  {
    id: "cookieyes", costKb: 40, mode: "tag",
    scriptHosts: ["https://cdn-cookieyes.com"],
    connectHosts: ["https://cdn-cookieyes.com", "https://log.cookieyes.com"],
    configPattern: /^[a-z0-9]{10,40}$/i,
    tag: (config) => `<script id="cookieyes" src="https://cdn-cookieyes.com/client_data/${config}/script.js" defer></script>`,
  },
]

/** Enabled scripts validated against the template catalog. Pure. */
export function validScripts(s: SeoSettings): Array<{ entry: TemplateScript; config: string }> {
  const out: Array<{ entry: TemplateScript; config: string }> = []
  for (const e of s.scripts) {
    const entry = TEMPLATE_SCRIPT_CATALOG.find((t) => t.id === e.id)
    if (entry && entry.configPattern.test(e.config) && !out.some((o) => o.entry.id === entry.id)) {
      out.push({ entry, config: e.config })
    }
  }
  return out
}

/** The <head> script tags for enabled scripts. "" when none (byte-identical). */
export function scriptTagsFor(s: SeoSettings): string {
  const enabled = validScripts(s)
  const tags: string[] = []
  for (const { entry, config } of enabled) {
    if (entry.mode === "tag" && entry.tag) tags.push(entry.tag(config))
  }
  if (enabled.some(({ entry }) => entry.mode === "loader")) {
    tags.push(`<script src="/js/site-scripts.js" defer></script>`)
  }
  return tags.join("\n  ")
}

/** Is a V1.3 SEO profile enabled for this site? Absent settings ⇒ false. */
export function profileOn(s: SeoSettings, id: string): boolean {
  return s.profiles.includes(id)
}

// ─────────────── Forms Engine (V1.4 F1) ───────────────
// Static rendering mirror of src/modules/forms/model.ts renderFormHtml —
// native HTML controls only (zero-JS covenant; Turnstile is the one allowed
// script and the PAGE adds its tag, matching the contact-form pattern).

export interface CmsFormField {
  key: string
  label: string
  type: string
  required?: boolean
  options?: string[]
  help?: string
}
export interface CmsForm {
  id: string
  slug: string
  title: string
  fields: CmsFormField[]
}

let _formsCache: CmsForm[] | null = null

/** Active forms (memoized). [] on error — byte-identical for form-less sites. */
export async function fetchForms(config: SiteConfig): Promise<CmsForm[]> {
  if (_formsCache) return _formsCache
  const key = process.env.CMS_API_KEY
  if (!key) return (_formsCache = [])
  try {
    const resp = await fetch(`${config.cmsApiUrl}/forms`, { headers: { Authorization: `Bearer ${key}` } })
    if (!resp.ok) return (_formsCache = [])
    const data = (await resp.json()) as { forms?: CmsForm[] }
    _formsCache = Array.isArray(data.forms) ? data.forms.filter((f) => f.slug && Array.isArray(f.fields)) : []
    return _formsCache
  } catch {
    return (_formsCache = [])
  }
}

const fEsc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] ?? c)

/** Render one form as pure static HTML. `action` = platform submit endpoint. */
export function renderCmsForm(form: CmsForm, action: string, turnstileSitekey: string | undefined, page: string): string {
  const rows = form.fields.map((d) => {
    const req = d.required ? " required" : ""
    const name = fEsc(d.key)
    const label = `<label for="f-${name}"><strong>${fEsc(d.label)}</strong>${d.required ? " *" : ""}</label>`
    const help = d.help ? `<p style="font-size:0.85rem;color:var(--muted);margin:0.1rem 0">${fEsc(d.help)}</p>` : ""
    let control: string
    switch (d.type) {
      case "textarea": control = `<textarea id="f-${name}" name="${name}" rows="5"${req} style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:6px"></textarea>`; break
      case "select": control = `<select id="f-${name}" name="${name}"${req} style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:6px"><option value="">Choose…</option>${(d.options ?? []).map((o) => `<option value="${fEsc(o)}">${fEsc(o)}</option>`).join("")}</select>`; break
      case "radio": control = (d.options ?? []).map((o, i) => `<label style="display:block"><input type="radio" name="${name}" value="${fEsc(o)}"${i === 0 && d.required ? " required" : ""}> ${fEsc(o)}</label>`).join(""); break
      case "checkbox": return `<p>${label ? "" : ""}<label><input type="checkbox" id="f-${name}" name="${name}"${req}> ${fEsc(d.help ?? d.label)}</label></p>`
      case "file": control = `<input type="file" id="f-${name}" name="${name}" accept="image/*,.pdf"${req}>`; break
      case "hidden": return `<input type="hidden" name="${name}" value="">`
      default: {
        const map: Record<string, string> = { email: "email", phone: "tel", date: "date", number: "number" }
        control = `<input type="${map[d.type] ?? "text"}" id="f-${name}" name="${name}"${req} style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:6px">`
      }
    }
    return `<p>${label}${help}${control}</p>`
  })
  const hasFile = form.fields.some((d) => d.type === "file")
  return `<form method="POST" action="${fEsc(action)}"${hasFile ? ` enctype="multipart/form-data"` : ""} style="max-width:32rem">
${rows.join("\n")}
<input type="text" name="website_url_confirm" value="" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">
<input type="hidden" name="_page" value="${fEsc(page)}">
${turnstileSitekey ? `<div class="cf-turnstile" data-sitekey="${fEsc(turnstileSitekey)}"></div>` : ""}
<p><button type="submit" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:0.6rem 1.4rem;font-size:1rem;cursor:pointer">Send</button></p>
</form>`
}

/** Replace <div class="form-embed" data-form="slug"></div> markers in post
 *  content with the rendered form. No markers = content untouched. */
export function injectFormEmbeds(html: string, forms: CmsForm[], config: SiteConfig, page: string): string {
  if (!html.includes("form-embed")) return html
  return html.replace(/<div class="form-embed" data-form="([a-z0-9-]+)"><\/div>/gi, (m, slug: string) => {
    const f = forms.find((x) => x.slug === slug)
    if (!f || !config.formsEndpoint) return ""
    const base = config.formsEndpoint.replace(/\/api\/saas\/forms\/.*$/, "")
    return renderCmsForm(f, `${base}/api/saas/form/${config.formsEndpoint.split("/").pop()}/${f.id}`, config.turnstileSitekey, page)
  })
}

// ─────────────── CTA blocks (V1.4 F3, template mirror) ───────────────
// Pure HTML/CSS, token-styled — mirrors src/modules/forms/hooks.ts.

const CTA_BTN = "display:inline-block;background:var(--accent);color:#fff;text-decoration:none;border-radius:8px;padding:0.7rem 1.4rem;font-weight:600"
const ctaEsc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] ?? c)

export function injectCtaBlocks(html: string): string {
  if (!html.includes("cta-block")) return html
  return html.replace(/<div class="cta-block" data-cta="([a-z]+)"([^>]*)><\/div>/gi, (m, kind: string, attrs: string) => {
    const attr = (name: string) => {
      const mm = new RegExp(`data-${name}="([^"]*)"`, "i").exec(attrs)
      return mm ? mm[1] : ""
    }
    const v = attr("value").trim()
    const label = attr("label")
    switch (kind) {
      case "whatsapp": {
        const url = `https://wa.me/${v.replace(/[^\d]/g, "")}${attr("prefill") ? `?text=${encodeURIComponent(attr("prefill"))}` : ""}`
        return `<p class="cta"><a href="${ctaEsc(url)}" rel="noopener" style="${CTA_BTN};background:#25d366">${ctaEsc(label || "Chat on WhatsApp")}</a></p>`
      }
      case "call": return `<p class="cta"><a href="tel:${ctaEsc(v.replace(/\s+/g, ""))}" style="${CTA_BTN}">${ctaEsc(label || "Call now")}</a></p>`
      case "email": return `<p class="cta"><a href="mailto:${ctaEsc(v)}" style="${CTA_BTN}">${ctaEsc(label || "Email us")}</a></p>`
      case "book": return `<p class="cta"><a href="${ctaEsc(v)}" rel="noopener" style="${CTA_BTN}">${ctaEsc(label || "Book a time")}</a></p>`
      case "download": return `<p class="cta"><a href="/forms/${ctaEsc(v)}/" style="${CTA_BTN}">${ctaEsc(label || "Get the download")}</a></p>`
      case "subscribe": return `<p class="cta"><a href="/forms/${ctaEsc(v)}/" style="${CTA_BTN}">${ctaEsc(label || "Subscribe")}</a></p>`
      default: return ""
    }
  })
}

// ─────────────── AI-SEO profile (V1.3 P5) — AEO blocks ───────────────
// Mirrors src/modules/seo/aeo.ts: content blocks are plain-HTML conventions
// (.aeo-tldr / .aeo-definition / .aeo-stat) turned into matching schema.

export interface AeoBlocks {
  tldr: string[]
  definitions: Array<{ term: string; definition: string }>
}

const AEO_STRIP = /<[^>]+>/g
const aeoText = (html: string) => html.replace(AEO_STRIP, " ").replace(/\s+/g, " ").trim()

export function extractAeoBlocks(html: string): AeoBlocks {
  const out: AeoBlocks = { tldr: [], definitions: [] }
  if (!html) return out
  const tldr = /<div class="aeo-tldr">([\s\S]*?)<\/div>/i.exec(html)
  if (tldr) {
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi
    let m: RegExpExecArray | null
    while ((m = liRe.exec(tldr[1])) !== null) out.tldr.push(aeoText(m[1]))
  }
  const defRe = /<div class="aeo-definition">([\s\S]*?)<\/div>/gi
  let d: RegExpExecArray | null
  while ((d = defRe.exec(html)) !== null) {
    const term = /<dfn[^>]*>([\s\S]*?)<\/dfn>/i.exec(d[1])
    if (!term) continue
    const full = aeoText(d[1])
    const termText = aeoText(term[1])
    const definition = full.startsWith(termText) ? full.slice(termText.length).replace(/^[\s—–:-]+/, "") : full
    if (termText && definition) out.definitions.push({ term: termText, definition })
  }
  return out
}

// ─────────────── Image SEO profile (V1.3 P4) ───────────────

/** Extract content image URLs from post HTML (absolute https only). */
export function contentImageUrls(html: string): string[] {
  const out: string[] = []
  const re = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (/^https:\/\//i.test(m[1]) && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

/** ImageObject node with license/creator (licensable-images eligibility).
 *  null when the license config is absent — byte-identical. */
export function imageObjectLd(imageUrl: string, s: SeoSettings): object | null {
  const lic = s.imageLicense
  if (!lic || (!lic.licenseUrl && !lic.acquireLicenseUrl && !lic.creatorName)) return null
  const node: Record<string, unknown> = { "@type": "ImageObject", contentUrl: imageUrl }
  if (lic.licenseUrl) node.license = lic.licenseUrl
  if (lic.acquireLicenseUrl) node.acquireLicensePage = lic.acquireLicenseUrl
  if (lic.creatorName) {
    node.creator = { "@type": "Person", name: lic.creatorName }
    node.creditText = lic.creatorName
    node.copyrightNotice = lic.creatorName
  }
  return node
}

// ─────────────── Ecommerce SEO profile (V1.3 P3) — merchant ───────────────

export interface MerchantExtras {
  config: {
    shippingRateCents?: number | null
    shippingCurrency?: string
    shipCountry?: string
    handlingDaysMax?: number | null
    transitDaysMax?: number | null
    returnDays?: number | null
    returnFees?: string
  } | null
  products: Array<{
    id: string; slug: string; brand: string | null; gtin: string | null
    mpn: string | null; condition: string | null
    ratingValue: number | null; ratingCount: number | null
  }>
}

let _merchantCache: MerchantExtras | null = null

/** Merchant config + per-product extras (memoized). Empty when the ecommerce
 *  profile is off — product pages keep today's exact base schema. */
export async function fetchMerchant(config: SiteConfig): Promise<MerchantExtras> {
  if (_merchantCache) return _merchantCache
  const key = process.env.CMS_API_KEY
  const settings = await fetchSeoSettings(config)
  if (!key || !profileOn(settings, "ecommerce")) return (_merchantCache = { config: null, products: [] })
  try {
    const resp = await fetch(`${config.cmsApiUrl}/merchant`, { headers: { Authorization: `Bearer ${key}` } })
    if (!resp.ok) return (_merchantCache = { config: null, products: [] })
    const data = (await resp.json()) as { config?: MerchantExtras["config"]; products?: MerchantExtras["products"] }
    _merchantCache = { config: data.config ?? null, products: Array.isArray(data.products) ? data.products : [] }
    return _merchantCache
  } catch {
    return (_merchantCache = { config: null, products: [] })
  }
}

const CONDITION_SCHEMA: Record<string, string> = {
  new: "https://schema.org/NewCondition",
  refurbished: "https://schema.org/RefurbishedCondition",
  used: "https://schema.org/UsedCondition",
}

/** Merchant-depth schema additions for one product (mirrors
 *  src/modules/seo/merchant.ts — only real values are emitted). */
export function merchantExtrasFor(m: MerchantExtras, productId: string): { product: Record<string, unknown>; offer: Record<string, unknown> } {
  const product: Record<string, unknown> = {}
  const offer: Record<string, unknown> = {}
  const x = m.products.find((p) => p.id === productId)
  const cfg = m.config
  if (x) {
    if (x.brand) product.brand = { "@type": "Brand", name: x.brand }
    if (x.gtin) product.gtin = x.gtin
    if (x.mpn) product.mpn = x.mpn
    if (x.ratingValue != null && x.ratingCount != null && x.ratingValue > 0 && x.ratingCount > 0) {
      product.aggregateRating = { "@type": "AggregateRating", ratingValue: x.ratingValue, reviewCount: x.ratingCount }
    }
    if (x.condition && CONDITION_SCHEMA[x.condition]) offer.itemCondition = CONDITION_SCHEMA[x.condition]
  }
  if (cfg && cfg.shippingRateCents != null) {
    offer.shippingDetails = {
      "@type": "OfferShippingDetails",
      shippingRate: { "@type": "MonetaryAmount", value: (cfg.shippingRateCents / 100).toFixed(2), currency: (cfg.shippingCurrency ?? "usd").toUpperCase() },
      shippingDestination: { "@type": "DefinedRegion", addressCountry: cfg.shipCountry ?? "US" },
      ...(cfg.handlingDaysMax != null && cfg.transitDaysMax != null
        ? { deliveryTime: { "@type": "ShippingDeliveryTime",
            handlingTime: { "@type": "QuantitativeValue", minValue: 0, maxValue: cfg.handlingDaysMax, unitCode: "DAY" },
            transitTime: { "@type": "QuantitativeValue", minValue: 1, maxValue: cfg.transitDaysMax, unitCode: "DAY" } } }
        : {}),
    }
  }
  if (cfg && cfg.returnDays != null) {
    offer.hasMerchantReturnPolicy = {
      "@type": "MerchantReturnPolicy",
      applicableCountry: cfg.shipCountry ?? "US",
      returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
      merchantReturnDays: cfg.returnDays,
      returnMethod: "https://schema.org/ReturnByMail",
      returnFees: cfg.returnFees === "free" ? "https://schema.org/FreeReturn" : "https://schema.org/ReturnShippingFees",
    }
  }
  return { product, offer }
}

// ─────────────── News SEO profile (V1.3 P2) — authors ───────────────

export interface CmsAuthor {
  id: string
  name: string
  slug: string
  bio: string
  photo: string
  sameAs: string[]
}

let _authorsCache: CmsAuthor[] | null = null

/** Fetch authors (memoized). [] on error or when none exist — byte-identical. */
export async function fetchAuthors(config: SiteConfig): Promise<CmsAuthor[]> {
  if (_authorsCache) return _authorsCache
  const key = process.env.CMS_API_KEY
  if (!key) return (_authorsCache = [])
  try {
    const resp = await fetch(`${config.cmsApiUrl}/authors`, { headers: { Authorization: `Bearer ${key}` } })
    if (!resp.ok) return (_authorsCache = [])
    const data = (await resp.json()) as { authors?: CmsAuthor[] }
    _authorsCache = Array.isArray(data.authors) ? data.authors : []
    return _authorsCache
  } catch {
    return (_authorsCache = [])
  }
}

/** Person JSON-LD for an author page/byline. */
export function personLd(a: CmsAuthor, siteUrl: string): object {
  const node: Record<string, unknown> = {
    "@type": "Person",
    "@id": `${siteUrl}authors/${a.slug}/#person`,
    name: a.name,
    url: `${siteUrl}authors/${a.slug}/`,
  }
  if (a.bio) node.description = a.bio
  if (a.photo) node.image = a.photo
  if (a.sameAs.length) node.sameAs = a.sameAs
  return node
}

// ─────────────── Local SEO profile (V1.3 P1) ───────────────

export interface BusinessLocation {
  id: string
  name: string
  subtype: string
  street: string; city: string; region: string; postal: string; country: string
  phone: string
  hours: { weekly: Record<string, string | null>; holidays: Array<{ date: string; hours: string | null }> }
  latitude: number | null
  longitude: number | null
  serviceAreas: string[]
  priceRange: string
  gbpUrl: string
  ratingValue: number | null
  ratingCount: number | null
  isPrimary: boolean
  slug: string
}

let _locationsCache: BusinessLocation[] | null = null

/** Fetch business locations (memoized). Best-effort: [] on any error, and []
 *  when the Local profile is off — byte-identical builds either way. */
export async function fetchLocations(config: SiteConfig): Promise<BusinessLocation[]> {
  if (_locationsCache) return _locationsCache
  const key = process.env.CMS_API_KEY
  const settings = await fetchSeoSettings(config)
  if (!key || !profileOn(settings, "local")) return (_locationsCache = [])
  try {
    const resp = await fetch(`${config.cmsApiUrl}/local`, { headers: { Authorization: `Bearer ${key}` } })
    if (!resp.ok) return (_locationsCache = [])
    const data = (await resp.json()) as { locations?: BusinessLocation[] }
    _locationsCache = Array.isArray(data.locations) ? data.locations : []
    return _locationsCache
  } catch {
    return (_locationsCache = [])
  }
}

const DAY_SCHEMA: Record<string, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday",
}

/** LocalBusiness JSON-LD node (mirrors src/modules/seo/local.ts — required
 *  name + address/areaServed; honest ratings only). Null when incomplete. */
export function localBusinessLd(loc: BusinessLocation, siteUrl: string, pageUrl: string): object | null {
  const hasAddress = !!(loc.street && loc.city)
  const hasArea = loc.serviceAreas.length > 0
  if (!loc.name || (!hasAddress && !hasArea)) return null
  const node: Record<string, unknown> = {
    "@type": loc.subtype || "LocalBusiness",
    "@id": `${pageUrl}#business`,
    name: loc.name,
    url: siteUrl,
  }
  if (hasAddress) {
    node.address = {
      "@type": "PostalAddress",
      streetAddress: loc.street, addressLocality: loc.city,
      ...(loc.region ? { addressRegion: loc.region } : {}),
      ...(loc.postal ? { postalCode: loc.postal } : {}),
      ...(loc.country ? { addressCountry: loc.country } : {}),
    }
  }
  if (hasArea) node.areaServed = loc.serviceAreas.map((a) => ({ "@type": "Place", name: a }))
  if (loc.phone) node.telephone = loc.phone
  if (loc.latitude != null && loc.longitude != null) node.geo = { "@type": "GeoCoordinates", latitude: loc.latitude, longitude: loc.longitude }
  const spans = new Map<string, string[]>()
  for (const [d, span] of Object.entries(loc.hours?.weekly ?? {})) {
    if (!span || !DAY_SCHEMA[d]) continue
    const list = spans.get(span) ?? []
    list.push(DAY_SCHEMA[d])
    spans.set(span, list)
  }
  const spec: object[] = []
  for (const [span, days] of spans) {
    const [opens, closes] = span.split("-")
    spec.push({ "@type": "OpeningHoursSpecification", dayOfWeek: days, opens, closes })
  }
  for (const h of loc.hours?.holidays ?? []) {
    if (h.hours) { const [opens, closes] = h.hours.split("-"); spec.push({ "@type": "OpeningHoursSpecification", validFrom: h.date, validThrough: h.date, opens, closes }) }
    else spec.push({ "@type": "OpeningHoursSpecification", validFrom: h.date, validThrough: h.date, opens: "00:00", closes: "00:00" })
  }
  if (spec.length) node.openingHoursSpecification = spec
  if (loc.priceRange) node.priceRange = loc.priceRange
  if (loc.gbpUrl) node.sameAs = [loc.gbpUrl]
  if (loc.ratingValue != null && loc.ratingCount != null && loc.ratingValue > 0 && loc.ratingCount > 0) {
    node.aggregateRating = { "@type": "AggregateRating", ratingValue: loc.ratingValue, reviewCount: loc.ratingCount }
  }
  return node
}

/** Static OSM map image URL (no JS map — covenant P1). */
export function staticMapUrlFor(loc: BusinessLocation, w = 600, h = 300): string | null {
  if (loc.latitude == null || loc.longitude == null) return null
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${loc.latitude},${loc.longitude}&zoom=15&size=${w}x${h}&markers=${loc.latitude},${loc.longitude},red-pushpin`
}

/** The address/NAP block HTML shared by contact + location pages. */
export function napBlockHtml(loc: BusinessLocation): string {
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] ?? c)
  const lines: string[] = [`<p><strong>${esc(loc.name)}</strong></p>`]
  if (loc.street && loc.city) {
    lines.push(`<p>${esc(loc.street)}<br>${esc([loc.city, loc.region, loc.postal].filter(Boolean).join(", "))}</p>`)
  }
  if (loc.phone) lines.push(`<p>Phone: <a href="tel:${esc(loc.phone.replace(/\s+/g, ""))}">${esc(loc.phone)}</a></p>`)
  if (loc.serviceAreas.length) lines.push(`<p>Serving: ${esc(loc.serviceAreas.join(", "))}</p>`)
  const days: Array<[string, string]> = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]]
  const hourRows = days
    .map(([k, label]) => {
      const span = loc.hours?.weekly?.[k]
      return span ? `<tr><td>${label}</td><td>${esc(span)}</td></tr>` : null
    })
    .filter(Boolean)
  if (hourRows.length) lines.push(`<h3>Opening hours</h3><table>${hourRows.join("")}</table>`)
  const map = staticMapUrlFor(loc)
  if (map) lines.push(`<p><img src="${map}" alt="Map showing the location of ${esc(loc.name)}" width="600" height="300" loading="lazy"></p>`)
  if (loc.gbpUrl) lines.push(`<p><a href="${esc(loc.gbpUrl)}" rel="noopener">Find us on Google</a></p>`)
  return lines.join("\n")
}

let _seoSettingsCache: SeoSettings | null = null

/** Load the site's SEO settings once (memoized). Best-effort: any error → the
 *  defaults, so the build proceeds exactly as before. */
export async function fetchSeoSettings(config: SiteConfig): Promise<SeoSettings> {
  if (_seoSettingsCache) return _seoSettingsCache
  const key = process.env.CMS_API_KEY
  if (!key) return (_seoSettingsCache = SEO_SETTINGS_DEFAULTS)
  try {
    const resp = await fetch(`${config.cmsApiUrl}/seo-settings`, { headers: { Authorization: `Bearer ${key}` } })
    if (!resp.ok) return (_seoSettingsCache = SEO_SETTINGS_DEFAULTS)
    const data = (await resp.json()) as { settings?: Partial<SeoSettings> }
    _seoSettingsCache = { ...SEO_SETTINGS_DEFAULTS, ...(data.settings ?? {}) }
    return _seoSettingsCache
  } catch {
    return (_seoSettingsCache = SEO_SETTINGS_DEFAULTS)
  }
}

/** Global Organization + WebSite JSON-LD, or null when disabled (byte-identical
 *  default). Mirrors src/modules/seo/settings.ts globalSchema(). */
export function globalSchemaFor(s: SeoSettings, siteName: string, siteUrl: string): object | null {
  if (!s.globalSchemaEnabled) return null
  const org: Record<string, unknown> = { "@type": "Organization", name: s.orgName.trim() || siteName, url: siteUrl }
  if (s.orgLogo.trim()) org.logo = s.orgLogo.trim()
  const profiles = s.socialProfiles.map((p) => p.trim()).filter(Boolean)
  if (profiles.length) org.sameAs = profiles
  return { "@context": "https://schema.org", "@graph": [org, { "@type": "WebSite", name: siteName, url: siteUrl }] }
}

export function canonicalHost(config: SiteConfig): string {
  return config.canonicalHost === "www" ? `www.${config.domain}` : config.domain
}

/** Fetch all published posts (paged). Fails the build loudly on API errors —
 *  a silent empty site is worse than a red build. */
export async function fetchAllPosts(config: SiteConfig): Promise<CmsPost[]> {
  const key = process.env.CMS_API_KEY
  if (!key) throw new Error("CMS_API_KEY is not set (repo Actions secret)")
  const out: CmsPost[] = []
  const limit = 100
  for (let offset = 0; ; offset += limit) {
    const resp = await fetch(`${config.cmsApiUrl}/posts?limit=${limit}&offset=${offset}&published=true&type=post`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!resp.ok) throw new Error(`CMS API returned ${resp.status} — check CMS_API_KEY and cmsApiUrl`)
    const data = (await resp.json()) as {
      posts: Array<{
        id: string; title: string; slug: string; content?: string; excerpt?: string | null
        coverImage?: string | null; publishedAt?: string | null; updatedAt?: string | null
        category?: { slug: string; name: string } | null
        seoTitle?: string | null; seoDescription?: string | null
        noIndex?: boolean; canonicalUrl?: string | null
        ogTitle?: string | null; ogDescription?: string | null; ogImage?: string | null
      }>
      total: number
    }
    for (const p of data.posts) {
      out.push({
        id: p.id,
        title: p.title,
        slug: p.slug,
        content: p.content ?? "",
        excerpt: p.excerpt ?? null,
        coverImage: p.coverImage ?? null,
        publishedAt: p.publishedAt ?? null,
        updatedAt: p.updatedAt ?? null,
        category: p.category ?? null,
        seoTitle: p.seoTitle ?? null,
        seoDescription: p.seoDescription ?? null,
        noIndex: p.noIndex ?? false,
        canonicalUrl: p.canonicalUrl ?? null,
        ogTitle: p.ogTitle ?? null,
        ogDescription: p.ogDescription ?? null,
        ogImage: p.ogImage ?? null,
      })
    }
    if (out.length >= data.total || data.posts.length < limit) break
  }
  // Merge V1.2 SEO override fields not carried by the frozen /v1/posts shape.
  await mergeSeoOverrides(config, out)
  return out
}

/** Fetch per-post SEO overrides from the additive /v1/seo endpoint and merge by
 *  id. Best-effort: on any error the site builds exactly as before (defaults). */
async function mergeSeoOverrides(config: SiteConfig, posts: CmsPost[]): Promise<void> {
  const key = process.env.CMS_API_KEY
  if (!key || posts.length === 0) return
  try {
    const resp = await fetch(`${config.cmsApiUrl}/seo`, { headers: { Authorization: `Bearer ${key}` } })
    if (!resp.ok) return
    const data = (await resp.json()) as { seo?: Array<{ id: string; nofollow?: boolean; schemaType?: string | null; faq?: Array<{ question: string; answer: string }> | null; authorId?: string | null; llmsExclude?: boolean; focusKeyword?: string | null }> }
    const byId = new Map((data.seo ?? []).map((s) => [s.id, s]))
    for (const p of posts) {
      const o = byId.get(p.id)
      if (!o) continue
      p.nofollow = o.nofollow ?? false
      p.schemaType = o.schemaType ?? null
      p.faq = o.faq ?? null
      p.authorId = o.authorId ?? null
      p.llmsExclude = o.llmsExclude ?? false
      p.focusKeyword = o.focusKeyword ?? null
    }
  } catch {
    // absent overrides = today's output
  }
}

/** Fetch all published products (ecommerce sites). Empty for non-store sites. */
export async function fetchAllProducts(config: SiteConfig): Promise<CmsProduct[]> {
  if (config.kind !== "ecommerce") return []
  const key = process.env.CMS_API_KEY
  if (!key) throw new Error("CMS_API_KEY is not set (repo Actions secret)")
  const out: CmsProduct[] = []
  const limit = 100
  for (let offset = 0; ; offset += limit) {
    const resp = await fetch(`${config.cmsApiUrl}/products?limit=${limit}&offset=${offset}&published=true`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!resp.ok) throw new Error(`CMS API /products returned ${resp.status}`)
    const data = (await resp.json()) as { products: CmsProduct[]; total: number }
    for (const p of data.products) out.push(p)
    if (out.length >= data.total || data.products.length < limit) break
  }
  return out
}

/** Money formatter for display (cents → localized currency string). */
export function formatPrice(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`
  }
}

export interface FaqPair {
  question: string
  answer: string
}

const STRIP_TAGS = /<[^>]+>/g
function textOf(html: string): string {
  return html.replace(STRIP_TAGS, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
}

const QUESTION_WORDS = /^(how|what|why|when|where|which|who|can|do|does|is|are|should|will)\b/i

/**
 * Extract question/answer pairs from post HTML for FAQPage JSON-LD (K8/AEO):
 * an h2/h3 phrased as a question, followed by the text up to the next heading.
 * Best-effort and defensive — returns [] on anything unexpected.
 */
export function extractFaqs(html: string): FaqPair[] {
  if (!html) return []
  const pairs: FaqPair[] = []
  // Split on h2/h3 boundaries, keeping the heading text.
  const re = /<h[23][^>]*>([\s\S]*?)<\/h[23]>([\s\S]*?)(?=<h[23][^>]*>|$)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const q = textOf(m[1])
    const a = textOf(m[2])
    const isQuestion = q.endsWith("?") || QUESTION_WORDS.test(q)
    if (isQuestion && q.length <= 200 && a.length >= 20) {
      pairs.push({ question: q, answer: a.slice(0, 600) })
    }
  }
  return pairs
}
