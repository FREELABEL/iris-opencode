import { describe, expect, test } from "bun:test"
import yargs from "yargs"
import { McpListCommand } from "./mcp"
import { buildMcpListJson } from "./mcp-list-json"

/** #191845 — `iris mcp list --json` was rejected ("Unknown argument: json"). */
describe("buildMcpListJson", () => {
  const clients = [
    { id: "claude-code", label: "Claude Code", configPath: "/h/.claude.json", detected: true, registered: true },
    { id: "cursor", label: "Cursor", configPath: "/h/.cursor/mcp.json", detected: false, registered: false },
  ]

  test("servers carry name, type, target, status, oauth — and an error only when there is one", () => {
    const out = buildMcpListJson(
      [
        { name: "local-one", config: { type: "local", command: ["iris", "mcp", "serve"] }, status: { status: "connected" } },
        { name: "remote-one", config: { type: "remote", url: "https://x.test/mcp", oauth: {} }, status: { status: "failed", error: "boom" } },
        { name: "cold", config: { type: "remote", url: "https://y.test/mcp" } },
      ],
      clients,
    )
    expect(out.ok).toBe(true)
    expect(out.servers).toEqual([
      { name: "local-one", type: "local", target: "iris mcp serve", status: "connected", oauth: false },
      { name: "remote-one", type: "remote", target: "https://x.test/mcp", status: "failed", error: "boom", oauth: true },
      { name: "cold", type: "remote", target: "https://y.test/mcp", status: "not_initialized", oauth: false },
    ])
    expect(out.clients).toEqual(clients.map(({ id, label, registered, detected, configPath }) => ({ id, label, registered, detected, configPath })))
    expect(out.meta).toEqual({ servers: 3, clients_registered: 1 })
  })

  test("no servers is an empty list, still ok", () => {
    const out = buildMcpListJson([], [])
    expect(out).toEqual({ ok: true, servers: [], clients: [], meta: { servers: 0, clients_registered: 0 } })
  })
})

describe("mcp list builder", () => {
  test("strict yargs accepts --json", async () => {
    let parseError: unknown = null
    const argv = await yargs(["list", "--json"])
      // The builder only — the handler would read this machine's real MCP config.
      .command({ ...McpListCommand, handler: () => {} } as any)
      .strict()
      .exitProcess(false)
      .fail((msg, err) => {
        parseError = err ?? new Error(msg)
      })
      .parseAsync()
    expect(parseError).toBeNull()
    expect((argv as any).json).toBe(true)
  })
})
