/**
 * `iris org explain` — the verdict half, pure (#192421, epic #192420).
 *
 * The cloud reports what its gates decide (`GET /api/v1/agents/{id}/authority`). It cannot see
 * Kinetic couples, which live on each node — so this joins the cloud's report with THIS node's
 * couples for the agent's sealed hash, and returns one verdict. No I/O here: platform-org.ts
 * fetches, this decides, and the tests can drive every branch.
 */

import { decide, isActive, type Couple } from "./kinetic-couple"

export interface CloudVerify {
  ok: boolean
  failures: Array<{ code: string; [k: string]: unknown }>
  warnings: Array<{ code: string; [k: string]: unknown }>
}

export interface KineticRow {
  couple_id: string
  body: string
  verbs: Array<{ verb: string; decision: string; reason: string }>
  active: boolean
  expires_at: string | null
  issued: boolean
}

export interface KineticView {
  node: string
  hash: string
  couples: KineticRow[]
  acts_7d: { allow: number; deny: number }
}

/**
 * This node's couples for one agent hash, each verb asked of `decide()` — the same function the
 * guard uses before a body moves, so the sheet cannot say "allowed" where the guard says no.
 */
export function kineticFor(args: {
  hash: string
  node: string
  couples: Couple[]
  acts: Array<{ ts?: string; agent?: string | null; decision?: string }>
  now: string
  verifySig?: (c: Couple) => boolean
  enforceOperators?: boolean
}): KineticView {
  const mine = args.couples.filter((c) => c.agent === args.hash && c.node === args.node)
  const rows: KineticRow[] = mine.map((c) => ({
    couple_id: c.id,
    body: c.body,
    active: isActive(c, args.now),
    expires_at: c.policy?.expires_at ?? null,
    issued: !!c.sig,
    verbs: c.allowlist.map((verb) => {
      const d = decide({
        actor: { kind: "agent", hash: args.hash },
        node: args.node,
        body: c.body.endsWith(":*") ? c.body.replace(/\*$/, "any") : c.body,
        verb,
        estimatedCents: null,
        couples: args.couples,
        now: args.now,
        enforceOperators: args.enforceOperators ?? false,
        verifySig: args.verifySig,
      })
      return { verb, decision: d.decision, reason: d.reason }
    }),
  }))
  const since = new Date(args.now).getTime() - 7 * 86400_000
  const acts_7d = { allow: 0, deny: 0 }
  for (const a of args.acts) {
    if (a.agent !== args.hash || !a.ts || new Date(a.ts).getTime() < since) continue
    if (a.decision === "deny") acts_7d.deny++
    else if (a.decision === "allow") acts_7d.allow++
  }
  return { node: args.node, hash: args.hash, couples: rows, acts_7d }
}

export interface Verdict {
  ok: boolean
  failures: Array<{ code: string; detail: string }>
  warnings: Array<{ code: string; detail: string }>
}

/**
 * One verdict from both halves. The cloud's failures stand. Its `kinetic_unknown` warning is
 * replaced by what this node actually holds — unknown in the cloud, KNOWN here. A couple that
 * claims a verb the guard would refuse (expired, revoked, unsigned on a locked node) is a failure:
 * the sheet would be telling someone the agent can do a thing it cannot.
 */
export function verdict(cloud: CloudVerify, kinetic: KineticView | null): Verdict {
  const failures = cloud.failures.map((f) => ({ code: f.code, detail: describe(f) }))
  const warnings = cloud.warnings
    .filter((w) => !(kinetic && w.code === "kinetic_unknown"))
    .map((w) => ({ code: w.code, detail: describe(w) }))
  if (kinetic) {
    for (const c of kinetic.couples) {
      for (const v of c.verbs) {
        if (c.active && v.decision === "deny")
          failures.push({ code: "couple_claims_refused_verb", detail: `${c.body} ${v.verb}: the couple lists it, the guard refuses it — ${v.reason}` })
      }
      if (!c.active) warnings.push({ code: "inactive_couple", detail: `${c.couple_id} on ${c.body} is expired or revoked` })
    }
    if (kinetic.couples.length === 0) warnings.push({ code: "no_couples_here", detail: `no couples for this agent on ${kinetic.node}` })
  }
  return { ok: failures.length === 0, failures, warnings }
}

function describe(x: { code: string; [k: string]: unknown }): string {
  if (typeof x.detail === "string") return x.detail
  if (x.code === "claim_mismatch")
    return `${x.effect} in ${x.mode}: the trust level says ${x.claimed}, the gate does ${x.actual} (${x.tool}${x.source ? `, ${x.source}` : ""})`
  return x.code
}
