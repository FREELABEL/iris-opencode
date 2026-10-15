import type { Argv, InferredOptionTypes } from "yargs"
import { Config } from "../config/config"

const options = {
  port: {
    type: "number" as const,
    describe: "port to listen on",
    default: 0,
  },
  hostname: {
    type: "string" as const,
    describe: "hostname to listen on",
    default: "127.0.0.1",
  },
  mdns: {
    type: "boolean" as const,
    describe: "enable mDNS service discovery (defaults hostname to 0.0.0.0)",
    default: false,
  },
  cors: {
    type: "string" as const,
    array: true,
    describe: "additional domains to allow for CORS",
    default: [] as string[],
  },
}

export type NetworkOptions = InferredOptionTypes<typeof options>

export function withNetworkOptions<T>(yargs: Argv<T>) {
  return yargs.options(options)
}

/**
 * IS THIS ADDRESS REACHABLE FROM ANOTHER MACHINE?
 *
 * Pure, so the rule can be proven without binding a socket. Loopback is the only safe default
 * because the session server has NO authentication of any kind — see assertBindIsSafe.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = (hostname ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "")
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true
  // An IPv4 peer on a dual-stack socket arrives as ::ffff:127.0.0.1.
  if (h.startsWith("::ffff:")) return isLoopbackHost(h.slice(7))
  // The whole 127.0.0.0/8 block, not just 127.0.0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  return false
}

/** Env var carrying the shared secret, matching the daemon's bridge-token convention. */
export const TOKEN_ENV = "IRIS_SERVER_TOKEN"

/**
 * Is a shared secret configured? Impure by nature, kept out of the rule below so the rule stays
 * provable. A token must be non-empty after trimming — an env var set to "" or a file containing
 * a newline is an ABSENT secret, and treating whitespace as a credential is how a fail-closed
 * check quietly becomes fail-open.
 */
export function serverTokenPresent(): boolean {
  return readServerToken() !== undefined
}

/** The shared secret itself, or undefined when none is configured. Same rules as above. */
export function readServerToken(): string | undefined {
  const fromEnv = (process.env[TOKEN_ENV] ?? "").trim()
  if (fromEnv.length > 0) return fromEnv

  try {
    const os = require("node:os")
    const path = require("node:path")
    const fs = require("node:fs")
    const file = path.join(os.homedir(), ".iris", "bridge-token")
    const token = fs.readFileSync(file, "utf8").trim()
    return token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return require("node:crypto").timingSafeEqual(ab, bb)
}

/**
 * MAY THIS REQUEST REACH THE SESSION API? (#182762)
 *
 * assertBindIsSafe lets a routable bind start when a token is configured — but until this rule
 * existed nothing ever CHECKED that token, so the network got the whole session surface anyway.
 * A routable bind now means every request from another machine must carry
 * `Authorization: Bearer <token>`.
 *
 * Requests from a loopback peer are allowed without it: the TUI talks to its own worker server
 * with no header, and the loopback surface is the same one a loopback bind already exposes.
 * An unknown peer is NOT loopback — absent information never reads as safe. CORS preflights
 * pass so the browser can learn the policy; they carry no data.
 */
export function requestIsAuthorized(input: {
  boundHostname: string
  peer: string | undefined
  method: string
  authorization: string | undefined
  token: string | undefined
}): boolean {
  if (isLoopbackHost(input.boundHostname)) return true
  if (input.peer && isLoopbackHost(input.peer)) return true
  if (input.method.toUpperCase() === "OPTIONS") return true
  if (!input.token) return false
  const match = /^Bearer\s+(.+)$/i.exec((input.authorization ?? "").trim())
  if (!match) return false
  return timingSafeEqual(match[1].trim(), input.token)
}

/**
 * REFUSE TO PUT AN UNAUTHENTICATED SESSION API ON THE NETWORK (#182762).
 *
 * Every running IRIS TUI starts a full server in its worker, and that server exposes the entire
 * session surface — POST /session/:id/message, POST /session/:id/shell, the Pty routes — with no
 * authentication middleware anywhere. The ONLY thing protecting it is the loopback bind.
 *
 * `--mdns` silently flipped that bind to 0.0.0.0 AND advertised the service over Bonjour, so
 * anyone on the same wifi got unauthenticated remote code execution as the logged-in user, with
 * the discovery step handed to them for free. Measured, not theorised: an unauthenticated
 * `curl http://127.0.0.1:<port>/session` returned every session title, cost and token count, and
 * an external process POSTed a message into a live session and had it stored as `role: "user"`
 * (#182785).
 *
 * The CORS allow-list is not a control here. CORS restricts browsers; it does nothing to curl.
 *
 * SO THIS FAILS CLOSED. A non-loopback bind requires a token, and without one the process
 * refuses to start rather than warning and continuing — a warning on a terminal that already
 * scrolled is not a control. It is deliberately checked in the RESOLVER rather than at each call
 * site, so a new command that binds a server cannot forget it.
 *
 * The token is then ENFORCED per request by requestIsAuthorized (server middleware). The
 * loopback surface stays open to local processes, as it is on a loopback bind.
 */
export function assertBindIsSafe(opts: { hostname: string; mdns?: boolean; tokenPresent: boolean }): void {
  if (isLoopbackHost(opts.hostname) || opts.tokenPresent) return

  const why = opts.mdns
    ? "--mdns defaults the bind to 0.0.0.0 and advertises this server over Bonjour"
    : `a non-loopback hostname (${opts.hostname}) was requested`

  throw new Error(
    [
      `Refusing to start: ${why}, and this server has no authentication.`,
      "",
      "Anyone who can reach this address could read every session and POST to /session/:id/shell,",
      "which is remote code execution as you. So a routable bind requires a shared secret.",
      "",
      "Fix it either way:",
      "  \u2022 keep it local   \u2014 drop --mdns / --hostname, or set server.hostname to 127.0.0.1",
      `  \u2022 bind on purpose \u2014 put a secret in ${TOKEN_ENV} or ~/.iris/bridge-token, then retry`,
      "",
      "See bug #182762.",
    ].join("\n"),
  )
}

export async function resolveNetworkOptions(args: NetworkOptions) {
  const config = await Config.global()
  const portExplicitlySet = process.argv.includes("--port")
  const hostnameExplicitlySet = process.argv.includes("--hostname")
  const mdnsExplicitlySet = process.argv.includes("--mdns")
  const corsExplicitlySet = process.argv.includes("--cors")

  const mdns = mdnsExplicitlySet ? args.mdns : (config?.server?.mdns ?? args.mdns)
  const port = portExplicitlySet ? args.port : (config?.server?.port ?? args.port)
  const hostname = hostnameExplicitlySet
    ? args.hostname
    : mdns && !config?.server?.hostname
      ? "0.0.0.0"
      : (config?.server?.hostname ?? args.hostname)
  const configCors = config?.server?.cors ?? []
  const argsCors = Array.isArray(args.cors) ? args.cors : args.cors ? [args.cors] : []
  const cors = [...configCors, ...argsCors]

  assertBindIsSafe({ hostname, mdns, tokenPresent: serverTokenPresent() })

  return { hostname, port, mdns, cors }
}
