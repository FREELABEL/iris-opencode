/**
 * Where couples live: a file on the node that holds the body.
 *
 * THIS IS THE ONE DESIGN DECISION OF THE BUILD, and #184906 forces it — "OFFLINE KINETICS: legal
 * only when sealed hash + couple record + device are all on the same node". A couple that lives
 * only in Atlas cannot authorise anything during an outage, which is exactly when an unattended
 * body is most likely to be moving. So the node-local file is the source of truth for the guard;
 * Atlas gets a published copy later, and a published copy is a report, not permission.
 *
 * A file that will not parse yields NO couples, never "skip the check" — see readCouples.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { AGENT_HASH, type Couple, type Actor } from "./kinetic-couple"
import { hostnameStem } from "./hive-local-node"
import type { ActRow } from "./kinetic-budget"
import { verifyCoupleSig } from "./kinetic-sign"

export const kineticDir = (): string => process.env.IRIS_KINETIC_HOME || join(process.env.IRIS_HOME || join(homedir(), ".iris"), "kinetic")
export const couplesPath = (): string => join(kineticDir(), "couples.json")
export const actLogPath = (): string => join(kineticDir(), "acts.jsonl")

export type ReadResult = { couples: Couple[]; error: string | null }

/**
 * Read the node's couples. A missing file is simply no couples. A CORRUPT file is also no couples,
 * plus an error the caller must show: the guard then refuses every agent act, which is the correct
 * failure for "I cannot tell what is permitted". Returning everything, or skipping the check, are
 * the two ways this goes wrong quietly.
 */
export function readCouples(): ReadResult {
  const p = couplesPath()
  if (!existsSync(p)) return { couples: [], error: null }
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"))
    if (!Array.isArray(raw)) return { couples: [], error: `${p} is not a list of couples` }
    const kept = raw.filter((c: unknown): c is Couple => !!c && typeof c === "object" && AGENT_HASH.test(String((c as Couple).agent ?? "")))
    // A node's own revocation outlives a re-import: an issued couple is still correctly signed
    // after it is revoked here, so the signature cannot be what withdraws it.
    const revoked = new Set(revokedIds())
    const couples = kept.map((c) => (revoked.has(c.id) && !c.revoked_at ? { ...c, revoked_at: "revoked-on-this-node" } : c))
    const dropped = raw.length - couples.length
    return { couples, error: dropped > 0 ? `${dropped} couple(s) in ${p} have no valid agent hash and were ignored` : null }
  } catch (e) {
    return { couples: [], error: `${p} could not be read: ${(e as Error).message}` }
  }
}

/** Atomic, owner-only. A half-written couples file is a file that cannot authorise anything. */
export function writeCouples(couples: Couple[]): void {
  mkdirSync(kineticDir(), { recursive: true, mode: 0o700 })
  const tmp = couplesPath() + ".tmp"
  writeFileSync(tmp, JSON.stringify(couples, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, couplesPath())
}

/** Every decision, allowed or refused, appended locally until Mint takes the ledger line (#184906 step 4). */
export function appendAct(record: unknown): void {
  try {
    mkdirSync(kineticDir(), { recursive: true, mode: 0o700 })
    appendFileSync(actLogPath(), JSON.stringify(record) + "\n", { mode: 0o600 })
  } catch {
    // Never fail an act because the log could not be written — but never claim it was logged either.
  }
}

/**
 * This node's key for couples.
 *
 * NOT `os.hostname()`. macOS rewrites it on every mDNS name collision (hive-local-node.ts records
 * one laptop reporting three names in a single run), and a couple keyed on a mutating string would
 * silently stop matching — which reads as "the guard is broken", not "the name changed". The stem
 * is the part that survives. IRIS_NODE_ID wins when the fleet has assigned one.
 */
export function nodeKey(): string {
  const explicit = String(process.env.IRIS_NODE_ID || "").trim()
  if (explicit) return explicit
  return hostnameStem(hostname()) || "unknown-node"
}

/**
 * Who is acting.
 *
 * An agent identifies itself with IRIS_AGENT (its sealed hash); anything else is an operator. The
 * default therefore cannot be "agent", so a missing variable can never dress a human up as a
 * coupled agent — it can only lose an agent its couple, which fails closed.
 */
export function currentActor(): Actor {
  const hash = String(process.env.IRIS_AGENT || "").trim()
  if (hash) return { kind: "agent", hash, label: process.env.IRIS_AGENT_LABEL || undefined }
  return { kind: "operator", who: process.env.USER || undefined }
}

/**
 * One id for THIS act, stable for the life of the process.
 *
 * The command-level gate and the instance-level gate both record, and without a shared id the same
 * act would be counted twice against its budget — a ceiling that halves itself is worse than none.
 */
let _actId: string | null = null
export function currentActId(): string {
  _actId ??= `act_${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 5).toString(36).padStart(5, "0")}`
  return _actId
}

export const currentRunId = (): string | null => String(process.env.IRIS_RUN_ID || "").trim() || null

/** Is this node locked down (an operator needs a couple too)? One file, one line, node-local. */
export function nodeIsLocked(): boolean {
  if (String(process.env.IRIS_KINETIC_LOCKED || "").trim() === "1") return true
  try {
    return existsSync(join(kineticDir(), "locked"))
  } catch {
    return false
  }
}

// ── issued couples: the trust store, and what survives a re-import ────────────────────────────

export const trustPath = (): string => join(kineticDir(), "trusted-issuers.json")
export const issuerKeyPath = (): string => join(kineticDir(), "issuer.key")
export const revokedPath = (): string => join(kineticDir(), "revoked.json")

/** Public keys this node accepts issued couples from. Empty means: only couples written here. */
export function trustedIssuers(): Record<string, string> {
  try {
    if (!existsSync(trustPath())) return {}
    const raw = JSON.parse(readFileSync(trustPath(), "utf-8"))
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string>) : {}
  } catch {
    // Unreadable trust store = trust nobody. The alternative (trust everybody) is how a signature
    // check becomes decoration.
    return {}
  }
}

export function trustIssuer(fingerprint: string, publicKeyPem: string): void {
  const all = trustedIssuers()
  all[fingerprint] = publicKeyPem
  mkdirSync(kineticDir(), { recursive: true, mode: 0o700 })
  writeFileSync(trustPath(), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 })
}

export function untrustIssuer(fingerprint: string): boolean {
  const all = trustedIssuers()
  if (!(fingerprint in all)) return false
  delete all[fingerprint]
  writeFileSync(trustPath(), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 })
  return true
}

/**
 * Couple ids revoked on this node.
 *
 * Kept SEPARATELY from the couples file, because a revoked issued couple would otherwise come back
 * the next time it is imported — the record is signed and still valid, so nothing about it says
 * "this node said no". A revocation is the node's own statement and outlives any re-import.
 */
export function revokedIds(): string[] {
  try {
    if (!existsSync(revokedPath())) return []
    const raw = JSON.parse(readFileSync(revokedPath(), "utf-8"))
    return Array.isArray(raw) ? raw.map(String) : []
  } catch {
    return []
  }
}

export function markRevoked(id: string): void {
  const all = new Set(revokedIds())
  all.add(id)
  mkdirSync(kineticDir(), { recursive: true, mode: 0o700 })
  writeFileSync(revokedPath(), JSON.stringify([...all], null, 2) + "\n", { mode: 0o600 })
}

/** The verifier the guard injects into `decide` — signature valid AND the issuer trusted here. */
export const sigVerifier = () => {
  const trusted = trustedIssuers()
  return (c: Parameters<typeof verifyCoupleSig>[0]) => verifyCoupleSig(c, trusted)
}

/** Recent act rows, for the spend windows. Tail-bounded: a year of acts should not be parsed to book one. */
export function recentActs(limit = 5000): ActRow[] {
  try {
    if (!existsSync(actLogPath())) return []
    const lines = readFileSync(actLogPath(), "utf-8").trim().split("\n").filter(Boolean)
    const out: ActRow[] = []
    for (const l of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(l))
      } catch {
        // one corrupt line must not hide the rest of the day's spend
      }
    }
    return out
  } catch {
    return []
  }
}
