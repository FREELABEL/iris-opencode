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
import { decide, actRecord, normalizeBody, type Decision } from "./kinetic-couple"
import { readCouples, appendAct, nodeKey, currentActor, currentRunId, nodeIsLocked } from "./kinetic-store"

/** Exit 5 is the house code for "refused, and not because it broke" — same as a gated edge export. */
export const REFUSED = 5

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
  const req = {
    actor: currentActor(),
    node: nodeKey(),
    body: opts.body,
    verb: opts.verb,
    estimatedCents: opts.estimatedCents ?? null,
    couples,
    now: new Date().toISOString(),
    enforceOperators: nodeIsLocked(),
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

  appendAct(actRecord(req, d, currentRunId()))

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
