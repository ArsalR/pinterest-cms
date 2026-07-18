// src/routes/public/v1/capabilities.ts
// GET /api/public/v1/capabilities — returns a snapshot of enabled features and
// available endpoints so CNOS can adapt without probing.
// Requires read API key auth.

import { Hono } from "hono"
import type { AppEnv } from "../../../lib/types"
import { validateApiKey } from "../../../lib/apiAuth"
import { apiError } from "../../../lib/errors"

export const capabilitiesRoutes = new Hono<AppEnv>()

capabilitiesRoutes.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const auth = await validateApiKey(siteDb, c.req.raw, "read")
  if (auth.error) return apiError(c, auth.status, auth.code, auth.error)

  const env = c.env
  const flag = (v: string | undefined) => v === "1" || v === "true"

  return c.json({
    success: true,
    apiVersion: "1",
    features: {
      idempotency: flag(env.FEATURE_IDEMPOTENCY),
      webhooks: flag(env.FEATURE_WEBHOOKS),
      rateLimit: flag(env.FEATURE_RATE_LIMIT),
      batchPosts: flag(env.FEATURE_BATCH_POSTS),
      r2Gc: flag(env.GC_ENABLED),
    },
    rateLimitRpm: parseInt(env.RATE_LIMIT_RPM ?? "60", 10) || 60,
    endpoints: [
      "GET  /api/public/v1/status",
      "GET  /api/public/v1/capabilities",
      "GET  /api/public/v1/posts",
      "GET  /api/public/v1/posts/:id",
      "GET  /api/public/v1/seo",
      "GET  /api/public/v1/seo-settings",
      "POST /api/public/v1/posts",
      "POST /api/public/v1/posts/batch",
      "PUT  /api/public/v1/posts/:id",
      "DELETE /api/public/v1/posts/:id",
      "GET  /api/public/v1/products",
      "GET  /api/public/v1/products/:id",
      "POST /api/public/v1/products",
      "GET  /api/public/v1/categories",
      "POST /api/public/v1/categories",
      "POST /api/public/v1/upload",
      "GET  /api/public/v1/webhooks",
      "POST /api/public/v1/webhooks",
      "PUT  /api/public/v1/webhooks/:id",
      "DELETE /api/public/v1/webhooks/:id",
      "GET  /api/public/v1/webhooks/:id/deliveries",
    ],
  })
})
