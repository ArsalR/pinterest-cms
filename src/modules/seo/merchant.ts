// src/modules/seo/merchant.ts
// Ecommerce SEO profile (V1.3 P3) — PURE builders, verified against Google's
// merchant-listing structured-data docs: Product name/image/offers required;
// OfferShippingDetails (shippingRate + deliveryTime) and MerchantReturnPolicy
// (returnPolicyCategory + merchantReturnDays) unlock the shipping/returns
// annotations. Plus the Google Merchant Center RSS 2.0 product feed. No I/O.

export interface MerchantConfig {
  /** Flat shipping rate in minor units; null = shipping details omitted. */
  shippingRateCents: number | null
  shippingCurrency: string
  /** Country the policy applies to (ISO 3166-1 alpha-2). */
  shipCountry: string
  handlingDaysMax: number | null
  transitDaysMax: number | null
  /** Days to return; null = return policy omitted. */
  returnDays: number | null
  /** "free" | "customer" — who pays return shipping. */
  returnFees: string
}

export const DEFAULT_MERCHANT_CONFIG: MerchantConfig = {
  shippingRateCents: null,
  shippingCurrency: "usd",
  shipCountry: "US",
  handlingDaysMax: null,
  transitDaysMax: null,
  returnDays: null,
  returnFees: "customer",
}

/** Parse the stored merchant JSON; junk → defaults (everything omitted). Pure. */
export function parseMerchantConfig(raw: unknown): MerchantConfig {
  if (typeof raw !== "string" || !raw.trim()) return { ...DEFAULT_MERCHANT_CONFIG }
  try {
    const o = JSON.parse(raw) as Partial<MerchantConfig>
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null)
    return {
      shippingRateCents: num(o.shippingRateCents),
      shippingCurrency: typeof o.shippingCurrency === "string" && o.shippingCurrency ? o.shippingCurrency : "usd",
      shipCountry: typeof o.shipCountry === "string" && /^[A-Z]{2}$/i.test(o.shipCountry) ? o.shipCountry.toUpperCase() : "US",
      handlingDaysMax: num(o.handlingDaysMax),
      transitDaysMax: num(o.transitDaysMax),
      returnDays: num(o.returnDays),
      returnFees: o.returnFees === "free" ? "free" : "customer",
    }
  } catch {
    return { ...DEFAULT_MERCHANT_CONFIG }
  }
}

export interface MerchantProduct {
  id: string
  slug: string
  title: string
  description: string
  priceCents: number
  currency: string
  images: string[]
  sku: string | null
  inStock: boolean
  brand: string | null
  gtin: string | null
  mpn: string | null
  condition: string | null // new | refurbished | used
  ratingValue: number | null
  ratingCount: number | null
}

const CONDITION_SCHEMA: Record<string, string> = {
  new: "https://schema.org/NewCondition",
  refurbished: "https://schema.org/RefurbishedCondition",
  used: "https://schema.org/UsedCondition",
}
const CONDITION_FEED: Record<string, string> = { new: "new", refurbished: "refurbished", used: "used" }

/** Merchant-depth additions for a product's JSON-LD Offer + Product node.
 *  Only fields with real values are emitted (additive to the existing base
 *  schema — absent = today's markup exactly). Pure. */
export function merchantSchemaExtras(p: MerchantProduct, cfg: MerchantConfig): { product: Record<string, unknown>; offer: Record<string, unknown> } {
  const product: Record<string, unknown> = {}
  const offer: Record<string, unknown> = {}
  if (p.brand) product.brand = { "@type": "Brand", name: p.brand }
  if (p.gtin) product.gtin = p.gtin
  if (p.mpn) product.mpn = p.mpn
  if (p.ratingValue != null && p.ratingCount != null && p.ratingValue > 0 && p.ratingCount > 0) {
    product.aggregateRating = { "@type": "AggregateRating", ratingValue: p.ratingValue, reviewCount: p.ratingCount }
  }
  if (p.condition && CONDITION_SCHEMA[p.condition]) offer.itemCondition = CONDITION_SCHEMA[p.condition]
  if (cfg.shippingRateCents != null) {
    offer.shippingDetails = {
      "@type": "OfferShippingDetails",
      shippingRate: {
        "@type": "MonetaryAmount",
        value: (cfg.shippingRateCents / 100).toFixed(2),
        currency: cfg.shippingCurrency.toUpperCase(),
      },
      shippingDestination: { "@type": "DefinedRegion", addressCountry: cfg.shipCountry },
      ...(cfg.handlingDaysMax != null && cfg.transitDaysMax != null
        ? {
            deliveryTime: {
              "@type": "ShippingDeliveryTime",
              handlingTime: { "@type": "QuantitativeValue", minValue: 0, maxValue: cfg.handlingDaysMax, unitCode: "DAY" },
              transitTime: { "@type": "QuantitativeValue", minValue: 1, maxValue: cfg.transitDaysMax, unitCode: "DAY" },
            },
          }
        : {}),
    }
  }
  if (cfg.returnDays != null) {
    offer.hasMerchantReturnPolicy = {
      "@type": "MerchantReturnPolicy",
      applicableCountry: cfg.shipCountry,
      returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
      merchantReturnDays: cfg.returnDays,
      returnMethod: "https://schema.org/ReturnByMail",
      returnFees: cfg.returnFees === "free" ? "https://schema.org/FreeReturn" : "https://schema.org/ReturnShippingFees",
    }
  }
  return { product, offer }
}

function xmlEsc(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c)
}

/** Google Merchant Center product feed (RSS 2.0, g: namespace) — generated at
 *  build, served at a stable URL for the customer to submit. Pure. */
export function buildMerchantFeed(siteName: string, siteUrl: string, products: MerchantProduct[]): string {
  const items = products
    .map((p) => {
      const lines = [
        `      <g:id>${xmlEsc(p.id)}</g:id>`,
        `      <g:title>${xmlEsc(p.title)}</g:title>`,
        `      <g:description>${xmlEsc(p.description || p.title)}</g:description>`,
        `      <g:link>${xmlEsc(`${siteUrl}products/${p.slug}/`)}</g:link>`,
        p.images[0] ? `      <g:image_link>${xmlEsc(p.images[0])}</g:image_link>` : null,
        `      <g:price>${(p.priceCents / 100).toFixed(2)} ${p.currency.toUpperCase()}</g:price>`,
        `      <g:availability>${p.inStock ? "in_stock" : "out_of_stock"}</g:availability>`,
        `      <g:condition>${CONDITION_FEED[p.condition ?? "new"] ?? "new"}</g:condition>`,
        p.brand ? `      <g:brand>${xmlEsc(p.brand)}</g:brand>` : null,
        p.gtin ? `      <g:gtin>${xmlEsc(p.gtin)}</g:gtin>` : null,
        p.mpn ? `      <g:mpn>${xmlEsc(p.mpn)}</g:mpn>` : null,
        !p.gtin && !p.brand ? `      <g:identifier_exists>false</g:identifier_exists>` : null,
      ].filter(Boolean)
      return `    <item>\n${lines.join("\n")}\n    </item>`
    })
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${xmlEsc(siteName)}</title>
    <link>${xmlEsc(siteUrl)}</link>
    <description>Product feed for ${xmlEsc(siteName)}</description>
${items}
  </channel>
</rss>
`
}
