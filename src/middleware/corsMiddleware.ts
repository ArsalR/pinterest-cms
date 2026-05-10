// src/middleware/corsMiddleware.ts
// CORS headers for the public REST API so automation tools can call from any origin.

import type { MiddlewareHandler } from "hono"
import type { AppEnv } from "../lib/types"

export const corsMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header("origin") ?? "*"

  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(origin),
    })
  }

  await next()
  // Append headers to the existing response.
  const headers = corsHeaders(origin)
  for (const [k, v] of Object.entries(headers)) c.res.headers.set(k, v)
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  }
}
