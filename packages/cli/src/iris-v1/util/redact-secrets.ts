// Credential shapes that must never reach a PUBLIC artifact (#186275).
//
// The capability index folds PRIVATE playbook/skill prose into capabilities.json, which is committed
// to the public iris-opencode repo and embedded in every CLI binary. Full URLs are already dropped
// there, but a secret written without a scheme, or an API key in running text, was not. Redact by
// SHAPE, not by a list of known secrets: the next leak is always one nobody listed.
export const SECRET_SHAPES: [string, RegExp][] = [
  ["discord webhook", /(?:discord(?:app)?\.com\/)?api\/webhooks\/\d{6,}(?:\/[A-Za-z0-9_-]+)?/gi],
  ["slack webhook", /hooks\.slack\.com\/services\/[A-Za-z0-9/]+/gi],
  ["model API key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ["IRIS node key", /\bnode_(?:live|test|local)_[A-Za-z0-9]{12,}/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}/g],
  ["Stripe key", /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g],
  ["bearer literal", /Bearer\s+[A-Za-z0-9._-]{30,}/g],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
]

export function redactSecrets(text: string): string {
  let out = text
  for (const [, re] of SECRET_SHAPES) out = out.replace(re, "[redacted]")
  return out
}

/** Names of the shapes found — for guards that must fail, never print the value. */
export function findSecretShapes(text: string): string[] {
  return SECRET_SHAPES.filter(([, re]) => new RegExp(re.source, re.flags).test(text)).map(([n]) => n)
}
