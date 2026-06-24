import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { McpClients } from "../../mcp/clients"

/**
 * `iris mcp install` — idempotently register `iris mcp serve` into detected MCP
 * client configs (Claude Code, Claude Desktop, Cursor, opencode, project
 * .mcp.json) using an ABSOLUTE binary path so GUI-launched clients (no login
 * shell) can resolve it. Closes bug #150264.
 */
export const McpInstallCommand = cmd({
  command: "install",
  describe: "register the IRIS MCP server into your MCP clients (Claude Code, Cursor, opencode, ...)",
  builder: (yargs) =>
    yargs
      .option("client", {
        type: "string",
        describe: "wire only this client (claude-code|claude-desktop|cursor|opencode|project)",
      })
      .option("all", {
        type: "boolean",
        default: false,
        describe: "wire every known client, even ones not detected on this machine",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "machine-readable output",
      }),
  async handler(args) {
    const bin = McpClients.irisBinary()
    const registry = McpClients.all()

    // Pick targets: explicit --client, else all known with --all, else detected.
    let targets: McpClients.Client[]
    if (args.client) {
      const match = registry.find((c) => c.id === args.client)
      if (!match) {
        if (args.json) {
          process.stdout.write(JSON.stringify({ error: `unknown client: ${args.client}`, known: registry.map((c) => c.id) }) + "\n")
        } else {
          UI.error(`Unknown client: ${args.client}`)
          UI.println(`Known: ${registry.map((c) => c.id).join(", ")}`)
        }
        process.exitCode = 1
        return
      }
      targets = [match]
    } else if (args.all) {
      targets = registry
    } else {
      // Default: detected clients + the project target (always useful for Claude Code).
      targets = registry.filter((c) => c.detected)
      if (targets.length === 0) targets = registry.filter((c) => c.id === "project")
    }

    const results = []
    for (const client of targets) {
      try {
        results.push(await McpClients.wire(client, bin))
      } catch (e) {
        results.push({ client, action: "error" as const, bin, error: e instanceof Error ? e.message : String(e) })
      }
    }

    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            binary: bin,
            wired: results.map((r) => ({
              id: r.client.id,
              path: r.client.configPath,
              action: r.action,
              ...("error" in r ? { error: (r as any).error } : {}),
            })),
          },
          null,
          2,
        ) + "\n",
      )
      return
    }

    UI.empty()
    prompts.intro("Install IRIS MCP server")
    prompts.log.info(`Binary: ${UI.Style.TEXT_DIM}${bin}`)

    for (const r of results) {
      const icon = r.action === "error" ? "✗" : r.action === "unchanged" ? "○" : "✓"
      const label = r.action === "error" ? `failed — ${(r as any).error}` : r.action
      prompts.log.info(`${icon} ${r.client.label} ${UI.Style.TEXT_DIM}${label}\n    ${UI.Style.TEXT_DIM}${r.client.configPath}`)
    }

    const changed = results.filter((r) => r.action === "created" || r.action === "updated").length
    prompts.outro(
      changed > 0
        ? `Wired ${changed} client(s). Restart the client to load IRIS tools.`
        : `All ${results.length} client(s) already configured.`,
    )
  },
})
