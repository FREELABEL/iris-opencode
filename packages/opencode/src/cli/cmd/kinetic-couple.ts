/**
 * THE CLUTCH — the couple record, and the decision that uses it.
 *
 * KINETICS — THE CLUTCH (#184906) states the rule in one sentence: "A Kinetic act is a minted
 * agent, on a node that holds both the hash and a named body, passing a command the allowlist
 * already blessed." Everything in this file is that sentence, made refusable.
 *
 * Pure on purpose (same reason as comms-log-group.ts): the guard is the part that must never be
 * wrong, so it is testable without a camera, a node, a network or the CLI's yargs graph.
 *
 * WHY THE DECISION FAILS CLOSED. Every path that is not a match returns "deny". A malformed body,
 * an unparseable hash, an empty allowlist, a couple for another node — none of them fall through
 * to allow. `iris hive run` can already dispatch any shell command to a node, so the only thing
 * standing between a sealed hash and a physical body is this function saying no.
 */

import { createHash } from "node:crypto"
import { budgetRefusal, EMPTY_SPEND, type BudgetPolicy, type Spend } from "./kinetic-budget"

/** A sealed agent identity. Mint (#184905) will issue these; until then `sealAgent` derives one. */
export const AGENT_HASH = /^sha256:[0-9a-f]{64}$/
/** `class:instance` — `camera:obsbot-tiny`, `obs:studio`, `device:iphone`. `class:*` is a wildcard. */
export const BODY = /^[a-z0-9]+:[a-z0-9._*-]+$/
export const VERB = /^[a-z][a-z0-9-]*$/

export type Actor = { kind: "agent"; hash: string; label?: string } | { kind: "operator"; who?: string }

export interface CouplePolicy extends BudgetPolicy {
  /** A single act may not exceed this. Absent means no ceiling from the couple. */
  max_single_expense_cents?: number | null
  /** A human confirms each act. The guard answers "hitl" — it never confirms on the human's behalf. */
  hitl?: boolean
  expires_at?: string | null
}

export interface Couple {
  id: string
  agent: string
  agent_label?: string | null
  node: string
  body: string
  allowlist: string[]
  policy: CouplePolicy
  created_at: string
  revoked_at?: string | null
  /** Present when the couple was ISSUED rather than written here — see kinetic-sign.ts. */
  sig?: { alg: "ed25519"; issuer: string; value: string } | null
}

export type Decision = {
  decision: "allow" | "deny" | "hitl"
  reason: string
  couple_id?: string
  /** An operator act on an unlocked node: allowed, but it is NOT an agent act and is booked as such. */
  unbound?: boolean
}

export interface ActRequest {
  actor: Actor
  node: string
  body: string
  verb: string
  estimatedCents?: number | null
  couples: Couple[]
  now: string
  /** Lock the node down so even an operator needs a couple. Off by default; a node-local choice. */
  enforceOperators?: boolean
  /**
   * What this couple has already spent (kinetic-budget). Absent means "nothing known", which is
   * only safe because the per-act ceiling is still checked — see the test that pins it.
   */
  spend?: Spend
  /**
   * Verifies an ISSUED couple's signature. Injected so this file stays pure and so the failure is
   * explicit: a signed couple with NO verifier available is refused, never waved through.
   */
  verifySig?: (c: Couple) => boolean
}

/**
 * Seal an agent's definition into an identity hash.
 *
 * The hash is over the definition itself, so editing the agent produces a different hash and every
 * couple sealed to the old one stops matching. That is the audit property minting exists for
 * (#184905) — "you can no longer prove which version of the agent produced which action" — and it
 * works today, before Mint issues hashes of its own. Key order must not change the identity, hence
 * the stable stringify.
 */
export function sealAgent(definition: unknown): string {
  return "sha256:" + createHash("sha256").update(stableStringify(definition)).digest("hex")
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]"
  const o = v as Record<string, unknown>
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}"
}

/** `Camera:OBSBOT-Tiny ` → `camera:obsbot-tiny`. Returns null for anything that is not `class:instance`. */
export function normalizeBody(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim().toLowerCase()
  return BODY.test(s) ? s : null
}

/**
 * A real device's name, as a body name: `OBSBOT Tiny 2 (USB)` → `camera:obsbot-tiny-2-usb`.
 *
 * It must be STABLE, because it is half of what a couple binds to — a body name that changes with
 * capitalisation or a trailing space would revoke a couple by accident, and the refusal would look
 * like a broken guard rather than a renamed device.
 */
export function bodyForDevice(kind: string, name: string): string | null {
  const k = String(kind ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "")
  const slug = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return k && slug ? normalizeBody(`${k}:${slug}`) : null
}

/** A couple for `camera:*` covers every camera on that node; `camera:obsbot-tiny` covers one. */
export function bodyMatches(pattern: string, body: string): boolean {
  const p = normalizeBody(pattern)
  const b = normalizeBody(body)
  if (!p || !b) return false
  if (p === b) return true
  const [pc, pi] = p.split(":")
  const [bc] = b.split(":")
  return pi === "*" && pc === bc
}

export function isActive(c: Couple, now: string): boolean {
  if (c.revoked_at) return false
  const exp = c.policy?.expires_at
  // An unparseable expiry is treated as expired: a date we cannot read is not permission.
  if (exp) {
    const t = Date.parse(exp)
    if (!Number.isFinite(t) || t <= Date.parse(now)) return false
  }
  return true
}

/** Every active couple that binds this hash, on this node, to this body. Exact body first. */
export function findCouples(couples: Couple[], q: { agent: string; node: string; body: string; now: string }): Couple[] {
  // AGENT_HASH is re-checked on the STORED side too, not only the caller's. A couples file with
  // `agent: ""` in it would otherwise match a caller with no identity and hand it a body — the
  // malformed record and the unsealed caller cancelling out into an allow.
  const hits = (couples ?? []).filter(
    (c) =>
      c &&
      AGENT_HASH.test(String(c.agent ?? "")) &&
      c.agent === q.agent &&
      c.node === q.node &&
      bodyMatches(c.body, q.body) &&
      isActive(c, q.now),
  )
  return hits.sort((a, b) => Number(b.body.endsWith(":*") === false) - Number(a.body.endsWith(":*") === false))
}

export function verbAllowed(c: Couple, verb: string): boolean {
  const v = String(verb ?? "").trim().toLowerCase()
  if (!VERB.test(v)) return false
  const list = c.allowlist ?? []
  return list.includes(v) || list.includes("*")
}

/** A short id — readable in a refusal message and in the ledger line that follows an act. */
export function coupleId(now = Date.now(), rand = Math.random): string {
  return `cpl_${now.toString(36)}${Math.floor(rand() * 36 ** 4).toString(36).padStart(4, "0")}`
}

/**
 * Shared pre-flight: verb, node, operator, sealed hash, signature check. Both the instance-level
 * decision and the class-level pre-check run it, so there is ONE set of rules, not two that drift.
 */
function preflight(req: { actor: Actor; node: string; verb: string; couples: Couple[]; enforceOperators?: boolean; verifySig?: (c: Couple) => boolean }):
  | { stop: Decision }
  | { hash: string; node: string; verb: string; usable: Couple[]; unverified: number } {
  const verb = String(req?.verb ?? "").trim().toLowerCase()
  if (!VERB.test(verb)) return { stop: { decision: "deny", reason: `not a verb: ${JSON.stringify(req?.verb ?? null)}` } }

  const node = String(req?.node ?? "").trim()
  if (!node) return { stop: { decision: "deny", reason: "no node id — a couple is only valid on the node that holds the body" } }

  if (req.actor?.kind === "operator") {
    if (!req.enforceOperators) {
      return { stop: { decision: "allow", reason: `operator act on an unlocked node — recorded as unbound, not as an agent act`, unbound: true } }
    }
    return { stop: { decision: "deny", reason: `this node requires a couple for every act, including an operator's. Seal a hash and couple it, or unlock the node.` } }
  }

  const hash = String((req.actor as { hash?: string })?.hash ?? "")
  if (!AGENT_HASH.test(hash)) {
    return { stop: { decision: "deny", reason: `not a sealed agent hash: ${hash ? hash.slice(0, 16) + "…" : "(none)"} — an unsealed caller has no identity to couple` } }
  }

  // An ISSUED couple must prove it was issued. Unsigned couples are node-local by definition —
  // they were written on this machine, and they already name this node, so they do not travel.
  let unverified = 0
  const usable = (req.couples ?? []).filter((c) => {
    if (!c?.sig) return true
    const ok = req.verifySig?.(c) === true
    if (!ok) unverified++
    return ok
  })

  return { hash, node, verb, usable, unverified }
}

/** The verb / budget / hitl loop, over whichever couples were found to match. */
function evaluate(req: ActRequest | ClassRequest, verb: string, matches: Couple[], target: string): Decision {
  let refusal: Decision | null = null
  for (const c of matches) {
    if (!verbAllowed(c, verb)) {
      refusal ??= { decision: "deny", reason: `couple ${c.id} does not bless "${verb}" — its allowlist is [${(c.allowlist ?? []).join(", ") || "empty"}]`, couple_id: c.id }
      continue
    }
    // Ceilings: this act, this run, today, and how many acts today. The per-act cap alone never
    // fires on a night of cheap acts, which is the shape most runaway automation actually has.
    const overBudget = budgetRefusal(c.policy, req.spend ?? EMPTY_SPEND, req.estimatedCents)
    if (overBudget) {
      refusal ??= { decision: "deny", reason: `couple ${c.id}: ${overBudget}`, couple_id: c.id }
      continue
    }
    if (c.policy?.hitl) return { decision: "hitl", reason: `couple ${c.id} requires a human to confirm each act`, couple_id: c.id }
    return { decision: "allow", reason: `couple ${c.id} blesses "${verb}" on ${target}`, couple_id: c.id }
  }
  return refusal ?? { decision: "deny", reason: "refused" }
}

/**
 * The guard. One function, because a second copy of this decision is a second place for a body to
 * move without one (the lane-parity lesson from the Genesis sandbox runbook).
 */
export function decide(req: ActRequest): Decision {
  const body = normalizeBody(req?.body)
  if (!body) return { decision: "deny", reason: `not a body name: ${JSON.stringify(req?.body ?? null)} — expected class:instance, e.g. camera:obsbot-tiny` }

  const pre = preflight(req)
  if ("stop" in pre) return pre.stop
  const { hash, node, verb, usable, unverified } = pre

  const matches = findCouples(usable, { agent: hash, node, body, now: req.now })
  if (matches.length === 0) {
    const why = whyNoCouple(usable, { agent: hash, node, body, now: req.now })
    const sigNote = unverified > 0 ? ` — and ${unverified} issued couple(s) here could not be verified against a trusted issuer` : ""
    return { decision: "deny", reason: `no couple binds ${hash.slice(0, 13)}… to ${body} on ${node}${why}${sigNote}` }
  }

  return evaluate(req, verb, matches, body)
}

export interface ClassRequest extends Omit<ActRequest, "body"> {
  /** `camera`, `obs`, `node`, … — the class half, when the instance is not known yet. */
  bodyClass: string
}

/**
 * THE CHOKE POINT'S DECISION: does this agent hold ANY couple for this CLASS of body, with this
 * verb, on this node?
 *
 * It exists because the middleware runs before a command has selected its device, and waiting for
 * the instance is what made enforcement opt-in. This is deliberately coarser than `decide`: it
 * cannot say WHICH camera, so a couple for any camera passes here and the instance-level check in
 * the act path still has to agree. Coarse-then-fine, never coarse-instead-of-fine — a pass here is
 * not permission to move anything, it is only "you are not obviously unauthorised".
 */
export function decideClass(req: ClassRequest): Decision {
  const cls = String(req?.bodyClass ?? "").trim().toLowerCase()
  if (!/^[a-z0-9]+$/.test(cls)) return { decision: "deny", reason: `not a body class: ${JSON.stringify(req?.bodyClass ?? null)}` }

  const pre = preflight(req)
  if ("stop" in pre) return pre.stop
  const { hash, node, verb, usable, unverified } = pre

  const matches = usable.filter(
    (c) =>
      c &&
      AGENT_HASH.test(String(c.agent ?? "")) &&
      c.agent === hash &&
      c.node === node &&
      String(c.body ?? "").split(":")[0] === cls &&
      isActive(c, req.now),
  )
  if (matches.length === 0) {
    const sigNote = unverified > 0 ? ` — and ${unverified} issued couple(s) here could not be verified against a trusted issuer` : ""
    return { decision: "deny", reason: `no couple binds ${hash.slice(0, 13)}… to any ${cls} on ${node}${sigNote}` }
  }

  return evaluate(req, verb, matches, `${cls}:*`)
}

/** The half-match is the useful half of a refusal: it says WHICH part is wrong, without leaking others' couples. */
function whyNoCouple(couples: Couple[], q: { agent: string; node: string; body: string; now: string }): string {
  const forAgent = (couples ?? []).filter((c) => c?.agent === q.agent)
  if (forAgent.length === 0) return " — this hash has no couples at all"
  if (forAgent.some((c) => c.node !== q.node && bodyMatches(c.body, q.body) && isActive(c, q.now)))
    return ` — it is coupled to that body on another node, and a couple does not travel`
  if (forAgent.some((c) => c.node === q.node && bodyMatches(c.body, q.body) && !isActive(c, q.now)))
    return ` — the couple that would allow it is revoked or expired`
  return ` — it holds couples for other bodies`
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

/** The line an act writes back, whatever the decision — a refusal is a fact worth keeping too. */
export function actRecord(req: ActRequest, d: Decision, runId?: string | null, actId?: string | null) {
  return {
    act_id: actId ?? null,
    ts: req.now,
    node: req.node,
    body: normalizeBody(req.body) ?? String(req.body ?? ""),
    verb: String(req.verb ?? "").trim().toLowerCase(),
    actor: req.actor?.kind ?? "unknown",
    agent: req.actor?.kind === "agent" ? req.actor.hash : null,
    couple_id: d.couple_id ?? null,
    decision: d.decision,
    reason: d.reason,
    unbound: d.unbound === true,
    estimated_cents: typeof req.estimatedCents === "number" ? req.estimatedCents : null,
    run_id: runId ?? null,
  }
}
