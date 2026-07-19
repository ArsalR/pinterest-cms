# V1.4 — FORMS & AUTOMATION ENGINE + FINAL VERIFICATION + GO-LIVE STEPS

Three jobs in order. Branch series `forms-f1` … `forms-f4`, then `v14-verify`, then the final go-live deliverable. Same rails as every prior spec: existing API byte-identical, `saas_mode` flag discipline, covenants deploy-blocking, additive schema only, tests with every stage, surface-don't-guess.

## Design principle (read first)

The 29-item automation wishlist collapses into ONE engine plus add-ons: almost every business form (contact, quote, estimate, callback, support ticket, complaint, feedback, review, job application, vendor/partner/franchise/investor inquiry, event registration, warranty claim, return request) is the same machinery with different fields. Build the machinery once, ship the variants as templates. Reuse what exists: the contact relay (Turnstile + Resend), the vault, per-site DBs, the quality/covenant pipeline, the vetted-script allowlist (V1.3), the ✨ assist pattern (customer's vault key).

Explicitly OUT of scope — do not build: CRM (outbound webhook covers it), email campaign system (capture + export only), appointment/calendar engine (link-out or vetted embed), voice AI, per-site visitor accounts/login portals, conversation translation. If a stage tempts you toward any of these, stop and surface it.

## JOB 1 — The engine

### Stage F1 — Forms Engine core
- **Form builder** in the dashboard per site: field palette (text, email, phone, textarea, select, radio, checkbox, date, number, file-upload-to-R2 with type/size limits, hidden), drag order, required flags, per-field labels + help text. Server-side validation generated from the same definition (one schema, two surfaces).
- **Form templates**: prebuilt starting points for the common variants (Contact, Quote Request, Free Estimate, Callback, Support Ticket, Complaint, Feedback, Review/Testimonial, Job Application, Event Registration, Partner/Vendor Inquiry, Newsletter). Each = a field set + recommended acknowledgment copy. One click to add, then editable.
- **Static rendering**: forms render as pure HTML in the template (zero-JS covenant intact — native HTML forms, no client script), styled by the site's design tokens, embeddable on any page via a content block. Turnstile on every form (existing pattern, the one allowed script).
- **Submission pipeline** (platform Worker): validate → store in the site's DB (`form_submissions`: form id, fields JSON, meta: page, timestamp, IP-derived country only — no raw IP retention beyond spam window) → notify owner (Resend, existing path) → **acknowledgment email to the submitter**: per-form toggle + editable template with field placeholders ({{name}}, {{form_title}}), sent from forms@arsal.app with Reply-To = site owner. Rate-limited per IP per form (existing rate-limit table pattern). Honeypot field as second spam layer.
- **Custom sending domain (optional per site)**: wizard step to verify the customer's own domain with Resend (SPF/DKIM records shown with live verification polling, same UX pattern as the main wizard); acknowledgments then send from their domain. Absent = platform domain default.

### Stage F2 — Submissions Inbox
- Per-site inbox in the dashboard: list with form filter, status (new/read/replied/archived), search, detail view with all fields, internal notes, CSV export per form/date-range. Badge counts in nav. Deletion honors an auto-retention setting (default keep-forever, configurable purge).
- **Reply from the inbox**: opens a compose box, sends via Resend (same from/Reply-To rules), thread stored on the submission. Marks status replied.
- Cross-site view: an "All inboxes" page aggregating new submissions across the customer's sites (network operators live here).

### Stage F3 — Automation hooks
- **Outbound webhook per form**: URL + optional secret (HMAC-signed payload, same signature scheme as existing webhooks), fired on each submission with retries/backoff; delivery log visible per form. This is the CRM/n8n/Make/Zapier integration — one field, infinite automations. Test-fire button in the UI.
- **CTA blocks** for the page editor: WhatsApp (wa.me + prefilled text), Call Now (tel:), Email (mailto:), Book (external scheduling URL — Cal.com/Calendly link-out), Download/Lead-magnet (form-gated: submit → acknowledgment email carries the R2-hosted file link), Subscribe (newsletter template shortcut). All pure HTML/CSS, token-styled.
- **Newsletter capture**: the Newsletter template stores to a per-site subscribers list (double-opt-in via confirmation email link — legally safer default), export CSV, unsubscribe link auto-appended and honored. No campaign sending — say so in the UI with a "connect your email tool via webhook" pointer.

### Stage F4 — Submission intelligence (✨, customer's vault key, hidden without it)
- Per-submission AI: summary line + lead score (hot/warm/cold with one-line reason) computed on arrival, shown in the inbox list; **drafted reply** in the compose box (always editable, never auto-sent). Batch daily digest email option: "You got 7 leads yesterday; 2 hot: …".
- Guardrails: per-customer assist rate-limits (existing pattern), key never in logs, prompt content excluded from audit rows (counts only). If the key is absent everything above simply doesn't render — F1–F3 must be fully useful without AI.

## JOB 2 — Verify everything in its place (whole-system regression)

After F4 merges, run the standing verification battery and fix anything found (adversarial rules from FINAL_AUDIT_PROMPT.md):
1. Full gates: typecheck, all tests, no cycles, cold `npm ci`, tenant API byte-for-byte with flag on/off.
2. Template: cold build; every covenant gate break-tested; forms render zero-JS (build with a form on every kind × a preset sample; assert no new scripts beyond the allowed Turnstile); preset matrix green.
3. New surfaces: forms/inbox/webhook/subscriber routes — auth, tenant scoping (cross-customer IDOR tests), input validation, CSRF, rate limits bound; file uploads can't smuggle executables (type allowlist, size caps, R2 keys unguessable); acknowledgment templating can't be abused for spam relaying (placeholders escape HTML, no arbitrary recipients — submitter address only, from the submission itself).
4. Email paths: acknowledgment, owner notification, inbox reply, double-opt-in, digest — each exercised against a Resend mock; unsubscribe honored end-to-end.
5. Composition: a site with every profile (V1.3) + forms + ecommerce + presets builds green through all gates; worst-case page still passes Lighthouse budgets.
6. Update AUDIT_REPORT.md with findings + honest verdict.

## JOB 3 — The final go-live steps (the deliverable I will hold in my hands)

Produce the FINAL `LAUNCH_CHECKLIST.md` (supersede all prior versions, fold in V1.3 + V1.4 additions), then ALSO print the complete checklist directly in your chat reply — numbered, top to bottom, nothing abbreviated — so I can follow it without opening a file. Requirements:
- Every step: exact command or exact dashboard click-path, what it unblocks, how to verify it worked, realistic minutes.
- Strict dependency order: Cloudflare Workers Paid → publish ArsalR/site-template (+ template-repo toggle) → all DNS in one table (arsal.app records, `*.cms.arsal.app` wildcard route, Resend SPF/DKIM, demo subdomains) → GitHub App creation (current callback URLs) → complete secrets inventory (every `wrangler secret put`, including any V1.3/V1.4 additions — IndexNow key, forms/Turnstile, assist limits config) → Stripe test-mode (webhook + secrets) → flip `SAAS_MODE=1` → the 10-item smoke test → provision the four demo sites through the real wizard (this IS the E2E test; include one form submission + acknowledgment email received on a demo as a checklist item) → LHCI live verification on the first template publish → Stripe live-mode switch → OAuth (Google/Pinterest) verification status check → 48-hour watch list.
- End with the measurable "YOU ARE LIVE" criteria: what must be true (all four demos serving on their subdomains, smoke test 10/10, one real form submission acknowledged, one paid test subscription completed and refunded) for the product to be declared live.

Work F1→F4 → Job 2 → Job 3. Checkpoint in AUDIT_STATE.md if context runs long.
