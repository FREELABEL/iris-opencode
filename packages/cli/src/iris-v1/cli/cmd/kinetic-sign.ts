/**
 * SIGNED COUPLES — how a fleet gets coupled without giving up the offline rule.
 *
 * Node-local couples were right and did not scale: coupling one agent across twenty nodes was
 * twenty commands typed on twenty machines, and revoking it was twenty more. The obvious fix —
 * keep couples in Atlas and fetch them — breaks the rule that makes the clutch trustworthy: a
 * couple that needs the network cannot authorise anything during an outage, which is exactly when
 * an unattended body is most likely to be moving.
 *
 * So the couple is ISSUED centrally and VERIFIED locally. An issuer signs it with an ed25519 key;
 * the node checks the signature against issuers it already trusts, with no call to anyone. The
 * cloud copy is still a report — the signature is the permission, and it travels with the record.
 *
 * Revocation keeps the same shape: short expiries re-issued on a heartbeat, plus a local revoke
 * that outlives any re-import (see `revokedIds` in the store).
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto"
import type { Couple } from "./kinetic-couple"

export interface CoupleSig {
  alg: "ed25519"
  /** Fingerprint of the issuing public key — which issuer, not which key file. */
  issuer: string
  value: string
}

export interface IssuerKeys {
  issuer: string
  publicKeyPem: string
  privateKeyPem: string
}

/**
 * The bytes that are signed.
 *
 * EVERY FIELD THAT GRANTS ANYTHING IS IN HERE — agent, node, body, allowlist, policy, expiry. A
 * field left out is a field an attacker may edit without breaking the signature, so "which fields
 * are covered" is the whole security of this file. `sig` itself is excluded, and `agent_label` is
 * excluded because it is decoration: changing it grants nothing.
 */
export function canonicalCouple(c: Couple): string {
  const p = c.policy ?? {}
  return JSON.stringify([
    "kinetic.couple.v1",
    c.id,
    c.agent,
    c.node,
    c.body,
    [...(c.allowlist ?? [])].map((v) => String(v).toLowerCase()).sort(),
    [
      numOrNull(p.max_single_expense_cents),
      numOrNull((p as { max_run_cents?: number | null }).max_run_cents),
      numOrNull((p as { max_day_cents?: number | null }).max_day_cents),
      numOrNull((p as { max_day_acts?: number | null }).max_day_acts),
      p.hitl === true,
      p.expires_at ?? null,
    ],
    c.created_at,
  ])
}

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** A short, stable name for a public key, so a node can say WHICH issuer it trusts. */
export function issuerFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" })
  return "iss_" + createHash("sha256").update(der).digest("hex").slice(0, 16)
}

export function generateIssuer(): IssuerKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString()
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  return { issuer: issuerFingerprint(publicKeyPem), publicKeyPem, privateKeyPem }
}

export function signCouple(c: Couple, privateKeyPem: string, issuer?: string): CoupleSig {
  const key = createPrivateKey(privateKeyPem)
  const value = cryptoSign(null, Buffer.from(canonicalCouple(c)), key).toString("base64")
  const iss = issuer ?? issuerFingerprint(createPublicKey(key).export({ type: "spki", format: "pem" }).toString())
  return { alg: "ed25519", issuer: iss, value }
}

/**
 * Does this couple carry a good signature from an issuer this node trusts?
 *
 * Fails closed on every abnormal path: an unknown issuer, an algorithm we do not implement, a
 * malformed key, unparseable base64, a thrown verify. A couple we cannot check is not permission.
 */
export function verifyCoupleSig(c: Couple, trusted: Record<string, string>): boolean {
  const sig = (c as Couple & { sig?: CoupleSig | null }).sig
  if (!sig) return false
  if (sig.alg !== "ed25519") return false
  const pem = trusted?.[sig.issuer]
  if (!pem) return false
  try {
    return cryptoVerify(null, Buffer.from(canonicalCouple(c)), createPublicKey(pem), Buffer.from(sig.value, "base64"))
  } catch {
    return false
  }
}
