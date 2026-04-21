import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, dim, bold, success, IRIS_API } from "./iris-api"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

// Endpoints (DiaryResource):
//   GET  /api/v6/diary           ?agent_id=&bloq_id=&user_id=
//   GET  /api/v6/diary/list      ?agent_id=&bloq_id=&user_id=&days=
//   GET  /api/v6/diary/{date}    ?agent_id=&bloq_id=&user_id=
//   POST /api/v6/diary           { agent_id?, bloq_id?, user_id?, content }
//
// Scopes:
//   iris diary               → user-level (default, "My Diary")
//   iris diary --agent 11    → agent-level
//   iris diary --bloq 325    → bloq/project-level

function getSdkUserId(): string | undefined {
  const envPath = join(process.env.HOME || "~", ".iris", "sdk", ".env")
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8")
    const match = content.match(/IRIS_USER_ID=(\d+)/)
    if (match) return match[1]
  }
  return undefined
}

function buildParams(args: Record<string, any>, extra: Record<string, any> = {}): URLSearchParams {
  const p = new URLSearchParams()
  if (args.agent) p.set("agent_id", String(args.agent))
  if (args.bloq) p.set("bloq_id", String(args.bloq))
  // If neither agent nor bloq, send user_id for user-level diary
  if (!args.agent && !args.bloq) {
    const userId = getSdkUserId()
    if (userId) p.set("user_id", userId)
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, String(v))
  return p
}

function scopeLabel(args: Record<string, any>): string {
  if (args.agent) return `Agent #${args.agent}`
  if (args.bloq) return `Bloq #${args.bloq}`
  return "My Diary"
}

const sharedOptions = (yargs: any) =>
  yargs
    .option("agent", { alias: "a", describe: "agent ID (agent-level diary)", type: "number" })
    .option("bloq", { alias: "b", describe: "bloq ID (project-level diary)", type: "number" })
    .option("json", { type: "boolean", default: false })

const DiaryTodayCommand = cmd({
  command: "today",
  describe: "show today's diary timeline",
  builder: sharedOptions,
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diary — Today (${scopeLabel(args)})`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const params = buildParams(args)
    const res = await irisFetch(`/api/v6/diary?${params}`, {}, IRIS_API)
    const ok = await handleApiError(res, "Today's diary")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }

    if (data.bloq_name) console.log(`  ${dim(`Bloq: ${data.bloq_name}`)}`)
    if (data.agent_name) console.log(`  ${dim(`Agent: ${data.agent_name}`)}`)
    console.log()

    printDivider()
    const timeline: any[] = data?.timeline ?? data?.data?.timeline ?? data?.entries ?? []
    if (timeline.length === 0) console.log(`  ${dim("(no entries today)")}`)
    else for (const e of timeline) {
      const ts = e.timestamp ?? e.created_at ?? ""
      const source = e.source === "heartbeat" ? dim(" [heartbeat]") : ""
      console.log(`  ${bold(String(ts).slice(11, 19))}  ${String(e.content ?? e.summary ?? "").slice(0, 100)}${source}`)
    }
    printDivider()
    prompts.outro(dim(`iris diary add "your entry here"${args.agent ? ` --agent ${args.agent}` : args.bloq ? ` --bloq ${args.bloq}` : ""}`))
  },
})

const DiaryListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list recent diary entries",
  builder: (yargs: any) => sharedOptions(yargs).option("days", { alias: "d", type: "number", default: 14 }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diary — Last ${args.days} Days (${scopeLabel(args)})`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const params = buildParams(args, { days: args.days })
    const res = await irisFetch(`/api/v6/diary/list?${params}`, {}, IRIS_API)
    const ok = await handleApiError(res, "List diary")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }

    if (data.bloq_name) console.log(`  ${dim(`Bloq: ${data.bloq_name}`)}`)
    console.log()

    const entries: any[] = data?.entries ?? data?.data ?? (Array.isArray(data) ? data : [])
    printDivider()
    if (entries.length === 0) {
      console.log(`  ${dim("(no entries)")}`)
    } else {
      for (const e of entries) {
        const indicators = []
        if (e.has_diary) indicators.push(`${e.diary_sections} sections`)
        if (e.has_heartbeats) indicators.push(`${e.heartbeat_count} heartbeats`)
        const meta = indicators.length > 0 ? dim(` (${indicators.join(", ")})`) : ""
        console.log(`  ${bold(String(e.date ?? "?"))}${meta}`)
        if (e.summary) console.log(`    ${dim(String(e.summary).slice(0, 100))}`)
      }
    }
    printDivider()
    prompts.outro(`${data.total_entries ?? entries.length} entries`)
  },
})

const DiaryViewCommand = cmd({
  command: "view <date>",
  describe: "view a specific day's diary",
  builder: sharedOptions,
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diary — ${args.date} (${scopeLabel(args)})`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const params = buildParams(args)
    const res = await irisFetch(`/api/v6/diary/${args.date}?${params}`, {}, IRIS_API)
    const ok = await handleApiError(res, "View diary")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }

    if (data.diary_content) {
      console.log()
      console.log(data.diary_content)
    }

    printDivider()
    const timeline: any[] = data?.timeline ?? data?.data?.timeline ?? []
    if (timeline.length === 0 && !data.diary_content) {
      console.log(`  ${dim("(no entries)")}`)
    } else {
      for (const e of timeline) {
        const source = e.source === "heartbeat" ? dim(" [heartbeat]") : ""
        console.log(`  ${bold(e.time ?? "?")}  ${String(e.content ?? e.summary ?? "").slice(0, 100)}${source}`)
      }
    }
    printDivider()
    prompts.outro("Done")
  },
})

const DiaryAddCommand = cmd({
  command: "add <content>",
  describe: "append a diary entry",
  builder: sharedOptions,
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diary — Add (${scopeLabel(args)})`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const payload: any = { content: args.content }
    if (args.agent) payload.agent_id = args.agent
    if (args.bloq) payload.bloq_id = args.bloq
    if (!args.agent && !args.bloq) {
      const userId = getSdkUserId()
      if (userId) payload.user_id = parseInt(userId, 10)
    }
    const res = await irisFetch(`/api/v6/diary`, { method: "POST", body: JSON.stringify(payload) }, IRIS_API)
    const ok = await handleApiError(res, "Add diary")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    prompts.outro(`${success("✓")} Added to ${data.date ?? "today"} at ${data.time ?? "now"}`)
  },
})

export const PlatformDiaryCommand = cmd({
  command: "diary",
  describe: "daily diary — user-level by default, --agent or --bloq for scoped diaries",
  builder: (yargs) =>
    yargs
      .command(DiaryTodayCommand)
      .command(DiaryListCommand)
      .command(DiaryViewCommand)
      .command(DiaryAddCommand)
      .demandCommand(),
  async handler() {},
})
