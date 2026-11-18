import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { parseConnect, readRemoteAccess, readSwitch, remoteAccessFile, setRemoteAccess } from "../../src/iris/remote-access"

// Settings → Hive → "Allow access to this computer" (epic #192964 W2). The daemon reads the same
// file (iris-bridge daemon/remote-access.js): only an explicit allow:false is OFF.

const home = () => mkdtempSync(path.join(tmpdir(), "ra-"))
const NOW = () => new Date("2026-11-09T15:00:00Z")
const online = async () => ({ node_id: "01a1801e-node" })

describe("remote access switch", () => {
  test("absent file is ON and not explicit; the daemon reads it the same way", () => {
    expect(readSwitch(home())).toEqual({ allow: true, explicit: false })
  })

  test("malformed file is ON, never a lock-out", () => {
    const h = home()
    mkdirSync(path.join(h, ".iris"), { recursive: true })
    writeFileSync(remoteAccessFile(h), "{nope")
    expect(readSwitch(h)).toEqual({ allow: true, explicit: false })
  })

  test("OFF writes allow:false and does NOT run the CLI", async () => {
    const h = home()
    const calls: string[][] = []
    const r = await setRemoteAccess(false, { home: h, cli: "/x/iris", now: NOW, health: online, exec: async (_f, a) => (calls.push(a), { code: 0, stdout: "", stderr: "" }) })
    expect(JSON.parse(readFileSync(remoteAccessFile(h), "utf8"))).toEqual({ allow: false, updated_at: "2026-11-09T15:00:00.000Z", by: "desktop" })
    expect(r).toMatchObject({ measured: true, allow: false, explicit: true })
    expect(calls).toEqual([])
    expect(readSwitch(h)).toEqual({ allow: false, explicit: true })
  })

  test("ON runs `iris hive connect --json` — the sign-in path — and reports the node", async () => {
    const h = home()
    const calls: string[][] = []
    const r = await setRemoteAccess(true, {
      home: h,
      cli: "/x/iris",
      now: NOW,
      health: online,
      exec: async (_f, a) => (calls.push(a), { code: 0, stdout: 'Connecting…\n{"node_id":"01a1801e-node","online":true,"autostart":null}\n', stderr: "" }),
    })
    expect(calls).toEqual([["hive", "connect", "--json"]])
    expect(r).toEqual({ measured: true, allow: true, explicit: true, daemon: "online", nodeId: "01a1801e-node" })
  })

  test("ON that does not come online says so, and keeps the switch ON", async () => {
    const h = home()
    const r = await setRemoteAccess(true, {
      home: h,
      cli: "/x/iris",
      now: NOW,
      health: async () => null,
      exec: async () => ({ code: 1, stdout: '{"node_id":null,"online":false}\n', stderr: "" }),
    })
    expect(r.allow).toBe(true)
    expect(r.daemon).toBe("not-running")
    expect(r.reason).toContain("did not come online")
    expect(readSwitch(h).allow).toBe(true)
  })

  test("ON without the CLI is allowed and explains why nothing started", async () => {
    const r = await setRemoteAccess(true, { home: home(), cli: null, now: NOW, health: async () => null, exec: async () => ({ code: 0, stdout: "", stderr: "" }) })
    expect(r.allow).toBe(true)
    expect(r.reason).toContain("CLI is not installed")
  })

  test("the daemon state comes from /health: no answer, no node id, a node id", async () => {
    const h = home()
    expect((await readRemoteAccess({ home: h, health: async () => null })).daemon).toBe("not-running")
    expect((await readRemoteAccess({ home: h, health: async () => ({ node_id: null }) })).daemon).toBe("not-enrolled")
    expect(await readRemoteAccess({ home: h, health: online })).toMatchObject({ daemon: "online", nodeId: "01a1801e-node" })
  })

  test("parseConnect takes the last JSON line and ignores the spinner", () => {
    expect(parseConnect('◇ Connecting\n{"node_id":"a","online":true}')).toEqual({ node_id: "a", online: true })
    expect(parseConnect("no json here")).toBeNull()
  })
})
