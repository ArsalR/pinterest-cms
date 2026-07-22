// src/modules/integrations/recipes.ts
// Copy-paste integration recipes (V1.5 M2) + an importable n8n workflow. Pure
// builders so the content is testable and stays in sync with the real routes:
// event webhooks (Site → n8n/GHL) and the scoped public API (n8n → Site).

/** A minimal, valid n8n workflow: a Webhook trigger that receives this site's
 *  events. Importable via n8n → Workflows → Import from File/URL. Pure. */
export function n8nSiteTriggerWorkflow(): Record<string, unknown> {
  return {
    name: "SiteNetwork — site events trigger",
    nodes: [
      {
        parameters: { httpMethod: "POST", path: "sitenetwork-events", options: {} },
        id: "webhook-1",
        name: "Site event",
        type: "n8n-nodes-base.webhook",
        typeVersion: 1,
        position: [260, 300],
        webhookId: "sitenetwork-events",
      },
      {
        parameters: {
          conditions: { string: [{ value1: "={{$json[\"body\"][\"event\"]}}", operation: "equals", value2: "form.submitted" }] },
        },
        id: "if-1",
        name: "Is a form submission?",
        type: "n8n-nodes-base.if",
        typeVersion: 1,
        position: [520, 300],
      },
    ],
    connections: {
      "Site event": { main: [[{ node: "Is a form submission?", type: "main", index: 0 }]] },
    },
    settings: {},
    active: false,
  }
}

export interface Recipe { id: string; title: string; body: string }

/** The three recipes shown on the dashboard. `origin` = the site's public API
 *  base (https://<host>/api/public) so the copy-paste snippets are real. */
export function recipes(host: string, siteId: string): Recipe[] {
  const api = `https://${host}/api/public/v1`
  return [
    {
      id: "site-to-n8n",
      title: "Site → n8n",
      body:
        `1. In n8n, add a <strong>Webhook</strong> node (HTTP Method: POST). Copy its <em>Production URL</em>.\n` +
        `2. Here in <strong>Event webhooks</strong>, add a subscription with that URL and tick the events you want (e.g. form.submitted).\n` +
        `3. Verify the <code>X-Webhook-Signature</code> header (HMAC-SHA256 of the raw body with your subscription secret) in a Function node.\n` +
        `Import the starter workflow below to skip steps 1 &amp; 3.`,
    },
    {
      id: "site-to-ghl",
      title: "Site → GoHighLevel (lead from a form)",
      body:
        `1. In GoHighLevel, create an <strong>Inbound Webhook</strong> trigger and copy its URL.\n` +
        `2. Add an Event-webhook subscription here for <code>form.submitted</code> pointing at that URL.\n` +
        `3. Map the payload's <code>data.fields.email</code> / <code>data.fields.name</code> into a GHL contact.\n` +
        `Every form submission now creates/updates a GHL contact automatically.`,
    },
    {
      id: "n8n-to-site",
      title: "n8n → Site (publish a post via the API)",
      body:
        `1. Create a scoped key here with the <code>write-posts</code> scope.\n` +
        `2. In n8n use an <strong>HTTP Request</strong> node: <code>POST ${api}/posts</code>, header <code>Authorization: Bearer sk_site_…</code>, JSON body <code>{"title":"…","content":"…","published":true}</code>.\n` +
        `3. Point its HTTP node at <code>${api.replace("/v1", "")}/v1/openapi.json</code> to autocomplete every endpoint.\n` +
        `Site id: <code>${siteId}</code>.`,
    },
  ]
}
