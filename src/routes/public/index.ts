// src/routes/public/index.ts
// Mount /api/public/* — CORS-enabled, API-key-authenticated automation surface.

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import { corsMiddleware } from "../../middleware/corsMiddleware"
import { uploadRoutes } from "./v1/upload"
import { postRoutes } from "./v1/posts"
import { categoryRoutes } from "./v1/categories"
import { statusRoutes } from "./v1/status"

export const publicApiRoutes = new Hono<AppEnv>()

publicApiRoutes.use("*", corsMiddleware)

publicApiRoutes.route("/v1/status", statusRoutes)
publicApiRoutes.route("/v1/upload", uploadRoutes)
publicApiRoutes.route("/v1/posts", postRoutes)
publicApiRoutes.route("/v1/categories", categoryRoutes)

publicApiRoutes.notFound((c) =>
  c.json({ error: "Not found", available: ["/v1/status", "/v1/posts", "/v1/upload", "/v1/categories"] }, 404)
)
