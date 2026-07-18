// src/modules/seo/service.ts
// Cockpit data layer: read/write a post's SEO fields directly in the site's CMS
// DB (same direct-write pattern as publishing/affiliate), and — on a published
// post's slug change — record an old→new 301 in the redirects table before
// triggering a rebuild. All writes flow through the normal rebuild → covenant
// gates path (safety rail #1). Validation is server-side against the analyze
// enums (never free-form).

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { getSiteDb } from "../../lib/turso"
import { cuid } from "../../lib/utils"
import { getConnection, installationToken, repositoryDispatch } from "../connections"
import { isValidSlug, isSchemaType, type FaqItem } from "./analyze"
import { noindexTransitionGate, SEO_SAFETY_OVERRIDE_PHRASE } from "./safety"

export interface PostSeoRow {
  id: string
  title: string
  slug: string
  published: boolean
  excerpt: string | null
  coverImage: string | null
  content: string
  focusKeyword: string | null
  metaTitle: string | null
  metaDescription: string | null
  ogTitle: string | null
  ogDescription: string | null
  ogImage: string | null
  canonicalUrl: string | null
  noIndex: boolean
  sitemapExclude: boolean
  nofollow: boolean
  schemaType: string | null
  faq: FaqItem[]
  authorId: string | null
}

export async function siteDbFor(master: Client, cmsSiteId: string): Promise<Client | null> {
  const r = await master.execute({ sql: "SELECT turso_url, turso_token FROM sites WHERE id = ? LIMIT 1", args: [cmsSiteId] })
  if (!r.rows.length) return null
  return getSiteDb(r.rows[0].turso_url as string, r.rows[0].turso_token as string)
}

/** Trigger a rebuild through the normal pipeline (safety rail #1). Best-effort:
 *  a missing/failed dispatch is logged, never thrown. Shared by every SEO
 *  writer (cockpit, image SEO, …) so all edits take the same covenant-gated path. */
export async function dispatchRebuild(env: CloudflareEnv, master: Client, customerId: string, repoFullName: string | null, reason: string): Promise<void> {
  if (!repoFullName) return
  const gh = await getConnection(master, customerId, "github")
  const installationId = Number((JSON.parse(gh?.meta || "{}") as { installationId?: number }).installationId ?? 0)
  if (!installationId) return
  try {
    const token = await installationToken(env, installationId)
    await repositoryDispatch(token, repoFullName, "content-updated", { reason })
  } catch (err) {
    console.error(`seo rebuild dispatch failed (${reason}):`, err instanceof Error ? err.message : err)
  }
}

function parseFaq(raw: string | null): FaqItem[] {
  if (!raw) return []
  try {
    const a = JSON.parse(raw) as FaqItem[]
    return Array.isArray(a) ? a.filter((f) => f && typeof f.question === "string") : []
  } catch {
    return []
  }
}

/** Posts of a site for the cockpit picker. */
export async function listPostsForSeo(master: Client, cmsSiteId: string, limit = 200): Promise<Array<{ id: string; title: string; slug: string; published: boolean; noIndex: boolean }>> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return []
  const r = await siteDb.execute({
    sql: "SELECT id, title, slug, published, no_index FROM posts WHERE type = 'post' ORDER BY updated_at DESC LIMIT ?",
    args: [limit],
  })
  return r.rows.map((row) => ({ id: String(row.id), title: String(row.title ?? "(untitled)"), slug: String(row.slug ?? ""), published: Number(row.published) === 1, noIndex: Number(row.no_index) === 1 }))
}

export async function loadPostSeo(master: Client, cmsSiteId: string, postId: string): Promise<PostSeoRow | null> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return null
  const r = await siteDb.execute({
    sql: `SELECT id, title, slug, published, excerpt, cover_image, content, seo_keywords, seo_title, seo_description, author_id,
                 og_title, og_description, og_image, canonical_url, no_index,
                 sitemap_exclude, nofollow, schema_type, faq_json
          FROM posts WHERE id = ? AND type = 'post' LIMIT 1`,
    args: [postId],
  })
  if (!r.rows.length) return null
  const p = r.rows[0]
  return {
    id: String(p.id), title: String(p.title ?? ""), slug: String(p.slug ?? ""), published: Number(p.published) === 1,
    excerpt: (p.excerpt as string | null) ?? null, coverImage: (p.cover_image as string | null) ?? null,
    content: String(p.content ?? ""), focusKeyword: (p.seo_keywords as string | null) ?? null,
    metaTitle: (p.seo_title as string | null) ?? null, metaDescription: (p.seo_description as string | null) ?? null,
    ogTitle: (p.og_title as string | null) ?? null, ogDescription: (p.og_description as string | null) ?? null,
    ogImage: (p.og_image as string | null) ?? null, canonicalUrl: (p.canonical_url as string | null) ?? null,
    noIndex: Number(p.no_index) === 1, sitemapExclude: Number(p.sitemap_exclude) === 1, nofollow: Number(p.nofollow) === 1,
    schemaType: (p.schema_type as string | null) ?? null, faq: parseFaq(p.faq_json as string | null),
    authorId: (p.author_id as string | null) ?? null,
  }
}

export interface SeoUpdate {
  metaTitle: string; metaDescription: string; slug: string; focusKeyword: string
  ogTitle: string; ogDescription: string; ogImage: string
  canonicalUrl: string; noIndex: boolean; sitemapExclude: boolean; nofollow: boolean
  schemaType: string; faq: FaqItem[]
  authorId: string
  addRedirectOnSlugChange: boolean
  /** SEO-safety override phrase, required only when the save trips rail #2. */
  typedOverride?: string
}

export interface SaveResult {
  ok: boolean
  error?: string
  slugChanged?: boolean
  redirectAdded?: boolean
  /** True when the save was refused by the SEO-safety gate and needs the
   *  typed override phrase to proceed (rail #2). */
  needOverride?: boolean
  /** True when a blocked save went through under a valid typed override —
   *  the route audit-logs this. */
  overrodeSafety?: boolean
}

/** Persist SEO fields for a post; on a published slug change, offer a 301. */
export async function savePostSeo(env: CloudflareEnv, customerId: string, cmsSiteId: string, repoFullName: string | null, postId: string, u: SeoUpdate, master: Client): Promise<SaveResult> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { ok: false, error: "The content workspace is unavailable." }

  const cur = await loadPostSeo(master, cmsSiteId, postId)
  if (!cur) return { ok: false, error: "That post no longer exists." }

  const newSlug = u.slug.trim()
  if (!isValidSlug(newSlug)) return { ok: false, error: "That slug isn't valid — lowercase letters, numbers and single hyphens only." }
  if (u.schemaType && !isSchemaType(u.schemaType)) return { ok: false, error: "Unknown schema type." }
  if (u.canonicalUrl && !/^https:\/\/\S+$/.test(u.canonicalUrl.trim())) return { ok: false, error: "Canonical URL must be a full https:// URL." }

  // Slug uniqueness (excluding this post).
  if (newSlug !== cur.slug) {
    const dup = await siteDb.execute({ sql: "SELECT 1 FROM posts WHERE slug = ? AND id != ? LIMIT 1", args: [newSlug, postId] })
    if (dup.rows.length) return { ok: false, error: "Another post already uses that slug." }
  }

  // SEO-safety gate (rail #2): newly noindexing a published post must not push
  // the site's deindexed share over the limit without an explicit typed
  // override. Only checked on the transition (off → on) so an already-noindexed
  // post can still be edited freely.
  let overrodeSafety = false
  if (u.noIndex && !cur.noIndex && cur.published) {
    const counts = await siteDb.execute({
      sql: "SELECT COUNT(*) AS total, SUM(CASE WHEN no_index = 1 THEN 1 ELSE 0 END) AS noidx FROM posts WHERE published = 1 AND type = 'post'",
      args: [],
    })
    const total = Number(counts.rows[0]?.total ?? 0)
    const noidx = Number(counts.rows[0]?.noidx ?? 0)
    const gate = noindexTransitionGate(total, noidx, u.typedOverride ?? null)
    if (!gate.passed) {
      return {
        ok: false,
        needOverride: true,
        error: `${gate.reasons.join(" ")} If you're sure, type "${SEO_SAFETY_OVERRIDE_PHRASE}" to confirm.`,
      }
    }
    overrodeSafety = gate.overridden
  }

  const faqJson = u.faq.filter((f) => f.question?.trim() && f.answer?.trim())
  await siteDb.execute({
    sql: `UPDATE posts SET seo_title=?, seo_description=?, seo_keywords=?, slug=?, og_title=?, og_description=?, og_image=?,
             canonical_url=?, no_index=?, sitemap_exclude=?, nofollow=?, schema_type=?, faq_json=?, author_id=?, updated_at=datetime('now')
          WHERE id=?`,
    args: [
      u.metaTitle.trim() || null, u.metaDescription.trim() || null, u.focusKeyword.trim() || null, newSlug,
      u.ogTitle.trim() || null, u.ogDescription.trim() || null, u.ogImage.trim() || null,
      u.canonicalUrl.trim() || null, u.noIndex ? 1 : 0, u.sitemapExclude ? 1 : 0, u.nofollow ? 1 : 0,
      u.schemaType || null, faqJson.length ? JSON.stringify(faqJson) : null, u.authorId.trim() || null, postId,
    ],
  })

  let redirectAdded = false
  const slugChanged = newSlug !== cur.slug
  if (slugChanged && cur.published && u.addRedirectOnSlugChange) {
    await siteDb.execute({
      sql: `INSERT INTO redirects (id, from_path, target, kind, match_type, message)
            VALUES (?, ?, ?, '301', 'exact', 'Slug changed in SEO cockpit') ON CONFLICT(from_path) DO NOTHING`,
      args: [cuid(), `/posts/${cur.slug}/`, `/posts/${newSlug}/`],
    }).then(() => { redirectAdded = true }).catch(() => {})
  }

  // Rebuild through the normal pipeline (safety rail #1).
  await dispatchRebuild(env, master, customerId, repoFullName, "seo-cockpit")
  return { ok: true, slugChanged, redirectAdded, overrodeSafety }
}
