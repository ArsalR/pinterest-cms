// Google Merchant Center product feed (V1.3 Ecommerce SEO profile) — built on
// every deploy at the stable URL /feed.xml for the customer to submit in
// Merchant Center. Emitted ONLY when the ecommerce profile is on — 404 (no
// file) otherwise, keeping other sites byte-identical. Mirrors
// src/modules/seo/merchant.ts buildMerchantFeed.
import type { APIRoute } from "astro"
import { loadConfig, fetchAllProducts, fetchSeoSettings, fetchMerchant, canonicalHost, profileOn } from "../lib/cms"

function esc(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c)
}
const COND: Record<string, string> = { new: "new", refurbished: "refurbished", used: "used" }

export const GET: APIRoute = async () => {
  const config = loadConfig()
  const settings = await fetchSeoSettings(config)
  if (!profileOn(settings, "ecommerce")) return new Response(null, { status: 404 })

  const host = canonicalHost(config)
  const products = await fetchAllProducts(config)
  const merchant = await fetchMerchant(config)
  const extrasById = new Map(merchant.products.map((p) => [p.id, p]))

  const items = products
    .map((p) => {
      const x = extrasById.get(p.id)
      const lines = [
        `      <g:id>${esc(p.id)}</g:id>`,
        `      <g:title>${esc(p.title)}</g:title>`,
        `      <g:description>${esc(p.seoDescription ?? p.description ?? p.title)}</g:description>`,
        `      <g:link>https://${host}/products/${esc(p.slug)}/</g:link>`,
        p.images[0] ? `      <g:image_link>${esc(p.images[0])}</g:image_link>` : null,
        `      <g:price>${(p.priceCents / 100).toFixed(2)} ${p.currency.toUpperCase()}</g:price>`,
        `      <g:availability>${p.stockStatus === "in_stock" ? "in_stock" : "out_of_stock"}</g:availability>`,
        `      <g:condition>${COND[x?.condition ?? "new"] ?? "new"}</g:condition>`,
        x?.brand ? `      <g:brand>${esc(x.brand)}</g:brand>` : null,
        x?.gtin ? `      <g:gtin>${esc(x.gtin)}</g:gtin>` : null,
        x?.mpn ? `      <g:mpn>${esc(x.mpn)}</g:mpn>` : null,
        !x?.gtin && !x?.brand ? `      <g:identifier_exists>false</g:identifier_exists>` : null,
      ].filter(Boolean)
      return `    <item>\n${lines.join("\n")}\n    </item>`
    })
    .join("\n")

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${esc(config.name)}</title>
    <link>https://${host}/</link>
    <description>Product feed for ${esc(config.name)}</description>
${items}
  </channel>
</rss>
`
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } })
}
