/**
 * Attribution tags for every upgrade / pricing link the CLI or desktop app prints or opens.
 *
 * Upgrades check out on web.heyiris.io/pricing (or web.freelabel.net/pricing), which records
 * UTMs into a first-party `fl_attr` cookie and forwards them to Stripe. A link with no tags
 * makes every upgrade look "direct", so we could not tell which in-app prompt — or which ad
 * that drove the install — produced the sale. This tags the link with:
 *
 *   utm_source   iris_desktop | iris_cli      (which client the user was in)
 *   utm_medium   app
 *   utm_campaign upgrade
 *   utm_content  <surface>                    (stable slug for the prompt that showed it)
 *   device_id    <id>                         (when known; pricing maps it to cli_device_id)
 *
 * Rules:
 * - Only ADDS params that are absent. Anything already on the URL (source=cli, a token, a
 *   campaign the server chose) wins.
 * - Never changes the host or path — a FREELABEL link stays FREELABEL (see pricing.ts, rule 2).
 * - Server-provided URLs are left untouched when tagging could break them: signed URLs
 *   (Laravel `signature`, AWS-style `X-Amz-Signature`) and Stripe-hosted pages, where an extra
 *   param invalidates the signature or is simply dropped. Anything unparseable or non-http(s)
 *   is returned as-is.
 */

export type UpgradeClient = "iris_cli" | "iris_desktop"

export interface UpgradeUrlOptions {
  /** Short, stable slug for the in-app prompt, e.g. "pricing_cmd", "subscription_error". */
  surface: string
  /** The installed device's id, when this surface knows it. */
  deviceId?: string
  /** Defaults from OPENCODE_CLIENT: the Tauri desktop sidecar sets it to "desktop". */
  client?: UpgradeClient
}

/** The desktop app spawns the CLI with OPENCODE_CLIENT=desktop (packages/desktop/src-tauri/src/lib.rs). */
export function upgradeClient(env: Record<string, string | undefined> = process.env): UpgradeClient {
  return env["OPENCODE_CLIENT"] === "desktop" ? "iris_desktop" : "iris_cli"
}

const SIGNATURE_PARAMS = ["signature", "x-amz-signature", "sig"]
const UNTOUCHABLE_HOSTS = ["checkout.stripe.com", "billing.stripe.com", "buy.stripe.com"]

export function upgradeUrl(base: string, opts: UpgradeUrlOptions): string {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return base
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return base
  if (UNTOUCHABLE_HOSTS.includes(url.hostname.toLowerCase())) return base
  for (const key of url.searchParams.keys()) {
    if (SIGNATURE_PARAMS.includes(key.toLowerCase())) return base
  }

  const add: Array<[string, string | undefined]> = [
    ["utm_source", opts.client ?? upgradeClient()],
    ["utm_medium", "app"],
    ["utm_campaign", "upgrade"],
    ["utm_content", opts.surface],
    ["device_id", opts.deviceId],
  ]
  for (const [key, value] of add) {
    if (!value) continue
    if (url.searchParams.has(key)) continue
    url.searchParams.set(key, value)
  }
  return url.toString()
}
