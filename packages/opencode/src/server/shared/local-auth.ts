// A STANDALONE ENGINE ANSWERS NOBODY WITHOUT A TOKEN (#192113).
//
// IRIS Desktop has started its engine with a per-launch password and a Host allowlist since
// #190647 (engine_auth.rs). Anything else that opens a socket with this code (`iris serve`,
// `iris web`, a `--port` on the TUI or ACP) was still open: `/session` answered with no
// credentials, and any Host was served. This gives those the same two controls by default.
//
// The token goes where Desktop's goes (OPENCODE_SERVER_PASSWORD, read by server/auth.ts). Every
// server publishes its password, generated or chosen, so local clients and iris-daemon find it in
// ~/.iris/servers/<port>.json, 0600 in a 0700 directory. That stops other OS
// users and every browser page. It does NOT stop a process running as the same user, which can
// read that file, and could read the session database anyway.
//
// OPENCODE_SERVER_AUTH=off is the loopback-only way out for the dev loop and Playwright, whose app
// builds have no way to be handed a token. Host validation stays on either way.
import { Flag } from "@opencode-ai/core/flag/flag"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const AUTH_ENV = "OPENCODE_SERVER_AUTH"
export const USERNAME = "opencode"

export function isLoopbackName(hostname: string) {
  const h = (hostname ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "")
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

// The names a guarded listener answers to when no explicit allowlist was given. Undefined until
// a command prepares a listener, so in-process `Server.Default()` keeps working.
let defaultHosts: Set<string> | undefined

function namesFor(hostname: string) {
  const out = new Set<string>()
  const bound = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "")
  if (bound === "0.0.0.0" || bound === "::") {
    const name = os.hostname().toLowerCase()
    out.add(name)
    out.add(`${name}.local`)
    out.add("opencode.local")
    for (const nets of Object.values(os.networkInterfaces())) {
      for (const net of nets ?? []) out.add(net.address.toLowerCase())
    }
  } else if (bound) out.add(bound)
  return out
}

/** Whether a Host may be served under the default policy. No listener prepared means yes. */
export function defaultHostAllowed(host: string | undefined) {
  if (!defaultHosts) return true
  // Absent is an in-process request. Every browser sends one, and the token still applies.
  if (host === undefined) return true
  const full = host.trim().toLowerCase()
  if (!full) return false
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(full)
  const name = bracket ? bracket[1]! : full.replace(/:\d+$/, "")
  return isLoopbackName(name) || defaultHosts.has(name) || defaultHosts.has(full)
}

/** Tests only. */
export function resetLocalAuth() {
  defaultHosts = undefined
}

export type Credentials = { username: string; password: string }

/**
 * Call before Server.listen. `credentials` is what the server will require, to hand to
 * publishRecord once it has a port; `generated` is whether nobody chose them. No credentials means
 * OPENCODE_SERVER_AUTH=off, which leaves nothing to publish.
 */
export function prepareListener(input: {
  hostname: string
  env?: NodeJS.ProcessEnv
}): { generated: boolean; credentials?: Credentials } {
  const env = input.env ?? process.env
  defaultHosts = namesFor(input.hostname)
  const chosen = env.OPENCODE_SERVER_PASSWORD
  if (chosen?.trim())
    return { generated: false, credentials: { username: env.OPENCODE_SERVER_USERNAME || USERNAME, password: chosen } }
  if (env[AUTH_ENV] === "off") {
    if (!isLoopbackName(input.hostname))
      throw new Error(`${AUTH_ENV}=off is for a loopback server only; this one binds ${input.hostname}.`)
    return { generated: false }
  }
  const password = crypto.randomBytes(32).toString("base64url")
  env.OPENCODE_SERVER_PASSWORD = password
  env.OPENCODE_SERVER_USERNAME = USERNAME
  Flag.OPENCODE_SERVER_PASSWORD = password
  Flag.OPENCODE_SERVER_USERNAME = USERNAME
  return { generated: true, credentials: { username: USERNAME, password } }
}

export function recordPath(port: number) {
  return path.join(os.homedir(), ".iris", "servers", `${port}.json`)
}

/** Atomic and owner-only from the first byte. A failure must not stop the server starting. */
export function publishRecord(input: { port: number; hostname: string; credentials: Credentials }) {
  const target = recordPath(input.port)
  const dir = path.dirname(target)
  const tmp = path.join(dir, `.${input.port}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`)
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (process.platform !== "win32") fs.chmodSync(dir, 0o700)
    sweep(dir)
    const body = { version: 1, port: input.port, pid: process.pid, hostname: input.hostname, ...input.credentials }
    fs.writeFileSync(tmp, JSON.stringify(body) + "\n", { mode: 0o600, flag: "wx" })
    fs.renameSync(tmp, target)
    const remove = () => {
      if (readOwnerOnly(target)?.pid === process.pid) fs.rmSync(target, { force: true })
    }
    process.once("exit", remove)
    return remove
  } catch {
    fs.rmSync(tmp, { force: true })
    return () => {}
  }
}

/**
 * Records of servers that died without stopping (`kill -9` runs no exit handler), or that name no
 * process. Only ever files this module named, and only real files this person owns: readOwnerOnly
 * refuses anything else, so a symlink stays where it is. Tidying must not stop the server starting.
 */
function sweep(dir: string) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^\d+\.json$/.test(name)) continue
      const file = path.join(dir, name)
      const record = readOwnerOnly(file)
      if (record && !alive(record.pid)) fs.rmSync(file, { force: true })
    }
  } catch {}
}

/**
 * A file anyone else could have written or read is not a credential: the rule iris-daemon applies.
 * lstat, because a symlink's own target decides nothing here, and a real file only: a FIFO would
 * hang the read.
 */
function readOwnerOnly(file: string): any {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) return undefined
    if (process.platform !== "win32") {
      if (stat.mode & 0o077) return undefined
      if (process.getuid && stat.uid !== process.getuid()) return undefined
    }
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

/**
 * A positive integer pid that is running. Anything else is not a live server: `process.kill(0, 0)`
 * and a negative pid signal a process group, so they succeed for a record that names no process.
 */
function alive(pid: unknown) {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false
  try {
    process.kill(pid as number, 0)
    return true
  } catch (e: any) {
    return e?.code === "EPERM"
  }
}

function fromRecord(file: string, port: number): Credentials | undefined {
  const record = readOwnerOnly(file)
  if (!record || Number(record.port) !== port || typeof record.password !== "string" || !record.password)
    return undefined
  if (!alive(record.pid)) return undefined
  return { username: typeof record.username === "string" && record.username ? record.username : USERNAME, password: record.password }
}

/** The port of a plain-http URL on this machine, else undefined. iris-daemon's loopbackPort. */
function loopbackPort(url: string) {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password) return undefined
  if (!isLoopbackName(parsed.hostname)) return undefined
  return Number(parsed.port || 80)
}

/**
 * Credentials this machine holds for the server at `url`: the environment, then the server's own
 * record, then Desktop's. All of them stop at loopback, OPENCODE_SERVER_PASSWORD included, because
 * it names this machine's server and is often set for a whole shell. The one way to send a secret
 * to another machine is `--password`, on the command that names that URL: see headersFor.
 */
export function credentialsFor(url: string, env: NodeJS.ProcessEnv = process.env): Credentials | undefined {
  const port = loopbackPort(url)
  if (port === undefined) return undefined
  if (env.OPENCODE_SERVER_PASSWORD?.trim())
    return { username: env.OPENCODE_SERVER_USERNAME || USERNAME, password: env.OPENCODE_SERVER_PASSWORD }
  return fromRecord(recordPath(port), port) ?? fromRecord(path.join(os.homedir(), ".iris", "desktop-engine.json"), port)
}

/** Headers for a client reaching `url`. An explicit password goes where it was aimed; see credentialsFor. */
export function headersFor(
  url: string,
  explicit?: { password?: string; username?: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  const found = explicit?.password
    ? { username: env.OPENCODE_SERVER_USERNAME || USERNAME, password: explicit.password }
    : credentialsFor(url, env)
  if (!found) return undefined
  const username = explicit?.username ?? found.username
  return { Authorization: `Basic ${Buffer.from(`${username}:${found.password}`).toString("base64")}` }
}

/**
 * The sentence to show when a client cannot get in, or undefined when it can. Clients call this
 * before starting, so a person sees why instead of an empty screen.
 */
export async function attachProblem(url: string, headers: Record<string, string> | undefined) {
  const base = url.replace(/\/+$/, "")
  const res = await fetch(`${base}/config`, { headers, signal: AbortSignal.timeout(5000) }).catch(() => undefined)
  if (!res || res.status !== 401) return undefined
  if (headers) return `${base} refused these credentials. Check --password or OPENCODE_SERVER_PASSWORD.`
  if (loopbackPort(url) === undefined)
    return (
      `${base} requires a token. OPENCODE_SERVER_PASSWORD and this machine's server records are only ` +
      `sent to a server on this machine, so name this one's with --password.`
    )
  return (
    `${base} requires a token and none was found. Pass --password or set OPENCODE_SERVER_PASSWORD. ` +
    `A server on this machine publishes it in ~/.iris/servers/<port>.json for its owner.`
  )
}

export * as LocalAuth from "./local-auth"
