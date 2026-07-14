// src/lib/saas/anthropic.ts
// Optional customer Anthropic key (decision #9: customer-side inference).
// Live validation only — the key is stored vault-encrypted and later set as a
// repo secret in the customer's own GitHub (Phase 3); the platform never
// calls the Anthropic API with it beyond this one-shot validation.

export interface AnthropicKeyCheck {
  valid: boolean
  problem: string | null
}

export async function verifyAnthropicKey(key: string): Promise<AnthropicKeyCheck> {
  const k = key.trim()
  if (!k.startsWith("sk-ant-")) {
    return { valid: false, problem: 'That doesn\'t look like an Anthropic API key — they start with "sk-ant-".' }
  }
  try {
    const resp = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": k, "anthropic-version": "2023-06-01" },
    })
    if (resp.status === 401 || resp.status === 403) {
      return { valid: false, problem: "Anthropic says this key isn't valid — check it in the Anthropic console and paste it again." }
    }
    if (!resp.ok) {
      return { valid: false, problem: "Couldn't confirm the key with Anthropic just now — please try again in a minute." }
    }
    return { valid: true, problem: null }
  } catch {
    return { valid: false, problem: "Couldn't reach Anthropic to check the key — please try again." }
  }
}
