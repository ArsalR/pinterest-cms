// src/routes/public/index.ts
// Mount /api/public/* — CORS-enabled, API-key-authenticated automation surface.

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import { corsMiddleware } from "../../middleware/corsMiddleware"
import { idempotencyMiddleware } from "../../lib/idempotency"
import { rateLimitMiddleware } from "../../lib/rateLimit"
import { uploadRoutes } from "./v1/upload"
import { postRoutes } from "./v1/posts"
import { categoryRoutes } from "./v1/categories"
import { statusRoutes } from "./v1/status"
import { webhookRoutes } from "./v1/webhooks"
import { capabilitiesRoutes } from "./v1/capabilities"

export const publicApiRoutes = new Hono<AppEnv>()

publicApiRoutes.use("*", corsMiddleware)
// Rate limiting runs first — 429 before auth saves a PBKDF2 verify on hot paths.
publicApiRoutes.use("/v1/*", rateLimitMiddleware)
// Idempotency is a no-op when header absent or FEATURE_IDEMPOTENCY != "1".
publicApiRoutes.use("/v1/*", idempotencyMiddleware)

publicApiRoutes.route("/v1/capabilities", capabilitiesRoutes)
publicApiRoutes.route("/v1/status", statusRoutes)
publicApiRoutes.route("/v1/upload", uploadRoutes)
publicApiRoutes.route("/v1/posts", postRoutes)
publicApiRoutes.route("/v1/categories", categoryRoutes)
publicApiRoutes.route("/v1/webhooks", webhookRoutes)

publicApiRoutes.notFound((c) =>
  c.json({ error: "Not found", available: ["/v1/status", "/v1/posts", "/v1/upload", "/v1/categories", "/v1/webhooks"] }, 404)
)
