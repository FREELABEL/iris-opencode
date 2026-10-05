import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, printDivider, dim, bold, success, IRIS_API, writeJson } from "./iris-api"
import { firstArray } from "../../util/array"
import {
  WEB_PROVIDER_IDS,
  planProviders,
  runWebSearch,
  formatOutcome,
  readPreferredProvider,
  writePreferredProvider,
  normalizeProviderName,
  type Exec,
} from "./web-search"

/**
 * `iris web-search <query>` — the open web, through whichever search provider you have
 * connected (#185571, folding #185771, #185774, #59969). Logic lives in web-search.ts.
 */

/** Active search-capable connections on iris-api, which is where these integrations live. */
async function connectedProviders(userId: number): Promise<string[]> {
  const res = await irisFetch(`/api/v1/users/${userId}/integrations`, {}, IRIS_API)
  if (!res.ok) throw new Error(`could not list integrations (HTTP ${res.status})`)
  const data = (await res.json()) as any
  const rows: any[] = firstArray(data?.connections, data?.data, data)
  const ids = new Set<string>()
  for (const r of rows) {
    const type = String(r?.type ?? "")
    if (WEB_PROVIDER_IDS.includes(type as any) && String(r?.status ?? "active") === "active") ids.add(type)
  }
  return [...ids]
}

function makeExec(userId: number): Exec {
  return async (integration, action, params) => {
    const res = await irisFetch(
      `/api/v1/users/${userId}/integrations/execute-direct`,
      { method: "POST", body: JSON.stringify({ integration, action, params }) },
      IRIS_API,
    )
    let body: any = null
    try { body = await res.json() } catch { /* non-JSON error page */ }
    if (!res.ok || body?.success === false) {
      throw new Error(String(body?.error ?? body?.message ?? `HTTP ${res.status}`).slice(0, 300))
    }
    return body?.data ?? body
  }
}

export interface WebSearchArgs {
  query: string
  provider?: string
  limit?: number
  news?: boolean
  all?: boolean
  json?: boolean
  "user-id"?: number
}

export async function webSearchHandler(args: WebSearchArgs): Promise<void> {
  const query = String(args.query)
  const limit = Math.max(1, Math.min(20, Number(args.limit) || 5))
  const news = !!args.news

  if (!args.json) { UI.empty(); prompts.intro(`◈  Web search${news ? " (news)" : ""} — "${query}"`) }

  const token = await requireAuth()
  if (!token) { process.exitCode = 1; if (!args.json) prompts.outro("Done"); return }
  const userId = await requireUserId(args["user-id"])
  if (!userId) { process.exitCode = 1; if (!args.json) prompts.outro("Done"); return }

  let connected: string[]
  try {
    connected = await connectedProviders(userId)
  } catch (e: any) {
    process.exitCode = 1
    if (args.json) await writeJson({ success: false, error: e.message })
    else { prompts.log.error(e.message); prompts.outro("Done") }
    return
  }

  const plan = planProviders(connected, { forced: args.provider, preferred: readPreferredProvider() })
  if (plan.error) {
    process.exitCode = 1
    if (args.json) await writeJson({ success: false, error: plan.error, outcomes: plan.outcomes })
    else { prompts.log.error(plan.error); prompts.outro("Done") }
    return
  }

  const spinner = args.json ? null : prompts.spinner()
  spinner?.start(args.all ? `Searching ${plan.order.join(", ")}…` : `Searching via ${plan.order[0]}…`)
  const { answers, outcomes } = await runWebSearch(query, plan, makeExec(userId), { limit, news, all: !!args.all })

  if (!answers.length) process.exitCode = 1

  if (args.json) {
    await writeJson({
      success: answers.length > 0,
      // Single-provider mode keeps a flat shape so `jq .results[]` works without knowing the engine.
      ...(args.all ? { query, answers } : answers[0] ?? { provider: null, query, answer: null, results: [] }),
      outcomes,
    })
    return
  }

  spinner?.stop(answers.length ? `${success("✓")} ${answers.map((a) => `${a.provider} · ${a.results.length} result(s)`).join("  ")}` : "No provider answered", answers.length ? 0 : 1)

  for (const a of answers) {
    if (args.all) { console.log(); console.log(`  ${bold(a.provider)}`); printDivider() }
    if (a.answer) {
      console.log()
      console.log(`  ${bold("Answer")}`)
      console.log(`  ${a.answer}`)
    }
    console.log()
    a.results.forEach((r, i) => {
      console.log(`  ${bold(`${i + 1}. ${r.title || r.url}`)}${r.published ? dim(`  ${r.published}`) : ""}`)
      console.log(`     ${dim(r.url)}`)
      if (r.snippet) console.log(`     ${r.snippet.replace(/\s+/g, " ").slice(0, 220)}${r.snippet.length > 220 ? "…" : ""}`)
    })
    if (!a.results.length) console.log(`  ${dim("(no results)")}`)
  }

  console.log()
  printDivider()
  for (const o of outcomes) console.log(`  ${dim(formatOutcome(o))}`)
  prompts.outro(dim(`Force one: --provider ${WEB_PROVIDER_IDS.join("|")} · compare: --all · make default: iris web-search --set-default <provider>`))
}

export const PlatformWebSearchCommand = cmd({
  command: "web-search [query]",
  aliases: ["websearch", "web-find"],
  describe: "search the open web through your connected provider (Tavily, Google via composio-search)",
  builder: (yargs) =>
    yargs
      .positional("query", { describe: "what to search for", type: "string" })
      .option("provider", { alias: "p", describe: `force one provider: ${WEB_PROVIDER_IDS.join(", ")} (default: auto-detect from your connections)`, type: "string" })
      .option("limit", { alias: "n", describe: "max results (1-20)", type: "number", default: 5 })
      .option("news", { describe: "recent news instead of general web results", type: "boolean", default: false })
      .option("all", { describe: "run every connected provider and show each — for comparing engines", type: "boolean", default: false })
      .option("set-default", { describe: "save a preferred provider for auto-detect (~/.iris/config.json)", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .example("iris web-search \"best coffee in austin\"", "answer + top 5 links from your default provider")
      .example("iris web-search \"openai\" --news --provider composio-search", "Google News results")
      .example("iris web-search --set-default tavily", "prefer Tavily when both are connected"),
  async handler(args) {
    const setDefault = args["set-default"] as string | undefined
    if (setDefault) {
      const id = normalizeProviderName(setDefault)
      if (!id) { prompts.log.error(`Unknown provider "${setDefault}". Known: ${WEB_PROVIDER_IDS.join(", ")}`); process.exitCode = 1; return }
      writePreferredProvider(id)
      prompts.log.success(`Default web search provider: ${id}`)
      if (!args.query) return
    }
    if (!args.query) { prompts.log.error("A query is required: iris web-search \"<query>\""); process.exitCode = 1; return }
    await webSearchHandler({
      query: String(args.query),
      provider: args.provider as string | undefined,
      limit: args.limit as number,
      news: args.news as boolean,
      all: args.all as boolean,
      json: args.json as boolean,
      "user-id": args["user-id"] as number | undefined,
    })
  },
})
