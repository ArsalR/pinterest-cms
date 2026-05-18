// src/routes/admin/pages.ts
// /admin/pages — same as posts but for type='page'. Reuses the post handlers.

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import {
  renderPostsList,
  renderEditorPage,
  savePost,
  deletePost,
  bulkAction,
} from "./posts"

export const pagesAdminRoute = new Hono<AppEnv>()

pagesAdminRoute.get("/", (c) => renderPostsList(c, "page"))
pagesAdminRoute.get("/new", (c) => renderEditorPage(c, null, "page"))
pagesAdminRoute.get("/:id", (c) => renderEditorPage(c, c.req.param("id") ?? null, "page"))
pagesAdminRoute.post("/save", (c) => savePost(c, "page"))
pagesAdminRoute.post("/bulk-action", (c) => bulkAction(c, "page"))
pagesAdminRoute.post("/:id/delete", (c) => deletePost(c))
