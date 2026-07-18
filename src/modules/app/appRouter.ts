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
  cloudflareConnectHandler, anthropicConnectHandler, stripeConnectHandler,
  disconnectHandler,
} from "../connections"
import {
  sitesPageHandler, createSitePostHandler, siteDetailHandler, siteRetryHandler,
  sitePromptHandler, siteGenesisHandler, siteRollbackHandler,
  previewPageHandler, previewApproveHandler, previewDiscardHandler,
} from "../sites"
import { performancePageHandler } from "../analytics"
import { draftsPageHandler, publishDraftHandler, publishAllHandler } from "../publishing"
import { pseoPageHandler, pseoGenerateHandler } from "../pseo"
import { insightsPageHandler } from "../linking"
import { marketingHomeHandler, marketingPrivacyHandler, marketingTermsHandler, marketingExamplesHandler } from "../marketing"
import { designPageHandler, designApplyHandler } from "../design"
import { seoPostsHandler, seoCockpitHandler, seoSaveHandler, seoCockpitJsHandler } from "../seo"
import {
  brainPageHandler, siteSearchPageHandler, siteDecayPageHandler, siteAeoPageHandler,
  gscStartHandler, gscCallbackHandler, submitSitemapHandler,
  notFoundPageHandler, addRedirectHandler,
} from "../network"
import {
  pinterestPageHandler, pinterestQueueHandler,
  pinterestStartHandler, pinterestCallbackHandler,
} from "../pinterest"
import { importPageHandler, importRunHandler } from "../importer"
import { affiliatePageHandler, affiliateSaveHandler, affiliateApplyHandler } from "../affiliate"
import { clonePageHandler, cloneSubmitHandler, cloneGenesisHandler } from "../cloning"
import {
  agencyPanelHandler, agencySaveHandler, seatCreateHandler, seatDeleteHandler, clientPortalHandler,
} from "../agency"
import { billingPageHandler, billingCheckoutHandler, billingPortalHandler } from "../billing"

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

// Public apex pages (homepage + legal). Root-path exact matches must be mounted
// DIRECTLY on the main app (Hono sub-app root-path gotcha #1), so these are
// exported pre-gated and worker.ts registers them alongside saasRootHandler.
// pub() falls through via next() on non-saas hosts, so tenant sites' "/" is
// untouched.
export const marketingHome: MiddlewareHandler<AppEnv> = pub(marketingHomeHandler)
export const marketingPrivacy: MiddlewareHandler<AppEnv> = pub(marketingPrivacyHandler)
export const marketingTerms: MiddlewareHandler<AppEnv> = pub(marketingTermsHandler)
export const marketingExamples: MiddlewareHandler<AppEnv> = pub(marketingExamplesHandler)

// Public, token-gated client report portal (K11) — root-mounted like the
// marketing pages (Hono root-path gotcha #1). pub()-gated → falls through on
// tenant hosts.
export const clientPortal: MiddlewareHandler<AppEnv> = pub(clientPortalHandler)

export const saasAppRoutes = new Hono<AppEnv>()

/**
 * Security headers for the dashboard (finding — D9). Applied ONLY when the
 * request is actually on the SaaS host (saasActive), so tenant-host responses
 * that fall through remain byte-identical. frame-ancestors 'none' blocks
 * clickjacking of the authenticated, state-changing dashboard; the CSP keeps
 * 'unsafe-inline' because the dashboard ships inline styles + small inline
 * scripts (e.g. the zone-activation poller) — still a real default-src lockdown.
 */
export const saasSecurityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next()
  if (!saasActive(c) || !c.res) return
  const h = c.res.headers
  h.set("X-Frame-Options", "DENY")
  h.set("X-Content-Type-Options", "nosniff")
  h.set("Referrer-Policy", "strict-origin-when-cross-origin")
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
  h.set(
    "Content-Security-Policy",
    "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; " +
      "img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
      // The preview window embeds the customer's live site + throwaway preview
      // worker (both https). The dashboard itself stays frame-ancestors 'none'.
      "frame-src https:"
  )
}
saasAppRoutes.use("*", saasSecurityHeaders)

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
// Design options — change preset/layout later (V1.1).
// SEO cockpit (V1.2 S1).
saasAppRoutes.get("/assets/seo-cockpit.js", pub(seoCockpitJsHandler))
saasAppRoutes.get("/sites/:id/posts", prot(seoPostsHandler))
saasAppRoutes.get("/sites/:id/posts/:postId/seo", prot(seoCockpitHandler))
saasAppRoutes.post("/sites/:id/posts/:postId/seo", prot(seoSaveHandler))
saasAppRoutes.get("/sites/:id/design", prot(designPageHandler))
saasAppRoutes.post("/sites/:id/design", prot(designApplyHandler))
// Visual preview window (K12).
saasAppRoutes.get("/sites/:id/preview", prot(previewPageHandler))
saasAppRoutes.post("/sites/:id/preview/approve", prot(previewApproveHandler))
saasAppRoutes.post("/sites/:id/preview/discard", prot(previewDiscardHandler))
// Gated publishing + content tools (Phase 5).
saasAppRoutes.get("/sites/:id/drafts", prot(draftsPageHandler))
saasAppRoutes.post("/sites/:id/drafts/:postId/publish", prot(publishDraftHandler))
saasAppRoutes.post("/sites/:id/drafts/publish-all", prot(publishAllHandler))
saasAppRoutes.get("/sites/:id/pseo", prot(pseoPageHandler))
saasAppRoutes.post("/sites/:id/pseo", prot(pseoGenerateHandler))
saasAppRoutes.get("/sites/:id/insights", prot(insightsPageHandler))
// Performance / Core Web Vitals (Phase 6).
saasAppRoutes.get("/sites/:id/performance", prot(performancePageHandler))
// Network brain — GSC + decay radar + AEO (Phase 7).
saasAppRoutes.get("/network", prot(brainPageHandler))
saasAppRoutes.get("/sites/:id/search", prot(siteSearchPageHandler))
saasAppRoutes.post("/sites/:id/search/sitemap", prot(submitSitemapHandler))
saasAppRoutes.get("/sites/:id/decay", prot(siteDecayPageHandler))
saasAppRoutes.get("/sites/:id/aeo", prot(siteAeoPageHandler))
saasAppRoutes.get("/sites/:id/404s", prot(notFoundPageHandler))
saasAppRoutes.post("/sites/:id/404s/redirect", prot(addRedirectHandler))
saasAppRoutes.get("/connections/gsc/start", prot(gscStartHandler))
saasAppRoutes.get("/connections/gsc/callback", prot(gscCallbackHandler))
// Cloning (Phase 9, K6).
saasAppRoutes.get("/sites/:id/clone", prot(clonePageHandler))
saasAppRoutes.post("/sites/:id/clone", prot(cloneSubmitHandler))
saasAppRoutes.post("/sites/:id/reseed", prot(cloneGenesisHandler))
// Platform billing (Phase 9b, decision #3).
saasAppRoutes.get("/billing", prot(billingPageHandler))
saasAppRoutes.post("/billing/checkout", prot(billingCheckoutHandler))
saasAppRoutes.post("/billing/portal", prot(billingPortalHandler))
// Agency mode — white-label + seats (Phase 9, K11).
saasAppRoutes.get("/agency", prot(agencyPanelHandler))
saasAppRoutes.post("/agency", prot(agencySaveHandler))
saasAppRoutes.post("/agency/seats", prot(seatCreateHandler))
saasAppRoutes.post("/agency/seats/:seatId/delete", prot(seatDeleteHandler))
// Pinterest traffic engine (Phase 8, K7).
saasAppRoutes.get("/sites/:id/pinterest", prot(pinterestPageHandler))
saasAppRoutes.post("/sites/:id/pinterest/queue", prot(pinterestQueueHandler))
saasAppRoutes.get("/connections/pinterest/start", prot(pinterestStartHandler))
saasAppRoutes.get("/connections/pinterest/callback", prot(pinterestCallbackHandler))
// WordPress import (Phase 8, K9).
saasAppRoutes.get("/sites/:id/import", prot(importPageHandler))
saasAppRoutes.post("/sites/:id/import", prot(importRunHandler))
// Affiliate compliance (Phase 8, K10).
saasAppRoutes.get("/sites/:id/affiliate", prot(affiliatePageHandler))
saasAppRoutes.post("/sites/:id/affiliate", prot(affiliateSaveHandler))
saasAppRoutes.post("/sites/:id/affiliate/apply", prot(affiliateApplyHandler))
// Connections wizard (Phase 2).
saasAppRoutes.get("/connections", prot(connectionsPageHandler))
saasAppRoutes.get("/connections/github/start", prot(githubStartHandler))
saasAppRoutes.get("/connections/github/callback", prot(githubCallbackHandler))
saasAppRoutes.post("/connections/cloudflare", prot(cloudflareConnectHandler))
saasAppRoutes.post("/connections/anthropic", prot(anthropicConnectHandler))
saasAppRoutes.post("/connections/stripe", prot(stripeConnectHandler))
saasAppRoutes.post("/connections/:provider/delete", prot(disconnectHandler))
saasAppRoutes.get(
  "/account",
  prot(saasStubHandler("Account", "account", "Account settings arrive with the next platform update."))
)
