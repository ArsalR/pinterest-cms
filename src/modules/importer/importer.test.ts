// src/modules/importer/importer.test.ts
// Pure-logic: the WXR parser (K9). Writing drafts into a CMS DB is I/O and
// belongs to Phase-10 mocked-integration tests.

import { describe, it, expect } from "vitest"
import {
  parseWxr, parseRestPosts, tagText, slugify,
  originalPath, extractImageUrls, rewriteImageUrls,
  postMeta, extractSeoMeta,
} from "./wordpress"
import { isZip, listZipEntries, extractWxrFromZip } from "./backup"

const WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/">
<channel>
  <item>
    <title>Hello World</title>
    <link>https://old.example/hello-world/</link>
    <content:encoded><![CDATA[<p>Body of the <strong>post</strong>.</p>]]></content:encoded>
    <excerpt:encoded><![CDATA[A short summary.]]></excerpt:encoded>
    <wp:post_name><![CDATA[hello-world]]></wp:post_name>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_type><![CDATA[post]]></wp:post_type>
    <wp:post_date_gmt><![CDATA[2024-03-01 12:00:00]]></wp:post_date_gmt>
    <category domain="category" nicename="news"><![CDATA[News]]></category>
    <category domain="post_tag" nicename="misc"><![CDATA[misc]]></category>
  </item>
  <item>
    <title>About</title>
    <content:encoded><![CDATA[<p>About page.</p>]]></content:encoded>
    <wp:post_type><![CDATA[page]]></wp:post_type>
    <wp:status><![CDATA[publish]]></wp:status>
  </item>
  <item>
    <title>Draft Post &amp; Notes</title>
    <content:encoded><![CDATA[<p>Draft body long enough.</p>]]></content:encoded>
    <wp:post_type><![CDATA[post]]></wp:post_type>
    <wp:status><![CDATA[draft]]></wp:status>
  </item>
</channel></rss>`

describe("parseWxr (K9 WordPress import)", () => {
  it("extracts posts and skips non-post items", () => {
    const { posts, skipped } = parseWxr(WXR)
    expect(posts).toHaveLength(2)          // the two 'post' items
    expect(skipped).toBe(1)                // the 'page'
    expect(posts.every((p) => p.type === "post")).toBe(true)
  })

  it("includes Pages (tagged type:'page') when opted in", () => {
    const { posts, skipped } = parseWxr(WXR, { includePages: true })
    expect(posts).toHaveLength(3)          // two posts + the About page
    expect(skipped).toBe(0)
    const about = posts.find((p) => p.title === "About")!
    expect(about.type).toBe("page")
    expect(about.slug).toBe("about")       // slugified fallback (no wp:post_name)
    expect(about.status).toBe("publish")
  })

  it("maps fields including CDATA content, excerpt, slug, status, date", () => {
    const { posts } = parseWxr(WXR)
    const p = posts[0]
    expect(p.title).toBe("Hello World")
    expect(p.slug).toBe("hello-world")
    expect(p.contentHtml).toContain("<strong>post</strong>")
    expect(p.excerpt).toBe("A short summary.")
    expect(p.status).toBe("publish")
    expect(p.publishedAt).toBe("2024-03-01T12:00:00.000Z")
  })

  it("keeps only category-domain terms, not tags", () => {
    const { posts } = parseWxr(WXR)
    expect(posts[0].categories).toEqual(["News"])
  })

  it("decodes entities in a title and falls back to a slug when post_name is absent", () => {
    const { posts } = parseWxr(WXR)
    const draft = posts[1]
    expect(draft.title).toBe("Draft Post & Notes")
    expect(draft.slug).toBe("draft-post-notes") // slugified fallback
  })

  it("returns empty (never throws) on junk input", () => {
    expect(parseWxr("not xml at all")).toEqual({ posts: [], skipped: 0 })
  })
})

// ─────────────────────── Yoast / Rank Math SEO mapping (S2) ───────────────────────

const YOAST_ITEM = `<rss xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item>
  <title>Yoast Post</title>
  <content:encoded><![CDATA[<p>Body content here.</p>]]></content:encoded>
  <wp:post_name><![CDATA[yoast-post]]></wp:post_name>
  <wp:post_type><![CDATA[post]]></wp:post_type>
  <wp:postmeta><wp:meta_key><![CDATA[_yoast_wpseo_title]]></wp:meta_key><wp:meta_value><![CDATA[Custom SEO Title]]></wp:meta_value></wp:postmeta>
  <wp:postmeta><wp:meta_key><![CDATA[_yoast_wpseo_metadesc]]></wp:meta_key><wp:meta_value><![CDATA[A tuned meta description.]]></wp:meta_value></wp:postmeta>
  <wp:postmeta><wp:meta_key><![CDATA[_yoast_wpseo_focuskw]]></wp:meta_key><wp:meta_value><![CDATA[espresso]]></wp:meta_value></wp:postmeta>
  <wp:postmeta><wp:meta_key><![CDATA[_yoast_wpseo_canonical]]></wp:meta_key><wp:meta_value><![CDATA[https://example.com/canonical/]]></wp:meta_value></wp:postmeta>
  <wp:postmeta><wp:meta_key><![CDATA[_yoast_wpseo_meta-robots-noindex]]></wp:meta_key><wp:meta_value><![CDATA[1]]></wp:meta_value></wp:postmeta>
  <wp:postmeta><wp:meta_key><![CDATA[_yoast_wpseo_opengraph-title]]></wp:meta_key><wp:meta_value><![CDATA[OG Title]]></wp:meta_value></wp:postmeta>
</item></channel></rss>`

const RANKMATH_ITEM = `<rss xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item>
  <title>Rank Post</title>
  <content:encoded><![CDATA[<p>Body content here.</p>]]></content:encoded>
  <wp:post_name><![CDATA[rank-post]]></wp:post_name>
  <wp:post_type><![CDATA[post]]></wp:post_type>
  <wp:postmeta><wp:meta_key><![CDATA[rank_math_title]]></wp:meta_key><wp:meta_value><![CDATA[RM SEO Title]]></wp:meta_value></wp:postmeta>
  <wp:postmeta><wp:meta_key><![CDATA[rank_math_description]]></wp:meta_key><wp:meta_value><![CDATA[RM meta description.]]></wp:meta_value></wp:postmeta>
  <wp:postmeta><wp:meta_key><![CDATA[rank_math_robots]]></wp:meta_key><wp:meta_value><![CDATA[a:2:{i:0;s:7:"noindex";i:1;s:8:"nofollow";}]]></wp:meta_value></wp:postmeta>
  <wp:postmeta><wp:meta_key><![CDATA[rank_math_canonical_url]]></wp:meta_key><wp:meta_value><![CDATA[https://example.com/rm/]]></wp:meta_value></wp:postmeta>
</item></channel></rss>`

describe("extractSeoMeta (Yoast / Rank Math)", () => {
  it("parses all postmeta pairs into a map", () => {
    const m = postMeta(YOAST_ITEM)
    expect(m.get("_yoast_wpseo_title")).toBe("Custom SEO Title")
    expect(m.get("_yoast_wpseo_meta-robots-noindex")).toBe("1")
  })

  it("maps Yoast meta onto the normalized shape", () => {
    const seo = extractSeoMeta(postMeta(YOAST_ITEM))!
    expect(seo.source).toBe("yoast")
    expect(seo.seoTitle).toBe("Custom SEO Title")
    expect(seo.seoDescription).toBe("A tuned meta description.")
    expect(seo.focusKeyword).toBe("espresso")
    expect(seo.canonicalUrl).toBe("https://example.com/canonical/")
    expect(seo.noindex).toBe(true)
    expect(seo.ogTitle).toBe("OG Title")
    expect(seo.nofollow).toBeUndefined()
  })

  it("maps Rank Math meta incl. serialized robots array", () => {
    const seo = extractSeoMeta(postMeta(RANKMATH_ITEM))!
    expect(seo.source).toBe("rankmath")
    expect(seo.seoTitle).toBe("RM SEO Title")
    expect(seo.noindex).toBe(true)
    expect(seo.nofollow).toBe(true)
    expect(seo.canonicalUrl).toBe("https://example.com/rm/")
  })

  it("returns undefined when neither plugin left meta (plain export = today)", () => {
    expect(extractSeoMeta(new Map())).toBeUndefined()
    expect(extractSeoMeta(new Map([["some_other_key", "x"]]))).toBeUndefined()
  })

  it("parseWxr attaches seo meta to the post", () => {
    const { posts } = parseWxr(YOAST_ITEM)
    expect(posts[0].seo?.seoTitle).toBe("Custom SEO Title")
  })
})

// ─────────────────────── .zip backup extraction (K9 extension) ───────────────────────

const SMALL_WXR = `<?xml version="1.0"?><rss xmlns:wp="http://wordpress.org/export/1.2/"><channel><item><title>Zipped</title><wp:post_type>post</wp:post_type><wp:post_name>zipped</wp:post_name></item></channel></rss>`

function u16(n: number): number[] { return [n & 0xff, (n >> 8) & 0xff] }
function u32(n: number): number[] { return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff] }

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const src = new ReadableStream<Uint8Array>({ start(ctrl) { ctrl.enqueue(bytes); ctrl.close() } })
  const cs = new CompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
  return new Uint8Array(await new Response(src.pipeThrough(cs)).arrayBuffer())
}

/** Build a minimal ZIP (local headers only — enough for the front-walking
 *  reader) from {name, text, method} entries. method 0 = stored, 8 = deflate. */
async function buildZip(entries: Array<{ name: string; text: string; method: 0 | 8 }>): Promise<Uint8Array> {
  const out: number[] = []
  for (const e of entries) {
    const nameBytes = [...new TextEncoder().encode(e.name)]
    const raw = new TextEncoder().encode(e.text)
    const data = e.method === 8 ? await deflateRaw(raw) : raw
    out.push(...u32(0x04034b50))        // local file header signature
    out.push(...u16(20), ...u16(0))     // version, flags
    out.push(...u16(e.method))          // compression method
    out.push(...u16(0), ...u16(0))      // mod time, date
    out.push(...u32(0))                 // crc32 (ignored by the reader)
    out.push(...u32(data.length))       // compressed size
    out.push(...u32(raw.length))        // uncompressed size
    out.push(...u16(nameBytes.length), ...u16(0)) // name len, extra len
    out.push(...nameBytes)
    out.push(...data)
  }
  return new Uint8Array(out)
}

describe("zip backup extraction", () => {
  it("isZip detects the PK signature", async () => {
    const zip = await buildZip([{ name: "x.xml", text: SMALL_WXR, method: 0 }])
    expect(isZip(zip)).toBe(true)
    expect(isZip(new TextEncoder().encode("<?xml"))).toBe(false)
  })

  it("lists entries by walking local headers", async () => {
    const zip = await buildZip([
      { name: "readme.txt", text: "hi", method: 0 },
      { name: "export.xml", text: SMALL_WXR, method: 0 },
    ])
    const names = listZipEntries(zip).map((e) => e.name)
    expect(names).toEqual(["readme.txt", "export.xml"])
  })

  it("extracts a stored WXR .xml", async () => {
    const zip = await buildZip([{ name: "export.xml", text: SMALL_WXR, method: 0 }])
    const wxr = await extractWxrFromZip(zip)
    expect(wxr).not.toBeNull()
    expect(parseWxr(wxr!).posts[0].title).toBe("Zipped")
  })

  it("inflates a deflated WXR .xml", async () => {
    const zip = await buildZip([{ name: "wp/export.xml", text: SMALL_WXR, method: 8 }])
    const wxr = await extractWxrFromZip(zip)
    expect(wxr).not.toBeNull()
    expect(wxr!).toContain("<wp:post_type>")
  })

  it("returns null for a backup with no WXR (e.g. a SQL dump)", async () => {
    const zip = await buildZip([{ name: "db.sql", text: "CREATE TABLE wp_posts (...);", method: 0 }])
    expect(await extractWxrFromZip(zip)).toBeNull()
  })

  it("picks the WXR even when a non-WXR .xml is also present", async () => {
    const zip = await buildZip([
      { name: "sitemap.xml", text: "<urlset><url><loc>x</loc></url></urlset>", method: 0 },
      { name: "content.xml", text: SMALL_WXR, method: 0 },
    ])
    const wxr = await extractWxrFromZip(zip)
    expect(wxr).not.toBeNull()
    expect(wxr!).toContain("Zipped")
  })
})

describe("helpers", () => {
  it("tagText unwraps CDATA and decodes entities", () => {
    expect(tagText("<title><![CDATA[Raw <b>x</b>]]></title>", "title")).toBe("Raw <b>x</b>")
    expect(tagText("<title>A &amp; B</title>", "title")).toBe("A & B")
  })
  it("slugify normalizes to url-safe", () => {
    expect(slugify("Hello, World!")).toBe("hello-world")
    expect(slugify("")).toBe("post")
  })
})

describe("WXR captures the old permalink for redirects", () => {
  it("sets originalUrl from <link>", () => {
    const { posts } = parseWxr(WXR)
    expect(posts[0].originalUrl).toBe("https://old.example/hello-world/")
  })
})

describe("parseRestPosts (REST API import)", () => {
  const rest = [
    {
      slug: "rest-post",
      status: "publish",
      link: "https://old.example/2024/rest-post/",
      date_gmt: "2024-05-02T09:00:00",
      title: { rendered: "REST &amp; Friends" },
      content: { rendered: "<p>Body from REST.</p>" },
      excerpt: { rendered: "<p>Summary.</p>" },
      _embedded: { "wp:term": [[{ taxonomy: "category", name: "Guides" }, { taxonomy: "post_tag", name: "x" }]] },
    },
  ]
  it("normalizes REST JSON into WpPost shape", () => {
    const [p] = parseRestPosts(rest)
    expect(p.title).toBe("REST & Friends")
    expect(p.slug).toBe("rest-post")
    expect(p.contentHtml).toContain("Body from REST")
    expect(p.excerpt).toBe("Summary.")
    expect(p.categories).toEqual(["Guides"])
    expect(p.originalUrl).toBe("https://old.example/2024/rest-post/")
    expect(p.publishedAt).toBe("2024-05-02T09:00:00.000Z")
  })
  it("returns [] on non-array input", () => {
    expect(parseRestPosts(null)).toEqual([])
    expect(parseRestPosts({})).toEqual([])
  })
})

describe("redirect + media helpers", () => {
  it("originalPath extracts the path, ignoring bare roots", () => {
    expect(originalPath("https://old.example/2024/hello/")).toBe("/2024/hello/")
    expect(originalPath("https://old.example/")).toBeNull()
    expect(originalPath("garbage")).toBeNull()
  })
  it("extractImageUrls finds absolute image srcs only", () => {
    const html = `<img src="https://cdn.old/a.jpg"><img src="/rel/b.png"><img src="https://cdn.old/a.jpg">`
    expect(extractImageUrls(html)).toEqual(["https://cdn.old/a.jpg"])
  })
  it("rewriteImageUrls swaps mapped URLs", () => {
    const html = `<img src="https://cdn.old/a.jpg">`
    const map = new Map([["https://cdn.old/a.jpg", "https://r2.pub/x/a.jpg"]])
    expect(rewriteImageUrls(html, map)).toBe(`<img src="https://r2.pub/x/a.jpg">`)
  })
})
