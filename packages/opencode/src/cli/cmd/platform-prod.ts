import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, printDivider, dim, bold, writeJson } from "./iris-api"
import { spawn } from "child_process"

// ============================================================================
// `iris prod` — what is actually happening on production, without memorising
// eleven `railway` incantations.
//
// Production is Railway, project `freelabel-eco`, environment `production`.
// Everything here shells out to the Railway CLI, so it inherits that auth and
// adds nothing new to steal.
//
// The design rule, learned from PRODUCTION_DEBUGGING_GUIDE.md the hard way:
// NEVER report a green state you did not actually measure. Every check below
// either prints a real value or says plainly that it could not be read. A
// check that cannot distinguish "healthy" from "not checked" is worse than no
// check, because it retires the question.
// ============================================================================

/** The services that make up production, in the order an operator cares about. */
const SERVICES = [
  { name: "fl-iris-api", role: "Iris main API (V6 engine)", repo: "iris" },
  { name: "fl-iris-worker", role: "Iris queue worker", repo: "iris" },
  { name: "fl-api", role: "Laravel 8 main API", repo: "fl-api" },
  { name: "fl-api-worker", role: "fl-api queue worker", repo: "fl-api" },
  { name: "fl-api-scheduler", role: "fl-api cron / scheduler", repo: "fl-api" },
  { name: "fl-elon-web-ui", role: "Elon frontend (Nuxt 2)", repo: "elon" },
  { name: "fl-n8n", role: "n8n automation", repo: "n8n" },
] as const

/**
 * Drift means "services that deploy from the SAME repo are on different commits".
 * Comparing every service globally is wrong — these are four separate repos, so a
 * global compare warns on every single run, and a check that always cries wolf is
 * one nobody reads. Only an intra-repo mismatch is the classic stale-worker bug.
 */
function repoDrift(rows: { service: string; commit: string | null }[]): string[] {
  const byRepo = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!r.commit) continue
    const repo = SERVICES.find((s) => s.name === r.service)?.repo ?? r.service
    if (!byRepo.has(repo)) byRepo.set(repo, new Set())
    byRepo.get(repo)!.add(r.commit.slice(0, 12))
  }
  return [...byRepo.entries()].filter(([, v]) => v.size > 1).map(([k]) => k)
}

/** Lines worth waking up for. Deliberately broad — false positives are cheap here. */
const ERROR_PATTERNS = /\b(error|exception|fatal|critical|failed|failure|traceback|stack trace|panic|refused|timeout|timed out|502|503|504|500)\b/i

/** Noise that matches ERROR_PATTERNS but never means anything. */
const NOISE_PATTERNS = /(error_log|log_errors|error_reporting|display_errors|ErrorDocument|--error|errorFormat|no error)/i

type RailwayResult = { ok: boolean; out: string; err: string; code: number | null }

/**
 * Run the Railway CLI with a hard timeout.
 *
 * `railway logs` follows by default and never exits, so every call here is
 * bounded. A hung poll that prints nothing looks exactly like a healthy quiet
 * service, which is the failure mode this whole command exists to avoid.
 */
function railway(args: string[], timeoutMs = 25_000): Promise<RailwayResult> {
  return new Promise((resolve) => {
    let out = "", err = "", settled = false
    const child = spawn("railway", args, { stdio: ["ignore", "pipe", "pipe"] })

    const finish = (code: number | null, timedOut = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill("SIGKILL") } catch { /* already gone */ }
      // A timeout that produced output is a success: `logs` never exits on its own.
      resolve({ ok: (code === 0 || (timedOut && out.length > 0)), out, err, code })
    }

    const timer = setTimeout(() => finish(null, true), timeoutMs)
    child.stdout.on("data", (d) => { out += d.toString() })
    child.stderr.on("data", (d) => { err += d.toString() })
    child.on("close", (code) => finish(code))
    child.on("error", (e) => { err += String(e); finish(null) })
  })
}

// Widened on purpose: SERVICES is `as const`, so its element type is a union of the
// seven known service NAMES. The passthrough branch below returns a service that is by
// definition not in that union, so the narrow type cannot describe this function's
// return value. `repo` is set to the service's own name so an unknown service is only
// ever compared against itself when computing deploy drift.
type Service = { name: string; role: string; repo: string }

function resolveServices(only?: string): Service[] {
  if (!only) return [...SERVICES]
  const want = only.toLowerCase()
  const hit = SERVICES.filter((s) => s.name.toLowerCase().includes(want))
  return hit.length ? [...hit] : [{ name: only, role: "(not a known service — passed through)", repo: only }]
}

function errorLines(raw: string): string[] {
  return raw.split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && ERROR_PATTERNS.test(l) && !NOISE_PATTERNS.test(l))
}

// ---------------------------------------------------------------------------

const LogsCommand = cmd({
  command: "logs [service]",
  describe: "recent production logs — one service, or a sweep across all of them",
  builder: (yargs) =>
    yargs
      .positional("service", { type: "string", describe: "service name or fragment (default: all)" })
      .option("lines", { type: "number", default: 60, describe: "lines per service" })
      .option("errors", { type: "boolean", default: false, describe: "only show error-shaped lines" })
      .option("build", { type: "boolean", default: false, describe: "build logs instead of runtime" })
      .option("timeout", { type: "number", default: 25, describe: "seconds to wait per service" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const services = resolveServices(args.service as string | undefined)
    UI.empty()
    prompts.intro(`◈  Production logs ${dim(`(${services.length} service${services.length > 1 ? "s" : ""})`)}`)

    const results: any[] = []
    for (const svc of services) {
      const flags = ["logs", "-s", svc.name, "--lines", String(args.lines)]
      if (args.build) flags.push("-b")
      const r = await railway(flags, Math.max(5, Number(args.timeout)) * 1000)

      const lines = args.errors ? errorLines(r.out) : r.out.split("\n").filter((l) => l.trim())
      results.push({ service: svc.name, ok: r.ok, lines: lines.length, output: lines })

      if (!args.json) {
        console.log("")
        console.log(`${bold(svc.name)}  ${dim(svc.role)}`)
        if (!r.ok && !r.out.trim()) {
          // Say which it is. "No logs" and "could not read logs" are different facts.
          console.log(`  ${dim("could not read logs —")} ${(r.err.trim().split("\n")[0] || "no output").slice(0, 160)}`)
        } else if (!lines.length) {
          console.log(`  ${dim(args.errors ? "no error-shaped lines in this window" : "no output in this window")}`)
        } else {
          for (const l of lines.slice(-Number(args.lines))) console.log(`  ${l.slice(0, 240)}`)
        }
      }
    }

    if (args.json) return writeJson({ services: results })
    printDivider()
    prompts.outro(dim("iris prod errors  ·  iris prod status  ·  iris prod check"))
  },
})

const ErrorsCommand = cmd({
  command: "errors",
  aliases: ["problems"],
  describe: "sweep every production service for error-shaped log lines",
  builder: (yargs) =>
    yargs
      .option("lines", { type: "number", default: 200, describe: "lines to scan per service" })
      .option("timeout", { type: "number", default: 25 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Production errors ${dim(`(scanning ${args.lines} lines x ${SERVICES.length} services)`)}`)

    const report: any[] = []
    let totalErrors = 0, unreadable = 0

    for (const svc of SERVICES) {
      const r = await railway(["logs", "-s", svc.name, "--lines", String(args.lines)], Math.max(5, Number(args.timeout)) * 1000)
      const readable = r.ok || r.out.trim().length > 0
      const errs = readable ? errorLines(r.out) : []
      if (!readable) unreadable++
      totalErrors += errs.length
      report.push({ service: svc.name, readable, errors: errs.length, sample: errs.slice(-5) })

      if (!args.json) {
        const label = !readable
          ? dim("UNREADABLE — not the same as clean")
          : errs.length === 0
            ? dim("clean")
            : `${errs.length} error line${errs.length > 1 ? "s" : ""}`
        console.log(`\n${bold(svc.name.padEnd(20))} ${label}`)
        for (const e of errs.slice(-5)) console.log(`  ${dim("›")} ${e.slice(0, 200)}`)
      }
    }

    if (args.json) return writeJson({ total_errors: totalErrors, unreadable, services: report })

    printDivider()
    if (unreadable) {
      console.log(`  ${bold(String(unreadable))} service(s) could not be read — treat those as UNKNOWN, not healthy.`)
    }
    console.log(`  ${totalErrors === 0 && !unreadable ? "No error-shaped lines found." : bold(String(totalErrors) + " error-shaped line(s)")}`)
    prompts.outro(dim("iris prod logs <service> --errors   — full context for one service"))
  },
})

const StatusCommand = cmd({
  command: "status",
  aliases: ["deployments", "deploys"],
  describe: "what commit each production service is actually running",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Production status")

    // The guide is emphatic about this: ask the container what it runs. Do not
    // infer it from a deploy that said SUCCESS, and never grep for a symbol.
    const rows: any[] = []
    for (const svc of SERVICES) {
      const r = await railway(["ssh", "-s", svc.name, "--", "printenv", "RAILWAY_GIT_COMMIT_SHA"], 30_000)
      const sha = (r.out.match(/\b[0-9a-f]{7,40}\b/) || [])[0] || null
      rows.push({ service: svc.name, commit: sha, reachable: !!sha })
      if (!args.json) {
        console.log(`  ${bold(svc.name.padEnd(20))} ${sha ? sha.slice(0, 12) : dim("unreachable — could not read commit")}`)
      }
    }

    const drifted = repoDrift(rows)
    const unreachable = rows.filter((r) => !r.commit).length

    if (args.json) return writeJson({ services: rows, drifted_repos: drifted })

    printDivider()
    if (drifted.length) {
      // The classic silent bug: a worker on an old commit runs stale job code.
      console.log(`  ${bold("⚠ COMMIT DRIFT")} within: ${drifted.join(", ")}`)
      console.log(`  ${dim("An API and its worker on different commits is the classic silent prod bug.")}`)
    } else {
      console.log(`  ${dim("No drift — every repo's services agree.")} ${dim("(4 repos deploy here, so differing SHAs across repos is normal.)")}`)
    }
    if (unreachable) console.log(`  ${bold(String(unreachable))} service(s) unreachable — UNKNOWN, not healthy.`)
    prompts.outro(dim("scripts/deployed.sh <service> --wait   — poll until your commit is live"))
  },
})

const IntegrationsCommand = cmd({
  command: "integrations",
  aliases: ["connected"],
  describe: "which operational integrations are connected for you right now",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth(); if (!token) return
    const userId = await requireUserId(); if (!userId) return

    UI.empty()
    prompts.intro("◈  Connected integrations")

    const res = await irisFetch(`/api/v1/integrations?user_id=${userId}&per_page=200`)
    if (!res.ok) {
      console.log(`  ${dim("could not read integrations —")} HTTP ${res.status}`)
      prompts.outro(dim("iris list-available   — full catalogue"))
      return
    }
    const body: any = await res.json()
    const rows: any[] = body?.data?.data ?? body?.data ?? body?.integrations ?? []

    if (args.json) return writeJson({ count: rows.length, integrations: rows })

    if (!rows.length) {
      console.log(`  ${dim("none reported for this account")}`)
    } else {
      // The API reports status as "active" — NOT "connected". Getting this wrong made the
      // command print "0 connected" while listing 24 live integrations, which is exactly
      // the kind of confidently-wrong summary this file's header warns about.
      const isLive = (r: any) => {
        const st = String(r.status ?? "").toLowerCase()
        return st === "active" || st === "connected" || r.is_connected === true
      }
      const connected = rows.filter(isLive)
      const other = rows.filter((r: any) => !isLive(r))
      console.log(`  ${bold(String(connected.length))} connected${other.length ? dim(`, ${other.length} inactive/other`) : ""}\n`)
      for (const r of connected) {
        const name = r.name || r.type || r.service || "(unnamed)"
        console.log(`  ${dim("✓")} ${String(name).slice(0, 40)}`)
      }
      for (const r of other.slice(0, 20)) {
        const name = r.name || r.type || r.service || "(unnamed)"
        console.log(`  ${dim("·")} ${dim(String(name).slice(0, 40))} ${dim(String(r.status ?? "inactive"))}`)
      }
    }
    printDivider()
    prompts.outro(dim("iris list-available   — everything installable  ·  iris doctor   — local health"))
  },
})

const CheckCommand = cmd({
  command: "check",
  aliases: ["overview", "all"],
  describe: "one look at production — commits, errors, integrations",
  builder: (yargs) =>
    yargs
      .option("lines", { type: "number", default: 150, describe: "lines to scan per service for errors" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Production check")

    const rows: any[] = []
    for (const svc of SERVICES) {
      const [logs, sha] = await Promise.all([
        railway(["logs", "-s", svc.name, "--lines", String(args.lines)], 25_000),
        railway(["ssh", "-s", svc.name, "--", "printenv", "RAILWAY_GIT_COMMIT_SHA"], 30_000),
      ])
      const readable = logs.ok || logs.out.trim().length > 0
      const commit = (sha.out.match(/\b[0-9a-f]{7,40}\b/) || [])[0] || null
      const errs = readable ? errorLines(logs.out) : []
      rows.push({ service: svc.name, readable, errors: errs.length, commit, sample: errs.slice(-2) })
    }

    const drifted = repoDrift(rows)
    const totalErrors = rows.reduce((a, r) => a + r.errors, 0)
    const unreadable = rows.filter((r) => !r.readable).length

    if (args.json) {
      return writeJson({ total_errors: totalErrors, unreadable, drifted_repos: drifted, services: rows })
    }

    console.log("")
    console.log(`  ${dim("SERVICE".padEnd(20))} ${dim("COMMIT".padEnd(14))} ${dim("ERRORS")}`)
    for (const r of rows) {
      const c = r.commit ? r.commit.slice(0, 12) : dim("unreachable")
      const e = !r.readable ? dim("unknown") : r.errors === 0 ? dim("0") : bold(String(r.errors))
      console.log(`  ${r.service.padEnd(20)} ${String(c).padEnd(14)} ${e}`)
      for (const s of r.sample) console.log(`    ${dim("›")} ${s.slice(0, 170)}`)
    }

    printDivider()
    if (drifted.length) console.log(`  ${bold("⚠ COMMIT DRIFT")} within: ${drifted.join(", ")} — stale workers run stale job code.`)
    if (unreadable) console.log(`  ${bold(String(unreadable))} service(s) unreadable — UNKNOWN, not healthy.`)
    if (!totalErrors && !unreadable && !drifted.length) console.log("  Nothing alarming in this window.")
    prompts.outro(dim("iris prod errors  ·  iris prod logs <service>  ·  iris prod integrations"))
  },
})

export const PlatformProdCommand = cmd({
  command: "prod <subcommand>",
  aliases: ["production"],
  describe: "production (Railway) — logs, errors, deployed commits, integrations",
  builder: (yargs) =>
    yargs
      .command(LogsCommand)
      .command(ErrorsCommand)
      .command(StatusCommand)
      .command(IntegrationsCommand)
      .command(CheckCommand)
      .demandCommand(1),
  async handler() {},
})
