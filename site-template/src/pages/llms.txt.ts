// llms.txt (K8 / AEO): a machine-readable site summary for AI assistants.
import type { APIRoute } from "astro"
import { loadConfig, fetchAllPosts, canonicalHost } from "../lib/cms"

export const GET: APIRoute = async () => {
  const config = loadConfig()
  const host = canonicalHost(config)
  const posts = await fetchAllPosts(config)
  const lines = [
    `# ${config.name}`,
    ``,
    `> ${config.niche}`,
    ``,
    `## Articles`,
    ...posts.slice(0, 100).map((p) => `- [${p.title}](https://${host}/posts/${p.slug}/)${p.excerpt ? `: ${p.excerpt}` : ""}`),
    ``,
    `## Policies`,
    `- [About](https://${host}/about/)`,
    `- [Editorial Policy](https://${host}/editorial/)`,
    `- [Contact](https://${host}/contact/)`,
  ]
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } })
}
