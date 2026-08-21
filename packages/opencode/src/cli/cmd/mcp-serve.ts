import { cmd } from "./cmd"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { getRegistry, CATEGORIES, COMMAND_CATEGORY_MAP } from "./command-groups"
import {
  loadPlaybooks,
  toolsFor,
  resourcesFor,
  readPlaybookResource,
  callPlaybookTool,
  PLAYBOOK_URI_PREFIX,
  TOOL_PREFIX,
} from "./mcp-playbooks"
import { homedir } from "os"
import { join } from "path"
import { readFileSync, existsSync } from "fs"
import { spill } from "./mcp-overflow"

// A bare "{" string literal silently breaks `script/build-capabilities.ts`: its block
// reader brace-MATCHES `cmd({ ... })` without skipping string literals, so one unmatched
// brace leaves the block unterminated, readBlock returns null, and the whole command drops
// out of the capability index. That is exactly how `mcp serve` went missing — the index
// still listed it, the scan no longer produced it, and the pre-push gate caught it.
// Writing the brace as a slice of a BALANCED pair keeps the counter honest.
const JSON_OPEN = "{}".slice(0, 1)

const IRIS_BIN = join(homedir(), ".iris", "bin", "iris")
const HOWTO_DIR = join(homedir(), ".iris", "how-to")
const MAX_OUTPUT = 100 * 1024 // 100KB
const TIMEOUT_MS = 30_000

// ── Local bridge auth (#145946) ───────────────────────────────────────────
// The hive_* tools proxy through the local daemon bridge, which gates every
// request on an `x-bridge-key` header. The MCP server is spawned without the
// secret in its env, and the bridge rotates its token on restart — so we read
// the live key from disk at call time (never cached stale) and retry once on 401.
const IRIS_DIR = join(homedir(), ".iris")
function readBridgeKey(): string | null {
  // Preferred: the rotating token file written by the daemon on (re)start.
  const tokenFile = join(IRIS_DIR, "bridge-token")
  if (existsSync(tokenFile)) {
    const t = readFileSync(tokenFile, "utf-8").trim()
    if (t) return t
  }
  // Fallback: the configured static key in the bridge config.
  const cfgFile = join(IRIS_DIR, "bridge", ".bridge-config.json")
  if (existsSync(cfgFile)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgFile, "utf-8"))
      const k = cfg?.auth?.apiKey
      if (typeof k === "string" && k) return k
    } catch {}
  }
  // Last resort: explicit env override.
  return process.env.IRIS_BRIDGE_KEY?.trim() || null
}

// fetch() wrapper that injects the live bridge key and re-reads + retries once on 401.
async function bridgeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const withKey = (key: string | null): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...(key ? { "x-bridge-key": key } : {}) },
    signal: init.signal ?? AbortSignal.timeout(5000),
  })
  let res = await fetch(url, withKey(readBridgeKey()))
  if (res.status === 401) {
    // Token likely rotated since process start — re-read from disk and retry once.
    res = await fetch(url, withKey(readBridgeKey()))
  }
  return res
}

// Normalized error text for a failed bridge response (#145951: consistent shape).
function bridgeErr(res: Response): string {
  if (res.status === 401)
    return "Bridge error: Unauthorized — the local daemon bridge rejected the key. Ensure the iris daemon is running (the key in ~/.iris/bridge-token rotates on restart)."
  return `Bridge error: ${res.status} ${res.statusText}`
}

// Known commands from the registry (populated at startup)
let knownCommands: Set<string> = new Set()

function buildCommandCatalog(): string {
  const commands = getRegistry()
  knownCommands = new Set(commands.flatMap((c) => [c.name, ...c.aliases]))

  const grouped: Record<string, typeof commands> = {}
  for (const cmd of commands) {
    const catKey = COMMAND_CATEGORY_MAP[cmd.name] ?? "core"
    if (!grouped[catKey]) grouped[catKey] = []
    grouped[catKey].push(cmd)
  }

  const lines: string[] = ["# IRIS CLI Command Catalog\n"]
  const sortedCats = Object.entries(CATEGORIES).sort(([, a], [, b]) => a.order - b.order)

  for (const [key, cat] of sortedCats) {
    const cmds = grouped[key]
    if (!cmds || cmds.length === 0) continue
    lines.push(`## ${cat.name}`)
    lines.push(`${cat.description}\n`)
    for (const c of cmds) {
      const aliases = c.aliases.length > 0 ? ` (${c.aliases.join(", ")})` : ""
      lines.push(`- **${c.name}**${aliases}: ${c.describe}`)
    }
    lines.push("")
  }

  lines.push(`\n${commands.length} commands across ${sortedCats.length} categories`)
  return lines.join("\n")
}

function buildGuide(): string {
  return `# IRIS CLI Guide

## Install
If \`iris\` is not found on this system, install it first:
\`\`\`bash
curl -fsSL https://heyiris.io/install-code | bash
\`\`\`

## Authenticate
\`\`\`bash
iris auth login
\`\`\`
Or set the \`IRIS_API_KEY\` environment variable.

## Usage Pattern
\`\`\`
iris <category> <action> [args] --json
\`\`\`
Most commands support \`--json\` for structured output. Use \`iris <command> --help\` for details.

## Key Categories
- **CRM**: \`iris leads\`, \`iris outreach\`, \`iris deals\`, \`iris invoices\`
- **Knowledge**: \`iris bloqs\`, \`iris memory\`, \`iris how-to\`
- **Pages**: \`iris pages\`, \`iris partials\`, \`iris copycat\`
- **Agents**: \`iris agents\`, \`iris chat\`, \`iris schedules\`, \`iris workflows\`
- **Integrations**: \`iris integrations\`, \`iris connect\`, \`iris n8n\`
- **Entities**: \`iris brands\`, \`iris products\`, \`iris services\`, \`iris events\`
- **Communication**: \`iris mail\`, \`iris imessage\`, \`iris phone\`, \`iris calendar\`
- **Hive**: \`iris hive\`, \`iris app\`

## Examples
\`\`\`bash
# Search leads
iris leads list --search "acme" --json

# Add a note to a lead
iris leads note 12345 "Spoke with CEO, interested in Q3"

# Apply an outreach strategy to a lead (per-lead steps live under \`outreach-send\`)
iris outreach apply 38 17 12345 --json

# List bloqs (knowledge bases)
iris bloqs list --json

# Chat with an agent
iris chat --agent 11 "summarize today's tasks"

# View schedules
iris schedules list --json
\`\`\`

## Tips
- Add \`--json\` to any command for structured output
- Use \`iris <command> --help\` to see all flags
- Commands run non-interactively when \`IRIS_NON_INTERACTIVE=1\` is set
`
}

async function loadRecipes(): Promise<string> {
  const fs = await import("fs")
  if (!fs.existsSync(HOWTO_DIR)) return "No recipes found. Create one with: `iris how-to add`"

  const files = fs.readdirSync(HOWTO_DIR).filter((f: string) => f.endsWith(".md")).sort()
  if (files.length === 0) return "No recipes found. Create one with: `iris how-to add`"

  const sections: string[] = ["# IRIS How-To Recipes\n"]
  for (const f of files) {
    const content = fs.readFileSync(join(HOWTO_DIR, f), "utf-8")
    sections.push(content)
    sections.push("---\n")
  }
  sections.push(`${files.length} recipe(s)`)
  return sections.join("\n")
}

// Pull board-item IDs out of an agent's PROSE. This is a heuristic over free text,
// not structural provenance — it reports what the agent SAID it used, which is not
// the same as what it retrieved. The tool description and the response banner both
// say so; do not let a caller mistake this for a verified source list.
//
// 4-digit floor is deliberate: agent IDs (#642) and bloq IDs (#532) are 3 digits and
// would otherwise be reported as cited items. It also keeps years and small figures out.
export function extractCitedIds(response: string): string[] {
  const matches = response.match(/(?:BloqItem[_#]?|#|item\s+#?)(\d{4,})/gi) ?? []
  return Array.from(
    new Set(matches.map((m) => (m.match(/(\d{4,})/) ?? [])[1]).filter(Boolean) as string[]),
  )
}

/**
 * Pull the first JSON value out of a model's reply.
 *
 * Models wrap JSON in prose and code fences no matter how firmly you ask them not to, so
 * the caller gets a parse error for an answer that was actually correct. Strip fences,
 * then brace-match from the first { or [ — a plain indexOf/lastIndexOf pair breaks the
 * moment the payload contains a nested object followed by trailing prose.
 */
export function extractJson(text: string): unknown | undefined {
  if (!text) return undefined
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : text
  const start = body.search(/[[{]/)
  if (start < 0) return undefined
  const open = body[start]
  const close = open === "{" ? "}" : "]"
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < body.length; i++) {
    const c = body[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === "\\") esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/**
 * Structural check against the useful subset of JSON Schema: type, properties, required,
 * items, enum. Returns PATH-QUALIFIED errors rather than a boolean, because "invalid" is
 * useless to a model being asked to try again — it needs to know which field and why.
 *
 * Deliberately NOT a full JSON Schema implementation. It is honest about that: unknown
 * keywords are ignored rather than silently treated as satisfied-by-default in a way that
 * would let a wrong shape through while claiming validation happened.
 */
export function validateAgainstSchema(value: unknown, schema: any, path = "$"): string[] {
  if (!schema || typeof schema !== "object") return []
  const errs: string[] = []
  const t = schema.type as string | undefined

  const typeOf = (v: unknown): string =>
    v === null ? "null" : Array.isArray(v) ? "array" : typeof v

  if (t) {
    const actual = typeOf(value)
    const ok =
      t === actual ||
      (t === "integer" && actual === "number" && Number.isInteger(value as number))
    if (!ok) return [`${path}: expected ${t}, got ${actual}`]
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    errs.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`)
  }

  if (t === "object" || (!t && value && typeof value === "object" && !Array.isArray(value))) {
    const obj = (value ?? {}) as Record<string, unknown>
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in obj)) errs.push(`${path}.${req}: required field missing`)
    }
    for (const [k, sub] of Object.entries((schema.properties as Record<string, any>) ?? {})) {
      if (k in obj) errs.push(...validateAgainstSchema(obj[k], sub, `${path}.${k}`))
    }
  }

  if (t === "array" && schema.items) {
    ;(value as unknown[]).forEach((el, i) =>
      errs.push(...validateAgainstSchema(el, schema.items, `${path}[${i}]`)),
    )
  }

  return errs
}

export type Provenance = {
  retrieved_item_ids: string[]
  retrieval_bloq_id: number | null
  document_count: number | null
  tool_calls: { tool: string; status?: string }[]
  thread_id: string | null
  history_messages: number | null
}

/**
 * Derive REAL provenance from the run trace (`iris chat -V`).
 *
 * This is the structural counterpart to `cited_ids`. `cited_ids` is pattern-matched out of
 * the model's prose and proves only that it SAID something; this reads what the ReAct loop
 * actually injected and called:
 *   memory_injection "context: rag_context"          -> data.sources (the documents retrieved)
 *   memory_injection "context: conversation_history" -> thread id + message count
 *   tool_call / tool_result                          -> what actually ran
 *
 * Trace shape is treated as untrusted: every field is probed, never assumed, so a change
 * upstream degrades to an empty provenance rather than throwing inside a tool call.
 */
export function extractProvenance(trace: unknown): Provenance {
  const out: Provenance = {
    retrieved_item_ids: [],
    retrieval_bloq_id: null,
    document_count: null,
    tool_calls: [],
    thread_id: null,
    history_messages: null,
  }
  if (!Array.isArray(trace)) return out

  const ids = new Set<string>()
  const statusByTool = new Map<string, string>()

  for (const ev of trace) {
    if (!ev || typeof ev !== "object") continue
    const e = ev as Record<string, any>
    const data = (e.data ?? {}) as Record<string, any>
    const label = typeof e.label === "string" ? e.label : ""

    if (e.type === "memory_injection" && label.includes("rag_context")) {
      if (typeof data.bloq_id === "number") out.retrieval_bloq_id = data.bloq_id
      if (typeof data.document_count === "number") out.document_count = data.document_count
      for (const src of Array.isArray(data.sources) ? data.sources : []) {
        const m = String(src).match(/BloqItem[_#]?(\d+)/)
        if (m) ids.add(m[1])
      }
    }

    if (e.type === "memory_injection" && label.includes("conversation_history")) {
      if (typeof data.thread_id === "string") out.thread_id = data.thread_id
      if (typeof data.message_count === "number") out.history_messages = data.message_count
    }

    // Labels are decorated with arrows ("→ ToolName" / "← ToolName"); strip them so a call
    // and its result collapse onto one entry instead of appearing as two different tools.
    if (e.type === "tool_call") {
      const tool = label.replace(/^[^A-Za-z0-9_]*/, "").trim()
      if (tool) out.tool_calls.push({ tool })
    }
    if (e.type === "tool_result") {
      const tool = label.replace(/^[^A-Za-z0-9_]*/, "").trim()
      if (tool && typeof data.status === "string") statusByTool.set(tool, data.status)
    }
  }

  for (const c of out.tool_calls) {
    const st = statusByTool.get(c.tool)
    if (st) c.status = st
  }
  out.retrieved_item_ids = [...ids]
  return out
}

export function validateCommand(command: string): { args: string[]; error?: string } {
  const trimmed = command.trim()
  if (!trimmed) return { args: [], error: "Empty command" }

  // Parse respecting quoted strings
  const args: string[] = []
  let current = ""
  let inQuote: string | null = null

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch
    } else if (ch === " " || ch === "\t") {
      if (current) {
        args.push(current)
        current = ""
      }
    } else {
      current += ch
    }
  }
  if (current) args.push(current)

  if (args.length === 0) return { args: [], error: "Empty command" }

  // Args go straight to Bun.spawn([IRIS_BIN, ...args]) — an argv array, NEVER
  // `sh -c` — so no shell ever interprets them. Shell metacharacters (; | ` & $
  // < > \ and newlines) are therefore inert literals here. Blocking them added
  // no real security (an agent can run destructive commands with no metacharacter,
  // and this can't protect a downstream command that shells its own args) while it
  // broke legitimate content: multi-line agent system prompts, notes like
  // "do X; then Y", etc. — the MCP was rejecting valid `agents create --prompt`.
  // The only guard we keep is against a NUL byte, which can truncate an argv
  // string at the syscall boundary.
  for (const arg of args) {
    if (arg.includes("\0")) {
      return { args: [], error: `Rejected: NUL byte in argument.` }
    }
  }

  // Models write the FULL command line, binary and all: "iris bloqs list --json".
  // The MCP spawns IRIS_BIN directly with this argv, so a leading "iris" lands as
  // argv[0] — a command name that does not exist — and the call fails with
  // `Unknown command "iris"`. Observed in production on 2026-08-17: the model was
  // asked to fetch projects, wrote the command exactly as a human would type it,
  // and was told its own CLI had no such command. It then apologised and claimed it
  // could not access the platform, which is a lie the tool taught it to tell.
  //
  // Accept both forms. Expecting every model to remember that this one interface
  // wants the binary name omitted is a convention we would have to re-teach with
  // every model swap, and today we swapped models three times.
  if (args.length > 1 && (args[0] === "iris" || args[0] === "iris-cli")) {
    args.shift()
  }

  // Validate first arg is a known command
  const firstArg = args[0]
  // Allow meta-commands that aren't in the registry
  if (firstArg === "help" || firstArg === "--help" || firstArg === "version" || firstArg === "--version") {
    return { args }
  }
  if (knownCommands.size > 0 && !knownCommands.has(firstArg)) {
    return { args: [], error: `Unknown command "${firstArg}". Use iris_help to discover available commands, or read the iris://commands resource.` }
  }
  // Rewrite alias to canonical command name so yargs resolves it
  const registry = getRegistry()
  const aliasMatch = registry.find((c) => c.aliases.includes(firstArg))
  if (aliasMatch) {
    args[0] = aliasMatch.name
  }

  return { args }
}

async function execIris(args: string[], timeoutMs: number = TIMEOUT_MS): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Don't auto-append --json — not all commands support it, and yargs strict
  // mode rejects unknown flags (e.g. `leads delete 123 --json` shows help text).
  // The tool description tells agents to use --json when they want structured output.
  const proc = Bun.spawn([IRIS_BIN, ...args], {
    env: { ...process.env, IRIS_NON_INTERACTIVE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })

  const timer = setTimeout(() => proc.kill(), timeoutMs)

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited

    clearTimeout(timer)

    // Oversized output is SPILLED to disk with an outline, not sliced.
    //
    // Slicing a JSON payload mid-object produces something no one can parse, so the
    // model loses the data and every route back to it. Worse, it reads as a failure:
    // on 2026-08-17 a 68KB `bloqs get 544 --json` came back truncated and the agent
    // told the user it could not access the platform. spill() writes the whole thing,
    // returns a map of its shape, and says plainly that the command SUCCEEDED.
    //
    // Truncation remains the fallback for when the spool cannot be written — a
    // degraded answer beats no answer.
    const overflow = (raw: string): string => {
      if (raw.length <= MAX_OUTPUT) return raw
      const guidance = spill(raw, args.join(" "))
      return guidance ?? raw.slice(0, MAX_OUTPUT) + "\n...(truncated — could not write spool file)"
    }

    return {
      stdout: overflow(stdout),
      stderr: overflow(stderr),
      exitCode,
    }
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

export const McpServeCommand = cmd({
  command: "serve",
  describe: "start IRIS MCP gateway server (stdio, or streamable HTTP with --http)",
  builder: (yargs) =>
    yargs
      .epilogue(
        [
          "Exposes IRIS to an external orchestrator (Claude Code, Codex, Cursor, ...) as MCP tools.",
          "",
          "TOOLS:",
          "  iris_run      run any IRIS CLI command; add --json for structured output",
          "  iris_help     per-command flags and subcommands",
          "  iris_agent    consult or configure a standing IRIS agent",
          "                list | ask | get | create | update | delete",
          "                ask takes an optional JSON `schema` -> a validated object, not prose",
          "  iris_memory   read/write the Atlas — boards, lists, items",
          "                search | boards | get | items | add | update",
          "  hive_*        inspect and drive Hive tmux sessions (needs the local daemon)",
          "  playbook_*    one typed tool per executable playbook (--no-playbooks to omit)",
          "",
          "RESOURCES:  iris://guide  iris://commands  iris://recipes",
          "",
          "A schema is prompt-enforced, not API-enforced, and an agent given a required shape",
          "will INVENT values to fill it — measured: a required enum produced a confident answer",
          "about a term sheet that does not exist. So a schema'd ask also offers the agent",
          "{\"_unavailable\":\"reason\"}, and a decline is reported as a decline, not a failure.",
          "",
          "Prefer iris_agent over `iris_run chat ...` and iris_memory over `iris_run bloqs ...`:",
          "both carry guard rails that a raw command string does not — an agent that answered",
          "without querying anything is flagged, cited item IDs are marked unverified, and a",
          "write that would change nothing is refused rather than reported as success.",
          "",
          "Register it with:  iris mcp install",
        ].join("\n"),
      )
      .option("playbooks", {
        type: "boolean",
        default: true,
        describe: "expose playbooks as typed tools + readable resources",
      })
      .option("http", {
        type: "boolean",
        default: false,
        describe: "serve streamable HTTP on loopback instead of stdio",
      })
      .option("port", { type: "number", default: 3210, describe: "port for --http" })
      .option("token", {
        type: "string",
        describe: "bearer token for --http (generated and printed if omitted)",
      })
      .option("stateful", {
        type: "boolean",
        default: false,
        describe: "keep MCP session state (blocks serverless/edge and horizontal scaling)",
      }),
  async handler(argv) {
    // Build registry so knownCommands is populated
    buildCommandCatalog()

    const playbooksEnabled = argv.playbooks !== false

    const server = new Server(
      { name: "IRIS OS", version: "1.0.0" },
      { capabilities: { resources: {}, tools: {} } },
    )

    // --- Resources ---

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        { uri: "iris://guide", name: "IRIS CLI Guide", description: "Install, authenticate, and use the IRIS CLI", mimeType: "text/markdown" },
        { uri: "iris://commands", name: "Command Catalog", description: "Full catalog of 120+ IRIS CLI commands grouped by category", mimeType: "text/markdown" },
        { uri: "iris://recipes", name: "How-To Recipes", description: "User-created workflow recipes from ~/.iris/how-to/", mimeType: "text/markdown" },
        // Every playbook is readable, whether or not it can be run. Most are
        // written procedures with no steps at all — that IS the artefact.
        ...(playbooksEnabled ? resourcesFor(await loadPlaybooks()) : []),
      ],
    }))

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params
      if (playbooksEnabled && uri.startsWith(PLAYBOOK_URI_PREFIX)) {
        const name = uri.slice(PLAYBOOK_URI_PREFIX.length)
        return { contents: [{ uri, mimeType: "text/markdown", text: await readPlaybookResource(name) }] }
      }
      switch (uri) {
        case "iris://guide":
          return { contents: [{ uri, mimeType: "text/markdown", text: buildGuide() }] }
        case "iris://commands":
          return { contents: [{ uri, mimeType: "text/markdown", text: buildCommandCatalog() }] }
        case "iris://recipes":
          return { contents: [{ uri, mimeType: "text/markdown", text: await loadRecipes() }] }
        default:
          throw new Error(`Unknown resource: ${uri}`)
      }
    })

    // --- Tools ---

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "iris_run",
          description: `Execute any IRIS CLI command. Add --json for structured output on list/get commands. Omit --json for action commands (create, update, close). Use iris_help to discover subcommands for any domain.

FINDING THINGS — READ THIS BEFORE ANSWERING ANY "what/which ... do I have" QUESTION.

'bloqs list' is RECENCY-ORDERED AND TRUNCATED. It is not an inventory. Answering a
question about WHICH things the user has by reading names out of 'bloqs list' will
silently miss anything older than the first page, and you will not be able to tell
that you missed it — the list looks complete.

Measured example: asked for "family projects", inferring from 'bloqs list' returns
"Mia Mayo — Life Atlas" and stops. 'bloqs search family' returns bloq #200 "Family
Businesses" and bloq #137 "Family Health and Finance Management Workflow" — neither
of which appears anywhere in 'bloqs list'. The list-only answer is not partial, it is
wrong.

So:
- To find things BY TOPIC, CATEGORY OR KEYWORD: use 'bloqs search <term> --json'.
  Search covers board names, item titles AND item content across every board.
- Use 'bloqs list' only to enumerate the most recent boards, or when the user has
  already named the one they mean.
- To answer "are there others?": run a SEARCH or re-read the full list. Do not fetch
  the contents of a board you already found — 'bloqs get <id>' returns what is INSIDE
  that board, which cannot tell you about other boards.
- Never answer a "which do I have" question from memory of an earlier tool result in
  the same conversation. Run the query.

If a result is too large it is saved to a file and you are given an outline — that is
a SUCCESS, not a failure. Prefer re-running something narrower (a specific id, or
--limit) over reading the whole file.

Common commands and their subcommands:
- leads: list, get, create, update, delete, search, note, notes, pulse, pulse-all, payment-gate, gate-all, update-gate, replied, merge, enrich, stats
- bug: report (aliases: submit, new), list (alias: ls), show, close (aliases: done, resolve, complete), update, verify — NO delete command, use close
- bloqs: list, get, create, update, search, items, add-item, update-item, create-list, rename-list, delete-list, invite, contributors
- pages: list, get, create, set, push, pull, diff, publish, unpublish, versions, rollback, visibility, share, preview
- agents: list, get, create, update, delete, chat, message, thread, inbox, assign
- outreach: list <bloq-id>, show <bloq-id> <id>, create, update, delete, apply, approve  (campaigns live under outreach-campaign; per-lead steps under outreach-send)
- brands: list, show, create, update, delete, personas, design-tokens (alias: dt), glossary, treatments
- invoices: list, show, create, send, checkout, mark-paid, subscribe
- schedules: list, get, create, update, delete, run, inspect, diagnose, toggle, history, approvals
- integrations: list-connected, list-available, list-integrations, list-tools, connect, exec, setup
- workflows: list, get, create, update, delete, run, status, runs, pull, push, diff
- memory: ALIAS for bloqs (list, show, add, compose, search, items) — there is no separate memory store; store facts as bloq items
- mail: accounts, read, send, search
- imessage: read, send, search
- partials: list, get, create, set, push, pull, usage, view
- hive: nodes (list|show), tasks (list|show), campaigns, run <node> "<cmd>"
- n8n: list, pull, push, patch, diff, activate, deactivate, dispatch, validate, restore

Examples: 'leads list --search acme --json', 'bug close 12345', 'pages get my-page --json'`,
          inputSchema: {
            type: "object" as const,
            properties: {
              command: { type: "string", description: "The iris command and arguments (without the 'iris' prefix). Example: 'leads list --limit 5'" },
            },
            required: ["command"],
          },
        },
        {
          name: "iris_help",
          description: "Get detailed help for a specific IRIS CLI command, including all available flags and subcommands.",
          inputSchema: {
            type: "object" as const,
            properties: {
              command: { type: "string", description: "The command to get help for (without 'iris' prefix). Example: 'leads'" },
            },
            required: ["command"],
          },
        },
        {
          name: "hive_sessions",
          description: "List all active tmux sessions managed by IRIS Hive. Shows session names, pane counts, and task metadata.",
          inputSchema: {
            type: "object" as const,
            properties: {},
          },
        },
        {
          name: "hive_panes",
          description: "Get status and recent output from a Hive tmux session's panes. Use this to monitor what agents in a swarm are doing.",
          inputSchema: {
            type: "object" as const,
            properties: {
              session: { type: "string", description: "Session name (e.g. iris-swarm-abc12345)" },
              lines: { type: "number", description: "Lines of output per pane (default: 20)" },
            },
            required: ["session"],
          },
        },
        {
          name: "hive_send_input",
          description: "Send text input to a specific pane in a running Hive tmux session. Use this for agent-to-agent communication.",
          inputSchema: {
            type: "object" as const,
            properties: {
              session: { type: "string", description: "Session name" },
              pane: { type: "number", description: "Pane index (0-based)" },
              text: { type: "string", description: "Text to send (Enter is appended automatically)" },
            },
            required: ["session", "pane", "text"],
          },
        },
        {
          name: "iris_agent",
          description: `Consult a standing IRIS agent. Use this BEFORE answering any question about
THIS USER'S own business, money, clients, projects or history from inference.

WHY THIS EXISTS. You are a general coding copilot: you can reason, but you do not know
what is true about this user's company. IRIS agents do. Each one is a persistent identity
with retrieval over the user's own boards (revenue records, client history, case files,
governance decisions). They are not better at reasoning than you — they are grounded, and
you are not. Delegate the question "what is actually true here", never "write this code".

Measured example (2026-08-20). Agent #642 "TOBI" was asked a deliberately false-premise
question: "Remind me, our goal is 2 million dollars a year, right?" It answered "No, our
goal is actually $2 million per month, not per year", and cited the board item it came
from. A copilot answering that from the conversation would have agreed with the premise
and been wrong about the user's single most important number.

So:
- action:"list" FIRST to see who exists and what each one owns. Pass \`query\` to filter
  by name/description (e.g. "finance", "pathways"). Agent IDs are stable — reuse them.
- action:"ask" to put a question to one agent. Returns the agent's answer plus the run
  envelope (iterations, tools the agent invoked, elapsed_ms).

READING THE RESULT — this matters:
- \`response\` is prose written by a model. Treat it as a sourced claim, not as a fact.
- \`provenance\` is STRUCTURAL — read from the run's own trace, not from the prose:
    retrieved_item_ids  the records actually pulled into context this turn
    retrieval_bloq_id   which board they came from
    tool_calls          what actually ran, with each call's status
    thread_id / history_messages   the conversation this turn was appended to
  This is the trustworthy half. If a figure matters, check it appears in retrieved_item_ids.
- \`cited_ids\` is pattern-matched from the prose. It tells you what the agent SAID it used,
  which is not the same thing and never has been.
- \`cited_not_retrieved\` is the cross-check between them: IDs the agent named that it did
  NOT read this turn. Not automatically fabrication — conversation history is also loaded,
  so it may be a real recall from earlier — but it is the line between "it read this" and
  "it said this". Verify with iris_memory {action:"items", bloq:<id>} before relying on it.
- \`tools_used\` empty means nothing was queried live; the answer came from retrieval context
  or model priors.
- ⚠️ ASK IS NOT A CLEAN ROOM. Each agent has ONE ongoing thread per user, and prior messages
  are loaded into every turn — including calls made by other sessions and by the user
  directly. An answer can be shaped by context you cannot see. For a decision that must not
  inherit anything, put the full premise in \`message\` rather than assuming a blank slate.
- An agent that says it cannot retrieve something is CORRECT behaviour, not a failure.
  Do not re-ask the question in a way that pressures it into inventing a number.

STRUCTURED OUTPUT — pass \`schema\` on action:"ask" to get a validated object instead of prose:

  iris_agent {action:"ask", agent:642, message:"...", schema:{
    type:"object", required:["mrr","source"],
    properties:{ mrr:{type:"number"}, source:{type:"string"} }}}

The result gains \`structured: {valid, data, errors, attempts}\`, and \`isError\` is true when
the schema is not satisfied. A malformed first reply is retried ONCE with the specific
validation errors fed back; \`attempts:2\` on a valid result means the first try was malformed,
which is worth knowing if you are measuring an agent's reliability.

⚠️ This is PROMPT-ENFORCED, not API-enforced. \`iris chat\` has no schema flag, so the shape is
requested in the message and checked here. \`valid:true\` means what came back satisfied the
schema — NOT that the model was constrained to produce it. Validation covers the useful subset
of JSON Schema (type, properties, required, items, enum); unknown keywords are ignored rather
than treated as satisfied. Do not read it as a guarantee.

Ask for a schema when you need a NUMBER OR A DECISION you will branch on. Do not wrap a
narrative answer in one — you will get a model padding fields to satisfy a shape, which is a
worse answer wearing better clothes.

COST + LATENCY: each ask is a real model turn (seconds, and it bills). Ask one good
question rather than iterating. Default timeout 120s; raise it with \`timeout\` for
agents that do multi-step retrieval.

WRITES: agents can take real actions. Anything outward or irreversible comes back with
requires_approval=true rather than executing — surface that to the user, do not retry
around it.

═══ CONFIGURING AGENTS (get / create / update / delete) ═══

action:"get" returns a COMPACT config summary — model, tool allowlist, RAG bloq scope,
heartbeat, and prompt sizes. Pass full:true for the raw record (large: the system prompt is
stored twice, so expect 10KB+). Read the compact form first; it holds every lever.

THE TOOL ALLOWLIST IS THE MAIN LEVER, NOT THE PROMPT. This is measured, not theory:
- An agent with an EMPTY allowlist gets the FULL tool set (backward compatibility). That is
  not "unrestricted but fine" — on 2026-07-05 an unscoped finance agent reached into a
  HEALTHCARE CLIENT's integration tools and reported $2.9M of medical case data as "our
  revenue." Scoping it to a finance keep-set fixed that instantly and permanently.
- The same session tried to fix two other behaviours with charter prose and few-shot
  examples. Both were IGNORED run after run. Only the structural allowlist change held.
So when an agent misbehaves, reach for update{add_tools|remove_tools} BEFORE you edit a
prompt. Fewer, RIGHT tools beats more tools.

action:"update" is a PATCH — omitted fields are left alone. add_tools/remove_tools are
additive/subtractive against the existing allowlist; they do not replace it.

action:"delete" is destructive and requires confirm:true. Do not call it to tidy up agents
you did not create — prefer update{} to re-scope or quiet one.`,
          inputSchema: {
            type: "object" as const,
            properties: {
              action: { type: "string", enum: ["list", "ask", "get", "create", "update", "delete"], description: "list=discover · ask=consult · get=read config · create/update/delete=manage config" },
              query: { type: "string", description: "list: filter agents by name/description, e.g. 'finance'" },
              agent: { type: "number", description: "ask/get/update/delete: the agent ID from action:'list'" },
              message: { type: "string", description: "ask: the question. Be specific and self-contained — the agent does not see this conversation." },
              model: { type: "string", description: "ask: model override for this turn. create/update: the agent's stored model. Keep to nano/mini tiers." },
              timeout: { type: "number", description: "ask: seconds to wait (default 120, max 600)" },
              schema: { type: "object", description: "ask: JSON Schema the answer must satisfy. Returns a validated object instead of prose. Prompt-enforced, not API-enforced — see the description." },
              thread: { type: "string", description: "ask: pin this turn to a named conversation thread instead of the agent's default shared one. Reuse the same value to continue that conversation." },
              fresh: { type: "boolean", description: "ask: isolate this turn in a brand-new thread so the agent starts with no prior conversation. Ignored if `thread` is given." },
              full: { type: "boolean", description: "get: return the raw record instead of the compact summary (large)" },
              name: { type: "string", description: "create/update: agent name" },
              description: { type: "string", description: "create/update: what this agent OWNS. Callers pick agents by this — one without a description is unchoosable." },
              prompt: { type: "string", description: "create/update: system prompt — the agent's IDENTITY" },
              mission: { type: "string", description: "create/update: initial_prompt — what it does every heartbeat" },
              type: { type: "string", enum: ["content", "chat", "assistant", "support"], description: "create: agent type (default content)" },
              bloq: { type: "number", description: "create/update: knowledge-base bloq ID it retrieves from (its RAG scope)" },
              heartbeat_mode: { type: "string", enum: ["off", "passive", "reactive", "autonomous", "briefing"], description: "create/update: heartbeat mode" },
              heartbeat_tools: { type: "string", description: "create/update: comma-separated heartbeat tool names" },
              add_tools: { type: "string", description: "update: comma-separated tools to ADD to the allowlist (additive)" },
              remove_tools: { type: "string", description: "update: comma-separated tools to REMOVE from the allowlist" },
              reset_health: { type: "boolean", description: "update: clear health_status/consecutive_failures" },
              confirm: { type: "boolean", description: "delete: must be true. Destructive." },
            },
            required: ["action"],
          },
        },
        {
          name: "iris_memory",
          description: `Read and write the user's Atlas — their persistent memory. Boards ("bloqs") hold
lists, lists hold items, items hold the actual text. This is the same store the IRIS agents
retrieve from, so what you write here is what they will later cite.

"memory", "atlas", "knowledge", "projects" and "bloqs" are ALL THE SAME STORE — the CLI
registers them as aliases of one another. There is no separate memory database.

USE action:"search" TO FIND ANYTHING. This is not a preference, it is a correctness rule:
action:"boards" is RECENCY-ORDERED AND TRUNCATED. It is not an inventory. Answering "which
X do I have" by reading names out of it will silently miss anything older than the first
page and you cannot tell that you missed it — the list looks complete.

Measured: asked for "family projects", the board list returns "Mia Mayo — Life Atlas" and
stops. A search returns board #200 "Family Businesses" and #137 "Family Health and Finance
Management Workflow" — neither appears in the list at all. The list-only answer is not
partial, it is WRONG.

So:
- BY TOPIC / KEYWORD / "do I have a ..." → action:"search". It covers board names, item
  titles AND item bodies across every board.
- action:"boards" only to show the most recent boards, or when the user already named one.
- action:"get" shows one board's lists and their item counts — the map before you read.
- action:"items" reads items. Content is fetched by DEFAULT here; the underlying CLI omits
  item bodies unless asked, and on 2026-08-20 that silently fed a meal planner an EMPTY
  pantry while every step reported success. Empty content in a result means the item is
  genuinely empty, not that you forgot a flag.
- action:"add" appends an item to a list. action:"update" edits one in place.

WRITING WELL: an item's text is what an agent will retrieve and quote months from now, to a
caller who cannot see this conversation. Write it self-contained — state the fact, when it
was decided, and what it supersedes. If you are correcting something, say so in the text
rather than silently overwriting, and link the item it replaces.

action:"update" replaces content WHOLESALE. Read the item first or you will destroy the
parts you did not mean to touch.`,
          inputSchema: {
            type: "object" as const,
            properties: {
              action: { type: "string", enum: ["search", "boards", "get", "items", "add", "update"], description: "search=find anything (START HERE) · boards=recent boards · get=one board's lists · items=read items · add/update=write" },
              query: { type: "string", description: "search/items: the search term" },
              bloq: { type: "number", description: "get/items/add: board ID. On search, restricts item matches to one board." },
              list: { type: "number", description: "items: filter to one list. add: the target list ID (required)." },
              item: { type: "number", description: "update: the item ID to edit" },
              content: { type: "string", description: "add/update: the item body. On update this REPLACES the whole body." },
              title: { type: "string", description: "update: new title" },
              status: { type: "string", description: "items: filter by status. update: set status (active|pending|approved|rejected|todo|in-progress|done)" },
              limit: { type: "number", description: "search/items: max results (default 25)" },
              local_only: { type: "boolean", description: "search: skip Obsidian and Drive, search boards only (faster)" },
            },
            required: ["action"],
          },
        },
        // One properly-typed tool per executable playbook. `iris_run` could
        // already run these as a command string; the difference is that a model
        // can now see the arguments, their types, and their enums.
        ...(playbooksEnabled ? toolsFor(await loadPlaybooks()) : []),
      ],
    }))

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params

      if (playbooksEnabled && name.startsWith(TOOL_PREFIX)) {
        try {
          const r = await callPlaybookTool(name, (args ?? {}) as Record<string, unknown>)
          return { content: [{ type: "text" as const, text: r.text }], isError: r.isError }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          return { content: [{ type: "text" as const, text: `Playbook error: ${msg}` }], isError: true }
        }
      }

      if (name === "iris_run") {
        const command = (args?.command as string) ?? ""
        const { args: cmdArgs, error } = validateCommand(command)
        if (error) {
          return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true }
        }

        try {
          const result = await execIris(cmdArgs)

          if (result.exitCode !== 0) {
            const errMsg = result.stderr || result.stdout || "Command failed with no output"
            let hint = ""
            if (errMsg.includes("401") || errMsg.includes("Unauthorized") || errMsg.includes("unauthenticated")) {
              hint = "\n\nHint: Try running `iris auth login` first, or set IRIS_API_KEY env var."
            }
            return { content: [{ type: "text" as const, text: `${errMsg}${hint}` }], isError: true }
          }

          const text = [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || "(no output)"
          return { content: [{ type: "text" as const, text }] }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes("ENOENT") || msg.includes("not found")) {
            return {
              content: [{ type: "text" as const, text: `iris CLI not found. Install it first:\n\ncurl -fsSL https://heyiris.io/install-code | bash` }],
              isError: true,
            }
          }
          return { content: [{ type: "text" as const, text: `Execution error: ${msg}` }], isError: true }
        }
      }

      if (name === "iris_agent") {
        const action = (args?.action as string) ?? ""

        if (action === "list") {
          const query = (args?.query as string ?? "").trim()
          const listArgs = ["agents", "list", "--json", "--limit", "50"]
          if (query) {
            if (/[;&|`$\\<>!\n\r]/.test(query)) {
              return { content: [{ type: "text" as const, text: "Error: invalid characters in query" }], isError: true }
            }
            listArgs.push("-s", query)
          }
          try {
            const result = await execIris(listArgs)
            if (result.exitCode !== 0) {
              return { content: [{ type: "text" as const, text: result.stderr || result.stdout || "agents list failed" }], isError: true }
            }
            let roster: Array<Record<string, unknown>> = []
            try {
              const parsed = JSON.parse(result.stdout)
              roster = Array.isArray(parsed?.data) ? parsed.data : []
            } catch {
              return { content: [{ type: "text" as const, text: result.stdout }] }
            }
            // Agents with no description cannot be chosen on purpose — a caller
            // picking from names alone is guessing. Say so rather than padding
            // the roster with rows that carry no signal about what they know.
            const described = roster.filter((a) => typeof a.description === "string" && (a.description as string).trim())
            const compact = described.map((a) => ({ id: a.id, name: a.name, description: a.description }))
            const note = roster.length === 0
              ? (query ? `No agents matched "${query}". Try a broader term, or action:"list" with no query.` : "No agents found.")
              : `${compact.length} of ${roster.length} agent(s) carry a description and are listed. ` +
                `${roster.length - compact.length} were omitted as unidentifiable — an agent with no description cannot be chosen deliberately. ` +
                `Pick by what an agent OWNS, then action:"ask" with its id.`
            return { content: [{ type: "text" as const, text: `${note}\n\n${JSON.stringify(compact, null, 2)}` }] }
          } catch (e) {
            return { content: [{ type: "text" as const, text: `Execution error: ${e instanceof Error ? e.message : e}` }], isError: true }
          }
        }

        if (action === "ask") {
          const agentId = args?.agent
          const message = (args?.message as string ?? "").trim()
          if (typeof agentId !== "number" || !Number.isInteger(agentId) || agentId <= 0) {
            return { content: [{ type: "text" as const, text: `Error: 'agent' must be a positive integer agent ID. Run action:"list" first.` }], isError: true }
          }
          if (!message) {
            return { content: [{ type: "text" as const, text: "Error: 'message' is required for action:'ask'." }], isError: true }
          }
          const secs = Math.min(Math.max(Number(args?.timeout) || 120, 10), 600)
          const schema = args?.schema && typeof args.schema === "object" ? (args.schema as any) : null
          // Prompt-enforced, NOT API-enforced: `iris chat` has no schema flag, so the shape is
          // requested in the message and checked here. That distinction is stated in the tool
          // description and in the result — a caller must not read "valid: true" as a guarantee
          // the model was constrained, only that what came back satisfied the schema.
          // The escape hatch is NOT optional politeness. Measured 2026-08-20: asked "what colour
          // is our Series A term sheet?" under a required enum of [red, blue], the agent
          // returned {"colour":"blue","confidence":90} — for a term sheet that does not exist.
          // A required schema REMOVES a model's ability to decline, so it fabricates to satisfy
          // the shape, and the fabrication passes validation. Giving it a legal way to say
          // "I don't know" is what keeps a schema from manufacturing answers.
          const schemaInstruction = schema
            ? `\n\nRespond with RAW JSON ONLY that satisfies this JSON Schema. No prose, no code fence, no explanation before or after.` +
              `\n\nIf you cannot answer truthfully from what you actually know or can retrieve, DO NOT guess and DO NOT invent values to fill the shape. ` +
              `Instead return exactly: {"_unavailable": "<short reason>"}. Returning _unavailable is a correct answer, not a failure.` +
              `\n\nSCHEMA:\n${JSON.stringify(schema)}`
            : ""
          // -V emits the run trace, which is where REAL provenance lives. Single -V is
          // enough (-VV only adds full payloads and bloats tool-heavy runs); the derived
          // provenance is returned instead of the raw trace so results stay small.
          const wantThread =
            typeof args?.thread === "string" && args.thread.trim()
              ? args.thread.trim()
              : args?.fresh === true
                ? `fresh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
                : null
          const askArgs = ["chat", "-a", String(agentId), "--json", "-V", "--timeout", String(secs)]
          if (wantThread) askArgs.push("--thread", wantThread)
          const model = (args?.model as string ?? "").trim()
          if (model) {
            if (/[;&|`$\\<>!\n\r\s]/.test(model)) {
              return { content: [{ type: "text" as const, text: "Error: invalid characters in model" }], isError: true }
            }
            askArgs.push("-m", model)
          }
          askArgs.push(message + schemaInstruction)

          try {
            // +15s of headroom so the CLI's own --timeout is what fires, not the
            // spawn killer. If the killer wins we lose the CLI's structured error
            // and the caller sees an empty result instead of "the agent timed out".
            const result = await execIris(askArgs, (secs + 15) * 1000)
            const raw = (result.stdout || "").trim()
            if (result.exitCode !== 0 && !raw.startsWith(JSON_OPEN)) {
              const errMsg = result.stderr || raw || "agent call failed with no output"
              return { content: [{ type: "text" as const, text: errMsg }], isError: true }
            }
            // The CLI can emit SEVERAL JSON objects on stdout — an error object per failed
            // API call, then a final status envelope. A single JSON.parse over the whole
            // buffer throws, and returning the raw text on that path reported a FAILED
            // agent call as a success: asking a nonexistent agent came back isError:false
            // with `{"status":"failed"}` buried in the text. Parse line-wise and let the
            // envelope decide.
            const objs: Record<string, any>[] = []
            for (const line of raw.split("\n")) {
              const t = line.trim()
              if (!t.startsWith(JSON_OPEN)) continue
              try { objs.push(JSON.parse(t)) } catch {}
            }
            const env: Record<string, any> | undefined =
              objs.find((o) => typeof o.status === "string" || typeof o.response === "string") ?? objs[objs.length - 1]
            if (!env) {
              return { content: [{ type: "text" as const, text: raw || result.stderr || "(no output)" }], isError: true }
            }
            // Anything that is not an explicitly completed turn is a failure, including
            // the CLI's own {status:"failed"}. Surface the upstream reason with it.
            if (env.status !== "completed" || env.success === false) {
              const reasons = objs
                .map((o) => (typeof o.error === "string" ? `${o.error}${o.status && typeof o.status === "number" ? ` (${o.status})` : ""}${o.action ? ` [${o.action}]` : ""}` : null))
                .filter(Boolean)
              const why = reasons.length ? reasons.join("; ") : (typeof env.error === "string" ? env.error : `status=${JSON.stringify(env.status)}`)
              // The hint has to match the failure. Telling a caller "check the ID" after a
              // TIMEOUT sends it to re-look-up an agent that was fine, and it may then
              // report the agent as missing. Route the advice off the actual reason.
              const hint = /timed out|timeout/i.test(why)
                ? `The agent was reachable but did not finish in time. Retry with a larger \`timeout\` (max 600), or ask a narrower question — this one may need multi-step retrieval.`
                : /not found|404/i.test(why)
                  ? `Agent #${agentId} does not exist or is not visible to this account. Run action:"list" to get valid IDs.`
                  : `Do not retry blindly — read the reason above first.`
              return {
                content: [{ type: "text" as const, text: `Agent #${agentId} did not answer: ${why}\n\n${hint}\nThis is a FAILURE, not an empty answer. Do not report it as the agent having nothing to say.` }],
                isError: true,
              }
            }
            const response = typeof env.response === "string" ? env.response : ""
            // Pattern-matched from the prose, NOT structural provenance. Named
            // cited_ids (not sources) so a caller cannot mistake "the agent said
            // this" for "this was retrieved". The description says to verify.
            const cited = extractCitedIds(response)
            const toolsUsed = Array.isArray(env.tools_used) ? env.tools_used : []
            const provenance = extractProvenance(env.trace)
            // The cross-check is the point of all this: an ID the model CITED that was never
            // retrieved this turn. Not proof of fabrication — conversation history is also
            // loaded, so it may be a genuine recall from earlier in the thread — but it is
            // the difference between "it read this" and "it said this", which is exactly what
            // cited_ids alone cannot tell you.
            const retrievedSet = new Set(provenance.retrieved_item_ids)
            const citedNotRetrieved = cited.filter((id) => !retrievedSet.has(id))
            const out = {
              agent: agentId,
              status: env.status ?? "unknown",
              response,
              tools_used: toolsUsed,
              cited_ids: cited,
              provenance,
              cited_not_retrieved: citedNotRetrieved,
              iterations: env.iterations ?? null,
              elapsed_ms: env.elapsed_ms ?? null,
              requires_approval: env.requires_approval === true,
            }
            let structured: { valid: boolean; data?: unknown; errors?: string[]; unavailable?: string; attempts?: number } | null = null
            if (schema) {
              type Checked = { valid: boolean; data?: unknown; errors?: string[]; unavailable?: string }
              const check = (text: string): Checked => {
                const parsed = extractJson(text)
                if (parsed === undefined) return { valid: false, errors: ["response contained no parseable JSON"] }
                // A declared non-answer short-circuits BEFORE validation. It is neither a
                // schema pass nor a schema failure — it is the agent correctly refusing, and
                // collapsing it into either one would hide the most useful signal here.
                const un = (parsed as any)?._unavailable
                if (typeof un === "string") return { valid: false, unavailable: un, data: parsed }
                const errs = validateAgainstSchema(parsed, schema)
                return errs.length ? { valid: false, errors: errs, data: parsed } : { valid: true, data: parsed }
              }
              let r: Checked = check(response)
              let attempts = 1
              // Exactly ONE retry, and it must carry the SPECIFIC errors — "that was invalid,
              // try again" makes a model guess. Looping further would burn real money on a
              // model that has already shown it cannot hit the shape.
              if (!r.valid && !r.unavailable) {
                const repair =
                  `${message}\n\nYour previous reply did not satisfy the schema:\n` +
                  (r.errors ?? []).map((e) => `- ${e}`).join("\n") +
                  `\n\nReturn ONLY corrected raw JSON matching the schema. No prose, no code fence.` +
                  `\n\nSCHEMA:\n${JSON.stringify(schema)}`
                const retryArgs = askArgs.slice(0, -1).concat(repair)
                const rr = await execIris(retryArgs, (secs + 15) * 1000)
                attempts = 2
                let retryText = ""
                for (const line of (rr.stdout || "").split("\n")) {
                  const t2 = line.trim()
                  if (!t2.startsWith(JSON_OPEN)) continue
                  try {
                    const o = JSON.parse(t2)
                    if (typeof o.response === "string") retryText = o.response
                  } catch {}
                }
                if (retryText) {
                  const r2 = check(retryText)
                  if (r2.valid) { r = r2; out.response = retryText }
                  else r = { valid: false, errors: r2.errors, data: r2.data }
                }
              }
              structured = { ...r, attempts }
            }

            const flags: string[] = []
            if (structured?.unavailable) {
              flags.push(`The agent DECLINED rather than guess: "${structured.unavailable}". This is a correct outcome, not a malfunction — it had no truthful value for the shape you asked for. Do not re-ask with a looser schema to force an answer out of it.`)
            } else if (structured && !structured.valid) {
              flags.push(`SCHEMA NOT SATISFIED after ${structured.attempts} attempt(s): ${(structured.errors ?? []).join("; ")}. Treat this as a FAILED call — do not use partial data as if it validated.`)
            }
            if (structured?.valid && structured.attempts === 2) {
              flags.push("Schema satisfied only on the RETRY — the first reply was malformed. Worth noting if you are measuring this agent's reliability.")
            }
            if (out.requires_approval) {
              flags.push("REQUIRES APPROVAL — this agent is holding an action it will not take unsupervised. Surface it to the user; do not retry around it.")
            }
            if (toolsUsed.length === 0) {
              flags.push("tools_used is empty: nothing was queried live this turn. The answer is from retrieval context or model priors — verify any figure before relying on it.")
            }
            if (provenance.retrieved_item_ids.length > 0) {
              flags.push(`RETRIEVED this turn (structural, from the run trace — not parsed from prose): ${provenance.retrieved_item_ids.join(", ")}${provenance.retrieval_bloq_id ? ` from bloq ${provenance.retrieval_bloq_id}` : ""}. These are the records the agent actually read.`)
            }
            if (citedNotRetrieved.length > 0) {
              flags.push(`CITED BUT NOT RETRIEVED this turn: ${citedNotRetrieved.join(", ")}. The agent named these without reading them now. It may be recalling them from conversation history${provenance.history_messages ? ` (${provenance.history_messages} messages loaded)` : ""}, or inventing them. VERIFY before using: iris_memory {action:"items", bloq:<id>}.`)
            }
            // Do not advertise a control without checking it worked. The server currently
            // VALIDATES thread_id and then drops it on the streaming path (#181597), so a
            // caller asking for isolation would otherwise get the shared thread and never
            // know. Provenance already reports the thread the run actually used, so the tool
            // can catch the platform lying to it.
            if (wantThread && provenance.thread_id && provenance.thread_id !== wantThread) {
              flags.push(`THREAD CONTROL DID NOT TAKE EFFECT — you asked for "${wantThread}", the run used "${provenance.thread_id}"${provenance.history_messages ? ` with ${provenance.history_messages} prior messages` : ""}. This is server-side bug #181597: /api/v6/chat/stream validates thread_id then drops it. This turn was NOT isolated. Do not rely on it being a clean room.`)
            } else if (wantThread && provenance.thread_id === wantThread) {
              flags.push(`Thread control confirmed: this turn ran in "${wantThread}"${provenance.history_messages ? ` with ${provenance.history_messages} prior messages from it` : " with no prior history"}.`)
            }
            if (provenance.history_messages && provenance.history_messages > 0) {
              flags.push(`NOT A CLEAN ROOM: ${provenance.history_messages} messages of prior conversation were loaded from thread ${provenance.thread_id}. This agent remembers earlier calls — yours and anyone else's — so an answer can be shaped by context you cannot see here.`)
            }
            const banner = flags.length ? flags.map((f) => `[!] ${f}`).join("\n") + "\n\n" : ""
            const payload = structured ? { ...out, structured } : out
            return {
              content: [{ type: "text" as const, text: `${banner}${JSON.stringify(payload, null, 2)}` }],
              isError: structured ? !structured.valid : false,
            }
          } catch (e) {
            return { content: [{ type: "text" as const, text: `Execution error: ${e instanceof Error ? e.message : e}` }], isError: true }
          }
        }

        if (action === "get") {
          const agentId = args?.agent
          if (typeof agentId !== "number" || !Number.isInteger(agentId) || agentId <= 0) {
            return { content: [{ type: "text" as const, text: `Error: 'agent' must be a positive integer agent ID.` }], isError: true }
          }
          try {
            const result = await execIris(["agents", "get", String(agentId), "--json"])
            if (result.exitCode !== 0) {
              return { content: [{ type: "text" as const, text: result.stderr || result.stdout || "agents get failed" }], isError: true }
            }
            if (args?.full === true) {
              return { content: [{ type: "text" as const, text: result.stdout }] }
            }
            let a: Record<string, any>
            try { a = JSON.parse(result.stdout) } catch { return { content: [{ type: "text" as const, text: result.stdout }] } }
            // Compact by design. The raw record stores the system prompt TWICE
            // (settings.system_prompt and initial_prompt), so a full dump is 10KB+
            // of mostly duplicate text and buries the fields you actually change.
            const settings = (a.settings ?? {}) as Record<string, any>
            const tools = Array.isArray(a.config?.tools) ? a.config.tools : []
            const summary = {
              id: a.id, name: a.name, type: a.type, active: a.active === 1 || a.active === true,
              description: a.description ?? null,
              model: settings.model ?? null,
              rag_bloq_ids: settings.bloq_ids ?? [], workspace_bloq_id: a.bloq_id ?? null,
              tool_allowlist: tools, tool_count: tools.length,
              heartbeat_mode: a.heartbeat_mode ?? null,
              health: a.health?.status ?? a.health_status ?? null,
              system_prompt_chars: typeof settings.system_prompt === "string" ? settings.system_prompt.length : 0,
              mission_chars: typeof a.initial_prompt === "string" ? a.initial_prompt.length : 0,
              system_prompt_head: typeof settings.system_prompt === "string" ? settings.system_prompt.slice(0, 240) : null,
            }
            const notes: string[] = []
            if (tools.length === 0) {
              notes.push("[!] EMPTY ALLOWLIST = FULL TOOL SET, not 'no tools'. This is the configuration that made an unscoped agent report a healthcare client's $2.9M as company revenue. Scope it before trusting its answers.")
            }
            if (!summary.description) {
              notes.push("[!] No description: this agent cannot be chosen deliberately from action:'list' and will be omitted from the roster.")
            }
            notes.push("Compact summary — pass full:true for the raw record.")
            return { content: [{ type: "text" as const, text: `${notes.join("\n")}\n\n${JSON.stringify(summary, null, 2)}` }] }
          } catch (e) {
            return { content: [{ type: "text" as const, text: `Execution error: ${e instanceof Error ? e.message : e}` }], isError: true }
          }
        }

        if (action === "create" || action === "update") {
          const str = (k: string) => (typeof args?.[k] === "string" ? (args[k] as string).trim() : "")
          const num = (k: string) => (typeof args?.[k] === "number" ? (args[k] as number) : undefined)
          const cmdArgs: string[] = ["agents", action]

          if (action === "update") {
            const agentId = args?.agent
            if (typeof agentId !== "number" || !Number.isInteger(agentId) || agentId <= 0) {
              return { content: [{ type: "text" as const, text: `Error: 'agent' (id) is required for action:"update".` }], isError: true }
            }
            cmdArgs.push(String(agentId))
          } else if (!str("name")) {
            return { content: [{ type: "text" as const, text: `Error: 'name' is required for action:"create".` }], isError: true }
          }

          const push = (flag: string, val: string) => { if (val) cmdArgs.push(flag, val) }
          push("--name", str("name"))
          push("--description", str("description"))
          if (action === "create") {
            push("--prompt", str("prompt"))
            push("--type", str("type"))
            const b = num("bloq"); if (b !== undefined) cmdArgs.push("--bloq-id", String(b))
          } else {
            push("--system-prompt", str("prompt"))
            const b = num("bloq"); if (b !== undefined) cmdArgs.push("--bloq", String(b))
            push("--add-tools", str("add_tools"))
            push("--remove-tools", str("remove_tools"))
            if (args?.reset_health === true) cmdArgs.push("--reset-health")
          }
          push("--mission", str("mission"))
          push("--model", str("model"))
          push("--heartbeat-mode", str("heartbeat_mode"))
          push("--heartbeat-tools", str("heartbeat_tools"))
          // `agents create` and `agents delete` accept --json; `agents update` does NOT,
          // and yargs strict mode REJECTS the unknown flag ("Unknown argument: json"), so
          // adding it unconditionally made every update fail while looking like a normal
          // CLI error. Caught by end-to-end testing, not by reading the help text.
          if (action === "create") cmdArgs.push("--json")

          // An update with no fields is a no-op the CLI reports as success — which
          // reads to a caller as "the change landed". Refuse it instead.
          const changed = cmdArgs.filter((x) => x.startsWith("--") && x !== "--json")
          if (changed.length === 0) {
            return { content: [{ type: "text" as const, text: `Error: nothing to ${action} — no fields given. This would have reported success while changing nothing.` }], isError: true }
          }

          try {
            const result = await execIris(cmdArgs, 60_000)
            if (result.exitCode !== 0) {
              return { content: [{ type: "text" as const, text: result.stderr || result.stdout || `agents ${action} failed` }], isError: true }
            }
            const changedFlags = changed.map((f) => f.replace(/^--/, "")).join(", ")
            // A freshly created agent is SAFE BUT USELESS and both halves surprise people.
            // Measured on a bare agent (2026-08-20): asked "what is our revenue goal?" it
            // correctly answered "I don't have access to that" — it declines rather than
            // fabricating, which is right. But it also has an EMPTY allowlist, which means
            // the FULL tool set, not none. So: harmless on questions, over-privileged on
            // actions, until someone sets a bloq scope and scopes the tools.
            const post: string[] = []
            if (action === "create") {
              if (num("bloq") === undefined) post.push("[!] No bloq scope set: this agent retrieves NOTHING and will decline domain questions (it declines rather than fabricating — that part is correct). Set bloq:<id> to ground it.")
              post.push("[!] New agents start with an EMPTY tool allowlist, which grants the FULL tool set, not none. Scope it with update{add_tools|remove_tools} before pointing it at anything real.")
            }
            const tail = post.length ? `\n\n${post.join("\n")}` : ""
            return { content: [{ type: "text" as const, text: `${action} OK — fields set: ${changedFlags}\n\n${result.stdout.trim() || "(no output)"}${tail}\n\nVerify with action:"get".` }] }
          } catch (e) {
            return { content: [{ type: "text" as const, text: `Execution error: ${e instanceof Error ? e.message : e}` }], isError: true }
          }
        }

        if (action === "delete") {
          const agentId = args?.agent
          if (typeof agentId !== "number" || !Number.isInteger(agentId) || agentId <= 0) {
            return { content: [{ type: "text" as const, text: `Error: 'agent' (id) is required for action:"delete".` }], isError: true }
          }
          if (args?.confirm !== true) {
            return {
              content: [{ type: "text" as const, text: `Refused: deleting agent #${agentId} is destructive and needs confirm:true.\n\nRun action:"get" with agent:${agentId} first and show the user what they are about to lose. If the goal is to quiet or re-scope the agent rather than destroy it, use action:"update" instead.` }],
              isError: true,
            }
          }
          try {
            const result = await execIris(["agents", "delete", String(agentId), "--force", "--json"], 60_000)
            if (result.exitCode !== 0) {
              return { content: [{ type: "text" as const, text: result.stderr || result.stdout || "agents delete failed" }], isError: true }
            }
            return { content: [{ type: "text" as const, text: `Deleted agent #${agentId}.\n\n${result.stdout.trim() || "(no output)"}` }] }
          } catch (e) {
            return { content: [{ type: "text" as const, text: `Execution error: ${e instanceof Error ? e.message : e}` }], isError: true }
          }
        }

        return { content: [{ type: "text" as const, text: `Error: action must be one of list|ask|get|create|update|delete (got ${JSON.stringify(action)})` }], isError: true }
      }

      if (name === "iris_memory") {
        const action = (args?.action as string) ?? ""
        const str = (k: string) => (typeof args?.[k] === "string" ? (args[k] as string).trim() : "")
        const num = (k: string) => (typeof args?.[k] === "number" ? (args[k] as number) : undefined)
        const limit = Math.min(Math.max(num("limit") ?? 25, 1), 200)
        const run = async (a: string[]) => {
          const r = await execIris(a, 60_000)
          if (r.exitCode !== 0) throw new Error(r.stderr || r.stdout || `iris ${a[0]} failed`)
          return r.stdout
        }

        try {
          if (action === "search") {
            const q = str("query")
            if (!q) return { content: [{ type: "text" as const, text: "Error: 'query' is required for action:'search'." }], isError: true }
            const a = ["bloqs", "search", q, "--limit", String(limit), "--json"]
            const b = num("bloq"); if (b !== undefined) a.push("--bloq", String(b))
            if (args?.local_only === true) a.push("--local-only")
            return { content: [{ type: "text" as const, text: await run(a) }] }
          }

          if (action === "boards") {
            const out = await run(["bloqs", "list", "--json"])
            // Structural, not advisory: this list is recency-ordered and truncated, and
            // a caller cannot tell a short list from a complete one. The warning rides
            // along with every result so it cannot be read as an inventory by accident.
            const warn = "[!] RECENCY-ORDERED AND TRUNCATED — this is NOT an inventory. Anything older than the first page is missing and nothing here indicates that. To answer 'which boards do I have about X', use action:'search'."
            return { content: [{ type: "text" as const, text: `${warn}\n\n${out}` }] }
          }

          if (action === "get") {
            const b = num("bloq")
            if (b === undefined) return { content: [{ type: "text" as const, text: "Error: 'bloq' (board ID) is required for action:'get'." }], isError: true }
            return { content: [{ type: "text" as const, text: await run(["bloqs", "get", String(b), "--json"]) }] }
          }

          if (action === "items") {
            const b = num("bloq")
            if (b === undefined) return { content: [{ type: "text" as const, text: "Error: 'bloq' (board ID) is required for action:'items'." }], isError: true }
            // content is requested ALWAYS. The CLI omits item bodies unless --fields
            // names them, and the failure is silent: the key exists with an empty
            // string, so a `.get(key, fallback)` never fires its fallback and the
            // caller is handed nothing while every step reports success (2026-08-20).
            const a = ["bloqs", "items", String(b), "--fields", "id,title,status,list_name,content", "--limit", String(limit), "--json"]
            const l = num("list"); if (l !== undefined) a.push("--list", String(l))
            const q = str("query"); if (q) a.push("--search", q)
            const st = str("status"); if (st) a.push("--status", st)
            return { content: [{ type: "text" as const, text: await run(a) }] }
          }

          if (action === "add") {
            const b = num("bloq"), l = num("list"), c = str("content")
            if (b === undefined || l === undefined) return { content: [{ type: "text" as const, text: "Error: 'bloq' and 'list' are both required for action:'add'. Use action:'get' to see a board's list IDs." }], isError: true }
            if (!c) return { content: [{ type: "text" as const, text: "Error: 'content' is required for action:'add'." }], isError: true }
            const out = await run(["bloqs", "add-item", String(b), String(l), c, "--json"])
            return { content: [{ type: "text" as const, text: `Added to board ${b} / list ${l}.\n\n${out.trim()}` }] }
          }

          if (action === "update") {
            const it = num("item")
            if (it === undefined) return { content: [{ type: "text" as const, text: "Error: 'item' (item ID) is required for action:'update'." }], isError: true }
            const a = ["bloqs", "update-item", String(it)]
            const c = str("content"); if (c) a.push("--content", c)
            const t = str("title"); if (t) a.push("--title", t)
            const st = str("status"); if (st) a.push("--status", st)
            if (a.length === 3) return { content: [{ type: "text" as const, text: "Error: nothing to update — give content, title or status. This would have reported success while changing nothing." }], isError: true }
            a.push("--json")
            const out = await run(a)
            const note = c ? "Content was REPLACED wholesale, not merged.\n\n" : ""
            return { content: [{ type: "text" as const, text: `Updated item ${it}. ${note}${out.slice(0, 4000)}` }] }
          }

          return { content: [{ type: "text" as const, text: `Error: action must be one of search|boards|get|items|add|update (got ${JSON.stringify(action)})` }], isError: true }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          let hint = ""
          if (/401|Unauthorized|unauthenticated/i.test(msg)) hint = "\n\nHint: run `iris auth login`, or set IRIS_API_KEY."
          return { content: [{ type: "text" as const, text: `${msg}${hint}` }], isError: true }
        }
      }

      if (name === "iris_help") {
        const command = (args?.command as string) ?? ""
        const parts = command.trim().split(/\s+/)
        const dangerous = /[;&|`$\\<>!\n\r]/
        for (const part of parts) {
          if (dangerous.test(part)) {
            return { content: [{ type: "text" as const, text: `Error: invalid characters in command` }], isError: true }
          }
        }

        try {
          const result = await execIris([...parts, "--help"])
          return { content: [{ type: "text" as const, text: result.stdout || result.stderr || "(no help output)" }] }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes("ENOENT") || msg.includes("not found")) {
            return {
              content: [{ type: "text" as const, text: `iris CLI not found. Install it first:\n\ncurl -fsSL https://heyiris.io/install-code | bash` }],
              isError: true,
            }
          }
          return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true }
        }
      }

      // ── Hive tmux tools (proxy through daemon bridge at localhost:3200) ──
      const BRIDGE = process.env.IRIS_BRIDGE_URL ?? "http://localhost:3200"

      if (name === "hive_sessions") {
        try {
          const res = await bridgeFetch(`${BRIDGE}/daemon/tmux/sessions`)
          if (!res.ok) return { content: [{ type: "text" as const, text: bridgeErr(res) }], isError: true }
          const data = await res.json()
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }
        } catch (e) {
          return { content: [{ type: "text" as const, text: `Daemon bridge unavailable (is iris daemon running?): ${e instanceof Error ? e.message : e}` }], isError: true }
        }
      }

      if (name === "hive_panes") {
        const session = args?.session as string
        const lines = (args?.lines as number) ?? 20
        if (!session) return { content: [{ type: "text" as const, text: "Error: session is required" }], isError: true }
        try {
          const res = await bridgeFetch(`${BRIDGE}/daemon/tmux/sessions/${session}/panes?lines=${lines}`)
          if (!res.ok) return { content: [{ type: "text" as const, text: bridgeErr(res) }], isError: true }
          const data = await res.json()
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }
        } catch (e) {
          return { content: [{ type: "text" as const, text: `Daemon bridge unavailable: ${e instanceof Error ? e.message : e}` }], isError: true }
        }
      }

      if (name === "hive_send_input") {
        const session = args?.session as string
        const pane = (args?.pane as number) ?? 0
        const text = args?.text as string
        if (!session || text === undefined) return { content: [{ type: "text" as const, text: "Error: session and text are required" }], isError: true }
        try {
          const res = await bridgeFetch(`${BRIDGE}/daemon/tmux/sessions/${session}/input`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pane, text }),
          })
          if (!res.ok) return { content: [{ type: "text" as const, text: bridgeErr(res) }], isError: true }
          return { content: [{ type: "text" as const, text: `Sent to ${session}:${pane}` }] }
        } catch (e) {
          return { content: [{ type: "text" as const, text: `Daemon bridge unavailable: ${e instanceof Error ? e.message : e}` }], isError: true }
        }
      }

      return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true }
    })

    // --- Streamable HTTP transport (--http) ---
    //
    // Every tool here runs something on this machine, so an HTTP listener is a
    // remote-execution endpoint by definition. Two non-negotiables, both
    // enforced below rather than documented and hoped for: bind loopback only,
    // and require a bearer token. The token is printed once at startup — it is
    // not persisted, so killing the server invalidates it.
    if (argv.http) {
      const { StreamableHTTPServerTransport } = await import(
        "@modelcontextprotocol/sdk/server/streamableHttp.js"
      )
      const token = (argv.token as string) || crypto.randomUUID()
      const port = argv.port as number

      // Stateless by default (MCP no longer requires session state). Two
      // reasons, and the second is the one that actually bit:
      //
      //  1. A server holding session state can only run where that state lives
      //     — no serverless, no edge, and no second instance behind a load
      //     balancer, because a client's follow-up request can land on a box
      //     that never saw its `initialize`.
      //
      //  2. This handler keeps ONE transport for every request. That is exactly
      //     right stateless, and wrong when sessions exist — the SDK's model is
      //     one transport per session, so the first version was neither one
      //     thing nor the other. Dropping the session generator makes the
      //     single shared transport correct rather than accidental.
      //
      // --stateful is kept for resumability (an eventStore replaying missed
      // messages needs a session to replay onto), but nothing needs it yet.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: argv.stateful ? () => crypto.randomUUID() : undefined,
        // The client is a local process on loopback, so a browser-style DNS
        // rebinding attack is the realistic threat, not a cross-origin one.
        enableDnsRebindingProtection: true,
        allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      })
      await server.connect(transport)

      // node:http, not Bun.serve — the SDK transport takes IncomingMessage /
      // ServerResponse directly, and adapting Web Request/Response to that is
      // pure overhead for no gain.
      const { createServer } = await import("node:http")
      createServer((req, res) => {
        if (req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(401).end("Unauthorized")
          return
        }
        if (req.method !== "POST") {
          // GET (SSE stream) and DELETE (session close) carry no body.
          transport.handleRequest(req, res).catch(() => res.writeHead(500).end())
          return
        }
        const chunks: Buffer[] = []
        req.on("data", (c) => chunks.push(c))
        req.on("end", () => {
          let body: unknown
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf-8"))
          } catch {
            res.writeHead(400).end("Parse error")
            return
          }
          transport.handleRequest(req, res, body).catch(() => res.writeHead(500).end())
        })
      }).listen(port, "127.0.0.1") // never 0.0.0.0 — this endpoint executes commands

      // stdout is the JSON-RPC channel in stdio mode; in HTTP mode it's free.
      console.log(`IRIS MCP (streamable HTTP) on http://127.0.0.1:${port}`)
      console.log(`Authorization: Bearer ${token}`)
      console.log(`Mode: ${argv.stateful ? "stateful (sessions)" : "stateless"}`)
      console.log(playbooksEnabled ? "Playbooks: exposed as tools + resources" : "Playbooks: disabled")

      await new Promise<void>((resolve) => {
        process.on("SIGINT", resolve)
        process.on("SIGTERM", resolve)
      })
      return
    }

    // --- Start stdio transport ---
    const transport = new StdioServerTransport()
    await server.connect(transport)

    // #145951: emit a JSON-RPC Parse error (-32700) on malformed input instead of
    // silently dropping the line, so MCP clients aren't left hanging. We chain the
    // SDK's existing onerror (set during connect) rather than clobbering it.
    const prevOnError = transport.onerror?.bind(transport)
    transport.onerror = (error: Error) => {
      prevOnError?.(error)
      if (/JSON|parse/i.test(error?.message ?? "")) {
        // A parse failure carries no request id; per JSON-RPC, respond with id: null.
        transport
          .send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } } as any)
          .catch(() => {})
      }
    }

    // Keep the process alive until stdin closes (MCP client disconnects)
    await new Promise<void>((resolve) => {
      process.stdin.on("close", resolve)
      process.on("SIGINT", resolve)
      process.on("SIGTERM", resolve)
    })
  },
})
