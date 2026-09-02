import type { Argv, InferredOptionTypes } from "yargs"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { Config } from "@/config/config"
import { Effect } from "effect"

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
  "mdns-domain": {
    type: "string" as const,
    describe: "custom domain name for mDNS service (default: opencode.local)",
    default: "opencode.local",
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

export function hasArg(name: string) {
  return networkArgs().some((arg) => arg === name || arg.startsWith(name + "="))
}

function hasBooleanArg(name: string) {
  return networkArgs().some(
    (arg) => arg === name || arg === name + "=true" || arg === name + "=false" || arg === "--no-" + name.slice(2),
  )
}

function networkArgs() {
  const separator = process.argv.indexOf("--")
  return process.argv.slice(2, separator === -1 ? undefined : separator)
}

export const resolveNetworkOptions = Effect.fn("Cli.resolveNetworkOptions")(function* (args: NetworkOptions) {
  const { Config } = yield* Effect.promise(() => import("@/config/config"))
  const config = yield* Config.Service.use((cfg) => cfg.getGlobal())
  return resolveNetworkOptionsNoConfig(args, config)
})

/**
 * IS THIS ADDRESS REACHABLE FROM ANOTHER MACHINE?
 *
 * Pure, so the rule can be proven without binding a socket. Loopback is the only safe default
 * because the session server has NO authentication of any kind — see assertBindIsSafe.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = (hostname ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "")
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true
  // The whole 127.0.0.0/8 block, not just 127.0.0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  return false
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
 * scrolled is not a control either. It is deliberately checked in the RESOLVER rather than at
 * each call site, so a new command that binds a server cannot forget it.
 *
 * This does NOT authenticate the loopback surface; a local process can still reach it. That is
 * the rest of #182762 and needs middleware in the server package. This closes the remote half,
 * which is the half a stranger on the network can reach.
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
      `  • keep it local   — drop --mdns / --hostname, or set server.hostname to 127.0.0.1`,
      `  • bind on purpose — put a secret in ${TOKEN_ENV} or ~/.iris/bridge-token, then retry`,
      "",
      "See bug #182762.",
    ].join("\n"),
  )
}

/** Env var carrying the shared secret, matching the daemon's bridge-token convention. */
export const TOKEN_ENV = "IRIS_SERVER_TOKEN"

/**
 * Is a shared secret configured? Impure by nature, kept out of the rule above so the rule stays
 * provable. A token must be non-empty after trimming — an env var set to "" or a file containing
 * a newline is an ABSENT secret, and treating whitespace as a credential is how a fail-closed
 * check quietly becomes fail-open.
 */
export function serverTokenPresent(): boolean {
  const fromEnv = (process.env[TOKEN_ENV] ?? "").trim()
  if (fromEnv.length > 0) return true

  try {
    const os = require("node:os")
    const path = require("node:path")
    const fs = require("node:fs")
    const file = path.join(os.homedir(), ".iris", "bridge-token")
    return fs.readFileSync(file, "utf8").trim().length > 0
  } catch {
    return false
  }
}

export function resolveNetworkOptionsNoConfig(args: NetworkOptions, config?: ConfigV1.Info) {
  const portExplicitlySet = hasArg("--port")
  const hostnameExplicitlySet = hasArg("--hostname")
  const mdnsExplicitlySet = hasBooleanArg("--mdns")
  const mdnsDomainExplicitlySet = hasArg("--mdns-domain")
  const mdns = mdnsExplicitlySet ? args.mdns : (config?.server?.mdns ?? args.mdns)
  const mdnsDomain = mdnsDomainExplicitlySet ? args["mdns-domain"] : (config?.server?.mdnsDomain ?? args["mdns-domain"])
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

  return { hostname, port, mdns, mdnsDomain, cors }
}
