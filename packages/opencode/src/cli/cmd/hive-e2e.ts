/**
 * End-to-end encryption for `iris hive send` — ON by default (epic "Hive without Tailscale", 2.1).
 *
 * Before this, `hive send` had two schemes:
 *   - legacy (default): AES-256-CBC under SHA-256(the sender's node_api_key). The platform issues
 *     and verifies node API keys, so it can derive that key; text and links weren't encrypted at
 *     all and went to the server in plain text.
 *   - ihw.v1 envelope (`--envelope`): a fresh key per transfer, wrapped to the RECIPIENT's
 *     registered X25519 public key, so only the recipient can read it. Off by default.
 *
 * MEASURED 2026-10-28, `--envelope` couldn't work for a signed-in user at all:
 *   1. /api/v6/hive/{keys,transfers/*} are `auth.node`, but the CLI called them with the USER
 *      token, and the API answered "Include your node API key". `iris hive keys register` failed
 *      the same way, so a node couldn't publish a key in the first place.
 *   2. dispatchToNode forwarded only `encrypted` + `encryption_iv`, dropping envelope_version,
 *      envelope_id, envelope_nonce, envelope_tag and envelope_target. A sealed upload would have
 *      reached the daemon with no way to open it.
 *
 * This module holds the parts that decide WHETHER to seal, so the decision can be tested
 * without a network.
 */
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const IRIS_API = process.env.IRIS_API_URL ?? "https://freelabel.net"

/** This machine's node API key — the only credential the envelope endpoints accept. */
export function readNodeApiKey(): string | null {
  try {
    const p = join(process.env.HOME || process.env.USERPROFILE || homedir(), ".iris", "config.json")
    if (!existsSync(p)) return null
    const cfg = JSON.parse(readFileSync(p, "utf-8"))
    return typeof cfg.node_api_key === "string" && cfg.node_api_key ? cfg.node_api_key : null
  } catch {
    return null
  }
}

export class NoNodeKeyError extends Error {
  constructor() {
    super("this machine is not a Hive node (no node_api_key in ~/.iris/config.json) — run `iris node install`")
  }
}

/**
 * Call an `auth.node` endpoint with this machine's node API key. Never falls back to the user
 * token: the API rejects that, and the rejection read like a key problem.
 */
export async function nodeKeyFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const key = readNodeApiKey()
  if (!key) throw new NoNodeKeyError()
  return fetch(`${IRIS_API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
      Authorization: `Bearer ${key}`,
    },
  })
}

/**
 * auto    — the default: seal when the recipient has a published key. Otherwise use the legacy
 *           scheme and print a warning that says what to run on the recipient.
 * require — `--envelope` / IRIS_HIVE_E2E=require: seal or refuse. Never downgrade.
 * off     — `--no-envelope` / IRIS_HIVE_E2E=off: legacy scheme, with a warning.
 */
export type E2eMode = "auto" | "require" | "off"

export function e2eMode(argvEnvelope: unknown, env: Record<string, string | undefined> = process.env): E2eMode {
  if (argvEnvelope === true) return "require"
  if (argvEnvelope === false) return "off"
  const v = (env.IRIS_HIVE_E2E ?? "").toLowerCase()
  if (v === "require" || env.IRIS_HIVE_ENVELOPE === "1") return "require"
  if (v === "off" || v === "0" || env.IRIS_HIVE_ENVELOPE === "0") return "off"
  return "auto"
}

/** What the targets lookup said, reduced to what the decision needs. */
export type TargetsOutcome =
  | { ok: true }
  | { ok: false; code: "no_recipient_key" | "no_node_key" | "server_policy" | "other"; message: string }

export type SealDecision =
  | { seal: true }
  | { seal: false; warning: string }
  | { seal: false; error: string }

export function decideSeal(
  mode: E2eMode,
  outcome: TargetsOutcome | null,
  recipient: string,
  opts: { explicitPolicy?: boolean } = {},
): SealDecision {
  const LEGACY =
    "it will use the older encryption, which our servers can decrypt (text and links go as plain text)"
  if (mode === "off") return { seal: false, warning: `End-to-end encryption is off (--no-envelope): ${LEGACY}.` }
  if (!outcome) return { seal: false, error: "could not look up the recipient's key" }
  if (outcome.ok) return { seal: true }

  if (mode === "require") {
    return { seal: false, error: `${outcome.message} (--envelope refuses to send without end-to-end encryption)` }
  }
  // auto: downgrade ONLY when the cause is a key that doesn't exist yet. Any other failure (network,
  // server error, an escrow-policy conflict) refuses, so we never send weaker encryption without saying so.
  if (outcome.code === "no_recipient_key") {
    return {
      seal: false,
      warning: `${recipient} has no end-to-end key yet, so ${LEGACY}. Run \`iris hive keys register\` on ${recipient} to fix it.`,
    }
  }
  // The server answered with a POLICY refusal (escrow), not a failure. MEASURED 2026-10-28: production's
  // default escrow policy is `required` and no escrow key is configured, so the server refuses every
  // envelope transfer. Refusing here would break `hive send` for everyone over a server setting, so the
  // default falls back and says why. A sender who named a policy (--class / --tenant) asked for one,
  // and is refused instead.
  if (outcome.code === "server_policy") {
    if (opts.explicitPolicy) return { seal: false, error: `end-to-end encryption refused by policy: ${outcome.message}` }
    return { seal: false, warning: `The server can't issue end-to-end transfers yet (${outcome.message}), so ${LEGACY}.` }
  }
  if (outcome.code === "no_node_key") {
    return { seal: false, warning: `This machine isn't a Hive node, so it can't seal for ${recipient}; ${LEGACY}.` }
  }
  return { seal: false, error: `end-to-end encryption failed: ${outcome.message}` }
}

/**
 * The task config for a sealed delivery. Every envelope field the daemon needs to open it has
 * to be here; dropping them is the bug this replaces.
 */
export function sealedConfigFields(payload: Record<string, unknown>): Record<string, unknown> {
  if (!payload.encrypted) return {}
  if (payload.envelope_version) {
    return {
      encrypted: true,
      envelope_version: payload.envelope_version,
      envelope_id: payload.envelope_id,
      envelope_nonce: payload.envelope_nonce,
      envelope_tag: payload.envelope_tag,
      envelope_target: payload.envelope_target,
    }
  }
  return { encrypted: true, encryption_iv: payload.encryption_iv }
}
