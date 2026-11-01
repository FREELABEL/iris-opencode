// A STANDALONE ENGINE ANSWERS NOBODY WITHOUT A TOKEN (#192113).
//
// IRIS Desktop has started its engine with a per-launch password and a Host allowlist since
// #190647 (engine_auth.rs). Anything else that opens a socket with this code (`iris serve`,
// `iris web`, a `--port` on the TUI or ACP) was still open: `/session` answered with no
// credentials, and any Host was served. This gives those the same two controls by default.
//
// The token goes where Desktop's goes (OPENCODE_SERVER_PASSWORD, read by server/auth.ts), and local
// clients find it in ~/.iris/servers/<port>.json, 0600 in a 0700 directory. That stops other OS
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

/**
 * Call before Server.listen. Returns whether this call generated the token, which is what decides
 * if a record is published: a password somebody chose is theirs to pass around, and Desktop writes
 * its own record (engine_auth.rs).
 */
export function prepareListener(input: { hostname: string; env?: NodeJS.ProcessEnv }) {
  const env = input.env ?? process.env
  defaultHosts = namesFor(input.hostname)
  if (env.OPENCODE_SERVER_PASSWORD?.trim()) return { generated: false as const }
  if (env[AUTH_ENV] === "off") {
    if (!isLoopbackName(input.hostname))
      throw new Error(`${AUTH_ENV}=off is for a loopback server only; this one binds ${input.hostname}.`)
    return { generated: false as const }
  }
  const password = crypto.randomBytes(32).toString("base64url")
  env.OPENCODE_SERVER_PASSWORD = password
  env.OPENCODE_SERVER_USERNAME = USERNAME
  Flag.OPENCODE_SERVER_PASSWORD = password
  Flag.OPENCODE_SERVER_USERNAME = USERNAME
  return { generated: true as const, password }
}

export function recordPath(port: number) {
  return path.join(os.homedir(), ".iris", "servers", `${port}.json`)
}

/** Atomic and owner-only from the first byte. A failure must not stop the server starting. */
export function publishRecord(input: { port: number; hostname: string; password: string }) {
  const target = recordPath(input.port)
  const dir = path.dirname(target)
  const tmp = path.join(dir, `.${input.port}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`)
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (process.platform !== "win32") fs.chmodSync(dir, 0o700)
    const body = { version: 1, port: input.port, pid: process.pid, hostname: input.hostname, username: USERNAME, password: input.password }
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

/** A file anyone else could have written or read is not a credential: the rule iris-daemon applies. */
function readOwnerOnly(file: string): any {
  try {
    const stat = fs.statSync(file)
    if (process.platform !== "win32") {
      if (stat.mode & 0o077) return undefined
      if (process.getuid && stat.uid !== process.getuid()) return undefined
    }
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === "EPERM"
  }
}

function fromRecord(file: string, port: number): string | undefined {
  const record = readOwnerOnly(file)
  if (!record || Number(record.port) !== port || typeof record.password !== "string") return undefined
  if (typeof record.pid === "number" && !alive(record.pid)) return undefined
  return record.password
}

/** The password for a server on this machine, from its record or Desktop's. Never for a remote URL. */
export function recordedPassword(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (!isLoopbackName(parsed.hostname)) return undefined
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80))
  return fromRecord(recordPath(port), port) ?? fromRecord(path.join(os.homedir(), ".iris", "desktop-engine.json"), port)
}

/**
 * The sentence to show when a client cannot get in, or undefined when it can. Clients call this
 * before starting, so a person sees why instead of an empty screen.
 */
export async function attachProblem(url: string, headers: Record<string, string> | undefined) {
  const base = url.replace(/\/+$/, "")
  const res = await fetch(`${base}/config`, { headers, signal: AbortSignal.timeout(5000) }).catch(() => undefined)
  if (!res || res.status !== 401) return undefined
  return headers
    ? `${base} refused these credentials. Check --password or OPENCODE_SERVER_PASSWORD.`
    : `${base} requires a token and none was found. Pass --password or set OPENCODE_SERVER_PASSWORD. ` +
        `A server on this machine publishes it in ~/.iris/servers/<port>.json for its owner.`
}

export * as LocalAuth from "./local-auth"
