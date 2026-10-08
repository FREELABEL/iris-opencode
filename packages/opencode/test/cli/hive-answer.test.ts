import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  runAnswerHook,
  withHook,
  withoutHook,
  hookInstalled,
  hookEntry,
  parseDuration,
  answersDir,
  awayFile,
  HOOK_TIMEOUT_S,
} from "../../src/cli/cmd/platform-hive-answer"

// Epic #188549 S4. The mechanism was measured on Claude Code 2.1.290 before this was written; these
// tests pin the contract with iris-daemon lib/session-answer.js (same files, same fields).

const SID = "2acb6f45-30a2-4238-8a42-9bc0ba3f237c"
const TOOL = "toolu_011oK5evtEurRVvcT7PgHLoW"
const INPUT = {
  session_id: SID,
  tool_use_id: TOOL,
  cwd: "/tmp/proj",
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_input: { questions: [{ question: "Which color?", options: [{ label: "Red" }, { label: "Blue" }] }] },
}
const NOW = Date.parse("2026-10-08T09:13:00Z")

function setup(away?: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hook-"))
  if (away) {
    fs.mkdirSync(path.join(home, ".iris"), { recursive: true })
    fs.writeFileSync(awayFile(home), JSON.stringify({ until: away }))
  }
  let t = NOW
  const deps = {
    home,
    env: { TMUX: "/tmp/tmux-1000/default,4411,0", TMUX_PANE: "%3" } as Record<string, string | undefined>,
    now: () => t,
    sleep: async (ms: number) => { t += ms },
    pid: 4242,
  }
  return { home, deps, dir: answersDir(home) }
}
const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"))

describe("runAnswerHook", () => {
  test("not away: records where the session runs, holds nothing, prints nothing", async () => {
    const { deps, dir } = setup()
    expect(await runAnswerHook(INPUT, deps)).toBeNull()
    expect(read(path.join(dir, `${SID}.where.json`))).toMatchObject({ tool_use_id: TOOL, tmux: { socket: "/tmp/tmux-1000/default", pane: "%3" } })
    expect(fs.existsSync(path.join(dir, `${SID}.holding.json`))).toBe(false)
  })

  test("away: holds, and an answer for THIS question comes back as updatedInput.answers", async () => {
    const { deps, dir } = setup("2026-10-08T11:00:00Z")
    const answer = path.join(dir, `${SID}.answer.json`)
    let checks = 0
    deps.sleep = async (ms: number) => {
      // While waiting, the hold is advertised — the daemon decides HOLD vs KEYS on this file.
      expect(read(path.join(dir, `${SID}.holding.json`))).toMatchObject({ tool_use_id: TOOL, pid: 4242, questions: INPUT.tool_input.questions })
      if (++checks === 3) fs.writeFileSync(answer, JSON.stringify({ tool_use_id: TOOL, answers: { "Which color?": "Blue" } }))
    }
    const out: any = await runAnswerHook(INPUT, deps)
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...INPUT.tool_input, answers: { "Which color?": "Blue" } },
    })
    expect(fs.existsSync(answer)).toBe(false)
    expect(fs.existsSync(path.join(dir, `${SID}.holding.json`))).toBe(false)
  })

  test("an answer meant for a different question is ignored", async () => {
    const { deps, dir } = setup("2026-10-08T09:14:00Z")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${SID}.answer.json`), JSON.stringify({ tool_use_id: "toolu_OLD", answers: { x: "y" } }))
    expect(await runAnswerHook(INPUT, deps)).toBeNull()
  })

  test("no answer before away ends: lets go (the prompt shows on screen) and clears the hold", async () => {
    const { deps, dir } = setup("2026-10-08T09:14:00Z")
    expect(await runAnswerHook(INPUT, deps)).toBeNull()
    expect(fs.existsSync(path.join(dir, `${SID}.holding.json`))).toBe(false)
  })

  test("the hold never outlives Claude Code's hook timeout", async () => {
    const { deps, dir } = setup("2026-10-09T09:00:00Z") // away for a day
    let maxUntil = 0
    deps.sleep = async (ms: number) => {
      maxUntil = Math.max(maxUntil, Date.parse(read(path.join(dir, `${SID}.holding.json`)).until))
      ;(deps as any).now = () => maxUntil + 1 // jump to the end
    }
    await runAnswerHook(INPUT, deps)
    expect(maxUntil - NOW).toBeLessThan(HOOK_TIMEOUT_S * 1000)
  })

  test("other tools, bad ids, garbage: nothing written, no waiting, never throws", async () => {
    const { deps, dir } = setup("2026-10-08T11:00:00Z")
    let waited = 0
    deps.sleep = async () => { waited++; (deps as any).now = () => Date.parse("2026-10-08T12:00:00Z") }
    for (const bad of [null, {}, { ...INPUT, tool_name: "Bash" }, { ...INPUT, session_id: "../../x" }, { ...INPUT, tool_use_id: "" }])
      expect(await runAnswerHook(bad, deps)).toBeNull()
    expect(waited).toBe(0)
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([])
  })

  test("outside tmux: where is recorded with tmux null (the daemon will refuse keystrokes)", async () => {
    const { deps, dir } = setup()
    deps.env = {}
    await runAnswerHook(INPUT, deps)
    expect(read(path.join(dir, `${SID}.where.json`)).tmux).toBeNull()
  })
})

describe("settings.json", () => {
  const entry = hookEntry("/usr/local/bin/iris")
  test("install keeps every other setting and hook, and is idempotent", () => {
    const mine = { matcher: "Bash", hooks: [{ type: "command", command: "my-guard.sh" }] }
    const s = { model: "x", hooks: { PreToolUse: [mine], Stop: [{ hooks: [] }] } }
    const once = withHook(s, entry)
    const twice = withHook(once, entry)
    expect(twice).toEqual(once)
    expect(twice.model).toBe("x")
    expect(twice.hooks.Stop).toEqual(s.hooks.Stop)
    expect(twice.hooks.PreToolUse).toEqual([mine, entry])
    expect(hookInstalled(twice)).toBe(true)
  })
  test("uninstall removes only ours", () => {
    const mine = { matcher: "Bash", hooks: [{ type: "command", command: "my-guard.sh" }] }
    expect(withoutHook(withHook({ hooks: { PreToolUse: [mine] } }, entry)).hooks.PreToolUse).toEqual([mine])
    expect(withoutHook(withHook({}, entry)).hooks.PreToolUse).toBeUndefined()
  })
  test("the hook runs this binary by absolute path when compiled, matches only AskUserQuestion", () => {
    expect(entry.matcher).toBe("AskUserQuestion")
    expect(entry.hooks[0].command).toBe('"/usr/local/bin/iris" hive answer-hook')
    expect(entry.hooks[0].timeout).toBe(HOOK_TIMEOUT_S)
    expect(hookEntry("/home/u/.bun/bin/bun").hooks[0].command).toBe('"iris" hive answer-hook')
  })
})

test("parseDuration", () => {
  expect(parseDuration("45m")).toBe(45 * 60_000)
  expect(parseDuration("2h")).toBe(120 * 60_000)
  expect(parseDuration("30")).toBe(30 * 60_000)
  for (const bad of ["", "soon", "-5m", "2d", undefined]) expect(parseDuration(bad as any)).toBeNull()
})
