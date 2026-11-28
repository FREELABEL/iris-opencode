import { spawn } from "child_process"
import { homedir } from "os"
import { irisCliPath } from "./playbook-install"

/**
 * RUN ONE `iris …` COMMAND FOR A BUTTON (#194581).
 *
 * Desktop panes ended in "Copy scan command" / "Run iris hive connect in a terminal": a button that
 * copies a command is not a button. This is the narrow way a pane runs the command instead.
 *
 * WHAT IT WILL RUN, AND HOW:
 *   - only the installed IRIS CLI (`~/.iris/bin/iris`), never another program;
 *   - the words as an argv array — no shell, so `;`, `&&`, `$(…)` and quotes are just characters
 *     inside one argument;
 *   - stdin closed (a prompt cannot hang it), a time limit, output capped;
 *   - not the commands that start a server or a UI, or replace the CLI itself (`BLOCKED`).
 *
 * READ OR WRITE: a command is a READ only when it is clearly one — its subcommand has a read verb
 * (`list`, `show`, `get`, …) and no part of it is a write word, or it only asks for `--help`.
 * Everything else is a WRITE, and a write runs only with `confirmed: true` — the app asks the
 * person first, in words, and the engine refuses an unconfirmed write even if the app forgot.
 */

/** Subcommand words that only look. A read has one of these after its group (`leads list`), and no write word. */
const READ_VERB =
  /^(list|ls|show|get|view|search|find|status|info|whoami|help|version|stats|count|describe|inspect|preview|history|logs|tail|peek|query|sessions|tasks|peers|machines|nodes|inventory)$/

/** Any of these in the subcommand path makes it a write, whatever it ends in. Matched per hyphen-part. */
const WRITE_WORD =
  /^(create|add|new|update|edit|set|move|delete|del|rm|remove|import|archive|unarchive|assign|unassign|note|comment|done|complete|close|reopen|rename|tag|untag|label|publish|unpublish|push|send|enroll|convert|merge|link|unlink|attach|detach|upload|save|install|uninstall|share|invite|approve|reject|pin|unpin|sync|run|start|stop|scan|connect|disconnect|login|logout|signin|signout|reset|restart|kill|revoke|grant|pay|charge|refund|deploy|release|fix|repair|apply|rollback|restore|clear|purge|enable|disable|accept|decline|reply|post|schedule|cancel|trigger|fire|answer)$/

/** Top-level commands a button never runs: servers, UIs, and the CLI replacing itself. */
const BLOCKED = new Set(["serve", "web", "tui", "attach", "acp", "mcp-server", "upgrade", "uninstall", "completion", "shell"])

export type CommandKind = "read" | "write"

/** The subcommand path: the leading words, up to the first flag or the first thing that is a value. */
export function subcommandPath(argv: readonly string[]): string[] {
  const out: string[] = []
  for (const w of argv) {
    if (!w || w.startsWith("-")) break
    // A value, not a subcommand: an id, a path, a quoted phrase, a URL, anything with odd characters.
    if (!/^[a-z][a-z0-9-]*$/.test(w)) break
    out.push(w)
  }
  return out
}

export function classifyIrisArgv(argv: readonly string[]): CommandKind {
  const words = argv[0] === "iris" ? argv.slice(1) : argv
  const asksHelp = words.some((w) => w === "--help" || w === "-h")
  const path = subcommandPath(words)
  if (path.some((w) => w.split("-").some((p) => WRITE_WORD.test(p)))) return asksHelp ? "read" : "write"
  if (asksHelp) return "read"
  // A plain word after the verb is a value (`pages search pricing`), so the verb may not be last.
  return path.some((w) => READ_VERB.test(w)) ? "read" : "write"
}

/** Why this argv must not run at all, or undefined. */
export function refuseIrisArgv(argv: readonly unknown[]): string | undefined {
  if (!Array.isArray(argv) || argv.length === 0) return "no command was given"
  if (argv.length > 64) return "too many words in the command"
  for (const w of argv) {
    if (typeof w !== "string") return "every word of the command must be text"
    if (w.length > 4096) return "a word in the command is too long"
    if (w.includes("\0")) return "the command contains a character that cannot be passed on"
  }
  const words = argv[0] === "iris" ? argv.slice(1) : argv
  if (words.length === 0) return "no command was given"
  const top = String(words[0])
  if (top.startsWith("-") && !words.some((w) => w === "--help" || w === "-h")) return "the command must start with a subcommand"
  if (BLOCKED.has(top)) return `\`iris ${top}\` starts a server or replaces the CLI, so it is not run from a button`
  return undefined
}

export interface RunResult {
  /** True when the CLI was started. */
  ran: boolean
  kind: CommandKind
  /** A write that was not confirmed: nothing ran. The app shows its confirm and asks again. */
  needsConfirm?: boolean
  /** It must not run at all, in words. */
  refused?: string
  code?: number
  stdout?: string
  stderr?: string
  /** Output was longer than the cap and was cut. */
  truncated?: boolean
  timedOut?: boolean
  ms?: number
}

type Exec = (
  file: string,
  args: string[],
  opts: { timeoutMs: number; maxBytes: number },
) => Promise<{ code: number; stdout: string; stderr: string; truncated: boolean; timedOut: boolean }>

const MAX_BYTES = 256 * 1024
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g

export function cleanOutput(s: string): string {
  return s.replace(ANSI, "").replace(/\r\n?/g, "\n")
}

const realExec: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: homedir(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", IRIS_NONINTERACTIVE: "1" },
    })
    let out = ""
    let err = ""
    let truncated = false
    let timedOut = false
    const take = (cur: string, chunk: Buffer) => {
      if (cur.length >= opts.maxBytes) {
        truncated = true
        return cur
      }
      const next = cur + chunk.toString("utf8")
      if (next.length > opts.maxBytes) truncated = true
      return next.slice(0, opts.maxBytes)
    }
    child.stdout?.on("data", (c: Buffer) => (out = take(out, c)))
    child.stderr?.on("data", (c: Buffer) => (err = take(err, c)))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), 2000).unref?.()
    }, opts.timeoutMs)
    child.on("error", (e) => {
      clearTimeout(timer)
      resolve({ code: 127, stdout: out, stderr: err || String(e.message), truncated, timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? (timedOut ? 124 : 1), stdout: out, stderr: err, truncated, timedOut })
    })
  })

/** What the route uses. Tests swap these (the route test stubs `exec`; nothing real runs). */
export const runDeps: { cli: () => string | null; exec: Exec } = { cli: () => irisCliPath(), exec: realExec }

export async function runIrisArgv(
  input: { argv: readonly unknown[]; confirmed?: boolean },
  deps: { cli?: string | null; exec?: Exec; timeoutMs?: number; now?: () => number } = {},
): Promise<RunResult> {
  const refused = refuseIrisArgv(input.argv)
  const argv = (Array.isArray(input.argv) ? input.argv : []).map(String)
  const words = argv[0] === "iris" ? argv.slice(1) : argv
  const kind = refused ? "write" : classifyIrisArgv(words)
  if (refused) return { ran: false, kind, refused }
  if (kind === "write" && input.confirmed !== true) return { ran: false, kind, needsConfirm: true }
  const cli = deps.cli === undefined ? runDeps.cli() : deps.cli
  if (!cli) return { ran: false, kind, refused: "The IRIS CLI is not installed on this computer, so the command cannot run here." }
  const now = deps.now ?? Date.now
  const started = now()
  const r = await (deps.exec ?? runDeps.exec)(cli, words, { timeoutMs: deps.timeoutMs ?? 120_000, maxBytes: MAX_BYTES })
  return {
    ran: true,
    kind,
    code: r.code,
    stdout: cleanOutput(r.stdout),
    stderr: cleanOutput(r.stderr),
    truncated: r.truncated || undefined,
    timedOut: r.timedOut || undefined,
    ms: now() - started,
  }
}
