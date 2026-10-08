import { cmd } from "./cmd"
import { requireAuth, requireUserId, writeJson, dim, bold, success, warn } from "./iris-api"
import { hiveFetch } from "./platform-hive-nodes"
import { fromHiveTask } from "./hive-script-result"
import fs from "fs"
import os from "os"
import path from "path"

/**
 * Answer a Claude Code question from somewhere other than its terminal (epic #188549, S4).
 *
 * MEASURED 2026-10-08, Claude Code 2.1.290 in tmux, before any of this was written:
 *   - A PreToolUse hook on AskUserQuestion that returns `permissionDecision: "allow"` with
 *     `updatedInput.answers = { "<question>": "<label>" }` is recorded as the person's answer:
 *     "User answered Claude's questions: Which color? → Blue", and the agent continued.
 *   - While the hook holds, the question is NOT on screen ("running PreToolUse hook"). That is why
 *     holding is opt-in (`iris hive away`): holding by default would hide every question from the
 *     person sitting at the keyboard.
 *   - When the hook lets go, the normal prompt appears, and one option-number keystroke into the
 *     session's tmux pane answers it ("2" → Pear, no Enter). The hook records the pane, so the
 *     daemon can do that later (iris-daemon lib/session-answer.js).
 *
 * The files below are a contract with iris-daemon lib/session-answer.js. Change both or neither.
 */

export const HOOK_COMMAND_MARK = "hive answer-hook"
/** Claude Code kills a hook at its timeout; the hold ends just before that so it can clean up. */
export const HOOK_TIMEOUT_S = 1800
const HOLD_MAX_MS = (HOOK_TIMEOUT_S - 20) * 1000
const SAFE_ID = /^[A-Za-z0-9_-]{8,128}$/

export const answersDir = (home: string) => path.join(home, ".iris", "answers")
export const awayFile = (home: string) => path.join(home, ".iris", "away.json")

type HookDeps = {
  home: string
  env: Record<string, string | undefined>
  now: () => number
  sleep: (ms: number) => Promise<void>
  pid: number
}

function writePrivate(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

/** Until when away mode holds questions, or null when it is off/expired. */
export function awayUntil(home: string, now: number): number | null {
  const a = readJson(awayFile(home))
  const t = a && Date.parse(a.until)
  return t && t > now ? t : null
}

/**
 * The hook. Returns the JSON to print (or null = print nothing, Claude Code shows its own prompt).
 * Never throws: a broken hook must degrade to the normal prompt, not to a stuck session.
 */
export async function runAnswerHook(input: any, deps: HookDeps): Promise<object | null> {
  try {
    if (!input || input.tool_name !== "AskUserQuestion") return null
    const sid = String(input.session_id || "")
    const toolUseId = String(input.tool_use_id || "")
    if (!SAFE_ID.test(sid) || !toolUseId) return null
    const dir = answersDir(deps.home)

    // Where this session can be typed into. $TMUX is "<socket>,<pid>,<index>".
    const tmuxSocket = (deps.env.TMUX || "").split(",")[0]
    const pane = deps.env.TMUX_PANE || ""
    writePrivate(path.join(dir, `${sid}.where.json`), {
      session_id: sid,
      tool_use_id: toolUseId,
      tmux: tmuxSocket && pane ? { socket: tmuxSocket, pane } : null,
      cwd: input.cwd || null,
      at: new Date(deps.now()).toISOString(),
    })

    const until = awayUntil(deps.home, deps.now())
    if (!until) return null

    const holdUntil = Math.min(until, deps.now() + HOLD_MAX_MS)
    const holding = path.join(dir, `${sid}.holding.json`)
    const answerPath = path.join(dir, `${sid}.answer.json`)
    // The questions travel in the hold file because, while this hook runs, Claude Code has NOT yet
    // written the tool_use to the transcript (measured) — this file is the only place they exist.
    writePrivate(holding, {
      tool_use_id: toolUseId,
      pid: deps.pid,
      until: new Date(holdUntil).toISOString(),
      asked_at: new Date(deps.now()).toISOString(),
      questions: Array.isArray(input.tool_input?.questions) ? input.tool_input.questions : [],
    })
    try {
      while (deps.now() < holdUntil) {
        const a = readJson(answerPath)
        if (a && a.tool_use_id === toolUseId && a.answers && typeof a.answers === "object") {
          try { fs.unlinkSync(answerPath) } catch {}
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              updatedInput: { ...(input.tool_input || {}), answers: a.answers },
            },
          }
        }
        await deps.sleep(500)
      }
      return null
    } finally {
      try { fs.unlinkSync(holding) } catch {}
    }
  } catch {
    return null
  }
}

/** The settings.json entry. Absolute path to this binary when compiled, so the hook does not depend on PATH. */
export function hookEntry(execPath: string) {
  const bin = /(^|\/)iris(\.exe)?$/.test(execPath) ? execPath : "iris"
  return {
    matcher: "AskUserQuestion",
    hooks: [{ type: "command", command: `${JSON.stringify(bin)} ${HOOK_COMMAND_MARK}`, timeout: HOOK_TIMEOUT_S }],
  }
}

const isOurs = (e: any) => Array.isArray(e?.hooks) && e.hooks.some((h: any) => String(h?.command || "").includes(HOOK_COMMAND_MARK))

/** Add (or replace) our PreToolUse entry, leaving every other setting and hook untouched. */
export function withHook(settings: any, entry: object): any {
  const s = settings && typeof settings === "object" ? { ...settings } : {}
  const hooks = s.hooks && typeof s.hooks === "object" ? { ...s.hooks } : {}
  const pre = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse.filter((e: any) => !isOurs(e)) : []
  hooks.PreToolUse = [...pre, entry]
  s.hooks = hooks
  return s
}

export function withoutHook(settings: any): any {
  if (!settings?.hooks || !Array.isArray(settings.hooks.PreToolUse)) return settings
  const s = { ...settings, hooks: { ...settings.hooks } }
  s.hooks.PreToolUse = s.hooks.PreToolUse.filter((e: any) => !isOurs(e))
  if (s.hooks.PreToolUse.length === 0) delete s.hooks.PreToolUse
  return s
}

export const hookInstalled = (settings: any) => Array.isArray(settings?.hooks?.PreToolUse) && settings.hooks.PreToolUse.some(isOurs)

const claudeSettings = () => path.join(os.homedir(), ".claude", "settings.json")

// ─── commands ────────────────────────────────────────────────────────────────

const AnswerHookCommand = cmd({
  command: "answer-hook",
  describe: false as any, // internal — invoked by Claude Code, not by people
  async handler() {
    const raw = await new Response(Bun.stdin.stream()).text().catch(() => "")
    let input: any = null
    try { input = JSON.parse(raw) } catch {}
    const out = await runAnswerHook(input, {
      home: os.homedir(),
      env: process.env,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      pid: process.pid,
    })
    if (out) process.stdout.write(JSON.stringify(out))
  },
})

const AnswersCommand = cmd({
  command: "answers [action]",
  describe: "let Claude Code questions on this machine be answered from elsewhere (install | uninstall | status)",
  builder: (yargs) =>
    yargs.positional("action", { type: "string", choices: ["install", "uninstall", "status"], default: "status" }),
  async handler(argv) {
    const file = claudeSettings()
    const current = readJson(file) ?? (fs.existsSync(file) ? undefined : {})
    if (current === undefined) {
      console.error(`${file} is not valid JSON — not touching it. Fix it, then re-run.`)
      process.exit(1)
    }
    if (argv.action === "status") {
      console.log()
      console.log(`  hook      ${hookInstalled(current) ? success("installed") : dim("not installed — iris hive answers install")}`)
      const until = awayUntil(os.homedir(), Date.now())
      console.log(`  away      ${until ? warn(`on until ${new Date(until).toLocaleTimeString()}`) + dim(" — questions wait for a remote answer") : dim("off — questions show on screen as normal")}`)
      console.log()
      return
    }
    const next = argv.action === "install" ? withHook(current, hookEntry(process.execPath)) : withoutHook(current)
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-iris`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n")
    if (hookInstalled(readJson(file)) !== (argv.action === "install")) {
      console.error(`Wrote ${file} but reading it back does not show the change. Previous copy: ${file}.bak-iris`)
      process.exit(1)
    }
    console.log()
    if (argv.action === "install") {
      console.log(success("  ✓ installed") + dim(`  ${file}  (previous copy: settings.json.bak-iris)`))
      console.log(dim("  New Claude Code sessions record where they run, so a question on screen in tmux can be"))
      console.log(dim("  answered with `iris hive answer`. To have questions WAIT for you instead: iris hive away on"))
    } else {
      console.log(success("  ✓ removed") + dim(`  ${file}`))
    }
    console.log()
  },
})

export function parseDuration(s: string | undefined): number | null {
  const m = /^(\d+)\s*(m|min|h|hr)?$/i.exec(String(s ?? "").trim())
  if (!m) return null
  const n = Number(m[1])
  return (m[2] && m[2].toLowerCase().startsWith("h") ? n * 60 : n) * 60_000
}

const AwayCommand = cmd({
  command: "away [state]",
  describe: "hold Claude Code questions on this machine until you answer them remotely (on | off)",
  builder: (yargs) =>
    yargs
      .positional("state", { type: "string", choices: ["on", "off"], default: "on" })
      .option("for", { describe: "how long, e.g. 45m or 2h (default 2h)", type: "string", default: "2h" }),
  async handler(argv) {
    const file = awayFile(os.homedir())
    if (argv.state === "off") {
      try { fs.unlinkSync(file) } catch {}
      console.log(success("  ✓ away off") + dim(" — new questions show on screen as normal"))
      return
    }
    const ms = parseDuration(argv.for as string)
    if (!ms) {
      console.error(`--for must look like 45m or 2h, not "${argv.for}"`)
      process.exit(1)
    }
    const until = new Date(Date.now() + ms)
    writePrivate(file, { until: until.toISOString() })
    const installed = hookInstalled(readJson(claudeSettings()))
    console.log(success(`  ✓ away until ${until.toLocaleTimeString()}`) + dim(" — each question waits up to 30 min for a remote answer, then shows on screen"))
    if (!installed) console.log(warn("  ! the hook is not installed, so nothing will be held: iris hive answers install"))
  },
})

const TERMINAL = new Set(["succeeded", "completed", "failed", "cancelled", "timeout", "errored"])

const AnswerCommand = cmd({
  command: "answer <session-id> <choice..>",
  describe: "answer the question a session is waiting on — by option number or label, one per question",
  builder: (yargs) =>
    yargs
      .positional("session-id", { describe: "from `iris hive sessions --status needs_you`", type: "string", demandOption: true })
      .positional("choice", { describe: "option number or label (or free text)", type: "string", array: true, demandOption: true })
      .option("json", { type: "boolean", default: false })
      .option("user-id", { type: "number" }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)
    const wanted = String(argv["session-id"])
    const res = await hiveFetch(`/api/v6/nodes/?user_id=${userId}&detailed=1`)
    const body0 = (await res.json().catch(() => ({}))) as any
    const nodes = (body0.nodes || body0.data || []) as any[]
    const hits: Array<{ node: any; s: any }> = []
    for (const n of nodes)
      for (const s of n.active_sessions || [])
        if (s.session_id === wanted || (wanted.length >= 6 && String(s.session_id).endsWith(wanted))) hits.push({ node: n, s })
    if (hits.length !== 1) {
      console.error(hits.length ? `"${wanted}" matches ${hits.length} sessions — use the full id.` : `No session matching "${wanted}".`)
      process.exit(1)
    }
    const { node, s } = hits[0]
    if (s.provider !== "claude_code") {
      console.error(`Answering is supported for Claude Code sessions; this one is ${s.provider}.`)
      process.exit(1)
    }
    const choices = (argv.choice as string[]).map(String)
    const create = await hiveFetch(`/api/v6/nodes/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        node_id: node.id,
        type: "session_message",
        title: `answer ${s.session_id.slice(-8)}`,
        prompt: choices.join(" | "),
        config: { session_id: s.session_id, provider: s.provider, answers: choices, from: os.hostname().replace(/\.local$/, "") },
      }),
    })
    if (!create.ok) {
      console.error(`Could not send: HTTP ${create.status} ${(await create.text()).slice(0, 200)}`)
      process.exit(1)
    }
    const taskId = ((await create.json()) as any)?.task?.id
    // Wait for the node to say what happened. "Sent" is not "answered" — the node may refuse
    // (not on screen, not in tmux), and that refusal is the whole answer.
    let final: any = null
    const deadline = Date.now() + 45_000
    while (taskId && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500))
      const r = await hiveFetch(`/api/v6/nodes/tasks/${taskId}?user_id=${userId}`)
      if (!r.ok) break
      const t = ((await r.json()) as any).task
      if (t && TERMINAL.has(t.status)) { final = t; break }
    }
    const out = final ? fromHiveTask(final) : null
    let body: any = null
    try { body = JSON.parse(String(out?.stdout || "").trim().split("\n").pop() || "") } catch {}
    if (argv.json) return void (await writeJson({ task_id: taskId, status: final?.status ?? "pending", result: body, stderr: out?.stderr }))
    console.log()
    if (body?.delivered) {
      console.log(success(`  ✓ answered`) + dim(` via ${body.delivered === "hook" ? "the waiting hook" : "a keystroke in its tmux pane"} · ${node.name}`))
      for (const [q, a] of Object.entries(body.answers || {})) console.log(dim(`    ${q} → `) + bold(String(a)))
    } else if (final) {
      console.log(warn(`  ✗ not answered`) + dim(` · ${node.name}`))
      console.log(`    ${body?.error || out?.stderr || final.error || "the node gave no reason"}`)
    } else {
      console.log(warn(`  … no result after 45s`) + dim(` — task ${taskId}; check: iris hive tasks ${taskId}`))
    }
    console.log()
  },
})

export const HiveAnswerHookCommand = AnswerHookCommand
export const HiveAnswersCommand = AnswersCommand
export const HiveAwayCommand = AwayCommand
export const HiveAnswerCommand = AnswerCommand
