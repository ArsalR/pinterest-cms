// src/routes/public/v1/openapi.ts
// OpenAPI 3 document for the public site API (V1.5 M2). Additive, unauthenticated
// (docs are public) so any tool's HTTP node can autocomplete the API. The path
// catalog mirrors capabilities.ts; the error schema mirrors errors.ts. Pure
// builder + a thin route.

import { Hono } from "hono"
import type { AppEnv } from "../../../lib/types"
import { ERROR_CODES } from "../../../lib/errors"

interface PathDef { method: "get" | "post" | "put" | "delete"; path: string; summary: string; scope: string }

const CATALOG: PathDef[] = [
  { method: "get", path: "/v1/status", summary: "API status + site info", scope: "read" },
  { method: "get", path: "/v1/capabilities", summary: "Endpoints, features, rate limit", scope: "read" },
  { method: "get", path: "/v1/posts", summary: "List posts", scope: "read" },
  { method: "get", path: "/v1/posts/{id}", summary: "Get a post", scope: "read" },
  { method: "post", path: "/v1/posts", summary: "Create a post", scope: "write" },
  { method: "put", path: "/v1/posts/{id}", summary: "Update a post", scope: "write" },
  { method: "delete", path: "/v1/posts/{id}", summary: "Delete a post", scope: "write" },
  { method: "post", path: "/v1/posts/batch", summary: "Create up to 50 posts", scope: "write" },
  { method: "get", path: "/v1/categories", summary: "List categories", scope: "read" },
  { method: "post", path: "/v1/categories", summary: "Create a category", scope: "write" },
  { method: "get", path: "/v1/forms", summary: "List active forms", scope: "read" },
  { method: "post", path: "/v1/upload", summary: "Upload media (multipart)", scope: "write" },
  { method: "get", path: "/v1/webhooks", summary: "List webhook endpoints", scope: "read" },
]

/** Build the OpenAPI 3 document for a given host. Pure — unit-tested. */
export function buildOpenApiSpec(host: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const e of CATALOG) {
    const p = (paths[e.path] ??= {})
    p[e.method] = {
      summary: e.summary,
      security: [{ bearerAuth: [] }],
      responses: {
        "200": { description: "Success" },
        "401": { $ref: "#/components/responses/Error" },
        "403": { $ref: "#/components/responses/Error" },
        "429": { $ref: "#/components/responses/Error" },
      },
      "x-required-scope": e.scope,
    }
  }
  return {
    openapi: "3.0.3",
    info: { title: "SiteNetwork Site API", version: "1", description: "Per-site content API. Authenticate with a Bearer key (cms_live_… or a scoped sk_site_… key)." },
    servers: [{ url: `https://${host}/api/public` }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "cms_live_… or sk_site_… key" } },
      responses: {
        Error: {
          description: "Typed error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string" },
            code: { type: "string", enum: ERROR_CODES },
          },
          required: ["error", "code"],
        },
      },
    },
  }
}

export const openApiRoutes = new Hono<AppEnv>()
openApiRoutes.get("/", (c) => {
  const host = c.req.header("host") ?? c.get("hostname") ?? "example.com"
  return c.json(buildOpenApiSpec(host))
})
