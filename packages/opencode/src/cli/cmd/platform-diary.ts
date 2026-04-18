import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, dim, bold, success } from "./iris-api"

// Endpoints (DiaryResource):
//   GET  /api/v6/diary           ?agent_id=&bloq_id=
//   GET  /api/v6/diary/list      ?agent_id=&days=
//   GET  /api/v6/diary/{date}    ?agent_id=
//   POST /api/v6/diary           { agent_id, content, bloq_id? }

function buildParams(agentId: number | undefined, bloqId: number | undefined, extra: Record<string, any> = {}): URLSearchParams {
  const p = new URLSearchParams()
  if (agentId) p.set("agent_id", String(agentId))
  if (bloqId) p.set("bloq_id", String(bloqId))
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, String(v))
  return p
}

const DiaryTodayCommand = cmd({
  command: "today [agentId]",
  describe: "show today's diary timeline",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number" })
      .option("bloq", { alias: "b", type: "number" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Diary — Today")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    if (!args.agentId && !args.bloq) { prompts.log.error("agent_id or --bloq required"); process.exitCode = 1; prompts.outro("Done"); return }
    const params = buildParams(args.agentId, args.bloq)
    const res = await irisFetch(`/api/v6/diary?${params}`)
    const ok = await handleApiError(res, "Today's diary")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }
    printDivider()
    const timeline: any[] = data?.timeline ?? data?.data?.timeline ?? data?.entries ?? []
    if (timeline.length === 0) console.log(`  ${dim("(no entries)")}`)
    else for (const e of timeline) {
      const ts = e.timestamp ?? e.created_at ?? ""
      console.log(`  ${dim(String(ts).slice(11, 19))}  ${String(e.content ?? e.summary ?? "").slice(0, 100)}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

const DiaryListCommand = cmd({
  command: "list [agentId]",
  aliases: ["ls"],
  describe: "list recent diary entries",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number" })
      .option("bloq", { alias: "b", type: "number" })
      .option("days", { alias: "d", type: "number", default: 14 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Diary — List")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    if (!args.agentId && !args.bloq) { prompts.log.error("agent_id or --bloq required"); process.exitCode = 1; prompts.outro("Done"); return }
    const params = buildParams(args.agentId, args.bloq, { days: args.days })
    const res = await irisFetch(`/api/v6/diary/list?${params}`)
    const ok = await handleApiError(res, "List diary")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }
    const entries: any[] = data?.entries ?? data?.data ?? (Array.isArray(data) ? data : [])
    printDivider()
    for (const e of entries) console.log(`  ${bold(String(e.date ?? e.created_at ?? "?"))}  ${dim(String(e.summary ?? e.content ?? "").slice(0, 80))}`)
    printDivider()
    prompts.outro("Done")
  },
})

const DiaryViewCommand = cmd({
  command: "view <agentId> <date>",
  describe: "view a specific day's diary",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number", demandOption: true })
      .positional("date", { type: "string", demandOption: true })
      .option("bloq", { alias: "b", type: "number" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diary — ${args.date}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const params = buildParams(args.agentId, args.bloq)
    const res = await irisFetch(`/api/v6/diary/${args.date}?${params}`)
    const ok = await handleApiError(res, "View diary")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }
    printDivider()
    const timeline: any[] = data?.timeline ?? data?.data?.timeline ?? []
    for (const e of timeline) console.log(`  ${dim(String(e.timestamp ?? "").slice(11, 19))}  ${String(e.content ?? e.summary ?? "").slice(0, 100)}`)
    printDivider()
    prompts.outro("Done")
  },
})

const DiaryAddCommand = cmd({
  command: "add <agentId> <content>",
  describe: "append a manual diary entry",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number", demandOption: true })
      .positional("content", { type: "string", demandOption: true })
      .option("bloq", { alias: "b", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Diary — Add")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const payload: any = { agent_id: args.agentId, content: args.content }
    if (args.bloq) payload.bloq_id = args.bloq
    const res = await irisFetch(`/api/v6/diary`, { method: "POST", body: JSON.stringify(payload) })
    const ok = await handleApiError(res, "Add diary")
    if (!ok) { prompts.outro("Done"); return }
    prompts.outro(`${success("✓")} Added`)
  },
})

export const PlatformDiaryCommand = cmd({
  command: "diary",
  describe: "view & manage agent daily diary entries",
  builder: (yargs) =>
    yargs
      .command(DiaryTodayCommand)
      .command(DiaryListCommand)
      .command(DiaryViewCommand)
      .command(DiaryAddCommand)
      .demandCommand(),
  async handler() {},
})
