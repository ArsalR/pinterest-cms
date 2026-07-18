// llms-full.txt (V1.3 AI-SEO profile) — the FULL-content companion to
// llms.txt: complete article text for AI assistants that want more than the
// summary index. Emitted ONLY when the AI profile is on; posts flagged
// llms_exclude in the cockpit are left out. 404 (no file) otherwise —
// byte-identical for other sites.
import type { APIRoute } from "astro"
import { loadConfig, fetchAllPosts, fetchSeoSettings, canonicalHost, profileOn } from "../lib/cms"

const STRIP = /<[^>]+>/g
function toText(html: string): string {
  return html
    .replace(/<\/(p|h[1-6]|li|blockquote)>/gi, "\n\n")
    .replace(STRIP, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export const GET: APIRoute = async () => {
  const config = loadConfig()
  const settings = await fetchSeoSettings(config)
  if (!profileOn(settings, "ai")) return new Response(null, { status: 404 })

  const host = canonicalHost(config)
  const posts = (await fetchAllPosts(config)).filter((p) => !p.llmsExclude)

  const sections = posts.map((p) => {
    const meta = [p.publishedAt ? `Published: ${p.publishedAt.slice(0, 10)}` : null, `URL: https://${host}/posts/${p.slug}/`]
      .filter(Boolean)
      .join(" · ")
    return `## ${p.title}\n\n${meta}\n\n${toText(p.content)}`
  })

  const body = [`# ${config.name} — full content`, ``, `> ${config.niche}`, ``, ...sections].join("\n")
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } })
}
