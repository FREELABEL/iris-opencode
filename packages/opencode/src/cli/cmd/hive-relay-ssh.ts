/**
 * `iris hive ssh <node>` over OUR relay when Tailscale isn't there (epic #191642, task 1.2 #191650).
 *
 * THE RELAY CARRIES TLS, NOT HTTP. relay/server.js (iris-daemon, running on iris-hive-001 as
 * hive-relay.service) reads only the TLS ClientHello's hostname and splices the encrypted bytes to
 * the node registered under that name; relay/client.js on the node terminates TLS with the node's
 * own certificate and pipes the plaintext to a local TCP port with `net.connect` — no HTTP parsing
 * anywhere. So any TCP protocol rides it once it is wrapped in TLS. Raw ssh does not: its first
 * bytes are "SSH-2.0-…", which the relay refuses as `not_tls` before routing.
 *
 *   A: ssh ─ProxyCommand─▶ iris hive ssh-gate connect <name>.t.heyiris.io
 *        │ TLS to <name>.t.heyiris.io (certificate checked: Let's Encrypt, key only on B)
 *        ▼
 *   relay (iris-hive-001:443) — sees the hostname, then ciphertext; holds no key for it
 *        ▼
 *   B: relay runner (tunnel.js) terminates TLS ─▶ the GATE on 127.0.0.1:<random>
 *        │ first line must be "HIVE-GATE/1 <ticket>": a single-use, 60-second ticket
 *        ▼
 *      sshd on 127.0.0.1:22 — ssh's own key exchange and key authentication, end to end
 *
 * WHO MAY CONNECT. Anyone on the internet can open a TLS connection to the name; nothing reaches
 * sshd without a ticket. A ticket is minted ON B by `iris hive ssh-gate issue`, which A runs on B
 * as a Hive task — and the platform only dispatches a task to B for B's owner and the users
 * attached to B (`iris hive access`, the same check every `hive run` gets). So: Hive membership
 * gets a ticket, the ticket gets to sshd, and sshd's own key auth gets a shell.
 *
 * WHAT EACH PARTY SEES. The relay: the hostname, timing and sizes; bytes encrypted twice (TLS to
 * B, and ssh inside it). Our servers: that a ticket was issued (the task, and today its output
 * including the ticket — the platform can already run commands on B, so a ticket adds nothing it
 * could not do; Phase 2 encrypts task output). Nobody but A and B sees the ssh session.
 *
 * The gate and the runner run on B only while needed: started by the first `issue`, they exit
 * after GATE_IDLE_MS with no connection and no new ticket.
 */
import { createHash, randomBytes } from "crypto"
import { connect as netConnect, createServer, type Socket } from "net"
import { connect as tlsConnect } from "tls"
import { spawn } from "child_process"
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"

export const GATE_PROTO = "HIVE-GATE/1"
export const TICKET_TTL_MS = 60_000
export const GATE_IDLE_MS = 15 * 60_000
const LINE_MAX = 512
const LINE_TIMEOUT_MS = 10_000

/** This machine's ssh-gate tunnel name: `<hostname>-ssh`, a valid relay label. */
export function gateTunnelName(host: string): string {
  const base = String(host || "node")
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 59)
    .replace(/-+$/, "")
  return `${base || "node"}-ssh`
}

export const gateDir = (home: string, name: string) => join(home, ".iris", "tunnels", name)
const ticketDir = (home: string, name: string) => join(gateDir(home, name), "tickets")
const ticketFile = (home: string, name: string, ticket: string) =>
  join(ticketDir(home, name), createHash("sha256").update(ticket).digest("hex"))

/**
 * Mint a ticket: 32 random bytes. Only its sha256 is written down (with its expiry), so a copy of
 * the ticket directory cannot be replayed.
 */
export function issueTicket(home: string, name: string, now = Date.now(), ttlMs = TICKET_TTL_MS): string {
  const dir = ticketDir(home, name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Sweep expired and used ones while we are here.
  for (const f of safeList(dir)) {
    const p = join(dir, f)
    try {
      if (f.endsWith(".used") || Number(readFileSync(p, "utf8")) < now) unlinkSync(p)
    } catch {}
  }
  const ticket = randomBytes(32).toString("base64url")
  writeFileSync(ticketFile(home, name, ticket), String(now + ttlMs), { mode: 0o600 })
  return ticket
}

/**
 * Spend a ticket. True exactly once, before it expires. Single use is a rename — atomic, so two
 * connections racing with one ticket cannot both win.
 */
export function consumeTicket(home: string, name: string, ticket: string, now = Date.now()): boolean {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(ticket)) return false
  const p = ticketFile(home, name, ticket)
  const used = p + ".used"
  try {
    renameSync(p, used)
  } catch {
    return false
  }
  try {
    return Number(readFileSync(used, "utf8")) >= now
  } catch {
    return false
  } finally {
    try {
      unlinkSync(used)
    } catch {}
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** "HIVE-GATE/1 <ticket>" → the ticket, or null. */
export function parseGateLine(line: string): string | null {
  const m = /^HIVE-GATE\/1 ([A-Za-z0-9_-]{20,100})\r?$/.exec(line)
  return m ? m[1] : null
}

export interface GateOffer {
  v: 1
  name: string
  host: string
  ticket: string
  user: string | null
}

/**
 * The offer in a task's stdout. The Hive transport may wrap stdout in a PTY stream (#182004), so
 * the answer is the last line that carries the marker, parsed strictly.
 */
export function parseGateOffer(stdout: string): GateOffer | { error: string } | null {
  const lines = String(stdout || "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i].indexOf("HIVE-GATE-OFFER ")
    if (at < 0) continue
    try {
      const o = JSON.parse(lines[i].slice(at + "HIVE-GATE-OFFER ".length))
      if (o && typeof o.error === "string") return { error: o.error }
      if (o?.v === 1 && typeof o.host === "string" && typeof o.ticket === "string" && typeof o.name === "string")
        return { v: 1, name: o.name, host: o.host, ticket: o.ticket, user: typeof o.user === "string" ? o.user : null }
    } catch {}
    return null
  }
  return null
}

// ─── B: the gate ────────────────────────────────────────────────────────────────────────────────

/**
 * Listen on 127.0.0.1, demand a ticket line from every connection, and splice the ones that have
 * one to the local sshd. Returns the port and a way to stop. `onActivity` lets the owner reset its
 * idle timer.
 */
export function startGate(o: {
  home: string
  name: string
  target?: { host: string; port: number }
  onActivity?: (active: number) => void
  log?: (msg: string) => void
}): Promise<{ port: number; close: () => void; active: () => number }> {
  const target = o.target ?? { host: "127.0.0.1", port: 22 }
  let active = 0
  const log = o.log ?? (() => {})
  const server = createServer((sock: Socket) => {
    active++
    o.onActivity?.(active)
    let buf = Buffer.alloc(0)
    let decided = false
    const done = () => {
      active--
      o.onActivity?.(active)
    }
    sock.once("close", done)
    sock.on("error", () => sock.destroy())
    const timer = setTimeout(() => refuse("no ticket in time"), LINE_TIMEOUT_MS)
    const refuse = (why: string) => {
      if (decided) return
      decided = true
      clearTimeout(timer)
      // What a refused stranger sent, printable and short — the hostname is public (certificate
      // transparency), so scanners arrive within seconds of the first certificate.
      const head = buf.subarray(0, 24).toString("latin1").replace(/[^\x20-\x7e]/g, ".")
      log(`refused: ${why}${head ? ` (first bytes: ${head})` : ""}`)
      sock.end(`NO ${why}\n`)
      setTimeout(() => sock.destroy(), 1000).unref?.()
    }
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      const nl = buf.indexOf(0x0a)
      if (nl < 0) {
        if (buf.length > LINE_MAX) refuse("bad request")
        return
      }
      sock.removeListener("data", onData)
      sock.pause()
      clearTimeout(timer)
      const ticket = parseGateLine(buf.subarray(0, nl).toString("latin1"))
      if (!ticket) return refuse("bad request")
      if (!consumeTicket(o.home, o.name, ticket)) return refuse("ticket refused (expired, used, or never issued)")
      decided = true
      const rest = buf.subarray(nl + 1)
      const up = netConnect(target.port, target.host)
      let connected = false
      up.once("connect", () => {
        connected = true
        log("connected")
        sock.write("OK\n")
        if (rest.length) up.write(rest)
        sock.pipe(up).pipe(sock)
        sock.resume()
      })
      up.on("error", () => {
        if (!connected) sock.end(`NO sshd is not answering on this machine (macOS: System Settings → General → Sharing → Remote Login)\n`)
        else sock.destroy()
      })
      up.on("close", () => {
        if (connected) sock.destroy()
      })
      sock.on("close", () => up.destroy())
    }
    sock.on("data", onData)
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port
      resolve({ port, close: () => server.close(), active: () => active })
    })
  })
}

export interface GateState {
  pid: number
  name: string
  host: string | null
  gate_port: number
  ready: boolean
  error?: string
  started_at: string
}

export const gateStatePath = (home: string, name: string) => join(gateDir(home, name), "gate.json")

export function readGateState(home: string, name: string): GateState | null {
  try {
    const s = JSON.parse(readFileSync(gateStatePath(home, name), "utf8")) as GateState
    if (!Number.isInteger(s.pid) || s.pid <= 1) return null
    process.kill(s.pid, 0)
    return s
  } catch {
    return null
  }
}

export function writeGateState(home: string, s: GateState) {
  mkdirSync(gateDir(home, s.name), { recursive: true, mode: 0o700 })
  writeFileSync(gateStatePath(home, s.name), JSON.stringify(s) + "\n", { mode: 0o600 })
}

/** How the CLI re-invokes itself: the compiled binary, or `bun <entry>` when run from source. */
export function selfCommand(execPath = process.execPath, argv1 = process.argv[1]): string[] {
  const base = execPath.split(/[\\/]/).pop() || ""
  return /^(bun|node)(\.exe)?$/i.test(base) && argv1 ? [execPath, argv1] : [execPath]
}

/** Start `iris hive ssh-gate serve` detached, logging next to its state. */
export function spawnGate(home: string, name: string): number | undefined {
  mkdirSync(gateDir(home, name), { recursive: true, mode: 0o700 })
  const log = openSync(join(gateDir(home, name), "gate.log"), "a", 0o600)
  const [bin, ...pre] = selfCommand()
  const child = spawn(bin, [...pre, "hive", "ssh-gate", "serve", "--name", name], { detached: true, stdio: ["ignore", log, log] })
  child.unref()
  return child.pid
}

/** The newest change in the ticket directory — a fresh ticket counts as activity. */
export function lastTicketAt(home: string, name: string): number {
  try {
    return statSync(ticketDir(home, name)).mtimeMs
  } catch {
    return 0
  }
}

// ─── A: the ProxyCommand ────────────────────────────────────────────────────────────────────────

/**
 * Open TLS to the gate's public name, present the ticket, and once the gate says OK, become a
 * byte pipe between ssh (stdin/stdout) and it. The certificate is checked against the public CA
 * for exactly that hostname — the relay holds no key for it, so it cannot stand in for B.
 */
export function proxyConnect(o: {
  host: string
  ticket: string
  relayAddr?: string
  port?: number
  stdin?: NodeJS.ReadableStream
  stdout?: NodeJS.WritableStream
  ca?: string | Buffer
}): Promise<number> {
  const stdin = o.stdin ?? process.stdin
  const stdout = o.stdout ?? process.stdout
  return new Promise((resolve) => {
    let settled = false
    const finish = (code: number, msg?: string) => {
      if (settled) return
      settled = true
      if (msg) process.stderr.write(`iris hive ssh: ${msg}\n`)
      resolve(code)
    }
    const s = tlsConnect({ host: o.relayAddr || o.host, port: o.port ?? 443, servername: o.host, ca: o.ca })
    s.on("error", (e) => finish(1, `could not reach ${o.host} through the Hive relay: ${e.message}`))
    s.once("secureConnect", () => {
      s.write(`${GATE_PROTO} ${o.ticket}\n`)
      let buf = Buffer.alloc(0)
      const onData = (d: Buffer) => {
        buf = Buffer.concat([buf, d])
        const nl = buf.indexOf(0x0a)
        if (nl < 0) {
          if (buf.length > LINE_MAX) finish(1, "the gate answered something unexpected")
          return
        }
        s.removeListener("data", onData)
        const answer = buf.subarray(0, nl).toString("utf8")
        if (answer !== "OK") {
          s.destroy()
          return finish(1, `the node refused: ${answer.replace(/^NO /, "")}`)
        }
        const rest = buf.subarray(nl + 1)
        if (rest.length) stdout.write(rest)
        s.pipe(stdout as any)
        stdin.pipe(s)
        s.on("close", () => finish(0))
        s.on("end", () => finish(0))
      }
      s.on("data", onData)
    })
  })
}

export function ticketDirExists(home: string, name: string): boolean {
  return existsSync(ticketDir(home, name))
}
