// src/modules/importer/importer.test.ts
// Pure-logic: the WXR parser (K9). Writing drafts into a CMS DB is I/O and
// belongs to Phase-10 mocked-integration tests.

import { describe, it, expect } from "vitest"
import {
  parseWxr, parseRestPosts, tagText, slugify,
  originalPath, extractImageUrls, rewriteImageUrls,
} from "./wordpress"

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
