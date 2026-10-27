import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, success, printDivider, printKV, irisFetch, requireAuth, requireUserId, handleApiError, writeJson } from "./iris-api"
import { fetchNodes, pickNode, type HiveNode } from "./platform-hive-nodes"
import { resolveLocalNode } from "./hive-local-node"
import { Skill } from "../../skill/skill"
import { Instance } from "../../project/instance"
import { parsePlan, splitPlaybookArgv, unknownPlaybookFlags, resolveArgs } from "../../skill/executor"
import { CliUsageError } from "../json-error"

// ============================================================================
// iris playbook schedule <name> [name=value..] --at 06:00
//
// #191366. The platform could already run a playbook on a schedule — a cloud schedule dispatches
// a `playbook_run` task to a Hive node, the daemon runs `iris playbook run`, and a failing run
// reads as failed. Nothing put that within reach of a person: it took
//
//   iris schedules create --type hive_task_dispatch --agent <id> \
//     --params '{"task_type":"playbook_run","prompt":"<name>","node_id":"<uuid>","playbook_args":{…}}'
//
// — an agent id the job never uses, a node UUID, an internal task-type name and hand-written JSON.
//
// #191367. Arguments were not checked when the schedule was made. Schedule #1063 carried
// `source=feed`, a flag discover-feed does not declare, and the mistake surfaced as a failed run
// at 9:17 the next morning. Here the playbook's own declarations are checked BEFORE anything is
// saved, with the same parser `playbook run` uses, so a schedule that would fail cannot be made.
// ============================================================================

export const FREQUENCIES = [
  "once", "hourly", "every_2_hours", "every_4_hours", "every_6_hours", "every_8_hours",
  "every_12_hours", "daily", "weekdays", "weekly", "monthly",
] as const

/**
 * The arguments a schedule will pass, checked against what the playbook declares.
 *
 * Only NAMED values are accepted. A positional lands in whichever slot comes first in the
 * schema, which is fine typed at a terminal and wrong in a schedule nobody reads again — the
 * stored job should say what each value means. Defaults are left out, so a playbook that later
 * changes a default is not pinned to the old one by every schedule made before.
 */
export function scheduleArgs(
  argv: string[],
  declared: Record<string, any> | undefined,
  playbook: string,
): Record<string, unknown> {
  const parsed = splitPlaybookArgv(argv, declared)
  const flagArgs = parsed.flagArgs
  const decl = Object.keys(declared ?? {})
  const hint = decl.length ? `"${playbook}" declares: ${decl.join(", ")}` : `"${playbook}" declares no arguments.`

  // `emial=send` is a misspelled NAME, not a missing one — the parser only binds name=value for
  // declared names, so the typo arrives as a positional. Report it as the unknown argument it is.
  const positional: string[] = []
  for (const p of parsed.positional) {
    const m = /^([A-Za-z_][\w-]*)=/.exec(p)
    if (m) flagArgs[m[1]] = p.slice(m[0].length)
    else positional.push(p)
  }

  if (positional.length) {
    throw new CliUsageError(
      [`Give each value a name so the schedule says what it means: ${positional.map((p) => `"${p}"`).join(", ")}`, hint, `  e.g. iris playbook schedule ${playbook} ${decl[0] ?? "name"}=value --at 06:00`].join("\n"),
    )
  }
  const unknown = unknownPlaybookFlags(flagArgs, declared)
  if (unknown.length) {
    const guesses = unknown.map((u) => closest(u, decl)).filter(Boolean).map((g, i) => `${unknown[i]} → ${g}`)
    throw new CliUsageError(
      [
        `Unknown argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
        ...(guesses.length ? [`Did you mean: ${guesses.join(", ")}`] : []),
        hint,
        `  iris playbook show ${playbook}`,
      ].join("\n"),
    )
  }
  let resolved: Record<string, unknown>
  try {
    resolved = resolveArgs((declared ?? {}) as any, [], flagArgs)
  } catch (e: any) {
    throw new CliUsageError(`${e.message}\n  iris playbook show ${playbook}`)
  }
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(flagArgs)) out[k] = resolved[k]
  return out
}

/** The declared name a typo most likely meant, or null when nothing is close. */
export function closest(word: string, names: string[]): string | null {
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
    for (let j = 1; j <= b.length; j++) d[0][j] = j
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
        // a swapped pair ("emial") is one slip, not two
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    return d[a.length][b.length]
  }
  let best: string | null = null
  let bestD = Infinity
  for (const n of names) {
    const dd = dist(word.toLowerCase(), n.toLowerCase())
    if (dd < bestD) { best = n; bestD = dd }
  }
  return best !== null && bestD <= Math.max(1, Math.floor(word.length / 3)) ? best : null
}

export function validTime(at: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at)
  return !!m && Number(m[1]) < 24 && Number(m[2]) < 60
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * Which node runs it. Named → that node (an offline one is refused, not queued silently).
 * Unnamed → this machine when it is a registered node; otherwise refuse and list the choices,
 * rather than guess which of someone's machines should run their mornings.
 */
export function chooseNode(
  nodes: HiveNode[],
  wanted: string | undefined,
  localId: string | null,
): { node: HiveNode } | { error: string } {
  const online = nodes.filter((n) => n.connection_status === "online")
  const choices = online.length
    ? `Online nodes: ${online.map((n) => n.name).join(", ")}`
    : "No node is online. Start one: iris daemon start"
  if (wanted) {
    const { node } = pickNode(nodes, wanted)
    if (!node) return { error: `No node matches "${wanted}". ${choices}` }
    if (node.connection_status !== "online") {
      return { error: `"${node.name}" is ${node.connection_status} — a schedule pinned to it would never run. ${choices}` }
    }
    return { node }
  }
  const local = localId ? nodes.find((n) => n.id === localId) : undefined
  if (local && local.connection_status === "online") return { node: local }
  return { error: `Say which machine runs it: --node <name>. ${choices}` }
}

export function buildSchedulePayload(input: {
  playbook: string
  args: Record<string, unknown>
  nodeId: string
  agentId: number
  at: string
  timezone: string
  frequency: string
  name?: string
  cwd?: string
}): Record<string, unknown> {
  const taskName = input.name ?? `Playbook: ${input.playbook}`
  const job: Record<string, unknown> = {
    type: "hive_task_dispatch",
    task_type: "playbook_run",
    dispatch_mode: "direct",
    prompt: input.playbook,
    node_id: input.nodeId,
    playbook_args: input.args,
    created_from: "iris playbook schedule",
    approval_mode: "autonomous",
  }
  if (input.cwd) job.cwd = input.cwd
  return {
    agent_id: input.agentId,
    task_name: taskName,
    prompt: input.playbook,
    time: input.at,
    frequency: input.frequency,
    timezone: input.timezone,
    data: { ...job, params: { ...job } },
  }
}

/** The schedule list, narrowed to playbook runs, as rows a person can read. */
export function playbookScheduleRows(jobs: any[]): Array<{ id: number; playbook: string; when: string; node: string; next: string; last: string; args: string }> {
  return jobs
    .filter((j) => (j?.data?.task_type ?? j?.data?.params?.task_type) === "playbook_run")
    .map((j) => {
      const d = j.data ?? {}
      const args = d.playbook_args ?? d.params?.playbook_args ?? {}
      return {
        id: j.id,
        playbook: String(d.prompt ?? j.prompt ?? "?"),
        when: `${j.frequency ?? "?"} ${String(j.scheduled_time ?? "").slice(0, 5)} ${j.timezone ?? ""}`.trim(),
        node: String(j.last_result?.task?.node?.name ?? d.node_id ?? "any"),
        next: String(j.next_run_at ?? "—"),
        last: j.last_error ? `failed: ${String(j.last_error).slice(0, 60)}` : String(j.last_result?.task?.status ?? (j.last_run_at ? "ran" : "never run")),
        args: Object.entries(args).map(([k, v]) => `${k}=${v}`).join(" "),
      }
    })
}

async function localNodeIdFor(nodes: HiveNode[]): Promise<string | null> {
  let configNodeId: string | null = null
  try {
    const p = path.join(os.homedir(), ".iris", "config.json")
    if (fs.existsSync(p)) configNodeId = JSON.parse(fs.readFileSync(p, "utf-8")).node_id || null
  } catch {}
  let daemonNodeId: string | null = null
  try {
    const res = await fetch("http://localhost:3200/health", { signal: AbortSignal.timeout(1500) })
    if (res.ok) daemonNodeId = ((await res.json()) as any)?.node_id ?? null
  } catch {}
  const r = resolveLocalNode({ daemonNodeId, configNodeId, hostname: os.hostname(), nodes: nodes.map((n) => ({ id: n.id, name: n.name })) })
  return r.uncertain ? null : r.nodeId
}

/**
 * The API stores an agent on every schedule. A playbook run never talks to it, so the person is
 * not asked for one: --agent wins, otherwise their oldest agent. Which one was used is printed
 * in the summary, never hidden.
 */
async function pickAgent(userId: number, flag?: number): Promise<{ id: number; name: string } | null> {
  if (flag) return { id: flag, name: `#${flag}` }
  const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents?per_page=100`)
  if (!res.ok) return null
  const body = (await res.json().catch(() => ({}))) as any
  const list = (body?.data?.data ?? body?.data ?? body?.agents ?? []) as any[]
  if (!list.length) return null
  const a = [...list].sort((x, y) => Number(x.id) - Number(y.id))[0]
  return { id: Number(a.id), name: String(a.name ?? `#${a.id}`) }
}

async function fetchSchedules(userId: number): Promise<any[]> {
  const res = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs?per_page=500`)
  if (!res.ok) throw new Error(`Could not read your schedules (${res.status})`)
  const body = (await res.json().catch(() => ({}))) as any
  return (body?.data?.data ?? body?.data ?? []) as any[]
}

export const PlaybookScheduleCommand = cmd({
  command: "schedule <name> [playbookArgs..]",
  describe: "run a playbook on a schedule — daily at 06:00, on a machine you choose",
  builder: (yargs) =>
    yargs
      .parserConfiguration({ "unknown-options-as-args": true })
      .positional("name", { type: "string", demandOption: true, describe: "the playbook" })
      .positional("playbookArgs", { type: "string", array: true, describe: "the playbook's own arguments, as name=value" })
      .option("at", { type: "string", default: "09:00", describe: "time of day, 24h (HH:MM)" })
      .option("tz", { type: "string", describe: "timezone (default: this machine's)" })
      .option("every", { type: "string", choices: FREQUENCIES as unknown as string[], default: "daily", describe: "how often" })
      .option("node", { type: "string", describe: "machine that runs it (default: this one)" })
      .option("title", { type: "string", describe: "name shown in the schedule list" })
      .option("cwd", { type: "string", describe: "folder on that machine to run in, for a project's own playbooks" })
      .option("agent", { type: "number", describe: "agent to file the schedule under (picked for you)" })
      .option("dry-run", { type: "boolean", default: false, describe: "check everything and show what would be saved, save nothing" })
      .option("json", { type: "boolean", default: false })
      .option("user-id", { type: "number" })
      .example("iris playbook schedule meal-plan-day action=write email=send --at 06:00 --tz America/Chicago", "every morning at 6")
      .example("iris playbook schedule weekly-report --every weekly --at 08:30 --node office-mac", "on another machine")
      .example("iris playbook schedules", "what is scheduled, when it runs next, how the last run went")
      .epilogue("Arguments are checked against the playbook before anything is saved. See a run: iris schedules history <id>"),
  async handler(args) {
    const playbook = String(args.name)
    const at = String(args.at)
    const tz = String(args.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "America/New_York")
    if (!validTime(at)) throw new CliUsageError(`--at must be a 24-hour time like 06:00, not "${at}".`)
    if (!validTimezone(tz)) throw new CliUsageError(`Unknown timezone "${tz}". Use a name like America/Chicago.`)

    const plan = await Instance.provide({
      directory: args.cwd ? String(args.cwd) : process.cwd(),
      fn: async () => {
        const info = await Skill.get(playbook)
        return info ? parsePlan(info) : null
      },
    })
    if (!plan) throw new CliUsageError(`No playbook named "${playbook}" on this machine. Find one: iris playbook search ${playbook}`)
    if (plan.version !== 2) throw new CliUsageError(`"${playbook}" has no steps to run — only executable playbooks can be scheduled.`)

    const pArgs = scheduleArgs((args.playbookArgs as string[] | undefined) ?? [], plan.args as any, playbook)

    await requireAuth()
    const userId = await requireUserId(args["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const nodes = await fetchNodes(userId)
    const choice = chooseNode(nodes, args.node as string | undefined, args.node ? null : await localNodeIdFor(nodes))
    if ("error" in choice) throw new CliUsageError(choice.error)
    const node = choice.node

    const agent = await pickAgent(userId, args.agent as number | undefined)
    if (!agent) throw new CliUsageError("Your account has no agent to file the schedule under. Create one: iris agents create")

    const payload = buildSchedulePayload({
      playbook, args: pArgs, nodeId: node.id, agentId: agent.id, at, timezone: tz,
      frequency: String(args.every), name: args.title as string | undefined, cwd: args.cwd as string | undefined,
    })

    const summary = {
      playbook, args: pArgs, when: `${args.every} at ${at} (${tz})`, node: node.name, agent: agent.name,
    }
    if (args["dry-run"]) {
      if (args.json) return void (await writeJson({ dry_run: true, ...summary, payload }))
      UI.empty()
      prompts.intro(`◈  Schedule (dry run): ${playbook}`)
      printKV("Runs", summary.when)
      printKV("On", node.name)
      printKV("Args", Object.entries(pArgs).map(([k, v]) => `${k}=${v}`).join(" ") || dim("(defaults)"))
      prompts.outro(dim("Checked. Nothing saved."))
      return
    }

    const res = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs`, { method: "POST", body: JSON.stringify(payload) })
    if (!(await handleApiError(res, "Create schedule"))) process.exit(1)
    const body = (await res.json().catch(() => ({}))) as any
    const job = body?.data ?? body

    if (args.json) return void (await writeJson({ id: job.id, next_run_at: job.next_run_at ?? null, ...summary }))
    UI.empty()
    prompts.intro(`◈  Scheduled: ${playbook}`)
    printDivider()
    printKV("Schedule", `#${job.id}`)
    printKV("Runs", summary.when)
    printKV("Next run", job.next_run_at ?? "pending")
    printKV("On", node.name)
    printKV("Args", Object.entries(pArgs).map(([k, v]) => `${k}=${v}`).join(" ") || dim("(defaults)"))
    printDivider()
    const local = await localNodeIdFor(nodes)
    if (node.id !== local) prompts.log.warn(`It runs on ${node.name}: make sure "${playbook}" is installed there (iris playbook install ${playbook}).`)
    prompts.log.info(dim(`Run it now:    iris schedules run ${job.id}`))
    prompts.log.info(dim(`See runs:      iris schedules history ${job.id}`))
    prompts.log.info(dim(`Stop it:       iris schedules toggle ${job.id}`))
    prompts.outro(success("Schedule created"))
  },
})

export const PlaybookSchedulesCommand = cmd({
  command: "schedules",
  describe: "list your scheduled playbooks — when each runs next and how the last run went",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }).option("user-id", { type: "number" }),
  async handler(args) {
    await requireAuth()
    const userId = await requireUserId(args["user-id"] as number | undefined)
    if (!userId) process.exit(1)
    const rows = playbookScheduleRows(await fetchSchedules(userId))
    if (args.json) return void (await writeJson(rows))
    UI.empty()
    prompts.intro("◈  Scheduled playbooks")
    if (!rows.length) {
      prompts.outro(dim("None yet. Make one: iris playbook schedule <name> --at 06:00"))
      return
    }
    for (const r of rows) {
      console.log(`  ${bold(`#${r.id}`)}  ${r.playbook}  ${dim(r.when)}`)
      console.log(dim(`        on ${r.node} · next ${r.next} · last: ${r.last}`))
      if (r.args) console.log(dim(`        ${r.args}`))
    }
    prompts.outro(dim("See runs: iris schedules history <id>"))
  },
})
