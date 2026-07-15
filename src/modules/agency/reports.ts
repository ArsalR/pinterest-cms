// src/modules/agency/reports.ts
// Monthly client reports (K11) — PURE builder + renderer, unit-tested. Takes
// already-collected metrics for a site and produces a report model + a
// self-contained, white-labelled HTML block used both in the client portal and
// the monthly email. No I/O — the service layer gathers the metrics.

import { escapeHtml } from "../../lib/utils"
import type { AgencyBrand } from "./branding"

export interface SiteMetrics {
  siteName: string
  domain: string
  clicks: number
  impressions: number
  prevClicks: number | null   // previous period, for the trend line
  cwv: { lcpMs: number; cls: number; inpMs: number } | null
  decayingPages: number
  affiliateClicks: number
}

export interface SiteReport {
  siteName: string
  domain: string
  headline: string
  clicks: number
  impressions: number
  clicksDeltaPct: number | null // vs previous period
  cwvSummary: string
  decayingPages: number
  affiliateClicks: number
}

function pct(delta: number): number {
  return Math.round(delta * 100)
}

/** Build the report model from raw metrics. Pure. */
export function buildSiteReport(m: SiteMetrics): SiteReport {
  const clicksDeltaPct =
    m.prevClicks && m.prevClicks > 0 ? pct((m.clicks - m.prevClicks) / m.prevClicks) : null

  let headline: string
  if (clicksDeltaPct === null) headline = `${m.clicks} search clicks this month.`
  else if (clicksDeltaPct > 0) headline = `Search clicks up ${clicksDeltaPct}% — ${m.clicks} this month.`
  else if (clicksDeltaPct < 0) headline = `Search clicks down ${Math.abs(clicksDeltaPct)}% — ${m.clicks} this month.`
  else headline = `Search clicks steady at ${m.clicks} this month.`

  const cwvSummary = m.cwv
    ? m.cwv.lcpMs <= 2500 && m.cwv.cls <= 0.1 && m.cwv.inpMs <= 200
      ? "Core Web Vitals: all good ✓"
      : "Core Web Vitals: needs attention"
    : "Core Web Vitals: no data yet"

  return {
    siteName: m.siteName,
    domain: m.domain,
    headline,
    clicks: m.clicks,
    impressions: m.impressions,
    clicksDeltaPct,
    cwvSummary,
    decayingPages: m.decayingPages,
    affiliateClicks: m.affiliateClicks,
  }
}

/** Email subject line for a report. Pure. */
export function reportEmailSubject(brand: AgencyBrand, period: string): string {
  return `${brand.name} — your ${period} site report`
}

function stat(label: string, value: string, accent: string): string {
  return `<td style="padding:12px 16px;border:1px solid #e5e7eb;border-radius:8px">
    <div style="font-size:12px;color:#6b7280">${escapeHtml(label)}</div>
    <div style="font-size:22px;font-weight:700;color:${accent}">${escapeHtml(value)}</div>
  </td>`
}

/**
 * Render a white-labelled report card (light theme — it's emailed and shown to
 * clients). Self-contained inline styles. Pure — all inputs escaped.
 */
export function renderReportHtml(report: SiteReport, brand: AgencyBrand, period: string): string {
  const delta =
    report.clicksDeltaPct === null
      ? ""
      : ` <span style="color:${report.clicksDeltaPct >= 0 ? "#16a34a" : "#dc2626"};font-size:13px">(${report.clicksDeltaPct >= 0 ? "+" : ""}${report.clicksDeltaPct}%)</span>`
  const logo = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.name)}" style="height:28px;vertical-align:middle;margin-right:8px">`
    : ""
  return `<div style="font-family:ui-sans-serif,system-ui,sans-serif;max-width:600px;margin:0 auto;background:#fff;color:#111827;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
    <div style="background:${escapeHtml(brand.color)};padding:16px 20px;color:#fff">
      ${logo}<strong style="font-size:16px">${escapeHtml(brand.name)}</strong>
    </div>
    <div style="padding:20px">
      <h2 style="margin:0 0 2px;font-size:18px">${escapeHtml(report.siteName)}</h2>
      <p style="margin:0 0 4px;color:#6b7280;font-size:13px">${escapeHtml(report.domain)} · ${escapeHtml(period)}</p>
      <p style="font-size:15px;margin:12px 0 16px">${escapeHtml(report.headline)}</p>
      <table style="border-collapse:separate;border-spacing:8px;width:100%"><tr>
        ${stat("Search clicks", String(report.clicks), brand.color)}
        ${stat("Impressions", String(report.impressions), "#111827")}
      </tr><tr>
        ${stat("Affiliate clicks", String(report.affiliateClicks), "#111827")}
        ${stat("Pages to refresh", String(report.decayingPages), report.decayingPages ? "#d97706" : "#16a34a")}
      </tr></table>
      <p style="margin:14px 0 0;font-size:13px;color:#374151">${escapeHtml(report.cwvSummary)}${delta ? " · clicks trend" + delta : ""}</p>
    </div>
  </div>`
}
