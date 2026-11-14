import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { connect, createServer, type Server } from "net"
import { createServer as createTlsServer, type Server as TlsServer } from "tls"
import { PassThrough } from "stream"
import { mkdtempSync, readdirSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawnSync } from "child_process"
import {
  consumeTicket,
  gateTunnelName,
  issueTicket,
  parseGateLine,
  parseGateOffer,
  proxyConnect,
  selfCommand,
  startGate,
} from "./hive-relay-ssh"
import { relaySshArgs, sshPath } from "./platform-hive-net"

/**
 * `iris hive ssh` over the Hive relay (#191650). The security claim is "nothing reaches sshd
 * without a single-use ticket minted on the node, and the relay cannot read or impersonate the
 * session". These tests run the real gate and the real ProxyCommand over real sockets; the only
 * stand-ins are sshd (an echo server) and the relay runner (a TLS server that terminates TLS and
 * pipes plaintext to the gate — exactly what relay/client.js does on the node).
 */
const home = () => mkdtempSync(join(tmpdir(), "gate-"))

describe("tickets", () => {
  test("a ticket works once", () => {
    const h = home()
    const t = issueTicket(h, "n-ssh")
    expect(consumeTicket(h, "n-ssh", t)).toBe(true)
    expect(consumeTicket(h, "n-ssh", t)).toBe(false)
  })

  test("an expired ticket is refused", () => {
    const h = home()
    const t = issueTicket(h, "n-ssh", Date.now() - 120_000, 60_000)
    expect(consumeTicket(h, "n-ssh", t)).toBe(false)
  })

  test("a ticket for another gate, or one never issued, is refused", () => {
    const h = home()
    const t = issueTicket(h, "a-ssh")
    expect(consumeTicket(h, "b-ssh", t)).toBe(false)
    expect(consumeTicket(h, "a-ssh", "x".repeat(43))).toBe(false)
    expect(consumeTicket(h, "a-ssh", "../../etc/passwd")).toBe(false)
  })

  test("only a hash is written down — the ticket itself is not on disk", () => {
    const h = home()
    const t = issueTicket(h, "n-ssh")
    const dir = join(h, ".iris", "tunnels", "n-ssh", "tickets")
    const files = readdirSync(dir)
    expect(files.length).toBe(1)
    expect(files[0]).not.toContain(t)
    expect(readFileSync(join(dir, files[0]), "utf8")).not.toContain(t)
  })
})

describe("wire format", () => {
  test("gate line", () => {
    expect(parseGateLine("HIVE-GATE/1 " + "a".repeat(43))).toBe("a".repeat(43))
    expect(parseGateLine("HIVE-GATE/1 " + "a".repeat(43) + "\r")).toBe("a".repeat(43))
    expect(parseGateLine("SSH-2.0-OpenSSH_9.6")).toBeNull()
    expect(parseGateLine("HIVE-GATE/1 short")).toBeNull()
  })

  test("the offer survives a PTY-wrapped task stdout (#182004)", () => {
    const pty = `\x1b[?2004h$ bash /tmp/t.sh\r\nHIVE-GATE-OFFER {"v":1,"name":"b-ssh","host":"b-ssh.t.heyiris.io","ticket":"${"t".repeat(43)}","user":"alex"}\r\n$ exit\r\n`
    expect(parseGateOffer(pty)).toEqual({ v: 1, name: "b-ssh", host: "b-ssh.t.heyiris.io", ticket: "t".repeat(43), user: "alex" })
  })

  test("an error from the node is an error, and an old CLI's help text is nothing", () => {
    expect(parseGateOffer('HIVE-GATE-OFFER {"error":"no node"}')).toEqual({ error: "no node" })
    expect(parseGateOffer("iris hive\n\nHive — your machines")).toBeNull()
  })

  test("tunnel name", () => {
    expect(gateTunnelName("iris-hive-002")).toBe("iris-hive-002-ssh")
    expect(gateTunnelName("Alexs-MacBook-Pro.local")).toBe("alexs-macbook-pro-ssh")
  })

  test("self-invocation: compiled binary alone, source runs through bun", () => {
    expect(selfCommand("/Users/a/.iris/bin/iris", "/x")).toEqual(["/Users/a/.iris/bin/iris"])
    expect(selfCommand("/usr/bin/bun", "/src/index.ts")).toEqual(["/usr/bin/bun", "/src/index.ts"])
  })

  test("ssh argv: ProxyCommand into the CLI, host key pinned to the node id", () => {
    const a = relaySshArgs({ self: ["/opt/my iris"], gateHost: "b-ssh.t.heyiris.io", nodeId: "n1", nodeName: "iris-hive-002", user: "alex", remote: "true" })
    expect(a).toContain("ProxyCommand='/opt/my iris' hive ssh-gate connect b-ssh.t.heyiris.io")
    expect(a).toContain("HostKeyAlias=hive-n1")
    expect(a.slice(-2)).toEqual(["alex@iris-hive-002", "true"])
  })
})

// ─── real sockets ───────────────────────────────────────────────────────────────────────────────

let echo: Server
let echoPort = 0
let cert = ""
let key = ""
const HOST = "b-ssh.t.example.test"

beforeAll(async () => {
  echo = createServer((s) => {
    s.write("SSH-2.0-FakeSSH\r\n")
    s.pipe(s)
  })
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()))
  echoPort = (echo.address() as any).port
  const dir = mkdtempSync(join(tmpdir(), "cert-"))
  const r = spawnSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
    "-subj", `/CN=${HOST}`, "-addext", `subjectAltName=DNS:${HOST}`,
    "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
  ])
  if (r.status !== 0) throw new Error(`openssl: ${r.stderr}`)
  cert = readFileSync(join(dir, "c.pem"), "utf8")
  key = readFileSync(join(dir, "k.pem"), "utf8")
})
afterAll(() => echo.close())

/** What relay/client.js does on the node: terminate TLS with the node's cert, pipe to a port. */
function fakeRunner(gatePort: number): Promise<{ server: TlsServer; port: number }> {
  return new Promise((r) => {
    const server = createTlsServer({ cert, key }, (s) => {
      const up = connect(gatePort, "127.0.0.1")
      s.pipe(up).pipe(s)
      up.on("error", () => s.destroy())
      s.on("error", () => up.destroy())
    })
    server.listen(0, "127.0.0.1", () => r({ server, port: (server.address() as any).port }))
  })
}

function rawGate(port: number, line: string): Promise<string> {
  return new Promise((r) => {
    const s = connect(port, "127.0.0.1")
    let out = ""
    s.on("data", (d) => {
      out += d
      if (out.includes("SSH-2.0")) s.end()
    })
    s.on("close", () => r(out))
    s.on("error", () => r(out))
    s.write(line)
  })
}

describe("the gate", () => {
  test("no ticket: refused, and sshd never speaks", async () => {
    const h = home()
    const g = await startGate({ home: h, name: "b-ssh", target: { host: "127.0.0.1", port: echoPort } })
    const out = await rawGate(g.port, "SSH-2.0-OpenSSH_9.6\r\n")
    expect(out).toMatch(/^NO /)
    expect(out).not.toContain("SSH-2.0-FakeSSH")
    g.close()
  })

  test("a valid ticket reaches sshd; the same ticket again does not", async () => {
    const h = home()
    const g = await startGate({ home: h, name: "b-ssh", target: { host: "127.0.0.1", port: echoPort } })
    const t = issueTicket(h, "b-ssh")
    const first = await rawGate(g.port, `HIVE-GATE/1 ${t}\n`)
    expect(first.startsWith("OK\nSSH-2.0-FakeSSH")).toBe(true)
    const again = await rawGate(g.port, `HIVE-GATE/1 ${t}\n`)
    expect(again).toMatch(/^NO ticket refused/)
    g.close()
  })

  test("sshd not running: the person is told so", async () => {
    const h = home()
    const dead = createServer()
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", () => r()))
    const port = (dead.address() as any).port
    await new Promise((r) => dead.close(r))
    const g = await startGate({ home: h, name: "b-ssh", target: { host: "127.0.0.1", port } })
    const out = await rawGate(g.port, `HIVE-GATE/1 ${issueTicket(h, "b-ssh")}\n`)
    expect(out).toMatch(/^NO sshd is not answering/)
    g.close()
  })
})

describe("ProxyCommand end to end (TLS ends on the node)", () => {
  async function session(o: { ticket: string; servername: string; h: string }) {
    const g = await startGate({ home: o.h, name: "b-ssh", target: { host: "127.0.0.1", port: echoPort } })
    const run = await fakeRunner(g.port)
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    let got = ""
    stdout.on("data", (d) => (got += d))
    const code = proxyConnect({ host: o.servername, relayAddr: "127.0.0.1", port: run.port, ticket: o.ticket, stdin, stdout, ca: cert })
    await new Promise((r) => setTimeout(r, 300))
    stdin.write("ping-123\n")
    await new Promise((r) => setTimeout(r, 300))
    stdin.end()
    const result = await Promise.race([code, new Promise<number>((r) => setTimeout(() => r(-1), 3000))])
    run.server.close()
    g.close()
    return { got, code: result }
  }

  test("bytes flow both ways once the ticket is accepted", async () => {
    const h = home()
    const r = await session({ h, ticket: issueTicket(h, "b-ssh"), servername: HOST })
    expect(r.got).toContain("SSH-2.0-FakeSSH")
    expect(r.got).toContain("ping-123")
  })

  test("a bad ticket ends the ProxyCommand with an error, no bytes from sshd", async () => {
    const h = home()
    const r = await session({ h, ticket: "z".repeat(43), servername: HOST })
    expect(r.code).toBe(1)
    expect(r.got).not.toContain("SSH-2.0-FakeSSH")
  })

  test("a certificate for a different name is refused — whoever sits in the middle cannot pose as the node", async () => {
    const h = home()
    const r = await session({ h, ticket: issueTicket(h, "b-ssh"), servername: "someone-else.t.example.test" })
    expect(r.code).toBe(1)
    expect(r.got).toBe("")
  })
})

describe("which path (#191650): prefer the tailnet, fall back to the relay", () => {
  test("auto: a tailnet address that answers is used", () => expect(sshPath("auto", true, true)).toBe("direct"))
  test("auto: a tailnet address that does NOT answer (Tailscale stopped) → relay", () => expect(sshPath("auto", true, false)).toBe("relay"))
  test("auto: no tailnet address at all → relay", () => expect(sshPath("auto", false, false)).toBe("relay"))
  test("--via relay always takes the relay", () => expect(sshPath("relay", true, true)).toBe("relay"))
  test("--via tailscale never silently takes the relay", () => {
    expect(sshPath("tailscale", true, false)).toBe("fail")
    expect(sshPath("tailscale", true, true)).toBe("direct")
  })
})
