import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { McpClients } from "../../mcp/clients"

/**
 * `iris mcp install` — idempotently register `iris mcp serve` into detected MCP
 * client configs (Claude Code, Claude Desktop, Cursor, Gemini CLI, opencode,
 * project .mcp.json) using an ABSOLUTE binary path so GUI-launched clients (no
 * login shell) can resolve it. Closes bug #150264.
 */
export const McpInstallCommand = cmd({
  command: "install",
  describe: "register the IRIS MCP server into your MCP clients (Claude Code, Cursor, Gemini CLI, opencode, ...)",
  builder: (yargs) =>
    yargs
      .option("client", {
        type: "string",
        describe: "wire only this client (claude-code|claude-desktop|cursor|gemini|opencode|project)",
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
      })
      .option("trust", {
        type: "boolean",
        default: true,
        describe: "add the working folder to Gemini's trusted list (--no-trust to skip)",
      })
      .option("trust-path", {
        type: "string",
        describe: "folder to trust for Gemini instead of the current directory",
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

    // Registering the server is only half a Gemini install. Gemini disables EVERY
    // MCP server in a folder it does not trust and calls it "Disabled", so without
    // a trust entry the user sees a clean success here and then no IRIS tools at
    // all. Do it for them — a client should not have to hand-edit JSON, and a
    // placeholder path in documentation WILL be pasted verbatim (it was).
    if (results.some((r) => r.client.id === "gemini" && r.action !== "error") && args.trust !== false) {
      const target = (args["trust-path"] as string) || process.cwd()
      try {
        const t = await McpClients.trustFolderForGemini(target)
        if (t.action === "added") {
          prompts.log.info(`✓ Trusted ${UI.Style.TEXT_HIGHLIGHT}${t.folder}${UI.Style.TEXT_NORMAL} for Gemini ${UI.Style.TEXT_DIM}(inherited by subfolders)`)
        } else if (t.action === "already-trusted") {
          prompts.log.info(`○ ${UI.Style.TEXT_DIM}${t.folder} is already trusted for Gemini`)
        } else {
          // Trusting $HOME would trust every folder the user will ever have.
          prompts.log.warn(
            `Not trusting your home directory for Gemini — that would trust everything.\n` +
              `    Re-run from your projects folder, or: ${UI.Style.TEXT_HIGHLIGHT}iris mcp install --client gemini --trust-path ~/sites${UI.Style.TEXT_NORMAL}`,
          )
        }
      } catch (e) {
        prompts.log.warn(`Could not write Gemini's trusted-folders file: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    const changed = results.filter((r) => r.action === "created" || r.action === "updated").length
    prompts.outro(
      changed > 0
        ? `Wired ${changed} client(s). Restart the client to load IRIS tools.`
        : `All ${results.length} client(s) already configured.`,
    )
  },
})
