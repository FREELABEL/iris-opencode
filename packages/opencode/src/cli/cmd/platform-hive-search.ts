import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { requireAuth, requireUserId, dim, bold, success, highlight } from "./iris-api"
import { hiveFetch, fetchNodes } from "./platform-hive-nodes"
import { existsSync, readFileSync, readdirSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// ============================================================================
// iris hive search — distributed search across all Hive nodes
//
// Dispatches a lightweight search task to every online node. Each daemon
// searches its local inbox, iMessage DB, and files. Results are aggregated
// and displayed tagged by node.
// ============================================================================

const SEARCH_TYPES = ["all", "files", "inbox", "imessage"] as const
type SearchType = typeof SEARCH_TYPES[number]

interface SearchResult {
  node_name: string
  node_id: string
  source: string   // "inbox" | "imessage" | "files"
  match: string    // filename, contact name, or snippet
  preview: string  // text preview
  date?: string
  path?: string
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return ""
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

/** Search the local Hive inbox for matching items */
function searchLocalInbox(query: string): SearchResult[] {
  const inboxDir = join(homedir(), ".iris", "hive", "inbox")
  const manifestPath = join(inboxDir, ".manifest.jsonl")
  if (!existsSync(manifestPath)) return []

  const raw = readFileSync(manifestPath, "utf-8").trim()
  if (!raw) return []

  const q = query.toLowerCase()
  const results: SearchResult[] = []

  for (const line of raw.split("\n")) {
    try {
      const item = JSON.parse(line)
      const haystack = [
        item.file, item.original_name, item.message, item.from_node, item.url,
      ].filter(Boolean).join(" ").toLowerCase()

      if (haystack.includes(q)) {
        // Read file content for preview
        let preview = item.message ?? ""
        if (!preview || preview.length < 20) {
          const filePath = join(inboxDir, item.file)
          try {
            if (existsSync(filePath)) {
              preview = readFileSync(filePath, "utf-8").substring(0, 200)
            }
          } catch {}
        }

        results.push({
          node_name: "local",
          node_id: "local",
          source: "inbox",
          match: item.original_name ?? item.file,
          preview: preview.substring(0, 120).replace(/\n/g, " "),
          date: item.received_at,
        })
      }
    } catch {}
  }

  return results
}

/** Search local iMessage database (macOS only) */
function searchLocalImessage(query: string): SearchResult[] {
  const results: SearchResult[] = []
  try {
    const { execSync } = require("child_process")
    const dbPath = join(homedir(), "Library", "Messages", "chat.db")
    if (!existsSync(dbPath)) return []

    // SQLite query — search message text
    const q = query.replace(/'/g, "''").replace(/[%_\\]/g, (c) => "\\" + c)
    const sql = `SELECT m.text, m.date/1000000000 + 978307200 as unix_ts, h.id as handle
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE m.text LIKE '%${q}%' ESCAPE '\\\\'
      ORDER BY m.date DESC
      LIMIT 20`

    const output = execSync(`sqlite3 "${dbPath}"`, {
      input: sql,
      timeout: 10000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })

    for (const line of output.trim().split("\n")) {
      if (!line) continue
      const parts = line.split("|")
      const text = parts[0] ?? ""
      const ts = parts[1] ? new Date(Number(parts[1]) * 1000).toISOString() : undefined
      const handle = parts[2] ?? "unknown"

      results.push({
        node_name: "local",
        node_id: "local",
        source: "imessage",
        match: handle,
        preview: text.substring(0, 120).replace(/\n/g, " "),
        date: ts,
      })
    }
  } catch { /* not macOS, no access, or sqlite3 not available */ }

  return results
}

// ============================================================================
// Command
// ============================================================================

export const HiveSearchCommand = cmd({
  command: "search <query>",
  describe: "search files, messages, and iMessages across all Hive nodes",
  builder: (yargs) =>
    yargs
      .positional("query", { describe: "search term", type: "string", demandOption: true })
      .option("type", {
        describe: "search scope",
        type: "string",
        choices: SEARCH_TYPES,
        default: "all" as SearchType,
      })
      .option("mesh", { describe: "search ALL online nodes (not just local)", type: "boolean", default: true })
      .option("limit", { describe: "max results per source", type: "number", default: 10 })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    if (!argv.json) { UI.empty(); prompts.intro("◈  Hive Search") }

    const query = String(argv.query)
    const searchType = argv.type as SearchType
    const limit = argv.limit as number
    const sp = argv.json ? null : prompts.spinner()

    // Step 1: Search local machine
    sp?.start("Searching local node…")
    const localResults: SearchResult[] = []

    if (searchType === "all" || searchType === "inbox") {
      localResults.push(...searchLocalInbox(query).slice(0, limit))
    }
    if (searchType === "all" || searchType === "imessage") {
      localResults.push(...searchLocalImessage(query).slice(0, limit))
    }

    sp?.stop(`${localResults.length} local result(s)`)

    // Step 2: Search remote nodes (mesh mode)
    let remoteResults: SearchResult[] = []

    if (argv.mesh) {
      const token = await requireAuth()
      if (token) {
        const userId = await requireUserId(argv["user-id"] as number | undefined)
        if (userId) {
          sp?.start("Searching remote nodes…")

          try {
            const nodes = await fetchNodes(userId)
            const thisHostname = require("os").hostname()
            const remoteNodes = nodes.filter(
              (n) => n.connection_status === "online" && !n.name.includes(thisHostname),
            )

            if (remoteNodes.length > 0) {
              // Dispatch search tasks to all remote nodes
              const searchPromises = remoteNodes.map(async (node) => {
                try {
                  const res = await hiveFetch(`/api/v6/nodes/tasks`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      user_id: userId,
                      title: `hive search: "${query}"`,
                      type: "hive_search",
                      node_id: node.id,
                      prompt: query,
                      config: {
                        search_type: searchType,
                        limit,
                        sender_name: thisHostname,
                      },
                    }),
                  })

                  if (!res.ok) return []

                  const data = (await res.json()) as { task: { id: string } }
                  const taskId = data.task.id

                  // Poll for results (search should be fast — 15s max)
                  for (let i = 0; i < 10; i++) {
                    await new Promise((r) => setTimeout(r, 1500))
                    const pollRes = await hiveFetch(
                      `/api/v6/nodes/tasks/${taskId}?user_id=${userId}`,
                    )
                    if (!pollRes.ok) continue
                    const pollData = (await pollRes.json()) as { task: any }
                    const task = pollData.task

                    if (task.status === "completed" || task.status === "failed") {
                      // Parse search results from task output
                      try {
                        const output = task.result?.output ?? ""
                        const parsed = JSON.parse(output)
                        if (Array.isArray(parsed)) {
                          return parsed.map((r: any) => ({
                            ...r,
                            node_name: node.name,
                            node_id: node.id,
                          }))
                        }
                      } catch { /* output wasn't JSON — skip */ }
                      return []
                    }
                  }
                  return [] // timeout
                } catch {
                  return []
                }
              })

              const nodeResults = await Promise.allSettled(searchPromises)
              for (const r of nodeResults) {
                if (r.status === "fulfilled") {
                  remoteResults.push(...(r.value as SearchResult[]))
                }
              }
            }

            sp?.stop(`${remoteResults.length} remote result(s) from ${remoteNodes.length} node(s)`)
          } catch {
            sp?.stop("Remote search failed")
          }
        }
      }
    }

    // Step 3: Merge and display results
    const allResults = [...localResults, ...remoteResults]

    if (argv.json) {
      console.log(JSON.stringify(allResults, null, 2))
      return
    }

    if (allResults.length === 0) {
      console.log(dim(`  No results for "${query}"`))
      prompts.outro("Done")
      return
    }

    // Group by source
    const grouped: Record<string, SearchResult[]> = {}
    for (const r of allResults) {
      const key = r.source
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(r)
    }

    console.log()
    console.log(bold(`  ${allResults.length} result(s) for "${query}"`))
    console.log(dim("  " + "─".repeat(70)))

    for (const [source, results] of Object.entries(grouped)) {
      console.log()
      console.log(bold(`  ${source.toUpperCase()} (${results.length})`))

      for (const r of results.slice(0, limit)) {
        const node = r.node_name === "local" ? dim("local") : highlight(r.node_name)
        const age = r.date ? dim(timeAgo(r.date)) : ""
        console.log(`    ${node}  ${bold(r.match)}  ${age}`)
        if (r.preview) {
          console.log(`      ${dim(r.preview.substring(0, 80))}`)
        }
      }
    }

    console.log()
    prompts.outro("Done")
  },
})
