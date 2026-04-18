import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"

// ============================================================================
// Event Production CLI — runsheet, checklist, budget, overview
// All data in metadata.production (no new tables)
// ============================================================================

async function loadEvent(eventId: number): Promise<any> {
  const res = await irisFetch(`/api/v1/events/${eventId}`)
  if (!res.ok) return null
  return ((await res.json()) as any)?.data ?? null
}

async function loadSubResources(eventId: number) {
  const [stagesRes, ticketsRes, vendorsRes] = await Promise.all([
    irisFetch(`/api/v1/events/${eventId}/stages`).catch(() => null),
    irisFetch(`/api/v1/events/${eventId}/tickets`).catch(() => null),
    irisFetch(`/api/v1/events/${eventId}/vendors`).catch(() => null),
  ])
  return {
    stages: stagesRes?.ok ? ((await stagesRes.json()) as any)?.data ?? [] : [],
    tickets: ticketsRes?.ok ? ((await ticketsRes.json()) as any)?.data ?? [] : [],
    vendors: vendorsRes?.ok ? ((await vendorsRes.json()) as any)?.data ?? [] : [],
  }
}

function to12h(t: string): string {
  if (!t) return ""
  const [h, m] = t.split(":").map(Number)
  const ampm = h >= 12 ? "PM" : "AM"
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`
}

function getProduction(event: any): any {
  return event?.metadata?.production ?? {}
}

// Load local event JSON (for metadata editing)
async function loadLocalEvent(eventId: number): Promise<{ data: any; path: string } | null> {
  const { existsSync, readFileSync, readdirSync } = await import("fs")
  const { join } = await import("path")
  const { homedir } = await import("os")
  const dir = join(homedir(), ".iris", "events")
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter((f: string) => f.startsWith(`${eventId}-`) && f.endsWith(".json") && !f.includes("tickets"))
  if (files.length === 0) return null
  const path = join(dir, files[0])
  return { data: JSON.parse(readFileSync(path, "utf8")), path }
}

async function saveLocalEvent(path: string, data: any) {
  const { writeFileSync } = await import("fs")
  writeFileSync(path, JSON.stringify(data, null, 2))
}

// ── Overview ──

const OverviewCmd = cmd({
  command: "overview",
  aliases: ["status", "dashboard"],
  describe: "full production dashboard — readiness, runsheet, tickets, staff, budget",
  builder: (y) => y,
  async handler(args: any) {
    const eventId = args._parentEventId
    UI.empty()
    prompts.intro(`◈  Production: Event #${eventId}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Loading…")

    const event = await loadEvent(eventId)
    if (!event) { sp.stop("Event not found", 1); prompts.outro("Done"); return }
    const { stages, tickets, vendors } = await loadSubResources(eventId)
    const prod = getProduction(event)

    sp.stop(bold(event.title))

    // Header
    printDivider()
    printKV("Date", `${event.start_date} ${to12h(event.start_time)} – ${to12h(event.end_time)}`)
    printKV("Venue", event.venue_name || dim("not set"))

    // Runsheet
    const runsheet: any[] = prod.runsheet ?? []
    // Also build from stage set times if no runsheet
    let timeline = runsheet
    if (timeline.length === 0) {
      for (const s of stages) {
        for (const st of (s.set_times ?? s.event_stage_set_times ?? [])) {
          timeline.push({ time: st.start_time, title: st.title, status: "pending", stage: s.title })
        }
      }
      // Add production timeline from metadata
      for (const pt of (event.metadata?.production_timeline ?? [])) {
        timeline.push({ time: pt.time, title: pt.task, status: "pending", isProd: true })
      }
      timeline.sort((a: any, b: any) => (a.time || "").localeCompare(b.time || ""))
    }

    if (timeline.length > 0) {
      console.log()
      console.log(`  ${bold("Runsheet")}  ${dim(`(${timeline.length} items)`)}`)
      const now = new Date()
      const nowTime = now.getHours().toString().padStart(2, "0") + ":" + now.getMinutes().toString().padStart(2, "0")
      for (const item of timeline) {
        const isPast = item.time < nowTime
        const icon = item.status === "done" ? success("✓") : isPast ? dim("·") : "○"
        const timeStr = dim(to12h(item.time).padEnd(9))
        const title = item.isProd ? dim(item.title) : item.title
        console.log(`    ${icon} ${timeStr} ${title}`)
      }
    }

    // Tickets
    console.log()
    console.log(`  ${bold("Tickets")}  ${dim(`(${tickets.length} tiers)`)}`)
    let totalRevenue = 0
    for (const t of tickets) {
      const sold = t.quantity_sold ?? 0
      const total = t.quantity_total
      const price = parseFloat(t.price || "0")
      totalRevenue += sold * price
      const soldStr = total ? `${sold}/${total}` : `${sold}`
      console.log(`    ${t.title}: ${soldStr} sold ${dim(`($${price})`)}`)
    }
    printKV("  Ticket Revenue", `$${totalRevenue.toFixed(2)}`)

    // Vendors
    console.log()
    console.log(`  ${bold("Vendors")}  ${dim(`(${vendors.length})`)}`)
    if (vendors.length === 0) {
      console.log(`    ${dim("none — iris events vendor-create " + eventId)}`)
    } else {
      for (const v of vendors) {
        console.log(`    ${v.title}${v.subtitle ? dim(` — ${v.subtitle}`) : ""}`)
      }
    }

    // Stages
    console.log()
    console.log(`  ${bold("Stages")}  ${dim(`(${stages.length})`)}`)
    for (const s of stages) {
      const setTimes = s.set_times ?? s.event_stage_set_times ?? []
      console.log(`    ${highlight(s.title)} ${dim(`(${setTimes.length} acts)`)}`)
    }

    // Checklist
    const checklist: any[] = prod.checklist ?? []
    if (checklist.length > 0) {
      const done = checklist.filter((c: any) => c.done).length
      const pct = Math.round((done / checklist.length) * 100)
      console.log()
      console.log(`  ${bold("Checklist")}  ${dim(`${done}/${checklist.length} (${pct}%)`)}`)
      for (const item of checklist) {
        const icon = item.done ? success("✓") : `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}`
        console.log(`    ${icon} ${item.item}`)
      }
    }

    // Budget
    const budget = prod.budget
    if (budget) {
      const income = (budget.income ?? []).reduce((s: number, i: any) => s + (i.amount || 0), 0)
      const expenses = (budget.expenses ?? []).reduce((s: number, i: any) => s + (i.amount || 0), 0)
      console.log()
      console.log(`  ${bold("Budget")}`)
      printKV("    Income", `$${income}`)
      printKV("    Expenses", `$${expenses}`)
      printKV("    Margin", income - expenses >= 0 ? success(`$${income - expenses}`) : `${UI.Style.TEXT_DANGER}$${income - expenses}${UI.Style.TEXT_NORMAL}`)
    }

    printDivider()
    prompts.outro("Done")
  },
})

// ── Runsheet ──

const RunsheetCmd = cmd({
  command: "runsheet",
  aliases: ["timeline", "schedule"],
  describe: "show/edit the run-of-show timeline",
  builder: (y) =>
    y
      .option("add", { type: "string", describe: 'add item: "18:30 Sound Check 30min"' })
      .option("done", { type: "number", describe: "mark item # as done" })
      .option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    const eventId = args._parentEventId
    UI.empty()
    prompts.intro(`◈  Runsheet — Event #${eventId}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const local = await loadLocalEvent(eventId)
    if (!local) {
      prompts.log.error(`No local event file. Run: iris events pull ${eventId}`)
      prompts.outro("Done")
      return
    }

    const prod = local.data.metadata?.production ?? {}
    let runsheet: any[] = prod.runsheet ?? []

    // If no runsheet, build from stages + production_timeline
    if (runsheet.length === 0 && !args.add) {
      const stages = local.data.stages ?? local.data.event_stages ?? []
      for (const s of stages) {
        for (const st of (s.set_times ?? s.event_stage_set_times ?? [])) {
          runsheet.push({ time: st.start_time, end: st.end_time, title: st.title, status: "pending", stage: s.title })
        }
      }
      for (const pt of (local.data.metadata?.production_timeline ?? [])) {
        runsheet.push({ time: pt.time, title: pt.task, status: "pending", isProd: true })
      }
      runsheet.sort((a: any, b: any) => (a.time || "").localeCompare(b.time || ""))
    }

    // --add
    if (args.add) {
      const match = String(args.add).match(/^(\d{1,2}:\d{2})\s+(.+?)(?:\s+(\d+)min)?$/)
      if (!match) {
        prompts.log.error('Format: "HH:MM Title [Nmin]" — e.g. "18:30 Sound Check 30min"')
        prompts.outro("Done")
        return
      }
      const [, time, title, dur] = match
      const item: any = { time, title, status: "pending" }
      if (dur) item.duration_min = parseInt(dur)
      runsheet.push(item)
      runsheet.sort((a: any, b: any) => (a.time || "").localeCompare(b.time || ""))

      if (!local.data.metadata) local.data.metadata = {}
      if (!local.data.metadata.production) local.data.metadata.production = {}
      local.data.metadata.production.runsheet = runsheet
      await saveLocalEvent(local.path, local.data)
      prompts.log.success(`Added: ${to12h(time)} ${title}`)
      prompts.log.info(dim(`Push with: iris events push ${eventId}`))
      prompts.outro("Done")
      return
    }

    // --done
    if (args.done != null) {
      const idx = args.done - 1
      if (idx < 0 || idx >= runsheet.length) {
        prompts.log.error(`Item #${args.done} not found (have ${runsheet.length} items)`)
        prompts.outro("Done")
        return
      }
      runsheet[idx].status = "done"
      if (!local.data.metadata) local.data.metadata = {}
      if (!local.data.metadata.production) local.data.metadata.production = {}
      local.data.metadata.production.runsheet = runsheet
      await saveLocalEvent(local.path, local.data)
      prompts.log.success(`Marked done: ${runsheet[idx].title}`)
      prompts.outro("Done")
      return
    }

    // Display
    if (args.json) {
      console.log(JSON.stringify(runsheet, null, 2))
      prompts.outro("Done")
      return
    }

    const now = new Date()
    const nowTime = now.getHours().toString().padStart(2, "0") + ":" + now.getMinutes().toString().padStart(2, "0")
    let nowIdx = -1
    for (let i = runsheet.length - 1; i >= 0; i--) {
      if (runsheet[i].time <= nowTime) { nowIdx = i; break }
    }

    printDivider()
    for (let i = 0; i < runsheet.length; i++) {
      const item = runsheet[i]
      const isPast = i < nowIdx
      const isNow = i === nowIdx
      const isNext = i === nowIdx + 1
      const isDone = item.status === "done"

      let icon = "○"
      if (isDone) icon = success("✓")
      else if (isNow) icon = highlight("●")
      else if (isPast) icon = dim("·")

      const num = dim(`${String(i + 1).padStart(2)}.`)
      const time = dim(to12h(item.time || "").padEnd(9))
      const label = isNow ? bold(item.title) : isNext ? highlight(item.title) : isPast && !isDone ? dim(item.title) : item.title
      const stage = item.stage && !item.isProd ? dim(` [${item.stage}]`) : ""
      const nowLabel = isNow ? ` ${highlight("← NOW")}` : isNext ? ` ${dim("← NEXT")}` : ""

      console.log(`  ${num} ${icon} ${time} ${label}${stage}${nowLabel}`)
    }
    printDivider()
    prompts.log.info(dim(`Mark done: iris events production ${eventId} runsheet --done 3`))
    prompts.log.info(dim(`Add item:  iris events production ${eventId} runsheet --add "18:30 Sound Check 30min"`))
    prompts.outro("Done")
  },
})

// ── Checklist ──

const ChecklistCmd = cmd({
  command: "checklist",
  aliases: ["todo", "tasks"],
  describe: "production checklist with completion tracking",
  builder: (y) =>
    y
      .option("add", { type: "string", describe: "add checklist item" })
      .option("done", { type: "number", describe: "mark item # as done" })
      .option("undo", { type: "number", describe: "mark item # as not done" })
      .option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    const eventId = args._parentEventId
    UI.empty()
    prompts.intro(`◈  Checklist — Event #${eventId}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const local = await loadLocalEvent(eventId)
    if (!local) {
      prompts.log.error(`No local event file. Run: iris events pull ${eventId}`)
      prompts.outro("Done")
      return
    }

    if (!local.data.metadata) local.data.metadata = {}
    if (!local.data.metadata.production) local.data.metadata.production = {}
    let checklist: any[] = local.data.metadata.production.checklist ?? []

    // --add
    if (args.add) {
      checklist.push({ item: String(args.add), done: false })
      local.data.metadata.production.checklist = checklist
      await saveLocalEvent(local.path, local.data)
      prompts.log.success(`Added: ${args.add}`)
      prompts.outro("Done")
      return
    }

    // --done
    if (args.done != null) {
      const idx = args.done - 1
      if (idx < 0 || idx >= checklist.length) {
        prompts.log.error(`Item #${args.done} not found`)
        prompts.outro("Done")
        return
      }
      checklist[idx].done = true
      local.data.metadata.production.checklist = checklist
      await saveLocalEvent(local.path, local.data)
      prompts.log.success(`Done: ${checklist[idx].item}`)
      prompts.outro("Done")
      return
    }

    // --undo
    if (args.undo != null) {
      const idx = args.undo - 1
      if (idx >= 0 && idx < checklist.length) {
        checklist[idx].done = false
        local.data.metadata.production.checklist = checklist
        await saveLocalEvent(local.path, local.data)
        prompts.log.info(`Undone: ${checklist[idx].item}`)
      }
      prompts.outro("Done")
      return
    }

    // Display
    if (args.json) {
      console.log(JSON.stringify(checklist, null, 2))
      prompts.outro("Done")
      return
    }

    if (checklist.length === 0) {
      prompts.log.warn("No checklist items yet")
      prompts.log.info(dim(`Add: iris events production ${eventId} checklist --add "Test OBS scenes"`))
      prompts.outro("Done")
      return
    }

    const done = checklist.filter((c: any) => c.done).length
    const pct = Math.round((done / checklist.length) * 100)
    const pctColor = pct >= 80 ? success : pct >= 50 ? (s: string) => `${UI.Style.TEXT_WARNING}${s}${UI.Style.TEXT_NORMAL}` : (s: string) => `${UI.Style.TEXT_DANGER}${s}${UI.Style.TEXT_NORMAL}`

    printDivider()
    for (let i = 0; i < checklist.length; i++) {
      const c = checklist[i]
      const icon = c.done ? success("✓") : `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}`
      const num = dim(`${String(i + 1).padStart(2)}.`)
      console.log(`  ${num} ${icon} ${c.done ? dim(c.item) : c.item}`)
    }
    printDivider()
    console.log(`  Completion: ${pctColor(`${pct}%`)} (${done}/${checklist.length})`)

    prompts.outro("Done")
  },
})

// ── Budget (quick view) ──

const BudgetCmd = cmd({
  command: "budget",
  aliases: ["pnl", "money"],
  describe: "income vs expenses with margin",
  builder: (y) =>
    y
      .option("add-income", { type: "string", describe: 'add income: "sponsors 500 confirmed"' })
      .option("add-expense", { type: "string", describe: 'add expense: "PA rental 200 pending"' })
      .option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    const eventId = args._parentEventId
    UI.empty()
    prompts.intro(`◈  Budget — Event #${eventId}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const local = await loadLocalEvent(eventId)
    if (!local) {
      prompts.log.error(`No local event file. Run: iris events pull ${eventId}`)
      prompts.outro("Done")
      return
    }

    if (!local.data.metadata) local.data.metadata = {}
    if (!local.data.metadata.production) local.data.metadata.production = {}
    if (!local.data.metadata.production.budget) local.data.metadata.production.budget = { income: [], expenses: [] }
    const budget = local.data.metadata.production.budget

    // --add-income
    if (args["add-income"]) {
      const parts = String(args["add-income"]).split(/\s+/)
      const source = parts[0]
      const amount = parseFloat(parts[1] || "0")
      const status = parts[2] || "pending"
      budget.income.push({ source, amount, status })
      await saveLocalEvent(local.path, local.data)
      prompts.log.success(`Added income: ${source} $${amount} (${status})`)
      prompts.outro("Done")
      return
    }

    // --add-expense
    if (args["add-expense"]) {
      const parts = String(args["add-expense"]).split(/\s+/)
      const item = parts[0]
      const amount = parseFloat(parts[1] || "0")
      const status = parts[2] || "pending"
      budget.expenses.push({ item, amount, status })
      await saveLocalEvent(local.path, local.data)
      prompts.log.success(`Added expense: ${item} $${amount} (${status})`)
      prompts.outro("Done")
      return
    }

    // Display
    const income = budget.income ?? []
    const expenses = budget.expenses ?? []
    const totalIncome = income.reduce((s: number, i: any) => s + (i.amount || 0), 0)
    const totalExpenses = expenses.reduce((s: number, i: any) => s + (i.amount || 0), 0)
    const margin = totalIncome - totalExpenses

    if (args.json) {
      console.log(JSON.stringify({ income, expenses, totalIncome, totalExpenses, margin }, null, 2))
      prompts.outro("Done")
      return
    }

    printDivider()
    console.log(`  ${bold("Income")}`)
    for (const i of income) {
      console.log(`    ${success("+")} $${i.amount}  ${i.source}  ${dim(i.status || "")}`)
    }
    if (income.length === 0) console.log(`    ${dim("none")}`)

    console.log()
    console.log(`  ${bold("Expenses")}`)
    for (const e of expenses) {
      console.log(`    ${dim("-")} $${e.amount}  ${e.item}  ${dim(e.status || "")}`)
    }
    if (expenses.length === 0) console.log(`    ${dim("none")}`)

    printDivider()
    printKV("  Total Income", success(`$${totalIncome}`))
    printKV("  Total Expenses", `$${totalExpenses}`)
    printKV("  Margin", margin >= 0 ? success(`$${margin}`) : `${UI.Style.TEXT_DANGER}-$${Math.abs(margin)}${UI.Style.TEXT_NORMAL}`)

    prompts.outro("Done")
  },
})

// ============================================================================
// Root — registered as subcommand of `iris events`
// ============================================================================

export const ProductionCommand = cmd({
  command: "production <event-id>",
  aliases: ["prod"],
  describe: "event production management — runsheet, checklist, budget, overview",
  builder: (y) =>
    y
      .positional("event-id", { type: "number", demandOption: true })
      .middleware([(argv: any) => { argv._parentEventId = argv["event-id"] }])
      .command(OverviewCmd)
      .command(RunsheetCmd)
      .command(ChecklistCmd)
      .command(BudgetCmd)
      .demandCommand(1, "specify: overview, runsheet, checklist, budget"),
  async handler() {},
})
