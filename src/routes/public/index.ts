// src/routes/public/index.ts
// Mount /api/public/* — CORS-enabled, API-key-authenticated automation surface.

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import { corsMiddleware } from "../../middleware/corsMiddleware"
import { idempotencyMiddleware } from "../../lib/idempotency"
import { rateLimitMiddleware } from "../../lib/rateLimit"
import { uploadRoutes } from "./v1/upload"
import { postRoutes } from "./v1/posts"
import { productRoutes } from "./v1/products"
import { categoryRoutes } from "./v1/categories"
import { statusRoutes } from "./v1/status"
import { webhookRoutes } from "./v1/webhooks"
import { capabilitiesRoutes } from "./v1/capabilities"
import { seoRoutes } from "./v1/seo"
import { seoSettingsRoutes } from "./v1/seoSettings"
import { localRoutes } from "./v1/local"
import { authorRoutes } from "./v1/authors"
import { merchantRoutes } from "./v1/merchant"
import { formDefRoutes } from "./v1/forms"
import { openApiRoutes } from "./v1/openapi"

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
// Mount the more specific /v1/seo-settings BEFORE /v1/seo (prefix-match safety).
publicApiRoutes.route("/v1/seo-settings", seoSettingsRoutes)
publicApiRoutes.route("/v1/seo", seoRoutes)
publicApiRoutes.route("/v1/local", localRoutes)
publicApiRoutes.route("/v1/authors", authorRoutes)
publicApiRoutes.route("/v1/merchant", merchantRoutes)
publicApiRoutes.route("/v1/forms", formDefRoutes)
publicApiRoutes.route("/v1/products", productRoutes)
publicApiRoutes.route("/v1/categories", categoryRoutes)
publicApiRoutes.route("/v1/webhooks", webhookRoutes)
publicApiRoutes.route("/v1/openapi.json", openApiRoutes)

publicApiRoutes.notFound((c) =>
  c.json({ error: "Not found", available: ["/v1/status", "/v1/posts", "/v1/seo", "/v1/seo-settings", "/v1/local", "/v1/authors", "/v1/merchant", "/v1/forms", "/v1/products", "/v1/upload", "/v1/categories", "/v1/webhooks", "/v1/openapi.json"] }, 404)
)
