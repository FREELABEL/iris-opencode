/**
 * WHO MAY TALK TO A LOCAL IRIS SERVER (#192113).
 *
 * Every `iris` server used to answer anything that could reach its port: `GET /session` listed
 * every session, `POST /session/:id/shell` ran commands, and a forged `Host` was served, so a web
 * page rebinding its DNS name to 127.0.0.1 had nothing in its way but CORS. Now three checks run
 * before any route:
 *
 *   1. Host. Only loopback names, the bound hostname and OPENCODE_SERVER_ALLOWED_HOSTS. A page
 *      can rebind DNS; it cannot change the Host its browser sends.
 *   2. Origin. A browser request from a page the CORS list does not know is refused outright,
 *      because CORS stops a page reading a response, not a websocket or a simple POST being sent.
 *   3. A token, on by default. Random per server start unless OPENCODE_SERVER_PASSWORD names one.
 *      Basic auth with username `opencode`, the same shape Desktop's engine and iris-daemon use.
 *
 * Clients that run as this person find the token in ~/.iris/servers/<port>.json, 0600 in a 0700
 * directory. That stops other OS users and every browser page. It does NOT stop a process running
 * as the same user, which can read that file, and could read the session database anyway.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export namespace LocalAuth {
  export const USERNAME = "opencode"
  export const ALLOWED_HOSTS_ENV = "OPENCODE_SERVER_ALLOWED_HOSTS"

  export type Credentials = { username: string; password: string }
  type Env = Record<string, string | undefined>

  export const UNAUTHORIZED_MESSAGE =
    "This IRIS server requires a token (#192113). Update this client with `iris upgrade`, or send " +
    "Basic auth: username `opencode`, password from OPENCODE_SERVER_PASSWORD or ~/.iris/servers/<port>.json."

  export function isLoopbackName(hostname: string): boolean {
    const h = (hostname ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "")
    if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  }

  /** A non-empty secret or nothing: whitespace is an absent secret, never a credential. */
  function secret(value: string | undefined) {
    const v = (value ?? "").trim()
    return v.length > 0 ? v : undefined
  }

  function bridgeToken() {
    try {
      return secret(fs.readFileSync(path.join(os.homedir(), ".iris", "bridge-token"), "utf8"))
    } catch {
      return undefined
    }
  }

  /** The credentials a server starting now will require. Never unset: there is no open mode. */
  export function resolve(input: { hostname: string; env?: Env }): Credentials {
    const env = input.env ?? process.env
    const password =
      secret(env.OPENCODE_SERVER_PASSWORD) ??
      secret(env.IRIS_SERVER_TOKEN) ??
      // assertBindIsSafe accepts the bridge token for a routable bind, so it must be what guards it.
      (isLoopbackName(input.hostname) ? undefined : bridgeToken()) ??
      crypto.randomBytes(32).toString("base64url")
    return { username: secret(env.OPENCODE_SERVER_USERNAME) ?? USERNAME, password }
  }

  export function basicHeader(credentials: Credentials) {
    return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`
  }

  // ── Host ────────────────────────────────────────────────────────────────────────────────────

  /** The names this server answers to besides loopback, lowercased. */
  export function allowedHosts(input: { hostname: string; env?: Env }): Set<string> {
    const env = input.env ?? process.env
    const out = new Set(
      (env[ALLOWED_HOSTS_ENV] ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    )
    const bound = input.hostname.trim().toLowerCase().replace(/^\[|\]$/g, "")
    if (bound === "0.0.0.0" || bound === "::") {
      // A wildcard bind is reached by this machine's own names and addresses.
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

  /**
   * May a request with this Host be served? Absent means in-process (`Request` objects handed to
   * the app directly); any real browser sends one, and the token still applies to the rest.
   */
  export function hostAllowed(host: string | undefined, allowed: Set<string>): boolean {
    if (host === undefined) return true
    const full = host.trim().toLowerCase()
    if (!full) return false
    const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(full)
    const name = bracket ? bracket[1]! : full.replace(/:\d+$/, "")
    return isLoopbackName(name) || allowed.has(name) || allowed.has(full)
  }

  export function sameOrigin(origin: string, host: string | undefined) {
    if (!host) return false
    try {
      return new URL(origin).host === host.trim().toLowerCase()
    } catch {
      return false
    }
  }

  // ── Token ───────────────────────────────────────────────────────────────────────────────────

  function equal(a: string, b: string) {
    const left = crypto.createHash("sha256").update(a).digest()
    const right = crypto.createHash("sha256").update(b).digest()
    return crypto.timingSafeEqual(left, right)
  }

  function decodeBasic(encoded: string, credentials: Credentials) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8")
    const at = decoded.indexOf(":")
    if (at === -1) return false
    return equal(decoded.slice(0, at), credentials.username) && equal(decoded.slice(at + 1), credentials.password)
  }

  export function cookieName(host: string | undefined) {
    const port = /:(\d+)$/.exec(host ?? "")?.[1]
    return `iris_local_${port ?? "0"}`
  }

  /** Derived, so the cookie is not the token and dies with it. */
  export function cookieValue(credentials: Credentials) {
    return crypto.createHash("sha256").update(`iris-local-session:${credentials.password}`).digest("base64url")
  }

  export function sessionCookie(host: string | undefined, credentials: Credentials) {
    return `${cookieName(host)}=${cookieValue(credentials)}; Path=/; HttpOnly; SameSite=Strict`
  }

  export type Verdict = { ok: false } | { ok: true; via: "header" | "query" | "cookie" }

  export function authorize(
    request: {
      authorization?: string
      cookie?: string
      authToken?: string
      origin?: string
      host?: string
    },
    credentials: Credentials,
  ): Verdict {
    const header = request.authorization ?? ""
    const basic = /^Basic\s+(.+)$/i.exec(header)
    if (basic && decodeBasic(basic[1]!, credentials)) return { ok: true, via: "header" }
    const bearer = /^Bearer\s+(.+)$/i.exec(header)
    if (bearer && equal(bearer[1]!.trim(), credentials.password)) return { ok: true, via: "header" }
    // Browsers cannot set a header on a navigation or a websocket: the format Desktop already uses.
    if (request.authToken && decodeBasic(request.authToken, credentials)) return { ok: true, via: "query" }
    if (request.cookie) {
      // A same-site page on another port still sends this cookie, so only same-origin may use it.
      const usable = request.origin === undefined || sameOrigin(request.origin, request.host)
      const wanted = `${cookieName(request.host)}=`
      const value = request.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(wanted))
        ?.slice(wanted.length)
      if (usable && value && equal(value, cookieValue(credentials))) return { ok: true, via: "cookie" }
    }
    return { ok: false }
  }

  // ── Where clients find it ───────────────────────────────────────────────────────────────────

  export function recordDirectory() {
    return path.join(os.homedir(), ".iris", "servers")
  }

  export function recordPath(port: number) {
    return path.join(recordDirectory(), `${port}.json`)
  }

  type Record_ = Credentials & { version: 1; port: number; pid: number; hostname: string }

  function alive(pid: number) {
    try {
      process.kill(pid, 0)
      return true
    } catch (e: any) {
      return e?.code === "EPERM"
    }
  }

  /** Atomic and owner-only from the first byte. A failure must not stop the server starting. */
  export function writeRecord(input: { port: number; hostname: string; credentials: Credentials }) {
    const dir = recordDirectory()
    const target = recordPath(input.port)
    const tmp = path.join(dir, `.${input.port}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`)
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      if (process.platform !== "win32") fs.chmodSync(dir, 0o700)
      const body: Record_ = {
        version: 1,
        port: input.port,
        pid: process.pid,
        hostname: input.hostname,
        ...input.credentials,
      }
      fs.writeFileSync(tmp, JSON.stringify(body) + "\n", { mode: 0o600, flag: "wx" })
      fs.renameSync(tmp, target)
      sweep(dir)
      return target
    } catch {
      fs.rmSync(tmp, { force: true })
      return undefined
    }
  }

  /** Records of servers that died without stopping. Only ever files this module named. */
  function sweep(dir: string) {
    for (const name of fs.readdirSync(dir)) {
      if (!/^\d+\.json$/.test(name)) continue
      const file = path.join(dir, name)
      const pid = readOwnerOnly(file)?.pid
      if (typeof pid === "number" && !alive(pid)) fs.rmSync(file, { force: true })
    }
  }

  export function removeRecord(port: number) {
    const file = recordPath(port)
    if (readOwnerOnly(file)?.pid === process.pid) fs.rmSync(file, { force: true })
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

  export function recordedPorts(): number[] {
    try {
      return fs
        .readdirSync(recordDirectory())
        .filter((name) => /^\d+\.json$/.test(name))
        .map((name) => Number(name.slice(0, -5)))
    } catch {
      return []
    }
  }

  function fromRecord(file: string, port: number): Credentials | undefined {
    const record = readOwnerOnly(file)
    if (!record || Number(record.port) !== port || typeof record.password !== "string") return undefined
    if (typeof record.pid === "number" && !alive(record.pid)) return undefined
    return { username: record.username || USERNAME, password: record.password }
  }

  /**
   * Credentials for the server at `url`. The environment first, then, on this machine only, the
   * server's own record or Desktop's. A remote URL never gets a local secret.
   */
  export function credentialsFor(url: string, env: Env = process.env): Credentials | undefined {
    const password = secret(env.OPENCODE_SERVER_PASSWORD)
    if (password) return { username: secret(env.OPENCODE_SERVER_USERNAME) ?? USERNAME, password }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return undefined
    }
    if (!isLoopbackName(parsed.hostname)) return undefined
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80))
    return (
      fromRecord(recordPath(port), port) ?? fromRecord(path.join(os.homedir(), ".iris", "desktop-engine.json"), port)
    )
  }

  export function headersFor(url: string, explicit?: { password?: string; username?: string }, env: Env = process.env) {
    const credentials = explicit?.password
      ? { username: explicit.username ?? secret(env.OPENCODE_SERVER_USERNAME) ?? USERNAME, password: explicit.password }
      : credentialsFor(url, env)
    return credentials ? { Authorization: basicHeader(credentials) } : undefined
  }

  /**
   * The sentence to show when a client cannot get in, or undefined when it can. Clients call this
   * before starting, so a person sees why instead of an empty screen or "Session not found".
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
}
