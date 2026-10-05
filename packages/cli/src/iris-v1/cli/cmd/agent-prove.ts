/**
 * `iris agents prove` — a repeatable assertion that an agent's answer is GROUNDED.
 *
 * The demo everyone reaches for is: ask an agent a question with a false premise and watch it
 * correct you, citing the record. It is a good demo and it was not runnable — it lived as an
 * anecdote in a document. This makes it a command, so it can be re-run, shown, or wired into
 * CI as a regression test for grounding.
 *
 * The load-bearing rule is `mustCite`: the id has to appear in what the run ACTUALLY
 * RETRIEVED, taken from the trace, not in the prose. An agent that says "#181392" while having
 * read nothing has produced a lucky answer, and a lucky answer must not pass as a grounded
 * one — that distinction is the entire product claim.
 */

export type ProofProvenance = { retrieved_item_ids: string[]; tool_calls: Array<{ tool: string }> }

export type Expectations = {
  mustContain?: string[]
  mustNotContain?: string[]
  mustCite?: string
}

export type ProofResult = { pass: boolean; failures: string[] }

export function evaluateProof(
  response: string,
  provenance: ProofProvenance,
  exp: Expectations,
): ProofResult {
  const failures: string[] = []
  const hay = (response ?? "").toLowerCase()

  const has = (exp.mustContain?.length ?? 0) + (exp.mustNotContain?.length ?? 0) + (exp.mustCite ? 1 : 0)
  // An assertion with nothing to assert reports success while testing nothing — the exact
  // shape this codebase keeps getting bitten by. Refuse it.
  if (has === 0) return { pass: false, failures: ["no expectations given — this would assert nothing and report a pass"] }

  for (const needle of exp.mustContain ?? []) {
    if (!hay.includes(needle.toLowerCase())) failures.push(`answer does not contain ${JSON.stringify(needle)}`)
  }
  for (const needle of exp.mustNotContain ?? []) {
    if (hay.includes(needle.toLowerCase())) failures.push(`answer still contains ${JSON.stringify(needle)} — it accepted the premise`)
  }
  if (exp.mustCite) {
    const read = (provenance?.retrieved_item_ids ?? []).includes(exp.mustCite)
    if (!read) {
      failures.push(
        `item ${exp.mustCite} was NOT retrieved this turn` +
          ((response ?? "").includes(exp.mustCite) ? " — the agent mentioned it without reading it" : ""),
      )
    }
  }

  return { pass: failures.length === 0, failures }
}

// ── command ──────────────────────────────────────────────────────────────────

import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { requireAuth, resolveUserId, dim, bold, streamAgentChat, writeJson } from "./iris-api"
import { extractProvenance } from "./mcp-serve"

export const AgentsProveCommand = cmd({
  command: "prove <id>",
  describe: "assert an agent's answer is GROUNDED — that it read the record it cites",
  builder: (y) =>
    y
      .positional("id", { type: "number", describe: "agent id" })
      .option("ask", { type: "string", demandOption: true, describe: "the question — a false premise is the strongest demo" })
      .option("must-contain", { type: "array", default: [], describe: "text the answer must include (repeatable)" })
      .option("must-not-contain", { type: "array", default: [], describe: "text the answer must NOT include" })
      .option("must-cite", { type: "string", describe: "item id that must appear in what the run actually RETRIEVED" })
      .option("model", { type: "string", describe: "model override (nano/mini)" })
      .option("timeout", { type: "number", default: 120 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Prove grounding — agent #${args.id}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const events: any[] = []
    const result = await streamAgentChat({
      agentId: Number(args.id),
      message: String(args.ask),
      userId: await resolveUserId(),
      overrideModel: args.model as string | undefined,
      timeoutSecs: Number(args.timeout),
      // Fresh thread: a proof must not pass because the answer was sitting in the shared
      // conversation from an earlier run. Grounding is the claim, not recall.
      threadId: `prove_${Date.now().toString(36)}`,
      onEvent: (e) => events.push(e),
    })

    const provenance = extractProvenance(events)
    const answer = result.content ?? ""
    const verdict = evaluateProof(answer, provenance as any, {
      mustContain: (args["must-contain"] as string[]).map(String),
      mustNotContain: (args["must-not-contain"] as string[]).map(String),
      mustCite: args["must-cite"] as string | undefined,
    })

    if (args.json) {
      await writeJson({ agent: Number(args.id), question: args.ask, answer, provenance, ...verdict })
      process.exitCode = verdict.pass ? 0 : 1
      prompts.outro("Done")
      return
    }

    console.log()
    console.log(`  ${dim("asked   ")} ${args.ask}`)
    console.log(`  ${dim("answered")} ${answer.slice(0, 300)}`)
    console.log(`  ${dim("read    ")} ${provenance.retrieved_item_ids.length ? provenance.retrieved_item_ids.join(", ") : dim("nothing")}`)
    if (provenance.tool_calls.length) {
      console.log(`  ${dim("tools   ")} ${provenance.tool_calls.map((t) => t.tool).join(", ")}`)
    }
    console.log()

    if (verdict.pass) {
      prompts.log.success(`${bold("GROUNDED")} — the agent answered correctly from records it actually read.`)
    } else {
      prompts.log.error(`${bold("NOT PROVEN")}`)
      for (const f of verdict.failures) prompts.log.error(`  · ${f}`)
    }
    // Exit code so this is usable as a regression gate, not just a demo.
    process.exitCode = verdict.pass ? 0 : 1
    prompts.outro("Done")
  },
})
