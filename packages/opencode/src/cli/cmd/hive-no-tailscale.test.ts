import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { resolveSshTarget, tailscaleDisabled } from "./hive-tailscale"
import { remoteCommand } from "./platform-hive-net"

/**
 * Hive without Tailscale (epic #191642, task 1.1 #191649). The exit check forces "no Tailscale"
 * with IRIS_HIVE_NO_TAILSCALE=1 because the machines it runs on must keep Tailscale up. A flag
 * that only SOME paths honour would let a tailnet address leak into a run that claims to have
 * none — these pin that every tailnet source is refused.
 */
const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

function cacheWith(nodeId: string, host: string) {
  const dir = mkdtempSync(join(tmpdir(), "hwt-"))
  const file = join(dir, "hive-ssh.json")
  writeFileSync(file, JSON.stringify({ [nodeId]: { host, user: "someone" } }))
  process.env.IRIS_HIVE_SSH_CACHE = file
}

describe("IRIS_HIVE_NO_TAILSCALE", () => {
  test("reads 1/true/yes as on, anything else as off", () => {
    for (const v of ["1", "true", "YES", " 1 "]) expect(tailscaleDisabled({ IRIS_HIVE_NO_TAILSCALE: v })).toBe(true)
    for (const v of [undefined, "", "0", "false", "no"]) expect(tailscaleDisabled({ IRIS_HIVE_NO_TAILSCALE: v })).toBe(false)
  })

  test("a CACHED tailnet address is not used", async () => {
    cacheWith("n1", "100.79.138.21")
    process.env.IRIS_HIVE_NO_TAILSCALE = "1"
    const r = await resolveSshTarget("n1", "iris-hive-002")
    expect("error" in r && r.error).toMatch(/IRIS_HIVE_NO_TAILSCALE/)
  })

  test("the address the node ADVERTISED is not used", async () => {
    cacheWith("other", "1.2.3.4")
    process.env.IRIS_HIVE_NO_TAILSCALE = "1"
    const r = await resolveSshTarget("n1", "iris-hive-002", { advertised: "100.79.138.21" })
    expect("error" in r).toBe(true)
  })

  test("an explicit --host is still honoured — a person named it", async () => {
    cacheWith("other", "1.2.3.4")
    process.env.IRIS_HIVE_NO_TAILSCALE = "1"
    const r = await resolveSshTarget("n1", "iris-hive-002", { host: "192.168.1.9" })
    expect("error" in r ? r.error : r.host).toBe("192.168.1.9")
  })

  test("without the flag the cache still wins, as before", async () => {
    cacheWith("n1", "100.79.138.21")
    delete process.env.IRIS_HIVE_NO_TAILSCALE
    const r = await resolveSshTarget("n1", "iris-hive-002")
    expect("error" in r ? r.error : r.host).toBe("100.79.138.21")
  })
})

describe("iris hive ssh B -- <command>", () => {
  test("everything after -- is the remote command", () => {
    expect(remoteCommand({ "--": ["echo", "hi"] })).toBe("echo hi")
    expect(remoteCommand({ "--": ["true"] })).toBe("true")
  })
  test("--cmd wins; nothing means an interactive shell", () => {
    expect(remoteCommand({ cmd: "uptime", "--": ["true"] })).toBe("uptime")
    expect(remoteCommand({})).toBeUndefined()
    expect(remoteCommand({ "--": [] })).toBeUndefined()
  })
})
