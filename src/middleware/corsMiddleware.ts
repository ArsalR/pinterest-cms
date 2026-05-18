// src/middleware/corsMiddleware.ts
// CORS headers for the public REST API.
// The API uses Bearer token auth — no cookies — so Allow-Origin: * is correct.
// Never reflect the request Origin back; that combined with Allow-Credentials
// would let any website make authenticated cross-origin requests.

import type { MiddlewareHandler } from "hono"
import type { AppEnv } from "../lib/types"

export const corsMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    })
  }

  await next()
  const headers = corsHeaders()
  for (const [k, v] of Object.entries(headers)) c.res.headers.set(k, v)
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With",
    "Access-Control-Max-Age": "86400",
  }
}
