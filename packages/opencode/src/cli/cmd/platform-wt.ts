// `iris wt` — a thin passthrough to the worktree script (#190212).
//
// The worktree rule (#188702: every worktree tied to a ticket, cap 15 per machine) is enforced by
// a shell script, `wt`, that lives in ~/.iris/bin or in a repo's scripts/ folder. It was not an
// iris command and not on PATH, so an agent that knew the rule burned six calls guessing where
// the tool was (`iris wt`, `./wt`, `../scripts/wt`, …). This finds it and runs it, unchanged.
//
//   iris wt new <ticket-id> <slug> [base]   iris wt list   iris wt done [path]   iris wt prune
//
// Run it from the TARGET repo's main checkout — the script reads `git rev-parse --show-toplevel`.

import { statSync } from "fs"
import { dirname, join } from "path"
import { homedir } from "os"
import { spawnSync } from "child_process"
import { cmd } from "./cmd"

export const WT_RULE = "run from the target repo's main checkout (e.g. cd ~/work/<repo> && iris wt new <ticket-id> <slug>)"

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Where the wt script is, in order: ~/.iris/bin/wt, <git toplevel>/scripts/wt, then scripts/wt in
 * each parent directory of the cwd. `looked` lists every path checked, for the not-found message.
 */
export function resolveWtScript(opts: {
  cwd: string
  home?: string
  gitToplevel?: string | null
  exists?: (p: string) => boolean
}): { path: string | null; looked: string[] } {
  const exists = opts.exists ?? isFile
  const looked: string[] = []
  const tryPath = (p: string) => {
    if (looked.includes(p)) return false
    looked.push(p)
    return exists(p)
  }
  const home = opts.home ?? homedir()
  const candidates: string[] = [join(home, ".iris", "bin", "wt")]
  if (opts.gitToplevel) candidates.push(join(opts.gitToplevel, "scripts", "wt"))
  for (let dir = opts.cwd; ; ) {
    candidates.push(join(dir, "scripts", "wt"))
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  for (const c of candidates) if (tryPath(c)) return { path: c, looked }
  return { path: null, looked }
}

function gitToplevel(cwd: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8" })
  return r.status === 0 ? r.stdout.trim() || null : null
}

/** Everything after `wt` on the command line, verbatim — flags included. */
export function wtArgs(argv: string[]): string[] {
  // Skip the runtime and script path (argv[0..1]); the first "wt"/"worktree" after them is ours.
  const i = argv.findIndex((a, n) => n >= 1 && (a === "wt" || a === "worktree"))
  return i === -1 ? [] : argv.slice(i + 1)
}

export const PlatformWtCommand = cmd({
  command: "wt [args..]",
  aliases: ["worktree"],
  describe: "make a worktree tied to a ticket, list, finish or prune them — runs the wt script (new <ticket-id> <slug> | list | done | prune)",
  builder: (yargs) =>
    yargs
      .positional("args", { describe: "passed to the wt script unchanged: new <ticket-id> <slug> [base] | list | done [path] | prune", type: "string", array: true })
      .strict(false),
  async handler() {
    const cwd = process.cwd()
    const found = resolveWtScript({ cwd, gitToplevel: gitToplevel(cwd) })
    if (!found.path) {
      console.error("iris wt: the wt script was not found. Looked in:")
      for (const p of found.looked) console.error(`  ${p}`)
      console.error(`Rule: ${WT_RULE}`)
      process.exitCode = 127
      return
    }
    const r = spawnSync(found.path, wtArgs(process.argv), { cwd, stdio: "inherit" })
    if (r.error) {
      console.error(`iris wt: could not run ${found.path}: ${r.error.message}`)
      process.exitCode = 126
      return
    }
    process.exitCode = r.status ?? 1
  },
})
