import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { requireAuth, requireUserId, dim, bold, success, highlight, writeJson } from "./iris-api"
import { hiveFetch, fetchNodes } from "./platform-hive-nodes"
import { detectLocalNodeId } from "./hive-tailscale"
import { existsSync, readFileSync, readdirSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir, hostname } from "os"
import { createRequire } from "module"
import { execSync } from "child_process"
import {
  searchRemoteNodes,
  searchNodeOnMesh,
  readRoster,
  writeRoster,
  formatReport,
  type ListedNode,
  type MeshRow,
  type NodeReport,
} from "../lib/hive-search-mesh"

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

/**
 * Whole-disk file search on THIS machine (#188665). The node daemon owns the implementation
 * (daemon/disk-search.js: fsearch → Spotlight → locate → a labelled home-folder scan); loading the
 * installed copy keeps one implementation instead of two that drift. A machine that is not a Hive
 * node has no copy, and is told how to become one rather than silently searching nothing.
 */
const DISK_SEARCH = join(homedir(), ".iris", "bridge", "daemon", "disk-search.js")

/** This machine's file-search engines, from the installed node's own module. */
export async function localProviders(modulePath = DISK_SEARCH): Promise<{ json: any } | { error: string }> {
  if (!existsSync(modulePath)) return { error: "this machine is not a Hive node — run `iris node install`" }
  try {
    const mod = createRequire(import.meta.url)(modulePath)
    if (typeof mod.listProviders !== "function") return { error: "this node's daemon predates search engines — run `iris node install` to update it" }
    return { json: mod.listProviders() }
  } catch (e: any) {
    return { error: `could not read this machine's engines: ${String(e?.message ?? e).slice(0, 120)}` }
  }
}

export async function searchLocalFiles(
  query: string,
  limit: number,
  modulePath = DISK_SEARCH,
  provider: string | null = null,
): Promise<{ rows: SearchResult[]; note?: string }> {
  if (!existsSync(modulePath)) {
    return { rows: [], note: "this machine is not a Hive node, so its disk was not searched — run `iris node install`" }
  }
  try {
    // This machine's owner may have turned file search off (#188665) — honour it here too.
    const policyPath = join(modulePath, "..", "file-search-policy.js")
    if (existsSync(policyPath)) {
      const policy = createRequire(import.meta.url)(policyPath).fileSearchPolicy()
      if (!policy.enabled) return { rows: [], note: `this machine: ${policy.reason}` }
    }
    // createRequire, not require: the CLI runs as an ES module, where a bare require is undefined.
    const mod = createRequire(import.meta.url)(modulePath)
    const r = await mod.searchDisk(query, { limit, provider })
    const rows: SearchResult[] = (r.rows ?? []).map((x: any) => ({ ...x, node_name: "local", node_id: "local" }))
    return { rows, note: r.note }
  } catch (e: any) {
    return { rows: [], note: `file search failed here: ${String(e?.message ?? e).slice(0, 120)}` }
  }
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

/**
 * One node through the cloud task queue (~3–4 s). null when it did not answer in 15 s.
 * The path every node took before the mesh lane, and still the fallback for any node the mesh
 * cannot serve.
 */
async function cloudSearchNode(
  userId: number,
  node: { id: string; name: string },
  query: string,
  searchType: SearchType,
  limit: number,
  signal?: AbortSignal,
): Promise<MeshRow[] | null> {
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
        config: { search_type: searchType, limit, sender_name: hostname() },
      }),
    })
    if (!res.ok) return null
    const taskId = ((await res.json()) as { task: { id: string } }).task.id
    // Poll at 150 ms, easing to 1 s, so a fast node answers in a fast command (#188696 O3).
    const deadline = Date.now() + 15_000
    for (let i = 0; Date.now() < deadline; i++) {
      if (signal?.aborted) return null
      await new Promise((r) => setTimeout(r, Math.min(150 * 1.3 ** i, 1000)))
      const pollRes = await hiveFetch(`/api/v6/nodes/tasks/${taskId}?user_id=${userId}`)
      if (!pollRes.ok) continue
      const task = ((await pollRes.json()) as { task: any }).task
      if (task.status === "completed" || task.status === "failed") {
        try {
          const parsed = JSON.parse(task.result?.output ?? "")
          if (Array.isArray(parsed)) return parsed
        } catch { /* output wasn't JSON */ }
        return []
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Where the mesh lane may ssh for a node — or null to use the cloud. Only a node this machine
 * already has an ssh binding for (~/.iris/hive-ssh.json, written by `iris hive fs` / `transcribe
 * --on` / `--host`), or one whose daemon advertises the direct route on its Tailscale address.
 * Anything else — e.g. a client's server on an old daemon — is never sent an ssh login attempt.
 */
export function meshTargetFor(
  n: ListedNode,
  cache: Record<string, { host?: string; user?: string }>,
): { host: string; user: string | null } | null {
  const c = cache[n.id]
  if (c?.host) return { host: c.host, user: c.user ?? null }
  const fs = n.bridge_capabilities?.file_search
  const ip = (n.tailscale_ip ?? "").trim()
  if (fs && fs.route === true && fs.available !== false && ip) return { host: ip, user: null }
  return null
}

function readSshBindings(): Record<string, { host?: string; user?: string }> {
  try {
    return JSON.parse(readFileSync(process.env.IRIS_HIVE_SSH_CACHE || join(homedir(), ".iris", "hive-ssh.json"), "utf-8"))
  } catch {
    return {}
  }
}

// ============================================================================
// Command
// ============================================================================

export const HiveSearchCommand = cmd({
  command: "search <query>",
  describe: "search files, messages, and iMessages across all Hive nodes",
  builder: (yargs) =>
    yargs
      .example('iris hive search "invoice march" --type files', "find a file on the disk of every machine you own")
      .example('iris hive search "dentist"', "files, the Hive inbox and iMessages, on every node")
      .positional("query", { describe: "search term", type: "string", demandOption: true })
      .option("type", {
        describe: "search scope — files = the whole disk on each node (fsearch or Spotlight on a Mac, locate or a home-folder scan on Linux)",
        type: "string",
        choices: SEARCH_TYPES,
        default: "all" as SearchType,
      })
      .option("mesh", { describe: "search ALL online nodes (not just local)", type: "boolean", default: true })
      .option("limit", { describe: "max results per source", type: "number", default: 10 })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("deadline", { describe: "files: stop waiting for any node after this many ms and report it as missed (default: wait for every node)", type: "number" })
      .option("timing", { describe: "print per-node lane, hits and time to stderr", type: "boolean", default: false }),
  async handler(argv) {
    const handlerStart = performance.now()
    if (!argv.json) { UI.empty(); prompts.intro("◈  Hive Search") }

    const query = String(argv.query)
    const searchType = argv.type as SearchType
    const limit = argv.limit as number
    const sp = argv.json ? null : prompts.spinner()

    // Step 1: dispatch to remote nodes FIRST and search this machine while they work. The
    // remote leg is ~1.5 s of network round trips and the local search is CPU and disk, so
    // running them one after the other paid for both (#188696 O3).
    let remoteResults: SearchResult[] = []
    let remoteNote: string | undefined
    let nodeReports: NodeReport[] = []
    const remoteDone = (async () => {

      // Files: each of your nodes is asked DIRECTLY over your Tailscale mesh where it can be
      // (ssh → the node daemon's loopback route), the cloud queue only for the rest (#188696 O3).
      if (argv.mesh && searchType === "files") {
        const token = await requireAuth()
        if (!token) return
        const userId = await requireUserId(argv["user-id"] as number | undefined)
        if (!userId) return
        const thisHostname = hostname()
        const nodesP = fetchNodes(userId) as Promise<ListedNode[]>
        nodesP.catch(() => {})
        const bindings = readSshBindings()
        const stop = new AbortController()
        try {
          const r = await searchRemoteNodes(userId, readRoster(userId), {
            nodes: nodesP,
            isLocal: async (list) => {
              const localId = await detectLocalNodeId(list).catch(() => null)
              return (n) => n.id === localId || n.name.includes(thisHostname)
            },
            target: async (n) => meshTargetFor(n, bindings),
            mesh: (t) => searchNodeOnMesh(t, query, limit),
            cloud: (n) => cloudSearchNode(userId, n, query, searchType, limit, stop.signal),
            deadlineMs: Number(argv.deadline) > 0 ? Math.max(0, Number(argv.deadline) - (performance.now() - handlerStart)) : undefined,
            onDeadline: () => stop.abort(),
          })
          remoteResults = r.rows as SearchResult[]
          nodeReports = r.reports
          if (r.roster) writeRoster(r.roster)
          const answered = r.reports.filter((x) => x.lane === "mesh" || x.lane === "cloud").length
          remoteNote = `${remoteResults.length} remote result(s) from ${answered}/${r.reports.length} node(s)`
        } catch (e: any) {
          remoteNote = `Remote search failed: ${String(e?.message ?? e).slice(0, 120)}`
        }
        return
      }

      if (argv.mesh) {
        const token = await requireAuth()
        if (token) {
          const userId = await requireUserId(argv["user-id"] as number | undefined)
          if (userId) {

            try {
              const nodes = await fetchNodes(userId)
              const thisHostname = hostname()
              // THIS machine is already searched above as "local". Excluding it by hostname
              // missed: node "Alexs-MacBook-Pro-11711" on host "Alexs-MacBook-Pro-3" (macOS renames
              // on mDNS collisions), so this Mac was dispatched a task and searched twice.
              // The daemon knows its own id; the hostname check stays as the fallback.
              const localNodeId = await detectLocalNodeId(nodes).catch(() => null)
              const remoteNodes = nodes.filter(
                (n) => n.connection_status === "online" && n.id !== localNodeId && !n.name.includes(thisHostname),
              )

              if (remoteNodes.length > 0) {
                // Dispatch search tasks to all remote nodes
                const searchPromises = remoteNodes.map(async (node) => {
                  const rows = await cloudSearchNode(userId, node, query, searchType, limit)
                  return (rows ?? []).map((r: any) => ({ ...r, node_name: node.name, node_id: node.id }))
                })

                const nodeResults = await Promise.allSettled(searchPromises)
                for (const r of nodeResults) {
                  if (r.status === "fulfilled") {
                    remoteResults.push(...(r.value as SearchResult[]))
                  }
                }
              }

              remoteNote = `${remoteResults.length} remote result(s) from ${remoteNodes.length} node(s)`
            } catch {
              remoteNote = "Remote search failed"
            }
          }
        }
      }

    })()

    // Step 2: Search local machine (while the remote tasks run)
    sp?.start(argv.mesh ? "Searching this machine and your other nodes…" : "Searching local node…")
    const localResults: SearchResult[] = []
    let localFilesNote: string | undefined

    if (searchType === "all" || searchType === "inbox") {
      localResults.push(...searchLocalInbox(query).slice(0, limit))
    }
    if (searchType === "all" || searchType === "imessage") {
      localResults.push(...searchLocalImessage(query).slice(0, limit))
    }

    if (searchType === "all" || searchType === "files") {
      const disk = await searchLocalFiles(query, limit)
      localResults.push(...disk.rows)
      localFilesNote = disk.note
    }

    await remoteDone
    sp?.stop(`${localResults.length} local result(s)` + (remoteNote ? ` · ${remoteNote}` : ""))

    // Step 3: Merge and display results
    const allResults = [...localResults, ...remoteResults]
    const handlerMs = Math.round(performance.now() - handlerStart)
    if (argv.timing) {
      const nodes = new Set(allResults.filter((r) => r.source === "files" && !r.match.startsWith("(")).map((r) => r.node_name))
      process.stderr.write(`[timing] handler ${handlerMs} ms · local ${localResults.length} result(s) · machines with file hits: ${nodes.size}\n`)
      for (const r of nodeReports) process.stderr.write(`[timing]   ${formatReport(r)}\n`)
    }

    if (argv.json) {
      await writeJson(allResults)
      return
    }

    if (allResults.length === 0) {
      console.log(dim(`  No results for "${query}"`))
      for (const r of nodeReports) console.log(dim(`    ${formatReport(r)}`))
      if (localFilesNote) console.log(dim(`  ${localFilesNote}`))
      prompts.outro(`Done in ${handlerMs} ms`)
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

      // Files come back `limit` per node, so cap the group per node too, not in total.
      const cap = source === "files" ? limit * Math.max(1, new Set(results.map((r) => r.node_name)).size) : limit
      for (const r of results.slice(0, cap)) {
        const node = r.node_name === "local" ? dim("local") : highlight(r.node_name)
        const age = r.date ? dim(timeAgo(r.date)) : ""
        console.log(`    ${node}  ${bold(r.match)}  ${age}`)
        if (r.preview) {
          console.log(`      ${dim(r.preview.substring(0, 80))}`)
        }
      }
    }

    console.log()
    if (nodeReports.length) {
      console.log(bold("  NODES"))
      for (const r of nodeReports) console.log(dim(`    ${formatReport(r)}`))
    }
    if (localFilesNote) console.log(dim(`\n  ${localFilesNote}`))
    prompts.outro(`Done in ${handlerMs} ms`)
  },
})
