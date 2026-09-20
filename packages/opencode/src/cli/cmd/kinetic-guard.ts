/**
 * The guard as the act paths call it: one await before a body moves.
 *
 * `iris camera`, `iris obs` and `iris device` will drive hardware for whoever runs them, and
 * `iris hive run` will dispatch a shell command to a node. That is raw kinetic energy with no
 * mass identity (#184906). This is where a sealed hash is required to have a couple first.
 *
 * The impure half — files, env, the terminal. Every rule lives in kinetic-couple.ts, which is
 * pure and tested; this only fetches the inputs and turns a decision into an exit code.
 */

import * as prompts from "./clack"
import { dim, bold } from "./iris-api"
import { decide, decideClass, actRecord, normalizeBody, type Couple, type Decision } from "./kinetic-couple"
import { readCouples, appendAct, nodeKey, currentActor, currentRunId, currentActId, nodeIsLocked, sigVerifier, recentActs } from "./kinetic-store"
import { spendFor, EMPTY_SPEND } from "./kinetic-budget"
import { routeFor, declaredCents } from "./kinetic-bodies"

/** Exit 5 is the house code for "refused, and not because it broke" — same as a gated edge export. */
export const REFUSED = 5

/**
 * THE CHOKE POINT. One middleware, every command, consulted before any handler runs.
 *
 * The first build wired the guard into two act paths by hand, which left `iris device`, `iris hive
 * run` and everything written next month unguarded — enforcement was opt-in, and opt-in
 * enforcement is the failure Genesis invariant 4 describes. Here the route table decides whether a
 * command is an act, so a new act path is guarded by adding a row rather than by remembering.
 *
 * It is a CLASS-level check, because the instance is not known until the handler selects a device.
 * The act paths still run the instance check. Coarse first, fine second — never coarse instead.
 */
export async function guardCommand(argv: string[], parsed?: string[]): Promise<void> {
  const route = routeFor(argv, parsed)
  if (!route) return // a read, or a command that acts on nothing

  const actor = currentActor()
  const { couples, error } = readCouples()
  const now = new Date().toISOString()
  const estimatedCents = declaredCents(argv)
  const verifySig = sigVerifier()

  // When the argv already names the instance — `iris hive run <node>` — ask the PRECISE question
  // here. Only the paths that pick their device inside the handler (a camera) fall back to the
  // class-level check, and those re-ask precisely in the act path.
  const base = { actor, node: nodeKey(), verb: route.verb, estimatedCents, couples, now, enforceOperators: nodeIsLocked(), verifySig }
  const ask = (spend?: typeof EMPTY_SPEND) =>
    route.instance
      ? decide({ ...base, body: `${route.class}:${route.instance}`, spend })
      : decideClass({ ...base, bodyClass: route.class, spend })

  const first = ask()
  const spend = first.couple_id ? spendFor(recentActs(), { coupleId: first.couple_id, runId: currentRunId(), now }) : EMPTY_SPEND
  const d = ask(spend)

  // RECORD THE ALLOW TOO. `iris hive run`, `iris device clean --apply` and `iris n8n trigger` have
  // no instance-level call site, so if only refusals were recorded their spend would stay at zero
  // for ever and every ceiling would be unreachable — measured, not theorised: three 60c acts under
  // a $1.50 day cap booked $0.00. The act_id makes the second gate's row collapse onto this one.
  if (d.decision !== "deny") {
    appendAct({
      act_id: currentActId(), ts: now, node: nodeKey(), body: `${route.class}:${route.instance ?? "*"}`, verb: route.verb,
      actor: actor.kind, agent: actor.kind === "agent" ? actor.hash : null, couple_id: d.couple_id ?? null,
      decision: "allow", reason: d.reason, unbound: d.unbound === true, estimated_cents: estimatedCents,
      run_id: currentRunId(), gate: "command",
    })
    return // "hitl" is confirmed at the act path, where the instance can be named
  }

  appendAct({
    act_id: currentActId(), ts: now, node: nodeKey(), body: `${route.class}:${route.instance ?? "*"}`, verb: route.verb,
    actor: actor.kind, agent: actor.kind === "agent" ? actor.hash : null, couple_id: null,
    decision: "deny", reason: d.reason, unbound: false, estimated_cents: estimatedCents, run_id: currentRunId(),
    gate: "command",
  })
  prompts.log.error(`Refused: ${d.reason}`)
  console.error(
    dim(
      [
        "",
        `  \`iris ${argv.slice(0, 2).join(" ")}\` acts on a ${route.class}, and a Kinetic act needs a couple.`,
        error ? `  ${error}` : "",
        `  iris kinetic couple list`,
        `  iris kinetic couple add --agent <hash> --body ${route.class}:${route.instance ?? "<instance>"} --allow ${route.verb}`,
        "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  )
  process.exit(REFUSED)
}

export interface ActOptions {
  body: string
  verb: string
  estimatedCents?: number | null
  /** Skip the human confirmation a hitl couple demands (an explicit --yes at the call site). */
  yes?: boolean
}

const isNonInteractive = (): boolean =>
  !process.stdout.isTTY || String(process.env.IRIS_NON_INTERACTIVE || "") === "1" || String(process.env.CI || "") === "true"

/**
 * Decide, record, and either return or exit. Never returns on a refusal — a caller that forgets to
 * check a boolean is the failure mode this shape removes.
 */
export async function guardAct(opts: ActOptions): Promise<Decision> {
  const { couples, error } = readCouples()
  const now = new Date().toISOString()
  const verifySig = sigVerifier()

  // Spend is per COUPLE, and which couple applies is what `decide` is about to work out. So run it
  // once to learn the couple, then again with that couple's windows — cheap, and it keeps the
  // budget question out of the pure decision.
  const first = decide({ actor: currentActor(), node: nodeKey(), body: opts.body, verb: opts.verb, estimatedCents: opts.estimatedCents ?? declaredCents(process.argv.slice(2)), couples, now, enforceOperators: nodeIsLocked(), verifySig })
  const spend = first.couple_id ? spendFor(recentActs(), { coupleId: first.couple_id, runId: currentRunId(), now }) : EMPTY_SPEND

  const req = {
    actor: currentActor(),
    node: nodeKey(),
    body: opts.body,
    verb: opts.verb,
    estimatedCents: opts.estimatedCents ?? declaredCents(process.argv.slice(2)),
    couples,
    now,
    enforceOperators: nodeIsLocked(),
    verifySig,
    spend,
  }
  let d = decide(req)

  // A couples file we cannot read is not permission. Say so plainly, because "no couple binds …"
  // would send someone to write a couple that is already sitting in a file with a syntax error.
  if (error && d.decision !== "allow") {
    d = { ...d, reason: `${d.reason}\n  ${error}` }
  }

  if (d.decision === "hitl") {
    if (opts.yes) {
      d = { decision: "allow", reason: `${d.reason} — confirmed with --yes`, couple_id: d.couple_id }
    } else if (isNonInteractive()) {
      d = { decision: "deny", reason: `${d.reason}, and there is no terminal to confirm at. Re-run with --yes if you are the human.`, couple_id: d.couple_id }
    } else {
      const ok = await prompts.confirm({ message: `${opts.verb} ${normalizeBody(opts.body) ?? opts.body}?` })
      d = prompts.isCancel(ok) || !ok
        ? { decision: "deny", reason: "not confirmed", couple_id: d.couple_id }
        : { decision: "allow", reason: `${d.reason} — confirmed`, couple_id: d.couple_id }
    }
  }

  appendAct(actRecord(req, d, currentRunId(), currentActId()))

  if (d.decision === "deny") {
    prompts.log.error(`Refused: ${d.reason}`)
    console.error(
      dim(
        [
          "",
          `  A Kinetic act needs a couple: this agent hash, on this node, this body, this verb.`,
          `  node   ${nodeKey()}`,
          `  body   ${normalizeBody(opts.body) ?? opts.body}`,
          `  verb   ${opts.verb}`,
          `  actor  ${req.actor.kind === "agent" ? req.actor.hash.slice(0, 20) + "…" : "operator"}`,
          "",
          `  See what is coupled here:  iris kinetic couple list`,
          `  Couple it:                 iris kinetic couple add --agent <hash> --body ${normalizeBody(opts.body) ?? opts.body} --allow ${opts.verb}`,
          "",
        ].join("\n"),
      ),
    )
    process.exit(REFUSED)
  }

  if (d.unbound && !isNonInteractive()) {
    console.error(dim(`  ${bold("unbound")} — operator act, recorded but not booked to an agent`))
  }
  return d
}
