// src/routes/public/v1/status.ts
import { Hono } from "hono"
import type { AppEnv } from "../../../lib/types"

export const statusRoutes = new Hono<AppEnv>()

statusRoutes.get("/", (c) => {
  const site = c.get("site")
  return c.json({
    status: "ok",
    hostname: c.get("hostname"),
    site: site ? { id: site.id, name: site.name } : null,
    timestamp: new Date().toISOString(),
  })
})
