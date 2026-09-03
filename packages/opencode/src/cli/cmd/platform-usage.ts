import { cmd } from "./cmd"
import { irisFetch, dim, bold, IRIS_API, writeJson } from "./iris-api"
import { readdirSync, readFileSync, statSync } from "fs"
import { homedir } from "os"
import { join } from "path"

/**
 * `iris usage` and `iris traces` — the read half of the trace spine.
 *
 * The spine has been collecting since 2026-08-02 and nothing has ever read it.
 * That is not a small gap: a telemetry store nobody can query is indistinguishable
 * from one that was never built, except that it costs rows. Worse, it means every
 * claim about how the platform behaves — which commands fail, what a run costs,
 * whether the MCP beta is being used at all — has been argued from memory.
 *
 *   iris usage                what I ran, how much of it worked, what it cost
 *   iris usage --days 7
 *   iris usage --local        the same question for Claude Code / Codex, off disk
 *   iris traces               your recent runs, newest first
 *   iris traces <trace_id>    that run's steps
 *   iris traces <id> <span>   one step in full
 *   iris traces --tools       per-tool completion rates across the fleet (operator)
 *
 * Self-scoped by the token: you see your own rows. An operator holding a
 * PLATFORM_API_TOKEN sees the fleet, and can pass --user to narrow it.
 */

const TELEMETRY_BASE = IRIS_API

function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? dim("—") : `${n}%`
}

/**
 * Returns PLAIN text, never pre-styled: several call sites wrap the result in
 * dim() themselves, and a dim() inside a dim() emits nested escape codes that
 * render as literal `[90m` on terminals that do not collapse them.
 */
function ms(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—"
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`
}

function money(n: number | null | undefined): string {
  if (!n) return "$0.00"
  // Four decimals below a cent: individual nano-model calls genuinely cost less
  // than $0.01, and rounding them to two makes a real bill read as free.
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

/**
 * Compact token counts. Cache reads run to billions across a month of sessions, and a
 * fully punctuated 4,359,113,701 overflows its column and collides with the next one —
 * which is how the first version of this table rendered "8,638,2564,359,113,701".
 */
function tokens(n: number): string {
  if (!n) return "0"
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

function bar(value: number, max: number, width = 18): string {
  if (max <= 0) return ""
  return "█".repeat(Math.max(1, Math.round((value / max) * width)))
}

/**
 * Local agent history, read off disk.
 *
 * The server only knows what went through the IRIS proxy. Claude Code and Codex sessions
 * never touch it, so `iris usage` on a fresh machine reports nothing while the same laptop
 * holds months of real token spend in ~/.claude/projects. Reading it makes the command
 * useful on day one rather than after a fleet has been onboarded.
 *
 * IMPORTANT — this is runtime filesystem work, not a static import, so a `--compile` build
 * cannot bundle it away. That is deliberate and it is the thing to re-check on the shipped
 * binary: features that read from disk pass under `bun dev` and can vanish once compiled.
 *
 * Everything here stays on the machine. Nothing is uploaded; there is no beacon on this path.
 */
type LocalUsage = {
  source: string
  model: string
  day: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  messages: number
}

/** Session transcripts, newest first, across every project directory. */
function localSessionFiles(): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = []

  // Claude Code: ~/.claude/projects/<slugified-cwd>/<session-uuid>.jsonl
  const claudeRoot = join(homedir(), ".claude", "projects")
  try {
    for (const project of readdirSync(claudeRoot)) {
      const dir = join(claudeRoot, project)
      try {
        for (const f of readdirSync(dir)) {
          if (f.endsWith(".jsonl")) out.push({ file: join(dir, f), source: "claude-code" })
        }
      } catch {
        // Unreadable project dir — skip it rather than abandoning the whole scan.
      }
    }
  } catch {
    // No Claude Code on this machine. Not an error; most machines have one or the other.
  }

  // Codex: ~/.codex/sessions/**/*.jsonl. Same transcript shape, different home.
  const codexRoot = join(homedir(), ".codex", "sessions")
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e)
      let isDir = false
      try {
        isDir = statSync(p).isDirectory()
      } catch {
        continue
      }
      if (isDir) walk(p, depth + 1)
      else if (e.endsWith(".jsonl")) out.push({ file: p, source: "codex" })
    }
  }
  walk(codexRoot, 0)

  return out
}

/**
 * Aggregate token usage per model per day. Tolerant by design: these are other tools'
 * private formats, they change without notice, and a malformed line must cost one line
 * rather than the whole report.
 */
function readLocalUsage(days: number): { rows: LocalUsage[]; files: number; skipped: number } {
  const cutoff = Date.now() - days * 86_400_000
  const acc = new Map<string, LocalUsage>()
  let files = 0
  let skipped = 0

  for (const { file, source } of localSessionFiles()) {
    try {
      if (statSync(file).mtimeMs < cutoff) continue
    } catch {
      continue
    }
    files++

    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      skipped++
      continue
    }

    for (const line of text.split("\n")) {
      const parsed = parseUsageLine(line, cutoff)
      if (!parsed) continue

      const key = `${source}|${parsed.model}|${parsed.day}`
      const row = acc.get(key) ?? {
        source,
        model: parsed.model,
        day: parsed.day,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        messages: 0,
      }
      row.input += parsed.input
      row.output += parsed.output
      row.cacheRead += parsed.cacheRead
      row.cacheWrite += parsed.cacheWrite
      row.messages += 1
      acc.set(key, row)
    }
  }

  return { rows: [...acc.values()], files, skipped }
}

/**
 * One transcript line → one usage delta, or null to skip it.
 *
 * Split out from readLocalUsage so it can be tested without a filesystem. This parses
 * ANOTHER tool's private format: Claude Code and Codex owe us no compatibility and change
 * their transcript shape whenever they like. So every field is defensive, and the rule is
 * that a line we do not understand costs that line and nothing more — never the file, and
 * never the report. A crash here would take out a command whose entire job is telling you
 * what happened.
 */
export function parseUsageLine(
  line: string,
  cutoff = 0,
  now = Date.now(),
): { model: string; day: string; input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  if (!line.trim()) return null

  let d: any
  try {
    d = JSON.parse(line)
  } catch {
    return null // A truncated final line is normal in a session still being written.
  }

  const m = d?.message
  const u = m?.usage
  // `typeof [] === "object"`, so a bare object check lets an array through and adds a
  // zero-token message to the count — inflating the message tally with rows that carry
  // no usage at all.
  if (!u || typeof u !== "object" || Array.isArray(u)) return null

  const ts = Date.parse(d?.timestamp ?? m?.timestamp ?? "")
  const when = Number.isFinite(ts) ? ts : null
  // An undated line is kept and counted as today. Dropping it would silently undercount,
  // and undercounting is the failure mode this command exists to end.
  if (when !== null && when < cutoff) return null

  const n = (v: unknown) => {
    const x = Number(v ?? 0)
    return Number.isFinite(x) ? x : 0
  }

  return {
    model: String(m.model ?? "unknown"),
    day: new Date(when ?? now).toISOString().slice(0, 10),
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite: n(u.cache_creation_input_tokens),
  }
}

async function renderLocalUsage(days: number, json: boolean): Promise<void> {
  const { rows, files, skipped } = readLocalUsage(days)

  if (json) {
    await writeJson({ window_days: days, files_scanned: files, files_skipped: skipped, rows })
    return
  }

  console.log()
  console.log(bold(`  Local agent usage · last ${days} days`))
  console.log(dim(`  ~/.claude/projects and ~/.codex/sessions · ${files} session files · never uploaded`))
  console.log()

  if (!rows.length) {
    console.log(dim("  No local Claude Code or Codex sessions in this window."))
    console.log()
    return
  }

  const byModel = new Map<string, LocalUsage>()
  for (const r of rows) {
    const key = `${r.source}/${r.model}`
    const cur = byModel.get(key) ?? { ...r, day: "" }
    if (byModel.has(key)) {
      cur.input += r.input
      cur.output += r.output
      cur.cacheRead += r.cacheRead
      cur.cacheWrite += r.cacheWrite
      cur.messages += r.messages
    }
    byModel.set(key, cur)
  }

  const totals = [...byModel.entries()]
    .filter(([, t]) => t.messages > 0)
    .sort((a, b) => b[1].output - a[1].output)

  console.log(
    `  ${dim("model".padEnd(30))}${dim("msgs".padStart(8))}${dim("in".padStart(9))}${dim("out".padStart(9))}${dim("cache rd".padStart(10))}${dim("cache wr".padStart(10))}`,
  )
  for (const [key, t] of totals.slice(0, 15)) {
    console.log(
      `  ${key.slice(0, 29).padEnd(30)}${t.messages.toLocaleString().padStart(8)}${tokens(t.input).padStart(9)}` +
        `${tokens(t.output).padStart(9)}${tokens(t.cacheRead).padStart(10)}${tokens(t.cacheWrite).padStart(10)}`,
    )
  }

  const sum = (f: (r: LocalUsage) => number) => rows.reduce((a, r) => a + f(r), 0)
  console.log()
  console.log(
    `  ${bold(sum((r) => r.messages).toLocaleString())} messages · ` +
      `${tokens(sum((r) => r.input + r.output))} billed tokens · ` +
      `${tokens(sum((r) => r.cacheRead))} read from cache`,
  )
  // Cache reads are counted per message, so the same cached prefix is re-counted on every
  // turn of a long session. That is what the field means; it is a throughput number, not a
  // distinct-bytes one, and summing it to billions is expected rather than a bug.
  console.log(dim("  Cache reads count every turn that re-read the same prefix."))
  // No dollar figure: these transcripts record tokens, not prices, and the plans they were
  // billed under differ per model and per subscription. A number invented here would look
  // exactly like the server-side estimate and be far less defensible.
  console.log(dim("  Tokens only — local transcripts carry no pricing, so no cost is shown."))
  console.log()
}

async function getJson(path: string): Promise<any> {
  const res = await irisFetch(path, {}, TELEMETRY_BASE)
  const text = await res.text()
  if (!res.ok) {
    let detail = text.slice(0, 300)
    try {
      detail = JSON.parse(text)?.error?.message ?? detail
    } catch {}
    throw new Error(`${res.status} — ${detail}`)
  }
  return JSON.parse(text)
}

export const PlatformUsageCommand = cmd({
  command: "usage",
  describe: "what you ran, how much of it worked, and what it cost",
  builder: (yargs) =>
    yargs
      .option("days", { type: "number", default: 30, describe: "window in days (1-365)" })
      .option("source", { type: "string", describe: "filter ACTIVITY to one caller: cli | mcp | api | installer" })
      .option("surface", { type: "string", describe: "filter SPEND to one surface: command_bar | react_loop | heartbeat | proxy | transcription" })
      .option("user", { type: "number", describe: "another user's rows (requires a platform operator token)" })
      .option("local", { type: "boolean", default: false, describe: "local Claude Code / Codex sessions instead of the server" })
      .option("json", { type: "boolean", default: false, describe: "machine-readable" }),
  async handler(args) {
    // Local history is a different corpus, not a filter on the same one — the server has
    // never seen these sessions — so it gets its own view rather than being blended into
    // totals that would then mean two different things at once.
    if (args.local) {
      return await renderLocalUsage(Number(args.days ?? 30), Boolean(args.json))
    }

    const params = new URLSearchParams({ days: String(args.days ?? 30) })
    if (args.source) params.set("source", String(args.source))
    if (args.surface) params.set("surface", String(args.surface))
    if (args.user) params.set("user_id", String(args.user))

    let data: any
    try {
      data = await getJson(`/api/v6/telemetry/usage?${params}`)
    } catch (e: any) {
      console.error(`Could not read usage: ${e.message}`)
      process.exitCode = 1
      return
    }

    if (args.json) {
      await writeJson(data)
      return
    }

    const a = data.activity ?? {}
    const s = data.spend ?? {}

    // An older server does not know `surface`, ignores the query param, and answers 200
    // with the UNFILTERED numbers. Those look exactly like a filtered answer — same shape,
    // same fields, plausible totals — and a reader would quote them as one surface's cost.
    // iris-api and the CLI ship separately, so this is the normal state during a rollout,
    // not an edge case. Refuse rather than print a number that means something else.
    if (args.surface && s.available && s.surface_filter !== String(args.surface)) {
      console.error()
      console.error(`  --surface ${args.surface} was not applied: this IRIS API does not support surface filtering yet.`)
      console.error(`  Showing nothing rather than unfiltered totals under a filtered heading.`)
      console.error(dim(`  Needs iris-api with TelemetryController::spendStats($surface) — epic #182840 / CTX-0b.`))
      console.error()
      process.exitCode = 1
      return
    }

    console.log()
    console.log(bold(`  Usage · last ${data.window_days} days`))
    console.log()

    if (!a.available) {
      // Say WHICH half is missing. "No data" that actually means "this node has not
      // run the migration" is the exact ambiguity the spine exists to remove.
      console.log(`  ${dim("activity:")} unavailable — ${a.reason ?? "unknown"}`)
    } else if (!a.runs) {
      console.log(`  ${dim("No runs recorded in this window.")}`)
      console.log(
        dim(
          "  If you expected some: spans need a CLI new enough to send them, and\n" +
            "  IRIS_TELEMETRY=0 turns them off entirely.",
        ),
      )
    } else {
      console.log(`  ${bold(String(a.runs))} runs · ${pct(a.ok_rate)} finished ok`)
      if (a.started_not_finished > 0) {
        // Not an error count — these are runs that never reported an ending at all.
        // A crash and a still-running command look the same here; both are worth seeing.
        console.log(`  ${a.started_not_finished} started without reporting an end`)
      }
      if (s.available) {
        console.log(`  ${money(s.cost)} ${dim("estimated")} · ${Number(s.tokens ?? 0).toLocaleString()} tokens · ${s.calls} model calls`)
      }
      console.log()

      const cmds = (a.by_command ?? []).slice(0, 12)
      if (cmds.length) {
        const max = Math.max(...cmds.map((c: any) => Number(c.runs)))
        console.log(`  ${dim("command".padEnd(18))}${dim("runs".padStart(6))}  ${dim("ok".padStart(6))}  ${dim("avg")}`)
        for (const c of cmds) {
          const name = String(c.command ?? "—").slice(0, 17).padEnd(18)
          const runs = String(c.runs).padStart(6)
          const ok = pct(c.ok_rate).padStart(6)
          console.log(`  ${name}${runs}  ${ok}  ${ms(c.avg_ms).padStart(7)}  ${dim(bar(Number(c.runs), max))}`)
        }
        console.log()
      }

      const sources = a.by_source ?? []
      if (sources.length) {
        console.log(`  ${dim("by surface:")} ${sources.map((x: any) => `${x.source} ${x.runs}`).join(dim(" · "))}`)
      }
    }

    if (s.available && (s.by_model ?? []).length) {
      console.log()
      console.log(`  ${dim("model".padEnd(30))}${dim("tokens".padStart(12))}${dim("cost".padStart(10))}`)
      for (const m of s.by_model.slice(0, 10)) {
        const name = `${m.provider}/${m.model_name}`.slice(0, 29).padEnd(30)
        console.log(`  ${name}${Number(m.tokens ?? 0).toLocaleString().padStart(12)}${money(Number(m.cost)).padStart(10)}`)
      }
      console.log()
      console.log(dim(`  Cost is ${s.cost_basis}. Treat it as a comparison, not a bill.`))
    } else if (!s.available) {
      console.log(`  ${dim("spend:")} unavailable — ${s.reason ?? "unknown"}`)
    }

    // Who spent it. `source` on the cost rows is the agent/component that triggered the call.
    if (s.available && (s.by_agent ?? []).length) {
      console.log()
      console.log(`  ${dim("agent".padEnd(30))}${dim("calls".padStart(8))}${dim("tokens".padStart(12))}${dim("cost".padStart(10))}`)
      for (const a2 of s.by_agent.slice(0, 10)) {
        console.log(
          `  ${String(a2.source ?? "—").slice(0, 29).padEnd(30)}${String(a2.calls).padStart(8)}` +
            `${Number(a2.tokens ?? 0).toLocaleString().padStart(12)}${money(Number(a2.cost)).padStart(10)}`,
        )
      }
    }

    // Which SURFACE spent it, and how fat its prompts were. avg-in is the column that
    // earns this table: total tokens cannot tell a bloated system prompt from a long
    // answer, and those have opposite fixes. A surface whose avg-in dwarfs its avg-out
    // is paying for context it did not ask for on every single turn.
    if (s.available && (s.by_surface ?? []).length) {
      console.log()
      console.log(
        `  ${dim("surface".padEnd(24))}${dim("calls".padStart(8))}${dim("avg-in".padStart(10))}` +
          `${dim("max-in".padStart(10))}${dim("cost".padStart(10))}`,
      )
      for (const r of s.by_surface.slice(0, 10)) {
        console.log(
          `  ${String(r.surface ?? "—").slice(0, 23).padEnd(24)}${String(r.calls).padStart(8)}` +
            `${Number(r.avg_input_tokens ?? 0).toLocaleString().padStart(10)}` +
            `${Number(r.max_input_tokens ?? 0).toLocaleString().padStart(10)}` +
            `${money(Number(r.cost)).padStart(10)}`,
        )
      }
    }

    // How big the prompts actually are. Percentiles, not an average, and here is the
    // reason: a context block is paid on EVERY turn, so the number that decides whether a
    // budget blows is the worst turn on a populated account — an account with no leads and
    // an account with four hundred share an average and differ entirely at p99.
    //
    // This is the observation that replaces the hand-tokenised estimate in CTX-0, which
    // measured the SOURCE and said so. Narrow it with --surface to size one surface.
    const pp = s.input_percentiles
    if (s.available && pp) {
      console.log()
      if (pp.available === false) {
        console.log(`  ${dim("prompt size:")} unavailable — ${pp.reason}`)
      } else if (!pp.calls) {
        // Say which filter emptied it. "0 calls" under a --surface nobody ever wrote is a
        // typo, not a finding, and the two must not look the same.
        console.log(
          `  ${dim("prompt size:")} no model calls${s.surface_filter ? ` on surface ${bold(String(s.surface_filter))}` : ""} in this window`,
        )
        if (s.surface_filter && (s.by_surface ?? []).length) {
          console.log(dim(`  surfaces with rows: ${s.by_surface.map((r: any) => r.surface).join(", ")}`))
        }
      } else {
        const label = s.surface_filter ? `prompt tokens · ${s.surface_filter}` : "prompt tokens · all surfaces"
        console.log(`  ${bold(label)} ${dim(`(${pp.calls.toLocaleString()} calls)`)}`)
        console.log(
          `  ${dim("p50")} ${String(pp.p50.toLocaleString()).padEnd(10)}${dim("p90")} ${String(pp.p90.toLocaleString()).padEnd(10)}` +
            `${dim("p99")} ${String(pp.p99.toLocaleString()).padEnd(10)}${dim("max")} ${pp.max.toLocaleString()}`,
        )
      }
    }

    if (s.available && (s.by_type ?? []).length) {
      console.log()
      console.log(`  ${dim("by type:")} ${s.by_type.map((t: any) => `${t.usage_type ?? "—"} ${money(Number(t.cost))}`).join(dim(" · "))}`)
    }

    // Per-run cost (#179797). Still says WHY when it cannot answer, rather than letting an
    // absence read as "you had no runs" — and when it can, it shows how much spend is
    // untraced, because early on that is most of it and a short list of cheap runs would
    // otherwise look like complete coverage.
    const run = s.per_run
    if (s.available && run && run.available === false) {
      console.log()
      console.log(dim(`  No per-run cost: ${run.reason}`))
    } else if (s.available && run?.available) {
      console.log()
      if (run.note) console.log(dim(`  ${run.note}`))
      if ((run.runs ?? []).length) {
        console.log(`  ${dim("run")}${" ".repeat(28)}${dim("calls")}${dim("      tokens")}${dim("      cost")}`)
        for (const r of run.runs.slice(0, 10)) {
          const id = String(r.trace_id ?? "—").slice(0, 12)
          console.log(
            `  ${id.padEnd(30)}${String(r.calls).padStart(5)}${String(r.tokens).padStart(12)}${money(Number(r.cost)).padStart(10)}`,
          )
        }
      }
      console.log(
        dim(`  ${run.traced_rows} of ${run.traced_rows + run.untraced_rows} cost rows carry a run id.`) +
          dim(" Rows written before the stamp shipped cannot be attributed retroactively."),
      )
    }

    console.log()
    console.log(dim("  iris usage --local   the same question for Claude Code / Codex, read off disk"))
    console.log()
  },
})

export const PlatformTracesCommand = cmd({
  // Both ids are positional, so depth reads left to right: `traces`, `traces <run>`,
  // `traces <run> <step>`. Declaring only [trace_id] made the third level unreachable —
  // yargs rejected the extra positional and printed help instead.
  command: "traces [trace_id] [span_id]",
  describe: "what you ran — drill from runs, to one run's steps, to one step",
  builder: (yargs) =>
    yargs
      .positional("trace_id", { type: "string", describe: "a run id from the list — shows its steps" })
      .positional("span_id", { type: "string", describe: "a step id from a run — shows that step in full" })
      .option("hours", { type: "number", default: 24, describe: "window in hours (1-720)" })
      .option("failed", { type: "boolean", default: false, describe: "only runs that errored or never finished" })
      .option("tools", { type: "boolean", default: false, describe: "per-tool completion rates across the fleet (operator token)" })
      .option("tool", { type: "string", describe: "with --tools, filter to one tool" })
      .option("source", { type: "string", describe: "cli | mcp | proxy" })
      .option("user", { type: "number", describe: "another user's rows (operator token, --tools only)" })
      .option("json", { type: "boolean", default: false, describe: "machine-readable" }),
  async handler(args) {
    // ── Operator aggregate (--tools) ─────────────────────────────────────
    // A different QUESTION, not a deeper level: "which tools are failing across
    // everyone" rather than "what did I run". It keeps its own flag rather than
    // becoming `iris tools-traces`, and it is the only path that needs an admin token.
    if (args.tools) {
      return renderToolAggregate(args)
    }

    // ── The three depths ─────────────────────────────────────────────────
    // Depth is carried by which ids you hold, mirroring the inspect_runs tool: no id
    // lists runs and hands back trace ids; a trace id buys its steps and their span
    // ids; a span id buys one step. You cannot skip ahead, because the identifiers for
    // the deeper levels only exist in the output of the shallower ones.
    const params = new URLSearchParams()
    if (args.trace_id) params.set("trace_id", String(args.trace_id))
    if (args.span_id) params.set("span_id", String(args.span_id))
    if (!args.trace_id) {
      params.set("hours", String(args.hours ?? 24))
      if (args.failed) params.set("only_failed", "1")
      // --source was declared as an option and then never forwarded, so every value
      // returned the same unfiltered rows. A filter that silently declines to filter
      // reads as "there is nothing else here" — which is exactly wrong when you are
      // using it to ask why one surface looks empty.
      if (args.source) params.set("source", String(args.source))
    }

    let data: any
    try {
      data = await getJson(`/api/v6/telemetry/runs?${params}`)
    } catch (e: any) {
      console.error(`Could not read runs: ${e.message}`)
      process.exitCode = 1
      return
    }

    if (args.json) {
      await writeJson(data)
      return
    }

    if (data.level === "span") return renderSpan(data)
    if (data.level === "steps") return renderSteps(data)
    return renderRuns(data, args)
  },
})

/** LEVEL 1 — what ran. Every line carries the trace id level 2 needs. */
function renderRuns(data: any, args: any): void {
  console.log()
  console.log(bold(`  Runs · last ${data.window_hours}h`))
  console.log()

  const runs = data.runs ?? []
  if (!runs.length) {
    console.log(dim(args.failed ? "  No failed runs in this window." : "  No runs recorded in this window."))
    console.log(
      dim(
        "  If you expected some: spans need a CLI new enough to send them, and\n" +
          "  IRIS_TELEMETRY=0 turns them off entirely.",
      ),
    )
    console.log()
    return
  }

  for (const r of runs) {
    const mark = !r.finished ? "·" : r.outcome === "error" ? "✗" : "✓"
    const state = r.finished ? (r.outcome ?? "ended") : "never finished"
    const label = String(r.command ?? "(session)").slice(0, 26).padEnd(27)
    console.log(`  ${mark} ${label}${dim(String(r.source ?? "?").padEnd(6))}${state.padEnd(15)}${dim(ms(r.duration_ms).padStart(8))}`)
    console.log(`    ${dim(r.trace_id)}`)
  }
  console.log()
  console.log(dim(`  iris traces <id>          steps for one run`))
  console.log(dim(`  iris traces <id> <span>   one step in full`))
  console.log()
}

/** LEVEL 2 — one run's steps, as the tree they actually are. */
function renderSteps(data: any): void {
  console.log()
  console.log(bold(`  Run ${data.trace_id}`))
  console.log(`  ${data.step_count} steps`)
  console.log()

  // Indent children under their parent so retries and nested tool calls read as a
  // tree rather than a flat list in timestamp order.
  const byParent = new Map<string, any[]>()
  for (const sp of data.steps ?? []) {
    const key = sp.parent_span_id ?? "__root__"
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(sp)
  }

  const seen = new Set<string>()
  const walk = (key: string, depth: number) => {
    for (const sp of byParent.get(key) ?? []) {
      if (sp.span_id && seen.has(sp.span_id)) continue
      if (sp.span_id) seen.add(sp.span_id)
      const mark = sp.outcome === "error" ? "✗" : sp.outcome === "ok" ? "✓" : "·"
      const label = sp.tool_name ?? sp.command ?? sp.event_type
      console.log(`  ${"  ".repeat(depth)}${mark} ${label} ${dim(ms(sp.duration_ms))}${sp.span_id ? dim(`  ${sp.span_id}`) : ""}`)
      if (sp.span_id) walk(sp.span_id, depth + 1)
    }
  }
  walk("__root__", 0)

  // Spans whose parent is missing from this window would otherwise be printed by
  // nobody. Showing them flat beats silently dropping steps.
  for (const sp of (data.steps ?? []).filter((sp: any) => sp.span_id && !seen.has(sp.span_id))) {
    console.log(`  · ${sp.tool_name ?? sp.event_type} ${dim(ms(sp.duration_ms))} ${dim("(parent not in window)")}`)
  }
  console.log()
}

/** LEVEL 3 — one step, everything recorded about it. */
function renderSpan(data: any): void {
  const s = data.span ?? {}
  console.log()
  console.log(bold(`  ${s.tool_name ?? s.command ?? s.event_type}`))
  console.log(dim(`  run ${data.trace_id} · step ${s.span_id}`))
  console.log()
  const row = (k: string, v: any) => v !== null && v !== undefined && v !== "" && console.log(`  ${dim(k.padEnd(12))}${v}`)
  row("outcome", s.outcome)
  row("duration", s.duration_ms !== null && s.duration_ms !== undefined ? ms(s.duration_ms) : null)
  row("status", s.status_code)
  row("model", [s.provider, s.model].filter(Boolean).join(" ") || null)
  row("source", s.source)
  row("parent", s.parent_span_id)
  row("at", s.created_at)
  row("message", s.message)
  console.log()
  console.log(dim("  Spans carry shapes only — never arguments, prompts or responses."))
  console.log()
}

/** The fleet view. Admin-gated server-side; says so plainly instead of leaking a 403. */
async function renderToolAggregate(args: any): Promise<void> {
  const params = new URLSearchParams({ hours: String(args.hours ?? 24) })
  if (args.tool) params.set("tool", String(args.tool))
  if (args.source) params.set("source", String(args.source))
  if (args.user) params.set("user_id", String(args.user))

  let data: any
  try {
    data = await getJson(`/api/v6/telemetry/traces?${params}`)
  } catch (e: any) {
    if (String(e.message).startsWith("403")) {
      console.error("  --tools is the fleet-wide operator view and needs a platform token.")
      console.error(dim("  For your own runs, drop the flag: iris traces"))
      process.exitCode = 1
      return
    }
    console.error(`Could not read traces: ${e.message}`)
    process.exitCode = 1
    return
  }

  if (args.json) {
    await writeJson(data)
    return
  }

    // ── Aggregate ────────────────────────────────────────────────────────
    console.log()
    console.log(bold(`  Traces · last ${data.window_hours}h`))
    console.log()
    console.log(`  ${data.total_traces} runs · ${data.total_spans} spans · ${data.runs_finished}/${data.runs_started} finished`)

    if (data.runs_unfinished > 0) {
      console.log(`  ${data.runs_unfinished} never reported an end${dim(" — iris traces <id> to open one")}`)
      for (const t of (data.unfinished_traces ?? []).slice(0, 5)) console.log(dim(`      ${t}`))
    }
    console.log()

    const tools = data.by_tool ?? []
    if (!tools.length) {
      console.log(dim("  No tool spans in this window."))
      console.log()
      return
    }

    const max = Math.max(...tools.map((t: any) => Number(t.calls)))
    console.log(`  ${dim("tool".padEnd(28))}${dim("calls".padStart(6))}  ${dim("ok".padStart(6))}  ${dim("avg")}`)
    for (const t of tools.slice(0, 25)) {
      const name = String(t.tool_name).slice(0, 27).padEnd(28)
      const calls = String(t.calls).padStart(6)
      const ok = pct(t.ok_rate).padStart(6)
      // A tool that is abandoned rather than failing is a different problem — the
      // model gave up or timed out mid-call — so it gets its own column, not a
      // silent merge into the error count.
      const abandoned = Number(t.abandoned) > 0 ? dim(` ${t.abandoned} abandoned`) : ""
      console.log(`  ${name}${calls}  ${ok}  ${ms(t.avg_ms).padStart(7)}  ${dim(bar(Number(t.calls), max))}${abandoned}`)
    }
    console.log()
}
