import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { requireAuth, requireUserId, printDivider, printKV, dim, bold, success, streamAgentChat } from "./iris-api"
import { writeFileSync } from "fs"

// ============================================================================
// Simplified port of EvalCommand — runs a series of test prompts against an
// agent via the chat workflow API and reports per-test timing + completion.
// (The PHP version had a richer scoring system; this gives the same UX surface
// without porting the entire AgentEvaluator class.)
// ============================================================================

interface EvalTest {
  name: string
  prompt: string
  expectKeywords?: string[]
}

const CORE_TESTS: EvalTest[] = [
  { name: "introduction", prompt: "Hi, briefly introduce yourself and what you can do." },
  { name: "reasoning", prompt: "What is 17 * 24? Show your work." },
  { name: "factual", prompt: "What year was the Eiffel Tower completed?", expectKeywords: ["1889"] },
  { name: "creative", prompt: "Write a 2-line haiku about coffee." },
  { name: "instruction-following", prompt: 'Respond with exactly the word "ACK" and nothing else.', expectKeywords: ["ACK"] },
  { name: "tool-awareness", prompt: "What tools do you have available?" },
  { name: "summary", prompt: "Summarize this in one sentence: The quick brown fox jumps over the lazy dog repeatedly throughout the morning." },
]

interface EvalResult {
  test: string
  status: string
  elapsedSec: number
  keywordsFound: boolean | null
  summary?: string
  error?: string
}

async function runTest(agentId: number, userId: number, test: EvalTest, timeoutSec: number): Promise<EvalResult> {
  const start = Date.now()
  try {
    // Route through the SAME faithful V6 ReactLoop path as `iris agents chat`
    // (POST /api/v6/chat/stream on iris-api). The old harness POSTed to the dead
    // `raichu.heyiris.io/api/chat/start` route → 404 on every test → false 0/7
    // (#146509). streamAgentChat owns host + endpoint, so eval can't drift again.
    const result = await streamAgentChat({
      agentId,
      message: test.prompt,
      userId,
      timeoutSecs: timeoutSec,
    })
    const elapsed = (Date.now() - start) / 1000
    if (!result.ok) {
      return {
        test: test.name,
        status: result.timedOut ? "timeout" : "failed",
        elapsedSec: Math.round(elapsed * 10) / 10,
        keywordsFound: null,
        error: result.error,
      }
    }
    const summary: string = result.content ?? ""
    let kw: boolean | null = null
    if (test.expectKeywords && test.expectKeywords.length > 0) {
      const lower = summary.toLowerCase()
      kw = test.expectKeywords.every((k) => lower.includes(k.toLowerCase()))
    }
    // A non-empty response from a completed stream counts as a pass; the V6 stream
    // reports status "done"/"completed" — treat any ok+content run as completed.
    const status = summary.trim().length > 0 ? "completed" : (result.status ?? "unknown")
    return { test: test.name, status, elapsedSec: Math.round(elapsed * 10) / 10, keywordsFound: kw, summary: summary.slice(0, 200) }
  } catch (err) {
    return { test: test.name, status: "failed", elapsedSec: (Date.now() - start) / 1000, keywordsFound: null, error: err instanceof Error ? err.message : String(err) }
  }
}

const EvalListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list available core eval tests",
  builder: (yargs) => yargs,
  async handler() {
    UI.empty()
    prompts.intro("◈  Core Eval Tests")
    printDivider()
    for (const t of CORE_TESTS) console.log(`  ${bold(t.name)}  ${dim(t.prompt.slice(0, 70))}`)
    printDivider()
    prompts.outro(dim(`iris eval run <agentId>`))
  },
})

const EvalRunCommand = cmd({
  command: "run <agentId>",
  describe: "evaluate an agent against core test scenarios",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number", demandOption: true })
      .option("timeout", { alias: "t", type: "number", default: 120 })
      .option("save", { alias: "s", type: "string", describe: "save results to file" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Evaluate Agent #${args.agentId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(); if (!userId) { prompts.outro("Done"); return }

    const results: EvalResult[] = []
    for (const t of CORE_TESTS) {
      const spinner = prompts.spinner()
      spinner.start(`${t.name}…`)
      const r = await runTest(args.agentId, userId, t, args.timeout)
      const icon = r.status === "completed" ? success("✓") : "✗"
      spinner.stop(`${icon} ${t.name}  ${dim(`${r.elapsedSec}s`)}${r.keywordsFound === true ? `  ${success("kw✓")}` : r.keywordsFound === false ? `  ⚠kw` : ""}`)
      results.push(r)
    }

    if (args.json) console.log(JSON.stringify(results, null, 2))
    else {
      printDivider()
      const passed = results.filter((r) => r.status === "completed").length
      printKV("Tests passed", `${passed} / ${results.length}`)
      const avgTime = results.reduce((s, r) => s + r.elapsedSec, 0) / results.length
      printKV("Avg time", `${avgTime.toFixed(1)}s`)
      printDivider()
    }

    if (args.save) {
      const filename = args.save && args.save !== "" ? args.save : `agent-eval-${args.agentId}-${Date.now()}.json`
      writeFileSync(filename, JSON.stringify(results, null, 2))
      prompts.log.info(`Saved → ${filename}`)
    }
    prompts.outro("Done")
  },
})

export const PlatformEvalCommand = cmd({
  command: "eval",
  describe: "evaluate agent performance with test scenarios",
  builder: (yargs) =>
    yargs
      .command(EvalListCommand)
      .command(EvalRunCommand)
      .demandCommand(),
  async handler() {},
})
