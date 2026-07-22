// src/modules/mail/emailWorker.ts
// The Email Worker SOURCE that gets uploaded into the CUSTOMER'S Cloudflare
// account (V1.5 M1). Cloudflare invokes its `email()` handler on every inbound
// message routed by the catch-all. It parses the MIME, normalizes it to the
// platform's InboundMail shape, HMAC-signs the JSON (same scheme as the content
// webhooks), and POSTs it to /api/saas/mail/inbound/:siteId.
//
// It is deliberately SELF-CONTAINED (no imports) so it can be uploaded as a
// single ES module — no bundler, sidestepping the postal-mime bundling problem.
// The MIME parse is intentionally light (text/plain + text/html + first-level
// multipart attachments); good enough for a mailbox, honest about its limits.
// renderEmailWorker() is pure and unit-tested; the runtime behavior is verified
// via the platform's stubbed-inbound tests + the runbook.

export interface EmailWorkerOpts {
  /** Absolute platform endpoint, e.g. https://arsal.app/api/saas/mail/inbound/<siteId> */
  endpoint: string
  /** Per-site inbound secret (HMAC). Baked in — the script is unique per site. */
  secret: string
}

/** Render the customer-account Email Worker source. Pure. */
export function renderEmailWorker(opts: EmailWorkerOpts): string {
  const endpoint = JSON.stringify(opts.endpoint)
  const secret = JSON.stringify(opts.secret)
  return `// Auto-generated Site Mailbox worker — do not edit. Uploaded by SiteNetwork OS.
const ENDPOINT = ${endpoint};
const SECRET = ${secret};
const MAX_ATTACH = 10 * 1024 * 1024;

async function hmac(body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  let hex = ""; for (const b of sig) hex += b.toString(16).padStart(2, "0");
  return "sha256=" + hex;
}
function decodeBody(part, enc) {
  enc = (enc || "").toLowerCase();
  if (enc === "base64") { try { return atob(part.replace(/\\s+/g, "")); } catch { return part; } }
  if (enc === "quoted-printable") return part.replace(/=\\r?\\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return part;
}
function splitHeaders(block) {
  const idx = block.indexOf("\\r\\n\\r\\n") >= 0 ? block.indexOf("\\r\\n\\r\\n") : block.indexOf("\\n\\n");
  const h = idx >= 0 ? block.slice(0, idx) : block;
  const body = idx >= 0 ? block.slice(idx).replace(/^\\r?\\n\\r?\\n/, "") : "";
  const headers = {};
  h.replace(/\\r?\\n[ \\t]+/g, " ").split(/\\r?\\n/).forEach((line) => {
    const c = line.indexOf(":"); if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
  });
  return { headers, body };
}
function parseMime(raw) {
  const { headers, body } = splitHeaders(raw);
  const ct = headers["content-type"] || "text/plain";
  const out = { text: "", html: "", attachments: [] };
  const bmatch = /boundary="?([^";]+)"?/i.exec(ct);
  if (/multipart\\//i.test(ct) && bmatch) {
    const parts = body.split("--" + bmatch[1]);
    for (const p of parts) {
      if (!p.trim() || p.trim() === "--") continue;
      const sub = splitHeaders(p.replace(/^\\r?\\n/, ""));
      const sct = (sub.headers["content-type"] || "").toLowerCase();
      const enc = sub.headers["content-transfer-encoding"];
      const disp = sub.headers["content-disposition"] || "";
      const decoded = decodeBody(sub.body.trim(), enc);
      if (/attachment/i.test(disp) || /filename=/i.test(disp) || /name=/i.test(sct)) {
        const fn = (/(?:filename|name)="?([^";]+)"?/i.exec(disp + ";" + sct) || [, "attachment"])[1];
        const b64 = enc && enc.toLowerCase() === "base64" ? sub.body.replace(/\\s+/g, "") : btoa(decoded);
        if (b64.length * 0.75 <= MAX_ATTACH) out.attachments.push({ filename: fn, contentType: sct.split(";")[0].trim(), base64: b64 });
      } else if (/text\\/html/i.test(sct)) out.html = decoded;
      else out.text = decoded || out.text;
    }
  } else if (/text\\/html/i.test(ct)) out.html = decodeBody(body, headers["content-transfer-encoding"]);
  else out.text = decodeBody(body, headers["content-transfer-encoding"]);
  return out;
}

export default {
  async email(message, env, ctx) {
    try {
      const raw = await new Response(message.raw).text();
      const parsed = parseMime(raw);
      const h = message.headers;
      const refs = (h.get("references") || "").match(/<[^>]+>/g) || [];
      const payload = {
        from: message.from || h.get("from") || "",
        to: message.to || h.get("to") || "",
        subject: h.get("subject") || "",
        text: parsed.text, html: parsed.html,
        messageId: h.get("message-id") || "",
        inReplyTo: h.get("in-reply-to") || "",
        references: refs.map((x) => x.replace(/[<>]/g, "")),
        spamVerdict: h.get("x-cf-spam-verdict") || h.get("x-spam-status") || "",
        attachments: parsed.attachments,
      };
      const body = JSON.stringify(payload);
      const sig = await hmac(body);
      await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", "X-Webhook-Signature": sig }, body });
    } catch (e) {
      // Never bounce the sender on a parse error — best-effort delivery.
    }
  }
};
`
}
