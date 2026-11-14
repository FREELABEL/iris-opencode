import { describe, expect, test } from "bun:test"
import { createServer, type Server } from "net"
import { readFileSync } from "fs"
import { join } from "path"
import { tcpProbe } from "./hive-port"

/**
 * #191565: `iris hive ssh <ip>` on Linux always said "port 22 is closed" — the probe was
 * `nc -z -G`, and `-G` exists only in macOS's nc. These run a real listener on this machine.
 */
const listen = (onConn?: (s: import("net").Socket) => void): Promise<{ server: Server; port: number }> =>
  new Promise((r) => {
    const server = createServer((s) => (onConn ? onConn(s) : s.end()))
    server.listen(0, "127.0.0.1", () => r({ server, port: (server.address() as any).port }))
  })

describe("tcpProbe (#191565)", () => {
  test("an open port reads open — on Linux too", async () => {
    const { server, port } = await listen()
    expect((await tcpProbe("127.0.0.1", port)).open).toBe(true)
    server.close()
  })

  test("a closed port reads closed", async () => {
    const { server, port } = await listen()
    await new Promise((r) => server.close(r))
    expect((await tcpProbe("127.0.0.1", port, { timeoutMs: 1000 })).open).toBe(false)
  })

  test("reads the first line a server says (the ssh banner)", async () => {
    const { server, port } = await listen((s) => s.write("SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13\r\nrest"))
    const r = await tcpProbe("127.0.0.1", port, { banner: true })
    expect(r).toEqual({ open: true, banner: "SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13" })
    server.close()
  })

  test("an open port that says nothing is still open", async () => {
    const { server, port } = await listen(() => {})
    const r = await tcpProbe("127.0.0.1", port, { banner: true, timeoutMs: 300 })
    expect(r).toEqual({ open: true, banner: null })
    server.close()
  })

  test("no probe in hive ssh/probe shells out to nc (macOS-only -G flag)", () => {
    const src = readFileSync(join(import.meta.dir, "platform-hive-net.ts"), "utf8")
    expect(src).not.toMatch(/["'`]nc["'`]|\bnc -/)
  })
})

describe("hive ssh asks 'is this me?' over the whole node list (#191564)", () => {
  test("never with only the target — the daemon's own id must be in the list it is checked against", () => {
    const src = readFileSync(join(import.meta.dir, "platform-hive-net.ts"), "utf8")
    expect(src).not.toMatch(/detectLocalNodeId\(\[node\]\)/)
    expect(src).toMatch(/detectLocalNodeId\(all\)/)
  })
})
