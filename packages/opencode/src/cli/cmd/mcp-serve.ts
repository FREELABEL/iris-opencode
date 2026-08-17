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

# Draft an outreach email
iris outreach send --lead 12345 --channel email --json

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

async function execIris(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Don't auto-append --json — not all commands support it, and yargs strict
  // mode rejects unknown flags (e.g. `leads delete 123 --json` shows help text).
  // The tool description tells agents to use --json when they want structured output.
  const proc = Bun.spawn([IRIS_BIN, ...args], {
    env: { ...process.env, IRIS_NON_INTERACTIVE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })

  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS)

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

Common commands and their subcommands:
- leads: list, get, create, update, delete, note, pulse, gate, gate-all, pulse-all, subscription-update
- bug: report (aliases: submit, new), list (aliases: ls), close (aliases: done, resolve, complete) — NO delete command, use close
- bloqs: list, get, create, update, search, items
- pages: list, get, create, update, push, pull, sync, diff, publish, history, rollback
- agents: list, get, create, update, chat
- outreach: send, campaigns, templates, status
- brands: list, get, create, update, design-tokens (alias: dt)
- invoices: list, get, create, send
- schedules: list, get, create, delete, inspect
- integrations: list, connect, exec, status, test
- workflows: list, get, cancel
- memory: store, search, query, entities
- mail: inbox, read, send, search
- imessage: read, send, search
- partials: list, get, create, update, push, pull
- hive: nodes (list|show), tasks (list|show), campaigns, run <node> "<cmd>"
- n8n: list, pull, push, diff, activate, deactivate, dispatch

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
