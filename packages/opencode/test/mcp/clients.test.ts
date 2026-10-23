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

  // #190590: `iris mcp install` run once from a throwaway HOME (an install smoke test) saved
  // /tmp/tmp.CN1nv3EnPW/.iris/bin/iris into ~/work/.mcp.json. The folder went away and the IRIS OS
  // tools failed to connect at the start of every session. A path in a temp folder is never saved.
  describe("never registers a binary from a temporary folder (#190590)", () => {
    const tmpRoots = ["/fake-tmp"]

    test("a running binary under the temp folder is replaced by the stable install", async () => {
      const stable = path.join(home, ".iris", "bin", "iris")
      await fs.mkdir(path.dirname(stable), { recursive: true })
      await fs.writeFile(stable, "")
      const bin = McpClients.irisBinary({ execPath: "/fake-tmp/tmp.CN1nv3EnPW/.iris/bin/iris", tmpRoots })
      expect(bin).toBe(stable)
    })

    test("an existing binary in a temp folder is still refused (the incident: it existed when saved)", async () => {
      const tmp = path.join(home, "throwaway")
      const running = path.join(tmp, ".iris", "bin", "iris")
      const stable = path.join(home, ".iris", "bin", "iris")
      for (const f of [running, stable]) {
        await fs.mkdir(path.dirname(f), { recursive: true })
        await fs.writeFile(f, "")
      }
      expect(McpClients.irisBinary({ execPath: running, tmpRoots: [tmp] })).toBe(await fs.realpath(stable))
    })

    test("a temporary HOME is not a stable install either", () => {
      // No iris installed anywhere (a fresh CI runner): the answer is where it WILL be under the
      // account home — never the throwaway $HOME. Machine-independent: the account home is given.
      const bin = McpClients.irisBinary({
        execPath: "/fake-tmp/tmp.X/.iris/bin/iris",
        tmpRoots: ["/fake-tmp", home],
        accountHome: "/no-such-account-home",
      })
      expect(bin).toBe(path.join("/no-such-account-home", ".iris", "bin", "iris"))
    })

    // v1.5.9 shipped the fix above and still saved /tmp/tmp.y3zXyWHlyO/.iris/bin/iris: under Bun,
    // os.userInfo().homedir follows $HOME (Node reads the user database). These change the REAL
    // $HOME, which is what the incident did and what the cases above never exercised.
    test("the account home does not follow a throwaway $HOME", () => {
      // A fresh process, started with HOME pointing into /tmp — the incident. Changing
      // process.env.HOME inside this one is not the same thing: Bun reads HOME at start-up.
      const src = path.resolve(import.meta.dir, "../../src/mcp/clients.ts")
      const r = Bun.spawnSync(
        [process.execPath, "-e", `import { McpClients } from ${JSON.stringify(src)}; console.log(McpClients.accountHome())`],
        { env: { ...process.env, HOME: "/tmp/iris-throwaway-home" } },
      )
      const got = r.stdout.toString().trim()
      expect(got).not.toBe("")
      expect(got).not.toBe("/tmp/iris-throwaway-home")
      expect(McpClients.isTemporaryPath(got)).toBe(false)
    })

    test("with nothing stable to point at, there is no stable binary — install must refuse", () => {
      const bin = McpClients.stableIrisBinary({
        execPath: "/fake-tmp/tmp.X/.iris/bin/iris",
        tmpRoots: ["/fake-tmp", home],
        accountHome: "/fake-tmp/also-throwaway",
      })
      expect(bin).toBeUndefined()
    })

    test("a running binary outside the temp folder is used as is", () => {
      expect(McpClients.irisBinary({ execPath: "/opt/iris/bin/iris", tmpRoots })).toBe("/opt/iris/bin/iris")
    })

    test("temp detection matches the folder, not a name that starts the same", () => {
      expect(McpClients.isTemporaryPath("/fake-tmp/a/iris", tmpRoots)).toBe(true)
      expect(McpClients.isTemporaryPath("/fake-tmp", tmpRoots)).toBe(true)
      expect(McpClients.isTemporaryPath("/fake-tmpfiles/iris", tmpRoots)).toBe(false)
    })
  })

  test("wires Claude Code (mcpServers format) with command + args", async () => {
    const client = McpClients.get("claude-code")!
    const res = await McpClients.wire(client, "/abs/iris")
    expect(res.action).toBe("created")

    const config = JSON.parse(await fs.readFile(client.configPath, "utf8"))
    expect(config.mcpServers["IRIS OS"]).toEqual({ command: "/abs/iris", args: ["mcp", "serve"] })
  })

  test("wires opencode (mcp map, array command) format", async () => {
    const client = McpClients.get("opencode")!
    await McpClients.wire(client, "/abs/iris")

    const config = JSON.parse(await fs.readFile(client.configPath, "utf8"))
    expect(config.mcp["IRIS OS"]).toEqual({ type: "local", command: ["/abs/iris", "mcp", "serve"], enabled: true })
  })

  test("preserves unrelated keys and other servers", async () => {
    const client = McpClients.get("claude-code")!
    await fs.writeFile(
      client.configPath,
      JSON.stringify({ keepMe: 1, mcpServers: { other: { command: "x" } } }),
    )
    await McpClients.wire(client, "/abs/iris")

    const config = JSON.parse(await fs.readFile(client.configPath, "utf8"))
    expect(config.keepMe).toBe(1)
    expect(config.mcpServers.other).toEqual({ command: "x" })
    expect(config.mcpServers["IRIS OS"].command).toBe("/abs/iris")
  })

  test("de-dupes a legacy 'iris' key that runs iris mcp serve (#152285)", async () => {
    const client = McpClients.get("claude-code")!
    await fs.writeFile(
      client.configPath,
      JSON.stringify({ mcpServers: { iris: { command: "iris", args: ["mcp", "serve"] } } }),
    )
    const res = await McpClients.wire(client, "/abs/iris")
    expect(res.action).toBe("updated")

    const config = JSON.parse(await fs.readFile(client.configPath, "utf8"))
    // legacy key collapsed into the canonical one — no duplicate stdio server
    expect(config.mcpServers.iris).toBeUndefined()
    expect(Object.keys(config.mcpServers)).toEqual(["IRIS OS"])
    expect(config.mcpServers["IRIS OS"].command).toBe("/abs/iris")
  })

  test("de-dupes a bash-wrapped entry under a different key", async () => {
    const client = McpClients.get("claude-code")!
    await fs.writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          "IRIS OS legacy": { command: "/bin/bash", args: ["-l", "-c", "exec iris mcp serve"] },
        },
      }),
    )
    await McpClients.wire(client, "/abs/iris")

    const config = JSON.parse(await fs.readFile(client.configPath, "utf8"))
    expect(Object.keys(config.mcpServers)).toEqual(["IRIS OS"])
    expect(config.mcpServers["IRIS OS"].command).toBe("/abs/iris")
  })

  test("wires Gemini CLI into ~/.gemini/settings.json under a parseable key", async () => {
    const client = McpClients.get("gemini")!
    expect(client.configPath).toBe(path.join(home, ".gemini", "settings.json"))

    const res = await McpClients.wire(client, "/abs/iris")
    expect(res.action).toBe("created")

    const config = JSON.parse(await fs.readFile(client.configPath, "utf8"))
    // NOT "IRIS OS": Gemini names tools mcp_<server>_<tool> and parses the
    // server back out at the FIRST underscore, so a key containing a space or
    // underscore breaks includeTools/excludeTools/trust for the whole server.
    expect(Object.keys(config.mcpServers)).toEqual(["iris"])
    expect(config.mcpServers.iris).toEqual({
      command: "/abs/iris",
      args: ["mcp", "serve"],
      // Gemini force-redacts *KEY* host env vars from stdio servers; an explicit
      // entry is applied after that redaction, so this is what preserves a
      // user's exported IRIS_API_KEY.
      env: { IRIS_API_KEY: "$IRIS_API_KEY" },
    })
  })

  test("Gemini: migrates a hand-written 'IRIS OS' entry onto the parseable key", async () => {
    const client = McpClients.get("gemini")!
    await fs.mkdir(path.dirname(client.configPath), { recursive: true })
    await fs.writeFile(
      client.configPath,
      JSON.stringify({
        theme: "Default",
        mcpServers: { "IRIS OS": { command: "iris", args: ["mcp", "serve"] } },
      }),
    )
    await McpClients.wire(client, "/abs/iris")

    const config = JSON.parse(await fs.readFile(client.configPath, "utf8"))
    expect(config.theme).toBe("Default")
    expect(Object.keys(config.mcpServers)).toEqual(["iris"])
    expect(config.mcpServers.iris.command).toBe("/abs/iris")
  })

  test("Gemini: idempotent, and isWired reflects the client-specific key", async () => {
    const client = McpClients.get("gemini")!
    expect(await McpClients.isWired(client)).toBe(false)
    expect((await McpClients.wire(client, "/abs/iris")).action).toBe("created")
    expect((await McpClients.wire(client, "/abs/iris")).action).toBe("unchanged")
    expect(await McpClients.isWired(client)).toBe(true)
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

/**
 * Gemini folder trust (#180123 follow-up, and the live failure on 2026-08-16).
 *
 * `iris mcp install --client gemini` reported success, and every IRIS tool then
 * showed as "Disabled" because the folder was untrusted. The user pasted the
 * docs' `/Users/you/sites/freelabel` placeholder into trustedFolders.json
 * verbatim — trusting a path that does not exist — and nothing connected the
 * clean install to the missing tools. The installer now writes the entry itself.
 */
describe("Gemini folder trust", () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "iris-trust-"))
    prevHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = prevHome
    await fs.rm(home, { recursive: true, force: true })
  })

  test("creates the file and trusts the folder", async () => {
    const res = await McpClients.trustFolderForGemini(path.join(home, "sites"))
    expect(res.action).toBe("added")

    const cfg = JSON.parse(await fs.readFile(McpClients.geminiTrustFile(), "utf8"))
    expect(cfg[path.join(home, "sites")]).toBe("TRUST_FOLDER")
  })

  test("preserves entries someone else already trusted", async () => {
    const file = McpClients.geminiTrustFile()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ "/work/other": "TRUST_FOLDER", "/nope": "DO_NOT_TRUST" }))

    await McpClients.trustFolderForGemini(path.join(home, "sites"))

    const cfg = JSON.parse(await fs.readFile(file, "utf8"))
    expect(cfg["/work/other"]).toBe("TRUST_FOLDER")
    expect(cfg["/nope"]).toBe("DO_NOT_TRUST")
    expect(cfg[path.join(home, "sites")]).toBe("TRUST_FOLDER")
  })

  test("is idempotent, and honours inherited trust from a parent", async () => {
    const parent = path.join(home, "sites")
    await McpClients.trustFolderForGemini(parent)

    // Same folder again…
    expect((await McpClients.trustFolderForGemini(parent)).action).toBe("already-trusted")
    // …and a child, which Gemini already covers by subpath inheritance.
    const child = path.join(parent, "freelabel", "deep")
    expect((await McpClients.trustFolderForGemini(child)).action).toBe("already-trusted")

    const cfg = JSON.parse(await fs.readFile(McpClients.geminiTrustFile(), "utf8"))
    expect(Object.keys(cfg)).toEqual([parent])
  })

  test("refuses to trust the whole home directory", async () => {
    const res = await McpClients.trustFolderForGemini(home)
    expect(res.action).toBe("refused-home")

    // And writes nothing — trusting everything is not an installer's call.
    await expect(fs.readFile(McpClients.geminiTrustFile(), "utf8")).rejects.toThrow()
  })
})
