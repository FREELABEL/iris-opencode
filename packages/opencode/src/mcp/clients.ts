import path from "path"
import os from "os"
import fs from "fs/promises"
import { realpathSync } from "fs"

/**
 * Registry of known MCP clients and how to wire the IRIS MCP server into each.
 *
 * Bug #150264: the installer only scaffolds `~/.iris/mcp.json` (a bespoke format
 * no MCP client reads) and never registers `iris mcp serve` into any real client
 * config — so out of the box ZERO clients see IRIS. This module is the shared
 * source of truth used by `iris mcp install` and `iris mcp list` to fix that.
 */
export namespace McpClients {
  /**
   * Canonical server key written into client configs. Matches the server's own
   * `serverInfo` name ("IRIS OS 1.0.0") and the key hand-written configs already
   * use — so install updates the existing entry in place instead of adding a
   * second one (#152285). `wire()` additionally de-dupes any legacy key
   * ("iris", "iris-local", a bash-wrapped entry) that runs `iris mcp serve`.
   */
  export const SERVER_NAME = "IRIS OS"

  /**
   * Gemini CLI cannot use the canonical key. It builds every tool's function
   * name as `mcp_<serverName>_<toolName>` and then parses the server back out
   * with `/^([^_]+)_(.+)$/` — i.e. the server name is everything up to the FIRST
   * underscore. "IRIS OS" sanitizes to "IRIS_OS", so Gemini reads the server as
   * "IRIS" and the tool as "OS_iris_run", which silently breaks per-server
   * `includeTools`/`excludeTools`, trust and the `/mcp` display. Its own docs say
   * it outright: do not put underscores (or, therefore, spaces) in server names.
   */
  export const GEMINI_SERVER_KEY = "iris"

  /**
   * True if a client entry already launches `iris mcp serve`, under ANY key or
   * format (stdio array, command+args, or a `/bin/bash -l -c "exec iris mcp
   * serve"` wrapper). Used to de-dupe and to detect existing registration.
   */
  function isIrisServeEntry(entry: unknown): boolean {
    if (!entry || typeof entry !== "object") return false
    const e = entry as Record<string, unknown>
    const parts: string[] = []
    if (Array.isArray(e.command)) parts.push(...e.command.map(String))
    else if (typeof e.command === "string") parts.push(e.command)
    if (Array.isArray(e.args)) parts.push(...e.args.map(String))
    const joined = parts.join(" ").toLowerCase()
    const refsIris = joined.includes("iris")
    return refsIris && joined.includes("mcp") && joined.includes("serve")
  }

  /**
   * Two on-disk shapes clients use for a local (stdio) server:
   *  - "mcpServers": Claude Code / Claude Desktop / Cursor / project .mcp.json
   *      { "mcpServers": { "iris": { "command": "<abs>", "args": ["mcp","serve"] } } }
   *  - "opencode": opencode.json
   *      { "mcp": { "iris": { "type": "local", "command": ["<abs>","mcp","serve"], "enabled": true } } }
   *
   * Gemini CLI reuses the "mcpServers" shape (in ~/.gemini/settings.json), so it
   * needs no new format — only a different server KEY. See GEMINI_SERVER_KEY.
   */
  export type Format = "mcpServers" | "opencode"

  export interface Client {
    id: string
    label: string
    /** Absolute path to the client's MCP config file. */
    configPath: string
    format: Format
    /**
     * Whether this client appears installed on the machine. Project targets are
     * always "available" (we can always write a project .mcp.json).
     */
    detected: boolean
    /**
     * Key the server is written under, when the client cannot handle the
     * canonical SERVER_NAME. Defaults to SERVER_NAME.
     */
    serverKey?: string
  }

  /** The key this client's config should store the IRIS server under. */
  export function serverKey(client: Client): string {
    return client.serverKey ?? SERVER_NAME
  }

  /**
   * Resolve the absolute path to the running `iris` binary. Using an absolute
   * path (not the bare `iris`) is what makes GUI-launched clients — which spawn
   * the command WITHOUT a login shell, so `~/.zshrc` PATH edits don't apply —
   * able to start the server. Falls back to the canonical install location.
   */
  export function irisBinary(): string {
    try {
      const real = realpathSync(process.execPath)
      // When running the shipped binary, execPath IS iris. When running from
      // source (bun dev), it's the bun runtime — fall back to the install path.
      if (/[\\/](iris|opencode)$/i.test(real) || real.includes(`${path.sep}.iris${path.sep}`)) {
        return real
      }
    } catch {
      // ignore — fall through to the default location
    }
    return path.join(homeDir(), ".iris", "bin", "iris")
  }

  /**
   * Home directory. Honors OPENCODE_TEST_HOME for test isolation (matching
   * Global.Path.home) — `os.homedir()` is cached at process start and ignores a
   * runtime `process.env.HOME` change, so tests must use the explicit override.
   */
  function homeDir(): string {
    return process.env.OPENCODE_TEST_HOME || os.homedir()
  }

  function exists(p: string): boolean {
    try {
      return realpathSync(p) !== undefined
    } catch {
      return false
    }
  }

  /**
   * Build the full registry of known clients for the current platform.
   * @param projectDir - cwd used for the project `.mcp.json` target.
   */
  export function all(projectDir = process.cwd()): Client[] {
    const home = homeDir()
    const clients: Client[] = []

    // Claude Code — global ~/.claude.json (mcpServers map at top level).
    const claudeCode = path.join(home, ".claude.json")
    clients.push({
      id: "claude-code",
      label: "Claude Code",
      configPath: claudeCode,
      format: "mcpServers",
      detected: exists(claudeCode) || exists(path.join(home, ".claude")),
    })

    // Claude Desktop — platform-specific location.
    let claudeDesktop: string
    if (process.platform === "darwin") {
      claudeDesktop = path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    } else if (process.platform === "win32") {
      claudeDesktop = path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
    } else {
      claudeDesktop = path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude", "claude_desktop_config.json")
    }
    clients.push({
      id: "claude-desktop",
      label: "Claude Desktop",
      configPath: claudeDesktop,
      format: "mcpServers",
      detected: exists(claudeDesktop) || exists(path.dirname(claudeDesktop)),
    })

    // Cursor — ~/.cursor/mcp.json (mcpServers map).
    const cursor = path.join(home, ".cursor", "mcp.json")
    clients.push({
      id: "cursor",
      label: "Cursor",
      configPath: cursor,
      format: "mcpServers",
      detected: exists(cursor) || exists(path.join(home, ".cursor")),
    })

    // opencode — ~/.config/opencode/opencode.json (mcp map, array command).
    const opencodeDir = process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
      : path.join(home, ".config", "opencode")
    const opencode = path.join(opencodeDir, "opencode.json")
    clients.push({
      id: "opencode",
      label: "opencode",
      configPath: opencode,
      format: "opencode",
      detected: exists(opencode) || exists(opencodeDir),
    })

    // Gemini CLI — ~/.gemini/settings.json, same "mcpServers" shape as Claude
    // Code, but keyed "iris" (GEMINI_SERVER_KEY) because of its tool-name
    // parsing. Two other Gemini-specific facts, verified against the shipped
    // bundle rather than assumed:
    //  - stdio servers only start in a TRUSTED folder (`gemini trust`), and
    //  - Gemini force-redacts *KEY*/*TOKEN*/*SECRET* host env vars from the
    //    spawned process. That is survivable here because `iris` reads its
    //    canonical token from ~/.iris/sdk/.env and HOME is never redacted — but
    //    a user who only exports IRIS_API_KEY would lose it, so we pass it
    //    through explicitly (entry `env` is applied AFTER sanitization).
    const gemini = path.join(home, ".gemini", "settings.json")
    clients.push({
      id: "gemini",
      label: "Gemini CLI",
      configPath: gemini,
      format: "mcpServers",
      serverKey: GEMINI_SERVER_KEY,
      detected: exists(gemini) || exists(path.join(home, ".gemini")),
    })

    // Project — a .mcp.json in the working directory (Claude Code reads this).
    clients.push({
      id: "project",
      label: "Project (.mcp.json)",
      configPath: path.join(projectDir, ".mcp.json"),
      format: "mcpServers",
      detected: true,
    })

    return clients
  }

  export function get(id: string, projectDir = process.cwd()): Client | undefined {
    return all(projectDir).find((c) => c.id === id)
  }

  /** Build the IRIS server entry in the shape the given client expects. */
  function entryFor(client: Client, bin: string): Record<string, unknown> {
    if (client.format === "opencode") {
      return { type: "local", command: [bin, "mcp", "serve"], enabled: true }
    }
    if (client.id === "gemini") {
      // Explicit env survives Gemini's forced redaction of *KEY* host vars: the
      // entry is merged in AFTER sanitization, and — unlike `headers`, which
      // Gemini expands against the SANITIZED env and would therefore silently
      // turn "$IRIS_API_KEY" into "" — stdio `env` is expanded against the raw
      // process env. An unset variable just expands to "", and the CLI then
      // falls back to ~/.iris/sdk/.env, its canonical token location.
      return { command: bin, args: ["mcp", "serve"], env: { IRIS_API_KEY: "$IRIS_API_KEY" } }
    }
    return { command: bin, args: ["mcp", "serve"] }
  }

  async function readJson(p: string): Promise<Record<string, any>> {
    try {
      const text = await fs.readFile(p, "utf8")
      const trimmed = text.trim()
      if (!trimmed) return {}
      return JSON.parse(trimmed)
    } catch {
      return {}
    }
  }

  export interface WireResult {
    client: Client
    action: "created" | "updated" | "unchanged"
    bin: string
  }

  /**
   * Idempotently wire the IRIS server into a client config. Preserves all other
   * keys/servers. Returns whether the file was created, updated, or already
   * correct.
   */
  export async function wire(client: Client, bin = irisBinary()): Promise<WireResult> {
    const existed = exists(client.configPath)
    const config = await readJson(client.configPath)
    const entry = entryFor(client, bin)
    const key = serverKey(client)

    const mapKey = client.format === "opencode" ? "mcp" : "mcpServers"
    if (typeof config[mapKey] !== "object" || config[mapKey] === null) config[mapKey] = {}
    const map = config[mapKey] as Record<string, unknown>

    // De-dupe (#152285): remove any OTHER key that already runs `iris mcp serve`
    // (legacy "iris"/"iris-local", or a hand-written "IRIS OS" under a different
    // casing) so the client doesn't load the same tools twice. For Gemini this
    // also migrates a previously hand-written "IRIS OS" entry onto the key its
    // tool-name parser can actually read.
    let removedOther = false
    for (const k of Object.keys(map)) {
      if (k !== key && isIrisServeEntry(map[k])) {
        delete map[k]
        removedOther = true
      }
    }

    const before = JSON.stringify(map[key])
    map[key] = entry
    const after = JSON.stringify(entry)

    if (existed && !removedOther && before === after) {
      return { client, action: "unchanged", bin }
    }

    await fs.mkdir(path.dirname(client.configPath), { recursive: true })
    await fs.writeFile(client.configPath, JSON.stringify(config, null, 2) + "\n", "utf8")
    return { client, action: existed ? "updated" : "created", bin }
  }

  /**
   * Whether the IRIS server is already present in a client's config — under the
   * canonical key OR any other key that runs `iris mcp serve` (so `mcp list`
   * reports a hand-written "IRIS OS"/"iris" entry as registered too).
   */
  export async function isWired(client: Client): Promise<boolean> {
    const config = await readJson(client.configPath)
    const mapKey = client.format === "opencode" ? "mcp" : "mcpServers"
    const map = config?.[mapKey]
    if (!map || typeof map !== "object") return false
    if (map[serverKey(client)]) return true
    return Object.values(map).some((e) => isIrisServeEntry(e))
  }
}
