// IndexNow key file (V1.3 News SEO profile): /<key>.txt containing the key,
// which api.indexnow.org fetches to verify site ownership. Emitted ONLY when
// a key exists (the platform generates one on the first publish ping) — no
// key ⇒ no route ⇒ byte-identical.
import type { APIRoute } from "astro"
import { loadConfig, fetchSeoSettings } from "../lib/cms"

export async function getStaticPaths() {
  const config = loadConfig()
  const settings = await fetchSeoSettings(config)
  if (!settings.indexnowKey) return []
  return [{ params: { indexnow: settings.indexnowKey } }]
}

export const GET: APIRoute = async () => {
  const config = loadConfig()
  const settings = await fetchSeoSettings(config)
  return new Response(settings.indexnowKey, { headers: { "Content-Type": "text/plain; charset=utf-8" } })
}
