import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, dim, bold } from "./iris-api"

// ============================================================================
// Bloq Context CLI — Andrew "Esher" Usher's hierarchy:
//   Purpose → Mission → Vision → Values → Strategies → Goals → KPIs → Deals
//
// All writes thread expected_version through fl-api's optimistic-lock contract:
//   1. GET /bloqs/{id}/business-context → returns {business_context, version}
//   2. PATCH /bloqs/{id}/business-context/key with {path, value, action,
//      expected_version: <version from step 1>}
//   3. If 409 → re-read and retry up to N times
//
// Path allowlist on the backend rejects writes to good_deals.* and any unknown
// top-level keys.
// ============================================================================

interface ContextWithVersion {
  business_context: Record<string, any>
  version: number
}

async function getContext(bloqId: number): Promise<ContextWithVersion | null> {
  const res = await irisFetch(`/api/v1/bloqs/${bloqId}/business-context`)
  const ok = await handleApiError(res, "Get business context")
  if (!ok) return null
  const body = (await res.json()) as { data?: any }
  const data = body?.data ?? body
  return {
    business_context: data?.business_context ?? {},
    version: data?.version ?? 0,
  }
}

/**
 * Optimistic-lock retry helper. Reads version, writes with expected_version,
 * retries on 409 Conflict up to maxRetries times. Throws on persistent conflict.
 */
async function patchContextKey(
  bloqId: number,
  path: string,
  value: any,
  action: "set" | "append" | "remove" = "set",
  maxRetries = 3,
): Promise<any> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const current = await getContext(bloqId)
    if (current == null) throw new Error(`Failed to read business_context for bloq ${bloqId}`)

    const res = await irisFetch(`/api/v1/bloqs/${bloqId}/business-context/key`, {
      method: "PATCH",
      body: JSON.stringify({
        path,
        value,
        action,
        expected_version: current.version,
      }),
    })

    if (res.status === 409) {
      // Someone else wrote between read and write — retry with fresh version
      continue
    }

    const ok = await handleApiError(res, `patchContextKey ${action} ${path}`)
    if (!ok) return null
    return await res.json()
  }
  throw new Error(
    `Lost-update conflict on '${path}' after ${maxRetries} retries. Another writer keeps beating you to this key — try again later.`,
  )
}

/** Generate a short id for new list items (goal/strategy/deal/kpi). */
function uid(prefix: string): string {
  const r = Math.random().toString(36).slice(2, 8)
  const t = Date.now().toString(36).slice(-4)
  return `${prefix}_${t}${r}`
}

function printDivider() {
  console.log(dim("  " + "─".repeat(76)))
}

// ============================================================================
// bloq:context — generic dot-notation get/set
// ============================================================================

const ContextGetCommand = cmd({
  command: "get <bloqId> [path]",
  describe: "read business_context (or a single dot-notation path)",
  builder: (y) =>
    y
      .positional("bloqId", { type: "number", demandOption: true })
      .positional("path", { type: "string" })
      .option("json", { type: "boolean", default: false })
      .option("user-id", { type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  bloq:context get ${args.path ?? "(all)"}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const ctx = await getContext(args.bloqId)
      if (ctx == null) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop(`v${ctx.version}`)

      let value: any = ctx.business_context
      if (args.path) {
        for (const seg of String(args.path).split(".")) {
          if (value == null) break
          value = value[seg]
        }
      }
      console.log(JSON.stringify(value ?? null, null, 2))
      prompts.outro(dim(`version=${ctx.version}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const ContextSetCommand = cmd({
  command: "set <bloqId> <path> <value>",
  describe: "set a single business_context key (with optimistic lock retry)",
  builder: (y) =>
    y
      .positional("bloqId", { type: "number", demandOption: true })
      .positional("path", { type: "string", demandOption: true })
      .positional("value", { type: "string", demandOption: true })
      .option("user-id", { type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  bloq:context set ${args.path}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    // Try to JSON-decode the value first; fall back to plain string
    let value: any = args.value
    try {
      value = JSON.parse(String(args.value))
    } catch {
      // not JSON, leave as string
    }

    const spinner = prompts.spinner()
    spinner.start("Writing…")
    try {
      const result = await patchContextKey(args.bloqId, String(args.path), value, "set")
      if (result == null) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const v = result?.data?.version ?? "?"
      spinner.stop(`v${v}`)
      prompts.outro(`${dim("Set")} ${bold(args.path)}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const ContextAppendCommand = cmd({
  command: "append <bloqId> <listPath> <jsonValue>",
  describe: "append a JSON object to a list inside business_context",
  builder: (y) =>
    y
      .positional("bloqId", { type: "number", demandOption: true })
      .positional("listPath", { type: "string", demandOption: true })
      .positional("jsonValue", { type: "string", demandOption: true })
      .option("user-id", { type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  bloq:context append ${args.listPath}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    let value: any
    try {
      value = JSON.parse(String(args.jsonValue))
    } catch {
      prompts.log.error("jsonValue must be valid JSON")
      prompts.outro("Done"); return
    }

    const spinner = prompts.spinner()
    spinner.start("Appending…")
    try {
      const result = await patchContextKey(args.bloqId, String(args.listPath), value, "append")
      if (result == null) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop(`v${result?.data?.version ?? "?"}`)
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const ContextRemoveCommand = cmd({
  command: "remove <bloqId> <listPath> <itemId>",
  aliases: ["rm"],
  describe: "remove an item by id from a list inside business_context",
  builder: (y) =>
    y
      .positional("bloqId", { type: "number", demandOption: true })
      .positional("listPath", { type: "string", demandOption: true })
      .positional("itemId", { type: "string", demandOption: true })
      .option("user-id", { type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  bloq:context remove ${args.listPath} ${args.itemId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Removing…")
    try {
      const result = await patchContextKey(args.bloqId, String(args.listPath), { id: args.itemId }, "remove")
      if (result == null) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop(`v${result?.data?.version ?? "?"}`)
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Sugar commands — Andrew's hierarchy: purpose / mission / vision / values
// ============================================================================

function makeScalarSugar(key: "purpose" | "mission" | "vision") {
  const GetCmd = cmd({
    command: "get <bloqId>",
    describe: `read ${key}`,
    builder: (y) =>
      y.positional("bloqId", { type: "number", demandOption: true }).option("user-id", { type: "number" }),
    async handler(args) {
      const token = await requireAuth(); if (!token) return
      const ctx = await getContext(args.bloqId)
      if (ctx == null) return
      console.log(ctx.business_context?.[key] ?? dim("(empty)"))
    },
  })
  const SetCmd = cmd({
    command: "set <bloqId> <value>",
    describe: `set ${key}`,
    builder: (y) =>
      y
        .positional("bloqId", { type: "number", demandOption: true })
        .positional("value", { type: "string", demandOption: true })
        .option("user-id", { type: "number" }),
    async handler(args) {
      UI.empty()
      prompts.intro(`◈  bloq ${key} set`)
      const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
      const spinner = prompts.spinner()
      spinner.start("Writing…")
      try {
        const result = await patchContextKey(args.bloqId, key, String(args.value), "set")
        if (result == null) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
        spinner.stop(`v${result?.data?.version ?? "?"}`)
        prompts.outro(`${bold(key)}: ${args.value}`)
      } catch (err) {
        spinner.stop("Error", 1)
        prompts.log.error(err instanceof Error ? err.message : String(err))
        prompts.outro("Done")
      }
    },
  })
  return { GetCmd, SetCmd }
}

const purposeCmds = makeScalarSugar("purpose")
const missionCmds = makeScalarSugar("mission")
const visionCmds = makeScalarSugar("vision")

const PurposeGroup = cmd({
  command: "purpose",
  describe: "manage bloq purpose",
  builder: (y) => y.command(purposeCmds.GetCmd).command(purposeCmds.SetCmd).demandCommand(),
  async handler() {},
})
const MissionGroup = cmd({
  command: "mission",
  describe: "manage bloq mission",
  builder: (y) => y.command(missionCmds.GetCmd).command(missionCmds.SetCmd).demandCommand(),
  async handler() {},
})
const VisionGroup = cmd({
  command: "vision",
  describe: "manage bloq vision",
  builder: (y) => y.command(visionCmds.GetCmd).command(visionCmds.SetCmd).demandCommand(),
  async handler() {},
})

// ============================================================================
// List sugar — goals / strategies / kpis / deals
// ============================================================================

function makeListGroup(opts: {
  cmdName: string
  listKey: "goals" | "strategies" | "kpis" | "deals"
  itemPrefix: string
  describe: string
  buildItem: (args: any) => Record<string, any>
  enrichForComplete?: (item: any) => Record<string, any>
}) {
  const { cmdName, listKey, itemPrefix, describe, buildItem, enrichForComplete } = opts

  const ListCmd = cmd({
    command: "list <bloqId>",
    aliases: ["ls"],
    describe: `list ${listKey} on a bloq`,
    builder: (y) => y.positional("bloqId", { type: "number", demandOption: true }).option("user-id", { type: "number" }),
    async handler(args) {
      UI.empty()
      prompts.intro(`◈  bloq ${listKey} for #${args.bloqId}`)
      const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
      const ctx = await getContext(args.bloqId)
      if (ctx == null) { prompts.outro("Done"); return }
      const items: any[] = ctx.business_context?.[listKey] ?? []

      if (items.length === 0) {
        prompts.log.warn(`No ${listKey} yet`)
        prompts.outro(dim(`iris bloq ${cmdName} add ${args.bloqId} ...`))
        return
      }

      printDivider()
      for (const it of items) {
        const status = it.status ?? it.stage ?? ""
        const tag = status ? dim(` [${status}]`) : ""
        const id = dim(`#${it.id ?? "?"}`)
        const title = bold(it.title ?? it.name ?? "(untitled)")
        console.log(`  ${title} ${id}${tag}`)
        const extras: string[] = []
        if (it.target != null) extras.push(`target=${it.target}`)
        if (it.deadline) extras.push(`due=${it.deadline}`)
        if (it.scope_hours != null) extras.push(`hours=${it.scope_hours}`)
        if (it.hourly_rate_cents != null) extras.push(`rate=$${(it.hourly_rate_cents / 100).toFixed(2)}/h`)
        if (it.parent_strategy_id) extras.push(`strat=${it.parent_strategy_id}`)
        if (it.parent_goal_id) extras.push(`goal=${it.parent_goal_id}`)
        if (extras.length > 0) console.log("    " + dim(extras.join("  ")))
      }
      printDivider()
      prompts.outro(dim(`v${ctx.version}`))
    },
  })

  const AddCmd = cmd({
    command: "add <bloqId>",
    aliases: ["create", "new"],
    describe: `add a ${listKey.slice(0, -1)}`,
    builder: (y) => {
      let b = y
        .positional("bloqId", { type: "number", demandOption: true })
        .option("title", { type: "string" })
        .option("name", { type: "string" })
        .option("status", { type: "string" })
        .option("user-id", { type: "number" })
      if (listKey === "goals") {
        b = b
          .option("target", { type: "string" })
          .option("deadline", { type: "string", describe: "YYYY-MM-DD" })
          .option("kpi", { type: "string" })
          .option("parent-strategy", { type: "string" })
      } else if (listKey === "strategies") {
        b = b.option("description", { type: "string" }).option("parent-purpose", { type: "string" })
      } else if (listKey === "kpis") {
        b = b
          .option("target", { type: "number" })
          .option("current", { type: "number" })
          .option("unit", { type: "string" })
      } else if (listKey === "deals") {
        b = b
          .option("scope-hours", { type: "number" })
          .option("rate-cents", { type: "number" })
          .option("stage", { type: "string", describe: "lead|qualified|proposal|negotiation|won|lost" })
          .option("client-lead", { type: "number" })
      }
      return b
    },
    async handler(args) {
      UI.empty()
      prompts.intro(`◈  bloq ${cmdName} add`)
      const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

      const item = { id: uid(itemPrefix), ...buildItem(args) }
      const spinner = prompts.spinner()
      spinner.start("Appending…")
      try {
        const result = await patchContextKey(args.bloqId, listKey, item, "append")
        if (result == null) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
        spinner.stop(`v${result?.data?.version ?? "?"}`)
        prompts.outro(`${bold((item as any).title ?? (item as any).name ?? item.id)} ${dim("#" + item.id)}`)
      } catch (err) {
        spinner.stop("Error", 1)
        prompts.log.error(err instanceof Error ? err.message : String(err))
        prompts.outro("Done")
      }
    },
  })

  const RemoveCmd = cmd({
    command: "remove <bloqId> <itemId>",
    aliases: ["rm"],
    describe: `remove a ${listKey.slice(0, -1)} by id`,
    builder: (y) =>
      y
        .positional("bloqId", { type: "number", demandOption: true })
        .positional("itemId", { type: "string", demandOption: true })
        .option("user-id", { type: "number" }),
    async handler(args) {
      UI.empty()
      prompts.intro(`◈  bloq ${cmdName} remove ${args.itemId}`)
      const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
      const spinner = prompts.spinner()
      spinner.start("Removing…")
      try {
        const result = await patchContextKey(args.bloqId, listKey, { id: args.itemId }, "remove")
        if (result == null) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
        spinner.stop(`v${result?.data?.version ?? "?"}`)
        prompts.outro("Done")
      } catch (err) {
        spinner.stop("Error", 1)
        prompts.log.error(err instanceof Error ? err.message : String(err))
        prompts.outro("Done")
      }
    },
  })

  const subcommands: any[] = [ListCmd, AddCmd, RemoveCmd]

  // Goals get a `complete` action
  if (listKey === "goals") {
    const CompleteCmd = cmd({
      command: "complete <bloqId> <itemId>",
      describe: "mark a goal as completed",
      builder: (y) =>
        y
          .positional("bloqId", { type: "number", demandOption: true })
          .positional("itemId", { type: "string", demandOption: true })
          .option("user-id", { type: "number" }),
      async handler(args) {
        UI.empty()
        prompts.intro(`◈  bloq goals complete ${args.itemId}`)
        const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
        const spinner = prompts.spinner()
        spinner.start("Updating…")
        try {
          // Read-modify-write the whole goals list (need to mutate one item's status)
          const ctx = await getContext(args.bloqId)
          if (ctx == null) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
          const goals: any[] = ctx.business_context?.goals ?? []
          let found = false
          const updated = goals.map((g: any) => {
            if (g?.id === args.itemId) {
              found = true
              return { ...g, status: "completed" }
            }
            return g
          })
          if (!found) {
            spinner.stop("Not found", 1)
            prompts.outro(`No goal with id ${args.itemId}`)
            return
          }
          const result = await patchContextKey(args.bloqId, "goals", updated, "set")
          if (result == null) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
          spinner.stop(`v${result?.data?.version ?? "?"}`)
          prompts.outro(`${bold(args.itemId)} ${dim("→ completed")}`)
        } catch (err) {
          spinner.stop("Error", 1)
          prompts.log.error(err instanceof Error ? err.message : String(err))
          prompts.outro("Done")
        }
      },
    })
    subcommands.push(CompleteCmd)
  }

  // Deals get a `stage` action
  if (listKey === "deals") {
    const StageCmd = cmd({
      command: "stage <bloqId> <itemId> <newStage>",
      describe: "advance a deal stage",
      builder: (y) =>
        y
          .positional("bloqId", { type: "number", demandOption: true })
          .positional("itemId", { type: "string", demandOption: true })
          .positional("newStage", { type: "string", demandOption: true })
          .option("user-id", { type: "number" }),
      async handler(args) {
        UI.empty()
        prompts.intro(`◈  bloq deals stage ${args.itemId} → ${args.newStage}`)
        const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
        const spinner = prompts.spinner()
        spinner.start("Updating…")
        try {
          const ctx = await getContext(args.bloqId)
          if (ctx == null) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
          const deals: any[] = ctx.business_context?.deals ?? []
          let found = false
          const updated = deals.map((d: any) => {
            if (d?.id === args.itemId) {
              found = true
              return { ...d, stage: args.newStage }
            }
            return d
          })
          if (!found) {
            spinner.stop("Not found", 1)
            prompts.outro(`No deal with id ${args.itemId}`)
            return
          }
          const result = await patchContextKey(args.bloqId, "deals", updated, "set")
          if (result == null) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
          spinner.stop(`v${result?.data?.version ?? "?"}`)
          prompts.outro(`${bold(args.itemId)} ${dim("→ " + args.newStage)}`)
        } catch (err) {
          spinner.stop("Error", 1)
          prompts.log.error(err instanceof Error ? err.message : String(err))
          prompts.outro("Done")
        }
      },
    })
    subcommands.push(StageCmd)
  }

  return cmd({
    command: cmdName,
    describe,
    builder: (y) => {
      let b = y
      for (const sub of subcommands) b = b.command(sub)
      return b.demandCommand()
    },
    async handler() {},
  })
}

const GoalsGroup = makeListGroup({
  cmdName: "goals",
  listKey: "goals",
  itemPrefix: "g",
  describe: "manage bloq goals",
  buildItem: (args) => {
    const item: Record<string, any> = {
      title: args.title,
      status: args.status ?? "in_progress",
    }
    if (args.target) item.target = args.target
    if (args.deadline) item.deadline = args.deadline
    if (args.kpi) item.kpi = args.kpi
    if (args["parent-strategy"]) item.parent_strategy_id = args["parent-strategy"]
    return item
  },
})

const StrategiesGroup = makeListGroup({
  cmdName: "strategies",
  listKey: "strategies",
  itemPrefix: "s",
  describe: "manage bloq strategies",
  buildItem: (args) => {
    const item: Record<string, any> = {
      title: args.title,
      status: args.status ?? "active",
    }
    if (args.description) item.description = args.description
    if (args["parent-purpose"]) item.parent_purpose = args["parent-purpose"]
    return item
  },
})

const KpisGroup = makeListGroup({
  cmdName: "kpis",
  listKey: "kpis",
  itemPrefix: "k",
  describe: "manage bloq KPIs",
  buildItem: (args) => {
    const item: Record<string, any> = {
      name: args.name ?? args.title,
    }
    if (args.target != null) item.target = args.target
    if (args.current != null) item.current = args.current
    if (args.unit) item.unit = args.unit
    return item
  },
})

const DealsGroup = makeListGroup({
  cmdName: "deals",
  listKey: "deals",
  itemPrefix: "d",
  describe: "manage bloq deals",
  buildItem: (args) => {
    const item: Record<string, any> = {
      title: args.title,
      stage: args.stage ?? "lead",
    }
    if (args["scope-hours"] != null) item.scope_hours = args["scope-hours"]
    if (args["rate-cents"] != null) item.hourly_rate_cents = args["rate-cents"]
    if (args["client-lead"] != null) item.client_lead_id = args["client-lead"]
    return item
  },
})

// ============================================================================
// Root command
// ============================================================================

const ContextGroup = cmd({
  command: "context",
  describe: "raw business_context CRUD (get / set / append / remove)",
  builder: (y) =>
    y
      .command(ContextGetCommand)
      .command(ContextSetCommand)
      .command(ContextAppendCommand)
      .command(ContextRemoveCommand)
      .demandCommand(),
  async handler() {},
})

export const PlatformBloqContextCommand = cmd({
  command: "bloq",
  describe: "Andrew's hierarchy: purpose, strategies, goals, kpis, deals",
  builder: (yargs) =>
    yargs
      .command(ContextGroup)
      .command(PurposeGroup)
      .command(MissionGroup)
      .command(VisionGroup)
      .command(StrategiesGroup)
      .command(GoalsGroup)
      .command(KpisGroup)
      .command(DealsGroup)
      .demandCommand(),
  async handler() {},
})
