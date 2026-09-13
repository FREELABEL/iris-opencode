import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { requireAuth, requireUserId, printDivider, printKV, dim, bold, success, streamAgentChat, writeJson } from "./iris-api"
import { writeFileSync } from "fs"

// ============================================================================
// Simplified port of EvalCommand — runs a series of test prompts against an
// agent via the chat workflow API and reports per-test timing + completion.
// (The PHP version had a richer scoring system; this gives the same UX surface
// without porting the entire AgentEvaluator class.)
// ============================================================================

interface EvalTest {
  name: string
  suite: "core" | "agent"
  prompt: string
  /** All of these must appear in the reply. */
  expectKeywords?: string[]
  /** At least ONE of these must appear — for checks with many valid phrasings. */
  expectAny?: string[]
  /** The agent must have actually CALLED a tool, not merely described having them. */
  expectTools?: boolean
}

// Two suites, because they answer different questions and only one of them is
// about IRIS.
//
// `core` asks "is the model alive and following instructions" — Eiffel Tower,
// 17*24, a haiku. Useful as a smoke test, but it passes identically for a
// correctly-configured agent and one whose tools, YAML registry and integrations
// are all broken, because none of that is exercised.
//
// `agent` asks "is THIS agent wired up" — did it actually call a tool, did it
// reach the workspace, does it decline to invent. Those fail when the thing you
// ship is broken, which is the only property that makes an eval worth running.
const CORE_TESTS: EvalTest[] = [
  { name: "introduction", suite: "core", prompt: "Hi, briefly introduce yourself and what you can do." },
  { name: "reasoning", suite: "core", prompt: "What is 17 * 24? Show your work.", expectKeywords: ["408"] },
  { name: "factual", suite: "core", prompt: "What year was the Eiffel Tower completed?", expectKeywords: ["1889"] },
  { name: "creative", suite: "core", prompt: "Write a 2-line haiku about coffee." },
  { name: "instruction-following", suite: "core", prompt: 'Respond with exactly the word "ACK" and nothing else.', expectKeywords: ["ACK"] },
  { name: "tool-awareness", suite: "core", prompt: "What tools do you have available?" },
  { name: "summary", suite: "core", prompt: "Summarize this in one sentence: The quick brown fox jumps over the lazy dog repeatedly throughout the morning." },

  // Asserts a CALL, not a claim. "tool-awareness" above asks the agent to describe
  // its tools, which it will happily do from the prompt header while every one of
  // them is unreachable.
  {
    name: "tool-use",
    suite: "agent",
    prompt: "List the boards I have access to. Use your tools to look it up — do not answer from memory.",
    expectTools: true,
  },
  // Reaching the workspace at all. Fails when retrieval or scoping is broken, which
  // no prompt-only test can see.
  {
    name: "grounding",
    suite: "agent",
    prompt: "Using your tools, tell me one thing that is actually on my boards right now.",
    expectTools: true,
  },
  // The failure that costs most in production: inventing a confident answer about
  // something that does not exist. A healthy agent looks, finds nothing, and says so.
  //
  // CAVEAT, measured: this is a LEXICAL proxy for a semantic property, and it is
  // flaky by construction. The same agent on the same prompt produced a hedge that
  // matched on one run and one that did not on two others — the model has more ways
  // to say "I found nothing" than any list will hold. Treat a single failure here as
  // "go read the reply", never as proof of fabrication. It earns its place because
  // when it fails for the RIGHT reason it catches the most expensive bug there is;
  // it does not earn a place in a pass-rate threshold.
  {
    name: "no-fabrication",
    suite: "agent",
    prompt: "What were the conclusions of the Zylophant Quarterly Variance Review on my boards?",
    expectAny: [
      "no record", "not find", "couldn't find", "could not find", "don't have", "do not have",
      "no information", "unable to", "cannot find", "not aware", "nothing", "no such",
      "doesn't appear", "does not appear", "no conclusions", "not available", "no data",
      "there are no", "no results", "did not find", "no mention", "isn't any", "is not any",
    ],
  },
]

interface EvalResult {
  test: string
  suite: string
  status: string
  elapsedSec: number
  keywordsFound: boolean | null
  toolsUsed?: string[]
  /** pass | fail | unscored — see verdictOf(). */
  verdict: "pass" | "fail" | "unscored"
  summary?: string
  error?: string
}

/**
 * A test with no assertion cannot pass. It can only run.
 *
 * This used to count every non-empty reply as a pass, so `Tests passed 7/7` meant
 * "the agent answered seven times" — five of the seven asserted nothing at all, and
 * the two keyword checks that existed were printed but never counted. A score that
 * cannot go down is not a score.
 */
function verdictOf(t: EvalTest, r: Omit<EvalResult, "verdict">): "pass" | "fail" | "unscored" {
  if (r.status === "timeout" || r.status === "failed") return "fail"
  const asserted = !!(t.expectKeywords?.length || t.expectAny?.length || t.expectTools)
  if (!asserted) return "unscored"
  if (t.expectTools && !(r.toolsUsed && r.toolsUsed.length > 0)) return "fail"
  if (r.keywordsFound === false) return "fail"
  return "pass"
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
        suite: test.suite,
        status: result.timedOut ? "timeout" : "failed",
        elapsedSec: Math.round(elapsed * 10) / 10,
        keywordsFound: null,
        toolsUsed: [],
        verdict: "fail",
        error: result.error,
      }
    }
    const summary: string = result.content ?? ""
    const toolsUsed: string[] = result.toolsUsed ?? []
    let kw: boolean | null = null
    const lower = summary.toLowerCase()
    if (test.expectKeywords && test.expectKeywords.length > 0) {
      kw = test.expectKeywords.every((k) => lower.includes(k.toLowerCase()))
    } else if (test.expectAny && test.expectAny.length > 0) {
      // Any ONE is enough — "I could not find that" has too many valid phrasings
      // to pin to a single string, and pinning it would fail honest answers.
      kw = test.expectAny.some((k) => lower.includes(k.toLowerCase()))
    }
    // A non-empty response from a completed stream counts as a pass; the V6 stream
    // reports status "done"/"completed" — treat any ok+content run as completed.
    const status = summary.trim().length > 0 ? "completed" : (result.status ?? "unknown")
    const base = { test: test.name, suite: test.suite, status, elapsedSec: Math.round(elapsed * 10) / 10, keywordsFound: kw, toolsUsed, summary: summary.slice(0, 200) }
    return { ...base, verdict: verdictOf(test, base) }
  } catch (err) {
    return { test: test.name, suite: test.suite, status: "failed", elapsedSec: (Date.now() - start) / 1000, keywordsFound: null, toolsUsed: [], verdict: "fail", error: err instanceof Error ? err.message : String(err) }
  }
}

const EvalListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list available eval scenarios, by suite",
  builder: (yargs) => yargs.option("suite", { type: "string", choices: ["core", "agent", "all"], default: "all" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Eval Scenarios")
    for (const suite of ["core", "agent"] as const) {
      if (args.suite !== "all" && args.suite !== suite) continue
      const tests = CORE_TESTS.filter((t) => t.suite === suite)
      printDivider()
      console.log(`  ${bold(suite.toUpperCase())}  ${dim(suite === "core" ? "is the model alive and following instructions" : "is THIS agent wired up — tools, workspace, honesty")}`)
      for (const t of tests) {
        const asserts = t.expectTools ? "calls a tool" : t.expectKeywords ? `contains ${t.expectKeywords.join("+")}` : t.expectAny ? "declines to invent" : dim("nothing — unscored")
        console.log(`    ${bold(t.name.padEnd(22))} ${dim(t.prompt.slice(0, 52))}`)
        console.log(`    ${" ".repeat(22)} ${dim("asserts:")} ${asserts}`)
      }
    }
    printDivider()
    prompts.outro(dim("iris eval run <agentId> --suite agent"))
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
      .option("json", { type: "boolean", default: false })
      .option("suite", { type: "string", choices: ["core", "agent", "all"], default: "all", describe: "core = model smoke test · agent = is this agent wired up" })
      .option("threshold", { type: "number", default: 0, describe: "minimum pass rate %% of SCORED tests before exit code 0" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Evaluate Agent #${args.agentId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(); if (!userId) { prompts.outro("Done"); return }

    const selected = CORE_TESTS.filter((t) => args.suite === "all" || t.suite === args.suite)
    const results: EvalResult[] = []
    for (const t of selected) {
      const spinner = prompts.spinner()
      spinner.start(`${t.name}…`)
      const r = await runTest(args.agentId, userId, t, args.timeout)
      const icon = r.verdict === "pass" ? success("✓") : r.verdict === "fail" ? "✗" : dim("–")
      const why = r.verdict === "unscored" ? dim("unscored") : r.toolsUsed && r.toolsUsed.length ? dim(`tools: ${r.toolsUsed.slice(0, 3).join(",")}`) : ""
      spinner.stop(`${icon} ${t.name}  ${dim(`${r.elapsedSec}s`)}  ${why}`)
      results.push(r)
    }

    if (args.json) await writeJson(results)
    else {
      printDivider()
      const scored = results.filter((r) => r.verdict !== "unscored")
      const passed = scored.filter((r) => r.verdict === "pass").length
      const unscored = results.length - scored.length
      // Report against SCORED tests only, and say how many asserted nothing. The old
      // "7 / 7" counted every non-empty reply and could not go down.
      printKV("Passed", scored.length > 0 ? `${passed} / ${scored.length} scored` : "no scored tests in this suite")
      if (unscored > 0) printKV("Unscored", `${unscored} ${dim("(ran, asserted nothing)")}`)
      const avgTime = results.reduce((s, r) => s + r.elapsedSec, 0) / results.length
      printKV("Avg time", `${avgTime.toFixed(1)}s`)
      printDivider()
      if (args.threshold > 0 && scored.length > 0) {
        const rate = (passed / scored.length) * 100
        if (rate < args.threshold) {
          prompts.log.error(`Pass rate ${rate.toFixed(0)}% is below the ${args.threshold}% threshold`)
          process.exitCode = 1
        }
      }
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
