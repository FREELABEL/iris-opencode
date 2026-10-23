import { describe, test, expect, afterAll } from "bun:test"
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "fs"
import { homedir, tmpdir } from "os"
import { join } from "path"
import {
  parseSteps,
  parsePlan,
  validatePlan,
  executeSkill,
  runOutcome,
  InvalidPlaybookError,
  StepNotFoundError,
  type SkillPlan,
  type SkillResult,
  type StepDef,
} from "./executor"
import { lintPlaybook } from "./playbook-lint"

/**
 * `iris playbook run` must not report success for work it did not do (#182759, #190875,
 * #190876, #190879 — all measured on 2026-10-23 against the released binary).
 */

const F = "```"
const tmp = mkdtempSync(join(tmpdir(), "pb-honest-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const cleanupRun = (runId: string) => {
  const p = join(homedir(), ".iris", "skill-runs", `${runId}.json`)
  if (existsSync(p)) unlinkSync(p)
}

const step = (o: Partial<StepDef>): StepDef => ({
  id: "s1", title: "Step", mode: "shell", body: "", code: null,
  confirm: false, depends: null, retry: 0, delay: 0,
  condition: null, model: null, node: null,
  skillRef: null, skillArgs: null,
  workflowId: null, webhook: null, cron: null, input: null,
  integrations: [],
  ...o,
})

const plan = (o: Partial<SkillPlan>): SkillPlan => ({
  name: "honest", version: 2, description: "d", args: {}, steps: [],
  includes: [], confirm: [], onError: "ask", timeout: 300, integrations: [],
  location: join(tmp, "PLAYBOOK.md"),
  ...o,
})

async function planFrom(md: string): Promise<SkillPlan> {
  const dir = mkdtempSync(join(tmp, "pb-"))
  const location = join(dir, "PLAYBOOK.md")
  writeFileSync(location, md)
  return parsePlan({ name: "honest", description: "d", location, content: md } as any)
}

const result = (o: Partial<SkillResult>): SkillResult => ({
  run_id: "r", skill: "honest", status: "completed", steps: {},
  started_at: "", finished_at: "", args: {},
  ...o,
})
const sr = (id: string, status: "success" | "failed" | "skipped") => ({
  id, status, output: "", exit_code: status === "success" ? 0 : 1, duration_ms: 1, attempts: 1,
})

// ---------------------------------------------------------------------------
// #182759 — a failed run must exit non-zero, in --json mode too.
// ---------------------------------------------------------------------------
describe("#182759 runOutcome: the exit code tells the truth", () => {
  test("failed run -> exit 1", () => {
    const r = result({ status: "failed", steps: { a: sr("a", "success"), b: sr("b", "failed") } })
    expect(runOutcome(r).exitCode).toBe(1)
  })
  test("completed with a failed step (on-error: continue) -> still exit 1", () => {
    const r = result({ status: "completed", steps: { a: sr("a", "failed"), b: sr("b", "success") } })
    expect(runOutcome(r).exitCode).toBe(1)
  })
  test("interrupted -> exit 1, paused -> exit 2", () => {
    expect(runOutcome(result({ status: "interrupted", steps: { a: sr("a", "failed") } })).exitCode).toBe(1)
    expect(runOutcome(result({ status: "paused", steps: { a: sr("a", "success") } })).exitCode).toBe(2)
  })
  test("completed, every step passed -> exit 0", () => {
    const o = runOutcome(result({ steps: { a: sr("a", "success") } }))
    expect(o).toEqual({ exitCode: 0, ranNothing: false })
  })
  test("a full run whose steps were all if:-gated off stays exit 0", () => {
    expect(runOutcome(result({ steps: { a: sr("a", "skipped") } })).exitCode).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// #190875 — a title-less step heading is a step; zero steps is never success.
// ---------------------------------------------------------------------------
describe("#190875 title-less step headings", () => {
  const md = `### step:one\n\n${F}yaml\nmode: shell\n${F}\n\n${F}bash\necho SHOULD_RUN\n${F}\n`

  test("parseSteps reads `### step:one` as a step titled by its id", () => {
    const s = parseSteps(md)
    expect(s).toHaveLength(1)
    expect(s[0].id).toBe("one")
    expect(s[0].title).toBe("one")
    expect(s[0].code).toBe("echo SHOULD_RUN")
  })

  test("trailing whitespace / CRLF does not leak into the title", () => {
    const s = parseSteps(`### step:one   \r\n\n### step:two Second\r\n`)
    expect(s.map((x) => [x.id, x.title])).toEqual([["one", "one"], ["two", "Second"]])
  })

  test("the lint parser agrees with the executor", () => {
    const pb = `---\nname: x\nversion: 2\n---\n### step:one\n\n${F}yaml\nmode: ai\n${F}\n`
    expect(lintPlaybook(pb).some((f) => f.rule === "AI_NO_PROMPT" && f.stepId === "one")).toBe(true)
  })

  test("a `### step:` heading that does not parse is an error naming the line", async () => {
    const p = await planFrom(`---\nname: honest\ndescription: d\nversion: 2\n---\n### step: one Spaced\n\n${F}bash\necho hi\n${F}\n`)
    const err = validatePlan(p).find((i) => i.level === "error" && i.message.includes("### step: one Spaced"))
    expect(err).toBeDefined()
    expect(err!.message).toContain("line 6")
  })

  test("a `### step:` line inside a code fence is not flagged", async () => {
    const p = await planFrom(
      `---\nname: honest\ndescription: d\nversion: 2\n---\n### step:doc Doc\n\n${F}yaml\nmode: shell\n${F}\n\n${F}bash\ncat <<'X'\n### step: example\nX\n${F}\n`,
    )
    expect(validatePlan(p).filter((i) => i.level === "error")).toEqual([])
  })

  test("a playbook with no steps at all (documentation-style) is ran_nothing, NOT a failure: exit 0", () => {
    // desktop-release and ~8 other installed playbooks are prose with no `### step:` lines. The
    // daemon runs them with --yes --json; exit 1 would mark each one as a warning. Unparseable
    // headings are refused before the run (see below), so this case is only a genuinely stepless plan.
    expect(runOutcome(result({ status: "completed", steps: {} }))).toEqual({ exitCode: 0, ranNothing: true })
  })

  test("--step whose only step was skipped is ran_nothing (unchanged)", () => {
    expect(runOutcome(result({ steps: { a: sr("a", "skipped") } }), { stepFilter: "a" })).toEqual({
      exitCode: 1,
      ranNothing: true,
    })
  })
})

// ---------------------------------------------------------------------------
// #190876 — on-error and timeout are validated at test time AND at run time.
// ---------------------------------------------------------------------------
describe("#190876 on-error / timeout validation", () => {
  const one = [step({ id: "one", code: "echo hi" })]

  for (const bad of ["explode", "", "Continue", 3]) {
    test(`on-error ${JSON.stringify(bad)} is an error`, () => {
      const issues = validatePlan(plan({ steps: one, onError: bad as any }))
      const e = issues.find((i) => i.level === "error" && i.message.includes("on-error"))
      expect(e).toBeDefined()
      expect(e!.message).toContain(JSON.stringify(bad))
    })
  }
  for (const ok of ["continue", "stop", "ask"]) {
    test(`on-error ${ok} is fine`, () => {
      expect(validatePlan(plan({ steps: one, onError: ok as any })).filter((i) => i.level === "error")).toEqual([])
    })
  }
  for (const bad of [0, -5, "abc", Number.NaN, Infinity, true]) {
    test(`timeout ${String(bad)} is an error`, () => {
      const e = validatePlan(plan({ steps: one, timeout: bad as any })).find(
        (i) => i.level === "error" && i.message.includes("timeout"),
      )
      expect(e).toBeDefined()
    })
  }
  for (const ok of [1, 300, 0.5, "60"]) {
    test(`timeout ${JSON.stringify(ok)} is fine`, () => {
      expect(validatePlan(plan({ steps: one, timeout: ok as any })).filter((i) => i.level === "error")).toEqual([])
    })
  }

  test("run refuses an invalid on-error before any step runs", async () => {
    const marker = join(tmp, "ran-on-error")
    const p = plan({ onError: "explode" as any, steps: [step({ id: "one", code: `touch '${marker}'` })] })
    await expect(executeSkill(p, {}, { yes: true })).rejects.toBeInstanceOf(InvalidPlaybookError)
    await expect(executeSkill(p, {}, { yes: true })).rejects.toThrow(/on-error.*"explode"/)
    expect(existsSync(marker)).toBe(false)
  })

  test("run refuses timeout 0 before any step runs", async () => {
    const marker = join(tmp, "ran-timeout")
    const p = plan({ timeout: 0, steps: [step({ id: "one", code: `touch '${marker}'` })] })
    await expect(executeSkill(p, {}, { yes: true })).rejects.toThrow(/timeout/)
    expect(existsSync(marker)).toBe(false)
  })

  test("a valid plan still runs", async () => {
    const r = await executeSkill(plan({ timeout: 10, steps: one }), {}, { yes: true })
    try {
      expect(r.status).toBe("completed")
    } finally {
      cleanupRun(r.run_id)
    }
  })
})

// ---------------------------------------------------------------------------
// #190879 — --step <unknown> is a plain answer, not a crash.
// ---------------------------------------------------------------------------
describe("#190879 unknown --step", () => {
  test("throws StepNotFoundError naming the step and the available ids", async () => {
    const p = plan({ steps: [step({ id: "a", code: "true" }), step({ id: "b", code: "true" }), step({ id: "c", code: "true" })] })
    const err = await executeSkill(p, {}, { stepFilter: "nope", yes: true }).catch((e) => e)
    expect(err).toBeInstanceOf(StepNotFoundError)
    expect(err.message).toBe("Step 'nope' not found. Available: a, b, c")
  })
})

// ---------------------------------------------------------------------------
// #182759 — the CLI wiring. The --json branch returns early; it must set the exit code first.
// ---------------------------------------------------------------------------
describe("#182759 run handler wiring", async () => {
  const src = await Bun.file(new URL("../cli/cmd/platform-playbook.ts", import.meta.url).pathname).text()
  const start = src.indexOf("const SkillRunCommand = cmd({")
  const handler = src.slice(start, src.indexOf("const SkillTestCommand = cmd({", start))

  test("the --json branch sets process.exitCode from runOutcome before returning", () => {
    const json = handler.slice(handler.indexOf("ran_nothing: ranNothing,"))
    const block = json.slice(0, json.indexOf("return"))
    expect(block).toContain("process.exitCode = outcome.exitCode")
  })

  test("refusals (invalid header, unknown --step) are caught, not rethrown to the crash reporter", () => {
    expect(handler).toContain("e instanceof InvalidPlaybookError || e instanceof StepNotFoundError")
  })
})
