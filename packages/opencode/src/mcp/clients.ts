import path from "path"
import os from "os"
import fs from "fs/promises"
import { readFileSync, realpathSync } from "fs"
import { spawnSync } from "child_process"

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

  // ── Gemini folder trust ───────────────────────────────────────────────
  //
  // Gemini disables EVERY MCP server — local and remote — in a folder it does
  // not trust, and reports it as "Disabled" rather than as an error. Registering
  // the server is therefore only half an install: without a trust entry the user
  // sees a clean success from `iris mcp install` and then no IRIS tools at all,
  // with nothing connecting the two.
  //
  // We write the entry ourselves rather than printing instructions. Telling a
  // non-technical user to hand-edit JSON is how a `/Users/you/...` placeholder
  // ends up in a real config file, trusting a folder that does not exist.

  export function geminiTrustFile(): string {
    return path.join(homeDir(), ".gemini", "trustedFolders.json")
  }

  export type TrustResult =
    | { action: "added" | "already-trusted"; folder: string; file: string }
    | { action: "refused-home"; folder: string; file: string }

  /**
   * Add `folder` to Gemini's trusted list, preserving every other entry.
   *
   * Trust is inherited by subfolders, so one entry covers a whole projects
   * directory. We refuse to trust the home directory outright: that would trust
   * every folder the user will ever have, which is not a decision an installer
   * gets to make silently on someone's behalf.
   */
  export async function trustFolderForGemini(folder: string): Promise<TrustResult> {
    const file = geminiTrustFile()
    const resolved = path.resolve(folder)

    if (resolved === path.resolve(homeDir())) {
      return { action: "refused-home", folder: resolved, file }
    }

    const config = await readJson(file)
    // Already covered? Trust is inherited, so a parent entry counts.
    for (const [rule, level] of Object.entries(config)) {
      if (level !== "TRUST_FOLDER" && level !== "TRUST_PARENT") continue
      const base = path.resolve(rule)
      if (resolved === base || resolved.startsWith(base + path.sep)) {
        return { action: "already-trusted", folder: resolved, file }
      }
    }

    config[resolved] = "TRUST_FOLDER"
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf8")
    return { action: "added", folder: resolved, file }
  }

  /**
   * Resolve the absolute path to the running `iris` binary. Using an absolute
   * path (not the bare `iris`) is what makes GUI-launched clients — which spawn
   * the command WITHOUT a login shell, so `~/.zshrc` PATH edits don't apply —
   * able to start the server. Falls back to the canonical install location.
   *
   * Never a path in a temporary folder (#190590): run once from a throwaway HOME, this saved
   * /tmp/tmp.CN1nv3EnPW/.iris/bin/iris into a project .mcp.json, and every later session failed
   * to start the server once that folder was gone. The stable install is checked under $HOME and
   * under the account's real home, because a throwaway HOME is exactly the case being refused.
   */
  export function irisBinary(opts: { execPath?: string; tmpRoots?: string[]; accountHome?: string } = {}): string {
    const found = stableIrisBinary(opts)
    if (found) return found
    // Nothing installed yet: still name where it WILL be, never a temp folder (some callers write
    // this into a launch agent or a PATH). The account home first: a throwaway $HOME is the trap.
    const tmpRoots = opts.tmpRoots ?? temporaryRoots()
    return (
      [opts.accountHome ?? accountHome(), homeDir()]
        .map((home) => path.join(home, ".iris", "bin", "iris"))
        .find((p) => !isTemporaryPath(p, tmpRoots)) ?? path.join(homeDir(), ".iris", "bin", "iris")
    )
  }

  /**
   * The iris binary to WRITE into a config: never one in a temporary folder, or undefined when
   * nothing stable exists. `iris mcp install` refuses on undefined rather than saving a path that
   * will disappear (#190590).
   */
  export function stableIrisBinary(opts: { execPath?: string; tmpRoots?: string[]; accountHome?: string } = {}): string | undefined {
    const tmpRoots = opts.tmpRoots ?? temporaryRoots()
    try {
      const real = realpathSync(opts.execPath ?? process.execPath)
      // When running the shipped binary, execPath IS iris. When running from
      // source (bun dev), it's the bun runtime — fall back to the install path.
      if ((/[\\/](iris|opencode)$/i.test(real) || real.includes(`${path.sep}.iris${path.sep}`)) && !isTemporaryPath(real, tmpRoots)) {
        return real
      }
    } catch {
      // A path that no longer resolves is used as given, if it is not temporary.
      if (opts.execPath && !isTemporaryPath(opts.execPath, tmpRoots)) return opts.execPath
    }
    const stable = [homeDir(), opts.accountHome ?? accountHome()]
      .map((home) => path.join(home, ".iris", "bin", "iris"))
      .filter((p) => !isTemporaryPath(p, tmpRoots))
    return stable.find(exists)
  }

  /** True when `p` is inside one of the temp roots (the folder itself counts; a sibling named alike does not). */
  export function isTemporaryPath(p: string, tmpRoots: string[] = temporaryRoots()): boolean {
    const target = path.resolve(p)
    return tmpRoots.some((root) => {
      const r = path.resolve(root)
      return target === r || target.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
    })
  }

  function temporaryRoots(): string[] {
    const roots = new Set([os.tmpdir(), "/tmp", "/var/tmp", "/var/folders", "/private/tmp", "/private/var/folders"])
    for (const r of [...roots]) {
      try {
        roots.add(realpathSync(r))
      } catch {
        // not on this platform
      }
    }
    return [...roots]
  }

  /**
   * The account's home from the system's user database — not $HOME, which a throwaway shell can
   * point anywhere. Under Bun, os.userInfo().homedir FOLLOWS $HOME (Node reads getpwuid), which is
   * how v1.5.9 still saved a temp path (#190590). So: getent/passwd on Linux, the directory
   * service on macOS; $HOME-based answers only as a last resort.
   */
  export function accountHome(): string {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined
    if (uid !== undefined) {
      if (process.platform === "darwin") {
        const out = runQuiet("dscacheutil", ["-q", "user", "-a", "uid", String(uid)])
        const dir = out?.match(/^dir:\s*(.+)$/m)?.[1]?.trim()
        if (dir) return dir
      } else {
        const line =
          runQuiet("getent", ["passwd", String(uid)])?.trim() ||
          readPasswd().find((l) => l.split(":")[2] === String(uid))
        const dir = line?.split(":")[5]
        if (dir) return dir
      }
    }
    try {
      return os.userInfo().homedir
    } catch {
      return homeDir()
    }
  }

  function runQuiet(cmd: string, args: string[]): string | undefined {
    try {
      const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 2000 })
      return r.status === 0 ? r.stdout : undefined
    } catch {
      return undefined
    }
  }

  function readPasswd(): string[] {
    try {
      return readFileSync("/etc/passwd", "utf8").split("\n")
    } catch {
      return []
    }
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
