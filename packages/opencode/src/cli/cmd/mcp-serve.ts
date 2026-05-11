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
import { homedir } from "os"
import { join } from "path"

const IRIS_BIN = join(homedir(), ".iris", "bin", "iris")
const HOWTO_DIR = join(homedir(), ".iris", "how-to")
const MAX_OUTPUT = 100 * 1024 // 100KB
const TIMEOUT_MS = 30_000

// Known commands from the registry (populated at startup)
let knownCommands: Set<string> = new Set()

function buildCommandCatalog(): string {
  const commands = getRegistry()
  knownCommands = new Set(commands.map((c) => c.name))

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

  // Reject shell injection vectors — args are passed via Bun.spawn (no shell),
  // so only block chars that could chain/inject commands if a shell were involved.
  // Safe in direct spawn: & $ ! % # @ ? ^
  const dangerous = /[;|`\\<>\n\r]/
  for (const arg of args) {
    if (dangerous.test(arg)) {
      return { args: [], error: `Rejected: shell metacharacter found in argument "${arg}". Pass arguments individually, not as a shell expression.` }
    }
  }

  // Validate first arg is a known command
  const firstArg = args[0]
  if (knownCommands.size > 0 && !knownCommands.has(firstArg)) {
    // Check aliases
    const registry = getRegistry()
    const match = registry.find((c) => c.aliases.includes(firstArg))
    if (!match) {
      return { args: [], error: `Unknown command "${firstArg}". Use iris_help to discover available commands, or read the iris://commands resource.` }
    }
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

    return {
      stdout: stdout.length > MAX_OUTPUT ? stdout.slice(0, MAX_OUTPUT) + "\n...(truncated)" : stdout,
      stderr: stderr.length > MAX_OUTPUT ? stderr.slice(0, MAX_OUTPUT) + "\n...(truncated)" : stderr,
      exitCode,
    }
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

export const McpServeCommand = cmd({
  command: "serve",
  describe: "start IRIS MCP gateway server (stdio)",
  async handler() {
    // Build registry so knownCommands is populated
    buildCommandCatalog()

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
      ],
    }))

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params
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
          description: "Execute any IRIS CLI command. Add --json for structured output on list/get commands. Omit --json for action commands (delete, create, update). Example: 'leads list --search acme --json'",
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
      ],
    }))

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params

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

          return { content: [{ type: "text" as const, text: result.stdout || "(no output)" }] }
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

      return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true }
    })

    // --- Start stdio transport ---
    const transport = new StdioServerTransport()
    await server.connect(transport)

    // Keep the process alive until stdin closes (MCP client disconnects)
    await new Promise<void>((resolve) => {
      process.stdin.on("close", resolve)
      process.on("SIGINT", resolve)
      process.on("SIGTERM", resolve)
    })
  },
})
