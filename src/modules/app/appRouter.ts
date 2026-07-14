// src/modules/app/appRouter.ts
// SaaS dashboard router (/app/*) — assembled with fall-through gating.
//
// Gating contract (byte-identical guarantee): every handler here is wrapped
// so that when saas_mode is off OR the request is not on SAAS_APP_HOSTNAME,
// the handler defers via next() and the request falls through to whatever
// matched before this feature existed (the frontend catch-all). Tenant sites'
// /app/... URLs therefore behave exactly as they always did.
//
// NOTE for worker.ts: the /app root must be mounted twice directly on the
// main app (Hono sub-app root-path gotcha #1) — saasRootHandler is exported
// for that purpose.

import { Hono } from "hono"
import type { Context, MiddlewareHandler } from "hono"
import type { AppEnv } from "../../lib/types"
import { saasActive, requireCustomer } from "../auth"
import {
  signupGetHandler, signupPostHandler,
  loginGetHandler, loginPostHandler, logoutPostHandler,
  verifyGetHandler,
  forgotGetHandler, forgotPostHandler,
  resetGetHandler, resetPostHandler,
} from "../customers"
import { saasHomeHandler, resendVerificationHandler, saasStubHandler } from "../customers"
import {
  connectionsPageHandler,
  githubStartHandler, githubCallbackHandler,
  cloudflareConnectHandler, anthropicConnectHandler,
  disconnectHandler,
} from "../connections"
import {
  sitesPageHandler, createSitePostHandler, siteDetailHandler, siteRetryHandler,
  sitePromptHandler, siteGenesisHandler, siteRollbackHandler,
} from "../sites"

type PageHandler = (c: Context<AppEnv>) => Promise<Response>

/** Public page: gated on saas hostname+flag, no session required. */
function pub(handler: PageHandler): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!saasActive(c)) return next()
    return handler(c)
  }
}

/** Protected page: gated + signed-in customer required (302 to login otherwise). */
function prot(handler: PageHandler): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!saasActive(c)) return next()
    const customer = await requireCustomer(c, "page")
    if (customer instanceof Response) return customer
    return handler(c)
  }
}

/** Root handler for /app and /app/ — mounted directly on the main app. */
export const saasRootHandler: MiddlewareHandler<AppEnv> = prot(saasHomeHandler)

export const saasAppRoutes = new Hono<AppEnv>()

// Auth pages (no session).
saasAppRoutes.get("/signup", pub(signupGetHandler))
saasAppRoutes.post("/signup", pub(signupPostHandler))
saasAppRoutes.get("/login", pub(loginGetHandler))
saasAppRoutes.post("/login", pub(loginPostHandler))
saasAppRoutes.post("/logout", pub(logoutPostHandler))
saasAppRoutes.get("/verify", pub(verifyGetHandler))
saasAppRoutes.get("/forgot", pub(forgotGetHandler))
saasAppRoutes.post("/forgot", pub(forgotPostHandler))
saasAppRoutes.get("/reset", pub(resetGetHandler))
saasAppRoutes.post("/reset", pub(resetPostHandler))

// Signed-in pages.
saasAppRoutes.post("/resend-verification", prot(resendVerificationHandler))
// Sites + provisioning (Phase 3).
saasAppRoutes.get("/sites", prot(sitesPageHandler))
saasAppRoutes.post("/sites", prot(createSitePostHandler))
saasAppRoutes.get("/sites/:id", prot(siteDetailHandler))
saasAppRoutes.post("/sites/:id/retry", prot(siteRetryHandler))
// Prompt-to-build + rollback (Phase 4).
saasAppRoutes.post("/sites/:id/prompt", prot(sitePromptHandler))
saasAppRoutes.post("/sites/:id/genesis", prot(siteGenesisHandler))
saasAppRoutes.post("/sites/:id/rollback", prot(siteRollbackHandler))
// Connections wizard (Phase 2).
saasAppRoutes.get("/connections", prot(connectionsPageHandler))
saasAppRoutes.get("/connections/github/start", prot(githubStartHandler))
saasAppRoutes.get("/connections/github/callback", prot(githubCallbackHandler))
saasAppRoutes.post("/connections/cloudflare", prot(cloudflareConnectHandler))
saasAppRoutes.post("/connections/anthropic", prot(anthropicConnectHandler))
saasAppRoutes.post("/connections/:provider/delete", prot(disconnectHandler))
saasAppRoutes.get(
  "/account",
  prot(saasStubHandler("Account", "account", "Account settings arrive with the next platform update."))
)
