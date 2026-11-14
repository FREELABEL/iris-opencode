import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, printDivider, dim, bold, IRIS_API, writeJson } from "./iris-api"

// Cross-source recall — search agent memory, chat, diary, and the Desktop + CLI sessions on
// every machine you own (#191223). Backed by /api/v6/recall on iris-api.
//
// Usage:
//   iris recall "saddlepass deal"
//   iris recall "vagaro integration" --days 30 --no-summarize
//   iris recall "carrington" --agent 11 --limit 10

export type SessionHit = {
  title?: string | null
  session_id?: string | null
  provider?: string | null
  node?: string | null
  project?: string | null
  updated_at?: string | null
}

/**
 * A session hit as three lines: its title, where it lives (machine · folder · app · id), and the
 * command that opens it from here — `iris sessions read` fetches it from that machine (#191230).
 */
export function sessionHitLines(s: SessionHit): [string, string, string | null] {
  const app = s.provider === "claude_code" ? "Claude Code" : s.provider === "opencode" ? "IRIS" : s.provider
  const where = [s.node ?? "unknown machine", s.project, app, s.session_id].filter(Boolean).join(" · ")
  const open = s.session_id
    ? `    read: iris sessions read ${s.session_id}${s.node ? ` --machine "${s.node}"` : ""}`
    : null
  return [(s.title ?? "Session").replace(/\s+/g, " ").trim(), `    ${where}`, open]
}

/**
 * Which calls recall makes (#191306). The summary is a model call: measured 2026-10-27 it made the
 * API answer in 5.0 s (median) instead of 0.55 s, so the hits waited ~4.4 s for a paragraph. A
 * person now gets the hits first and the summary after; --json keeps one call, summary included,
 * because a script reads the whole answer at once. No hits means nothing to summarize.
 */
export function recallCalls(o: { json: boolean; summarize: boolean }): { first: boolean; thenSummary: boolean } {
  if (o.json) return { first: o.summarize, thenSummary: false }
  return { first: false, thenSummary: o.summarize }
}

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
      // boolean-negation is off globally (src/index.ts), so `--no-summarize` has to be its own flag (#191224).
      .option("no-summarize", { type: "boolean", default: false, describe: "skip the LLM summary" })
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

    const wantSummary = !!args.summarize && !args["no-summarize"]
    const plan = recallCalls({ json: !!args.json, summarize: wantSummary })
    const ask = async (summarize: boolean) => {
      const qs = new URLSearchParams({
        q: query,
        user_id: String(userId),
        days: String(args.days),
        limit: String(args.limit),
        summarize: summarize ? "1" : "0",
      })
      if (args.agent) qs.set("agent_id", args.agent)
      const res = await irisFetch(`/api/v6/recall?${qs.toString()}`, {}, IRIS_API)
      if (!(await handleApiError(res, "Recall"))) return null
      return (await res.json()) as any
    }

    const data = await ask(plan.first)
    if (!data) { prompts.outro("Done"); return }

    if (args.json) {
      await writeJson(data)
      prompts.outro("Done")
      return
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

    const sessions: SessionHit[] = data?.hits?.sessions ?? []
    if (sessions.length) {
      printDivider()
      console.log(`  ${bold("Sessions")}  ${dim(`(${sessions.length}) · Desktop + CLI, on every machine you own`)}`)
      for (const s of sessions) {
        const [title, where, open] = sessionHitLines(s)
        console.log(`  ${dim(s.updated_at ?? "")}  ${title}`)
        console.log(`  ${dim(where)}`)
        if (open) console.log(`  ${dim(open)}`)
      }
    }

    // The summary after the hits, so they are on screen while the model writes (#191306).
    if (plan.thenSummary && (data?.count ?? 0) > 0) {
      const spinner = prompts.spinner()
      spinner.start("Summarizing…")
      const withSummary = await ask(true).catch(() => null)
      spinner.stop(withSummary?.summary ? "Summary" : "No summary this time")
      if (withSummary?.summary) console.log(`  ${withSummary.summary}`)
    }

    printDivider()
    prompts.outro(`${data?.count ?? 0} hit(s) for "${query}"`)
  },
})
