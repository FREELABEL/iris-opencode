import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { McpClients } from "../../src/mcp/clients"

/**
 * Bug #150264: the installer scaffolded ~/.iris/mcp.json (a format no MCP client
 * reads) but never registered the server into a real client config. These tests
 * lock in the registration behavior of `iris mcp install`.
 */
describe("McpClients registration", () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "iris-mcp-"))
    // os.homedir() is cached at process start; the code honors OPENCODE_TEST_HOME
    // for isolation, so tests never touch the real ~/.claude.json etc.
    prevHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = prevHome
    await fs.rm(home, { recursive: true, force: true })
  })

  test("resolves an absolute iris binary path (never bare 'iris')", () => {
    const bin = McpClients.irisBinary()
    expect(path.isAbsolute(bin)).toBe(true)
    expect(bin).not.toBe("iris")
  })

  test("wires Claude Code (mcpServers format) with command + args", async () => {
    const client = McpClients.get("claude-code")!
    const res = await McpClients.wire(client, "/abs/iris")
    expect(res.action).toBe("created")

    const config = JSON.parse(await fs.readFile(client.configPath, "utf8"))
    expect(config.mcpServers.iris).toEqual({ command: "/abs/iris", args: ["mcp", "serve"] })
  })

  test("wires opencode (mcp map, array command) format", async () => {
    const client = McpClients.get("opencode")!
    await McpClients.wire(client, "/abs/iris")

    const config = JSON.parse(await fs.readFile(client.configPath, "utf8"))
    expect(config.mcp.iris).toEqual({ type: "local", command: ["/abs/iris", "mcp", "serve"], enabled: true })
  })

  test("preserves existing keys and other servers", async () => {
    const client = McpClients.get("claude-code")!
    await fs.writeFile(
      client.configPath,
      JSON.stringify({ keepMe: 1, mcpServers: { other: { command: "x" } } }),
    )
    await McpClients.wire(client, "/abs/iris")

    const config = JSON.parse(await fs.readFile(client.configPath, "utf8"))
    expect(config.keepMe).toBe(1)
    expect(config.mcpServers.other).toEqual({ command: "x" })
    expect(config.mcpServers.iris.command).toBe("/abs/iris")
  })

  test("is idempotent — second wire reports unchanged", async () => {
    const client = McpClients.get("cursor")!
    const first = await McpClients.wire(client, "/abs/iris")
    const second = await McpClients.wire(client, "/abs/iris")
    expect(first.action).toBe("created")
    expect(second.action).toBe("unchanged")
  })

  test("isWired reflects registration state", async () => {
    const client = McpClients.get("cursor")!
    expect(await McpClients.isWired(client)).toBe(false)
    await McpClients.wire(client, "/abs/iris")
    expect(await McpClients.isWired(client)).toBe(true)
  })
})
