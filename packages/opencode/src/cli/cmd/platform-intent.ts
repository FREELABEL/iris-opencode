import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, requireAuth, writeJson, dim, bold, success, IRIS_API } from "./iris-api"
import { UI } from "../ui"

// ============================================================================
// iris intent — which of these does this mean?
//
// I1 of #186466. Calls POST /api/v1/intent, which runs the SAME IntentClassifier
// the agent router uses, so the CLI and the router can never report two different
// answers for one sentence.
//
// NAMED `intent` DELIBERATELY (ADR-01). Not `iris jev` — that is a vendor's
// product name, reads as their tool, and is wrong the day the default model
// changes; model-agnostic is the whole position. Not `intent-router` — that names
// the mechanism, and the caller wants the outcome.
//
// AND NOTE THE COLLISION IT AVOIDS: KINETIC (#186341) uses `Intent` as a TYPE —
// a device-control document. That is a NOUN. This is a VERB on text. If KINETIC
// ever grows a CLI it is `iris kinetic …`, never `iris intent …`.
// ============================================================================

export const PlatformIntentCommand = cmd({
  command: "intent <text>",
  aliases: ["classify"],
  describe: "which of these does this mean? — decided by local rules when they cover it, a model when they don't",
  builder: (yargs) =>
    yargs
      .positional("text", { describe: "the message to route", type: "string", demandOption: true })
      .option("choices", {
        describe: "comma-separated labels to choose between (default: the built-in simple/complex)",
        type: "string",
      })
      .option("local-only", {
        describe: "never ask a model — fail instead if no local rule covers it",
        type: "boolean",
        default: false,
      })
      .option("model", { describe: "model to escalate to (nano only)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .example('iris intent "find my overdue leads"', "route one message")
      .example('iris intent "card charged twice" --choices billing,support,sales', "your own labels")
      .example('iris intent "..." --local-only', "refuse to egress when the rules miss"),
  async handler(args) {
    const a = args as any
    if (!(await requireAuth())) return

    const choices = a.choices
      ? String(a.choices)
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : undefined

    if (choices && choices.length < 2) {
      prompts.log.error("--choices needs at least two labels — choosing one of one is not a choice.")
      process.exitCode = 1
      return
    }

    // IRIS_API EXPLICITLY. irisFetch defaults to fl-api (raichu.heyiris.io); this route lives in
    // fl-iris-api. Omitting it returns a 404 from the wrong service, which reads exactly like an
    // undeployed route — half an hour of debugging the deploy that had already landed.
    const res = await irisFetch(
      "/api/v1/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: String(a.text),
          ...(choices ? { choices } : {}),
          ...(a["local-only"] ? { local_only: true } : {}),
          ...(a.model ? { model: String(a.model) } : {}),
        }),
      },
      IRIS_API,
    )

    const body = (await res.json().catch(() => ({}))) as any
    const d = body?.data ?? {}

    // --json emits the DECISION, not the envelope, so `| jq -e '.choice'` works — which is the
    // exit check this slice is scored against.
    //
    // AND IT EXITS NON-ZERO WHEN IT DID NOT DECIDE. The first version returned here before the
    // `!res.ok` branch below, so `--json` reported every refusal with exit 0: a script doing
    // `iris intent … --json || handle` never saw an error, and an undecided run was
    // byte-identical to a decided one for anything checking status. Same defect requireAuth
    // documents at #180540, reintroduced two files away.
    if (a.json) {
      if (!res.ok) process.exitCode = 1
      return writeJson(d)
    }

    if (!res.ok) {
      prompts.log.error(d?.error ?? body?.message ?? `HTTP ${res.status}`)
      if (d?.would_have_asked) {
        prompts.log.info(dim(`  would have asked ${d.would_have_asked} — drop --local-only to allow it`))
      }
      if (d?.raw) prompts.log.info(dim(`  model said: ${d.raw}`))
      process.exitCode = 1
      return
    }

    UI.empty()
    console.log(`  ${bold(String(d.choice))}  ${dim(`${d.ms}ms`)}`)
    // decided_by is printed EVERY time, not only when it is interesting. It is the field that
    // makes a wrong route traceable, and a field you only sometimes see is one nobody relies on.
    const by =
      d.decided_by === "rules"
        ? `${success("local rules")}${d.rule ? dim(`  ${d.rule} → "${d.matched}"`) : ""}  ${dim("no model, no egress")}`
        : `${d.decided_by}${d.tokens ? dim(`  ${d.tokens} tokens`) : ""}`
    console.log(`  ${dim("decided by")}  ${by}`)
    UI.empty()
  },
})
