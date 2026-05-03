import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, printDivider, dim, bold, IRIS_API } from "./iris-api"

// Cross-source recall — search past sessions, agent memory, and diary.
// Backed by /api/v6/recall on iris-api.
//
// Usage:
//   iris recall "saddlepass deal"
//   iris recall "vagaro integration" --days 30 --no-summarize
//   iris recall "carrington" --agent 11 --limit 10

export const PlatformRecallCommand = cmd({
  command: "recall <query..>",
  aliases: ["search-memory"],
  describe: "search past sessions, memory, and diary for a query",
  builder: (yargs) =>
    yargs
      .positional("query", { describe: "what to search for", type: "string", array: true })
      .option("days", { type: "number", default: 14, describe: "lookback window for diary (1-90)" })
      .option("limit", { type: "number", default: 5, describe: "max hits per source (1-20)" })
      .option("agent", { type: "string", describe: "scope to a specific agent_id" })
      .option("summarize", { type: "boolean", default: true, describe: "LLM summary of hits (gpt-5-nano)" })
      .option("json", { type: "boolean", default: false, describe: "raw JSON output" }),
  async handler(args) {
    const query = (args.query ?? []).join(" ").trim()
    if (!query) {
      console.error("recall: query is required — e.g. iris recall \"the saddlepass deal\"")
      process.exit(1)
    }
    const token = await requireAuth(); if (!token) return
    const userId = await requireUserId(); if (!userId) return

    UI.empty()
    prompts.intro(`◈  Recall: ${bold(query)}`)

    const qs = new URLSearchParams({
      q: query,
      user_id: String(userId),
      days: String(args.days),
      limit: String(args.limit),
      summarize: args.summarize ? "1" : "0",
    })
    if (args.agent) qs.set("agent_id", args.agent)

    const res = await irisFetch(`/api/v6/recall?${qs.toString()}`, {}, IRIS_API)
    const ok = await handleApiError(res, "Recall")
    if (!ok) { prompts.outro("Done"); return }

    const data = (await res.json()) as any

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      prompts.outro("Done")
      return
    }

    if (data?.summary) {
      printDivider()
      console.log(`  ${bold("Summary")}`)
      console.log(`  ${data.summary}`)
    }

    const renderBucket = (label: string, items: any[]) => {
      if (!items?.length) return
      printDivider()
      console.log(`  ${bold(label)}  ${dim(`(${items.length})`)}`)
      for (const item of items) {
        const when = item.created_at ?? item.date ?? ""
        const text = (item.content ?? item.summary ?? "").toString().slice(0, 200)
        console.log(`  ${dim(when)}  ${text}`)
      }
    }

    renderBucket("Memory", data?.hits?.memory ?? [])
    renderBucket("Chat", data?.hits?.chat ?? [])
    renderBucket("Diary", data?.hits?.diary ?? [])

    printDivider()
    prompts.outro(`${data?.count ?? 0} hit(s) for "${query}"`)
  },
})
