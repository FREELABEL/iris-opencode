import { cmd } from "./cmd"
import { productCommand } from "./product-command"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, success, writeJson, printDivider } from "./iris-api"

/**
 * RevOps OKRs + KPIs.
 *
 * Built in response to a real, named gap: Junaid (SaveLife.AI), on the 2026-08-23 call —
 * "the one big thing that is missing is actually KPIs." He assigned "revenue operations
 * and HR operations" as the build, decomposed into marketing/CRM/success/HR ops tracks,
 * with MediGuide as the first customer once it exists. See bloq #378 item #182058 for
 * the full call log this is built against.
 *
 * Deliberately generic, not a copy of the RevOps playbook Richard sent (#181962) — that
 * document is under a hard disclosure constraint (comprehension only, no borrowed
 * structure or vocabulary). "marketing_ops/crm_ops/success_ops/hr_ops" are industry-
 * standard RevOps category names, not that document's fingerprint; nothing here mirrors
 * its actual objectives, KPI table, or org-model recommendation.
 *
 * Two Atlas datasets (objectives+key_results are OKR-shaped: quarterly, goal-scoped;
 * kpis is the ongoing steady-state layer he named as missing — ongoing metrics with no
 * quarter or objective attached). Same schema-driven pattern as #182118's mentions
 * dataset — global per-user (bloq_id null), not scoped to a single project.
 */

const TRACKS = ["marketing_ops", "crm_ops", "success_ops", "hr_ops", "platform"] as const
const OBJ_STATUSES = ["not_started", "on_track", "at_risk", "off_track", "done"] as const
const KR_DIRECTIONS = ["increase", "decrease", "maintain"] as const
const KPI_CADENCES = ["daily", "weekly", "monthly", "quarterly"] as const

const STATUS_ICON: Record<string, string> = {
  not_started: dim("○"),
  on_track: "\x1b[92m●\x1b[0m", // green
  at_risk: "\x1b[93m●\x1b[0m", // yellow
  off_track: "\x1b[91m●\x1b[0m", // red
  done: "\x1b[96m✓\x1b[0m", // cyan
}

/**
 * Percent complete for one key result, RESPECTING its direction.
 *
 * Returns null when the pair cannot produce a percentage at all (no target, no
 * reading, a zero target an increase KR would divide by) — null is "not measured",
 * which callers must render differently from 0%.
 *
 * The direction is not decoration. `current / target` is only correct for an
 * INCREASE KR. Applied to a decrease KR it inverts: "cut manual effort from 6h to
 * 1h" evaluates 6/1 = 600%, caps to 100%, and reports a key result sitting at its
 * WORST possible value as complete — while dragging its objective's average up.
 * That shipped, and it was caught by seeding real RevOps data rather than by
 * reading the code: the objective read "60% avg" when its true progress was 10%.
 *
 * decrease  — target/current, so hitting the target is 100% and drifting away
 *             falls toward 0. Without a stored baseline this is a ratio, not a
 *             linear burn-down, but it is monotonic in the right direction and it
 *             never reports "done" for a KR that has not moved.
 * maintain  — 100% at the target, decaying by relative deviation either side.
 *             Overshooting a "hold this steady" KR is a miss, not a win.
 */
export function krProgress(
  current?: number | null,
  target?: number | null,
  direction?: string | null,
): number | null {
  if (target == null || current == null) return null
  const dir = direction ?? "increase"

  if (dir === "decrease") {
    // At or under target is the goal met. Checked before the divide so current=0
    // (a total elimination — the best case) cannot become Infinity.
    if (current <= target) return 100
    if (current === 0) return 100
    return (target / current) * 100
  }

  if (dir === "maintain") {
    if (target === 0) return current === 0 ? 100 : 0
    const deviation = Math.abs(current - target) / Math.abs(target)
    return Math.max(0, (1 - deviation) * 100)
  }

  if (target === 0) return null
  return (current / target) * 100
}

/** Render a key result's progress. Direction-aware — see krProgress. */
export function fmtPct(current?: number | null, target?: number | null, direction?: string | null): string {
  const raw = krProgress(current, target, direction)
  if (raw == null) return dim("—")
  const pct = Math.round(raw)
  const color = pct >= 100 ? "\x1b[96m" : pct >= 60 ? "\x1b[92m" : pct >= 30 ? "\x1b[93m" : "\x1b[91m"
  return `${color}${pct}%\x1b[0m`
}

async function fetchRecords(schema: string, params: Record<string, string> = {}): Promise<any[]> {
  const p = new URLSearchParams({ per_page: "200", sort: "created_at", ...params })
  const res = await irisFetch(`/api/v1/atlas/datasets/${schema}?${p}`)
  if (!res.ok) return []
  const body = (await res.json()) as any
  const records: any[] = body?.data?.records?.data ?? body?.data?.records ?? []
  return records
}

async function fetchOne(schema: string, id: number): Promise<any | null> {
  const res = await irisFetch(`/api/v1/atlas/datasets/${schema}/${id}`)
  if (!res.ok) return null
  const body = (await res.json()) as any
  return body?.data ?? null
}

async function createRecord(schema: string, data: Record<string, unknown>) {
  return irisFetch(`/api/v1/atlas/datasets/${schema}`, { method: "POST", body: JSON.stringify({ data }) })
}

async function updateRecord(schema: string, id: number, data: Record<string, unknown>) {
  return irisFetch(`/api/v1/atlas/datasets/${schema}/${id}`, { method: "PATCH", body: JSON.stringify({ data }) })
}

// ============================================================================
// Objectives
// ============================================================================

const ObjectivesListCmd = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list RevOps objectives",
  builder: (y) =>
    y
      .option("track", { type: "string", choices: TRACKS, describe: "filter by track" })
      .option("status", { type: "string", choices: OBJ_STATUSES, describe: "filter by status" })
      .option("quarter", { type: "string", describe: "filter by quarter, e.g. 2026-Q3" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  RevOps Objectives")
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let records = await fetchRecords("revops_objectives")
    let objs = records.map((r) => ({ id: r.id, ...r.data }))
    if (args.track) objs = objs.filter((o) => o.track === args.track)
    if (args.status) objs = objs.filter((o) => o.status === args.status)
    if (args.quarter) objs = objs.filter((o) => o.quarter === args.quarter)

    if (args.json) { await writeJson(objs); prompts.outro("Done"); return }
    if (!objs.length) {
      prompts.log.warn("No objectives yet. Add one with: iris okr objectives create --title \"...\" --track marketing_ops")
      prompts.outro("Done")
      return
    }

    printDivider()
    for (const o of objs) {
      const icon = STATUS_ICON[o.status] ?? dim("○")
      const trackTag = o.track ? dim(` [${o.track}]`) : ""
      const quarterTag = o.quarter ? dim(` · ${o.quarter}`) : ""
      const ownerTag = o.owner ? dim(` · ${o.owner}`) : ""
      console.log(`  ${icon} ${dim(`#${o.id}`)}  ${bold(o.title)}${trackTag}${quarterTag}${ownerTag}`)
    }
    printDivider()
    prompts.outro(`${success("✓")} ${objs.length} objective${objs.length === 1 ? "" : "s"}`)
  },
})

const ObjectivesCreateCmd = cmd({
  command: "create",
  describe: "create a RevOps objective",
  builder: (y) =>
    y
      .option("title", { type: "string", demandOption: true, describe: "the objective statement" })
      .option("track", { type: "string", choices: TRACKS, describe: "marketing_ops | crm_ops | success_ops | hr_ops | platform" })
      .option("owner", { type: "string", describe: "who owns it" })
      .option("quarter", { type: "string", describe: "e.g. 2026-Q3" })
      .option("status", { type: "string", choices: OBJ_STATUSES, default: "not_started" })
      .option("notes", { type: "string" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Objective")
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const res = await createRecord("revops_objectives", {
      title: args.title,
      track: args.track ?? null,
      owner: args.owner ?? null,
      quarter: args.quarter ?? null,
      status: args.status,
      notes: args.notes ?? null,
    })
    const ok = await handleApiError(res, "Create objective")
    if (!ok) { prompts.outro("Done"); return }
    const body = (await res.json()) as any
    if (args.json) { await writeJson(body.data); return }
    prompts.log.info(`Created objective ${bold(`#${body.data?.id}`)}: ${args.title}`)
    prompts.outro(`${success("✓")} Add key results: iris okr kr add ${body.data?.id} --description "..." --target=N`)
  },
})

const ObjectivesShowCmd = cmd({
  command: "show <id>",
  describe: "show an objective and its key results",
  builder: (y) => y.positional("id", { type: "number", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Objective #${args.id}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const record = await fetchOne("revops_objectives", args.id as number)
    if (!record) {
      prompts.log.error(`Objective #${args.id} not found`)
      prompts.outro("Done")
      return
    }
    const krRecords = await fetchRecords("revops_key_results")
    const krs = krRecords.map((r) => ({ id: r.id, ...r.data })).filter((k) => k.objective_id === args.id)

    if (args.json) { await writeJson({ ...record.data, id: record.id, key_results: krs }); return }

    const icon = STATUS_ICON[record.data.status] ?? dim("○")
    console.log(`  ${icon} ${bold(record.data.title)}`)
    console.log(`    ${dim(`#${record.id} · ${record.data.track ?? "no track"} · ${record.data.quarter ?? "no quarter"} · owner: ${record.data.owner ?? "unassigned"}`)}`)
    if (record.data.notes) console.log(`    ${dim(record.data.notes)}`)
    console.log()
    if (!krs.length) {
      console.log(`  ${dim("No key results yet — iris okr kr add " + args.id + " --description \"...\" --target=N")}`)
    } else {
      printDivider()
      for (const kr of krs) {
        const pct = fmtPct(kr.current_value, kr.target_value, kr.direction)
        const arrow = kr.direction === "decrease" ? "↓" : kr.direction === "maintain" ? "→" : "↑"
        console.log(`  ${dim(`#${kr.id}`)}  ${kr.description}`)
        console.log(`    ${arrow} ${kr.current_value ?? 0}${kr.unit ?? ""} / ${kr.target_value ?? "?"}${kr.unit ?? ""}  ${pct}${kr.due_date ? dim(`  due ${kr.due_date}`) : ""}`)
      }
      printDivider()
    }
    prompts.outro("Done")
  },
})

const ObjectivesUpdateCmd = cmd({
  command: "update <id>",
  describe: "update an objective",
  builder: (y) =>
    y
      .positional("id", { type: "number", demandOption: true })
      .option("title", { type: "string" })
      .option("track", { type: "string", choices: TRACKS })
      .option("owner", { type: "string" })
      .option("quarter", { type: "string" })
      .option("status", { type: "string", choices: OBJ_STATUSES })
      .option("notes", { type: "string" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update Objective #${args.id}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const data: Record<string, unknown> = {}
    for (const k of ["title", "track", "owner", "quarter", "status", "notes"] as const) {
      if (args[k] !== undefined) data[k] = args[k]
    }
    if (!Object.keys(data).length) {
      prompts.log.warn("Nothing to update — pass at least one of --title/--track/--owner/--quarter/--status/--notes")
      prompts.outro("Done")
      return
    }

    const res = await updateRecord("revops_objectives", args.id as number, data)
    const ok = await handleApiError(res, "Update objective")
    if (!ok) { prompts.outro("Done"); return }
    if (args.json) { await writeJson((await res.json() as any).data); return }
    prompts.outro(`${success("✓")} Updated`)
  },
})

const ObjectivesCmd = cmd({
  command: "objectives",
  aliases: ["obj", "o"],
  describe: "manage RevOps objectives",
  builder: (y) => y.command(ObjectivesListCmd).command(ObjectivesCreateCmd).command(ObjectivesShowCmd).command(ObjectivesUpdateCmd).demandCommand(),
  async handler() {},
})

// ============================================================================
// Key Results
// ============================================================================

const KrAddCmd = cmd({
  command: "add <objectiveId>",
  describe: "add a key result to an objective",
  builder: (y) =>
    y
      .positional("objectiveId", { type: "number", demandOption: true })
      .option("description", { type: "string", demandOption: true })
      .option("target", { type: "number", describe: "target value" })
      .option("current", { type: "number", default: 0, describe: "current value" })
      .option("unit", { type: "string", describe: "e.g. %, $, count" })
      .option("direction", { type: "string", choices: KR_DIRECTIONS, default: "increase" })
      .option("due", { type: "string", describe: "YYYY-MM-DD" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Add Key Result")
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const objective = await fetchOne("revops_objectives", args.objectiveId as number)
    if (!objective) {
      prompts.log.error(`Objective #${args.objectiveId} not found`)
      prompts.outro("Done")
      return
    }

    const res = await createRecord("revops_key_results", {
      objective_id: args.objectiveId,
      description: args.description,
      target_value: args.target ?? null,
      current_value: args.current,
      unit: args.unit ?? null,
      direction: args.direction,
      due_date: args.due ?? null,
    })
    const ok = await handleApiError(res, "Add key result")
    if (!ok) { prompts.outro("Done"); return }
    const body = (await res.json()) as any
    if (args.json) { await writeJson(body.data); return }
    prompts.outro(`${success("✓")} Added key result #${body.data?.id} to "${objective.data.title}"`)
  },
})

const KrUpdateCmd = cmd({
  command: "update <id>",
  describe: "update a key result's progress",
  builder: (y) =>
    y
      .positional("id", { type: "number", demandOption: true })
      .option("current", { type: "number", describe: "new current value" })
      .option("target", { type: "number" })
      .option("description", { type: "string" })
      .option("direction", { type: "string", choices: KR_DIRECTIONS })
      .option("due", { type: "string" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update Key Result #${args.id}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const data: Record<string, unknown> = {}
    if (args.current !== undefined) data.current_value = args.current
    if (args.target !== undefined) data.target_value = args.target
    if (args.description !== undefined) data.description = args.description
    if (args.direction !== undefined) data.direction = args.direction
    if (args.due !== undefined) data.due_date = args.due
    if (!Object.keys(data).length) {
      prompts.log.warn("Nothing to update — pass --current/--target/--description/--direction/--due")
      prompts.outro("Done")
      return
    }

    const res = await updateRecord("revops_key_results", args.id as number, data)
    const ok = await handleApiError(res, "Update key result")
    if (!ok) { prompts.outro("Done"); return }
    const body = (await res.json()) as any
    if (args.json) { await writeJson(body.data); return }
    const d = body.data?.data ?? {}
    prompts.outro(`${success("✓")} ${d.current_value ?? "?"}${d.unit ?? ""} / ${d.target_value ?? "?"}${d.unit ?? ""}  ${fmtPct(d.current_value, d.target_value, d.direction)}`)
  },
})

const KrCmd = cmd({
  command: "kr",
  describe: "manage key results",
  builder: (y) => y.command(KrAddCmd).command(KrUpdateCmd).demandCommand(),
  async handler() {},
})

// ============================================================================
// Status dashboard
// ============================================================================

const OkrStatusCmd = cmd({
  command: "status",
  describe: "RevOps OKR dashboard — objectives by status, across all tracks",
  builder: (y) => y.option("quarter", { type: "string" }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  RevOps OKR Status")
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let objRecords = await fetchRecords("revops_objectives")
    let objs = objRecords.map((r) => ({ id: r.id, ...r.data }))
    if (args.quarter) objs = objs.filter((o) => o.quarter === args.quarter)
    const krRecords = await fetchRecords("revops_key_results")
    const krs = krRecords.map((r) => ({ id: r.id, ...r.data }))

    if (args.json) {
      await writeJson({ objectives: objs, key_results: krs })
      return
    }

    if (!objs.length) {
      prompts.log.warn("No objectives yet. iris okr objectives create --title \"...\" --track marketing_ops")
      prompts.outro("Done")
      return
    }

    const counts: Record<string, number> = {}
    for (const o of objs) counts[o.status] = (counts[o.status] ?? 0) + 1
    prompts.log.info(bold(`${objs.length} objective${objs.length === 1 ? "" : "s"}`) + (args.quarter ? dim(` · ${args.quarter}`) : ""))
    for (const st of OBJ_STATUSES) {
      if (counts[st]) console.log(`    ${STATUS_ICON[st]} ${dim(st)}  ${counts[st]}`)
    }
    console.log()

    for (const track of TRACKS) {
      const trackObjs = objs.filter((o) => o.track === track)
      if (!trackObjs.length) continue
      console.log(`  ${bold(track)}`)
      for (const o of trackObjs) {
        const ownKrs = krs.filter((k) => k.objective_id === o.id)
        // Only KRs that actually yield a percentage are averaged, and each one is
        // measured through krProgress so a decrease KR counts the direction it is
        // meant to move. An unmeasurable KR is EXCLUDED rather than counted as 0 —
        // "not measured yet" is not "no progress", and folding the two together
        // makes an objective look worse than the evidence supports.
        const measured = ownKrs
          .map((k) => krProgress(k.current_value, k.target_value, k.direction))
          .filter((p): p is number => p != null)
        const avgPct = measured.length
          ? Math.round(measured.reduce((sum, p) => sum + Math.min(100, p), 0) / measured.length)
          : null
        const unmeasured = ownKrs.length - measured.length
        const pctTag =
          avgPct != null
            ? dim(`  ${avgPct}% avg across ${measured.length} KR${measured.length === 1 ? "" : "s"}`) +
              (unmeasured ? dim(` (+${unmeasured} unmeasured)`) : "")
            : ownKrs.length
              ? dim(`  ${ownKrs.length} KR${ownKrs.length === 1 ? "" : "s"}, none measurable yet`)
              : dim("  no key results")
        console.log(`    ${STATUS_ICON[o.status] ?? dim("○")} ${dim(`#${o.id}`)}  ${o.title}${pctTag}`)
      }
    }
    prompts.outro("Done")
  },
})

export const PlatformOkrCommand = productCommand({
  name: "okr",
  purpose: "RevOps OKRs — objectives and key results across marketing/CRM/success/HR ops",
  keywords: ["okr", "objective", "key result", "revops", "revenue operations", "goals"],
  builder: (y) => y.command(ObjectivesCmd).command(KrCmd).command(OkrStatusCmd).demandCommand(),
})

// ============================================================================
// KPIs — the ongoing steady-state layer, distinct from quarterly OKRs
// ============================================================================

const KpiListCmd = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list RevOps KPIs",
  builder: (y) =>
    y
      .option("track", { type: "string", choices: TRACKS })
      .option("cadence", { type: "string", choices: KPI_CADENCES })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  RevOps KPIs")
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let records = await fetchRecords("revops_kpis")
    let kpis = records.map((r) => ({ id: r.id, ...r.data }))
    if (args.track) kpis = kpis.filter((k) => k.track === args.track)
    if (args.cadence) kpis = kpis.filter((k) => k.cadence === args.cadence)

    if (args.json) { await writeJson(kpis); prompts.outro("Done"); return }
    if (!kpis.length) {
      prompts.log.warn("No KPIs yet. Add one with: iris kpi create --name \"...\" --track marketing_ops --cadence monthly")
      prompts.outro("Done")
      return
    }

    printDivider()
    for (const k of kpis) {
      const pct = fmtPct(k.current_value, k.target_value, k.direction)
      const trackTag = k.track ? dim(` [${k.track}]`) : ""
      const staleTag = k.last_updated ? dim(`  updated ${new Date(k.last_updated).toLocaleDateString()}`) : dim("  never updated")
      console.log(`  ${dim(`#${k.id}`)}  ${bold(k.name)}${trackTag}${dim(` · ${k.cadence ?? "?"}`)}`)
      const arrow = k.direction === "decrease" ? "↓" : k.direction === "maintain" ? "→" : "↑"
      console.log(`    ${arrow} ${k.current_value ?? dim("no reading")}${k.unit ?? ""} / ${k.target_value ?? "?"}${k.unit ?? ""}  ${pct}${staleTag}`)
    }
    printDivider()
    prompts.outro(`${success("✓")} ${kpis.length} KPI${kpis.length === 1 ? "" : "s"}`)
  },
})

const KpiCreateCmd = cmd({
  command: "create",
  describe: "define a new KPI",
  builder: (y) =>
    y
      .option("name", { type: "string", demandOption: true })
      .option("track", { type: "string", choices: TRACKS })
      .option("target", { type: "number" })
      .option("current", { type: "number", describe: "initial reading" })
      .option("unit", { type: "string" })
      .option("direction", {
        type: "string",
        choices: KR_DIRECTIONS,
        default: "increase",
        describe: "which way is good — a response-time KPI is 'decrease', not 'increase'",
      })
      .option("cadence", { type: "string", choices: KPI_CADENCES, default: "monthly" })
      .option("notes", { type: "string" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create KPI")
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const res = await createRecord("revops_kpis", {
      name: args.name,
      track: args.track ?? null,
      target_value: args.target ?? null,
      current_value: args.current ?? null,
      unit: args.unit ?? null,
      direction: args.direction,
      cadence: args.cadence,
      last_updated: args.current !== undefined ? new Date().toISOString() : null,
      notes: args.notes ?? null,
    })
    const ok = await handleApiError(res, "Create KPI")
    if (!ok) { prompts.outro("Done"); return }
    const body = (await res.json()) as any
    if (args.json) { await writeJson(body.data); return }
    prompts.outro(`${success("✓")} Created KPI #${body.data?.id}: ${args.name}`)
  },
})

const KpiUpdateCmd = cmd({
  command: "update <id>",
  describe: "log a new reading for a KPI",
  builder: (y) =>
    y
      .positional("id", { type: "number", demandOption: true })
      .option("current", { type: "number", demandOption: true, describe: "the new reading" })
      .option("target", { type: "number" })
      .option("notes", { type: "string" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update KPI #${args.id}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const data: Record<string, unknown> = { current_value: args.current, last_updated: new Date().toISOString() }
    if (args.target !== undefined) data.target_value = args.target
    if (args.notes !== undefined) data.notes = args.notes

    const res = await updateRecord("revops_kpis", args.id as number, data)
    const ok = await handleApiError(res, "Update KPI")
    if (!ok) { prompts.outro("Done"); return }
    const body = (await res.json()) as any
    if (args.json) { await writeJson(body.data); return }
    const d = body.data?.data ?? {}
    prompts.outro(`${success("✓")} ${d.name}: ${d.current_value}${d.unit ?? ""} / ${d.target_value ?? "?"}${d.unit ?? ""}  ${fmtPct(d.current_value, d.target_value, d.direction)}`)
  },
})

const KpiShowCmd = cmd({
  command: "show <id>",
  describe: "show a KPI's current state",
  builder: (y) => y.positional("id", { type: "number", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  KPI #${args.id}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const record = await fetchOne("revops_kpis", args.id as number)
    if (!record) {
      prompts.log.error(`KPI #${args.id} not found`)
      prompts.outro("Done")
      return
    }
    if (args.json) { await writeJson({ ...record.data, id: record.id }); return }

    const d = record.data
    console.log(`  ${bold(d.name)}  ${dim(`[${d.track ?? "no track"}] · ${d.cadence ?? "?"}`)}`)
    console.log(`    ${d.current_value ?? dim("no reading")}${d.unit ?? ""} / ${d.target_value ?? "?"}${d.unit ?? ""}  ${fmtPct(d.current_value, d.target_value, d.direction)}`)
    console.log(`    ${dim(d.last_updated ? `last updated ${new Date(d.last_updated).toLocaleString()}` : "never updated")}`)
    if (d.notes) console.log(`    ${dim(d.notes)}`)
    prompts.outro("Done")
  },
})

export const PlatformKpiCommand = productCommand({
  name: "kpi",
  purpose: "RevOps KPIs — the ongoing steady-state metrics layer (distinct from quarterly OKRs)",
  keywords: ["kpi", "metric", "revops", "revenue operations", "dashboard"],
  builder: (y) => y.command(KpiListCmd).command(KpiCreateCmd).command(KpiUpdateCmd).command(KpiShowCmd).demandCommand(),
})
