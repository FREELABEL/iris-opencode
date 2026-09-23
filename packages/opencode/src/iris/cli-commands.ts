import { execFile } from "child_process"
import { irisCliPath } from "./playbook-install"

/**
 * THE IRIS CLI's OWN COMMANDS, for the desktop command palette (#186546).
 *
 * The palette listed three things — New session, Toggle terminal, Toggle review — because those
 * are the app's own commands, and they are all the app knows about. The 1,664 IRIS commands are
 * not in this binary at all: the desktop engine carries 28 command modules and none of the
 * platform ones (that is the point of the sidecar split), so no amount of looking inward finds
 * `iris leads` or `iris pages`.
 *
 * They live in the INSTALLED CLI, which already answers the question for agents:
 *
 *     iris find <query> --kind command --limit N --json
 *
 * So this asks it. execFile with an argv array and no shell, exactly like playbook-install: a
 * query typed by a person must never reach a shell.
 *
 * WHEN THE CLI IS ABSENT the answer is "not installed", never an empty list — an empty palette
 * would read as "there are no commands", which is the opposite of true.
 */
export interface CliCommand {
  name: string
  describe?: string
  run: string
  aliases?: string[]
}

type Exec = (file: string, args: string[], opts: { timeoutMs: number }) => Promise<{ code: number; stdout: string }>

const realExec: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout ?? "") })
    })
  })

/** The CLI prints a banner around its JSON; take the object it printed. */
export function parseFindJson(stdout: string): CliCommand[] {
  const start = stdout.indexOf("{")
  if (start < 0) return []
  try {
    const body = JSON.parse(stdout.slice(start, stdout.lastIndexOf("}") + 1))
    const rows = Array.isArray(body?.results) ? body.results : []
    return rows
      .filter((r: any) => r && r.kind === "command" && typeof r.name === "string")
      .map((r: any) => ({
        name: r.name,
        describe: typeof r.describe === "string" ? r.describe : undefined,
        run: typeof r.run === "string" && r.run ? r.run : `iris ${r.name}`,
        aliases: Array.isArray(r.aliases) ? r.aliases.filter((a: any) => typeof a === "string") : undefined,
      }))
  } catch {
    return []
  }
}

/** A query the CLI can take as one argv item. Anything wilder is not a command search. */
export function sanitiseQuery(q: unknown): string {
  return String(q ?? "")
    .replace(/[^\w .:/-]/g, " ")
    .trim()
    .slice(0, 80)
}

export async function searchCliCommands(
  query: string,
  opts: { limit?: number; cli?: string | null; exec?: Exec } = {},
): Promise<{ measured: boolean; reason?: string; commands: CliCommand[] }> {
  const cli = opts.cli === undefined ? irisCliPath() : opts.cli
  if (!cli) {
    return {
      measured: false,
      reason: "The IRIS CLI is not installed on this machine, so its commands cannot be listed here.",
      commands: [],
    }
  }
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100)
  // An empty query still has to return something: the palette opens before anyone types, and a
  // blank list there is indistinguishable from "no commands exist". `iris` matches broadly.
  const q = sanitiseQuery(query) || "iris"
  const r = await (opts.exec ?? realExec)(cli, ["find", q, "--kind", "command", "--limit", String(limit), "--json"], {
    timeoutMs: 15_000,
  })
  const commands = parseFindJson(r.stdout)
  if (r.code !== 0 && commands.length === 0) {
    return { measured: false, reason: "the IRIS CLI could not list its commands", commands: [] }
  }
  return { measured: true, commands }
}
