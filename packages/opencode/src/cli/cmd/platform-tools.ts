import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, dim, bold, success } from "./iris-api"

// Endpoints (ToolsResource):
//   GET  /api/v1/tools                  — list all tools
//   POST /api/v1/tools/invoke           — invoke a tool

const ToolsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list available tools",
  builder: (yargs) =>
    yargs
      .option("json", { type: "boolean", default: false })
      .option("category", { type: "string", describe: "filter by category" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Tools Registry")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/tools`)
    const ok = await handleApiError(res, "List tools")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    let tools: any[] = data?.data ?? data?.tools ?? (Array.isArray(data) ? data : [])
    if (args.category) tools = tools.filter((t) => (t.category ?? "").toLowerCase() === args.category!.toLowerCase())
    if (args.json) { console.log(JSON.stringify(tools, null, 2)); prompts.outro("Done"); return }
    printDivider()
    if (tools.length === 0) console.log(`  ${dim("(no tools)")}`)
    else for (const t of tools) {
      console.log(`  ${bold(String(t.name ?? t.key ?? "?"))}  ${dim(String(t.category ?? ""))}`)
      if (t.description) console.log(`    ${dim(String(t.description).slice(0, 100))}`)
    }
    printDivider()
    prompts.outro(`${tools.length} tool(s)`)
  },
})

const ToolsInvokeCommand = cmd({
  command: "invoke <name>",
  describe: "invoke a tool by name with key=value params",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .option("param", { alias: "p", type: "array", string: true, default: [] as string[], describe: "key=value (repeatable)" })
      .option("json", { type: "boolean", default: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Invoke ${args.name}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const params: Record<string, any> = {}
    for (const p of (args.param as string[]) ?? []) {
      const eq = p.indexOf("=")
      if (eq > 0) params[p.slice(0, eq)] = p.slice(eq + 1)
    }
    const res = await irisFetch(`/api/v1/tools/invoke`, {
      method: "POST",
      body: JSON.stringify({ tool: args.name, params }),
    })
    const ok = await handleApiError(res, "Invoke tool")
    if (!ok) { prompts.outro("Done"); return }
    const data = await res.json()
    console.log(JSON.stringify(data, null, 2))
    prompts.outro(`${success("✓")} Done`)
  },
})

export const PlatformToolsCommand = cmd({
  command: "tools",
  describe: "list & invoke platform tools",
  builder: (yargs) =>
    yargs
      .command(ToolsListCommand)
      .command(ToolsInvokeCommand)
      .demandCommand(),
  async handler() {},
})
