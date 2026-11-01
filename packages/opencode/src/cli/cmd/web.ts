import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
import open from "open"
import { networkInterfaces } from "os"

function getNetworkIPs() {
  const nets = networkInterfaces()
  const results: string[] = []

  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue

    for (const netInfo of net) {
      // Skip internal and non-IPv4 addresses
      if (netInfo.internal || netInfo.family !== "IPv4") continue

      // Skip Docker bridge networks (typically 172.x.x.x)
      if (netInfo.address.startsWith("172.")) continue

      results.push(netInfo.address)
    }
  }

  return results
}

export const WebCommand = effectCmd({
  command: "web",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "start opencode server and open web interface",
  // Server loads instances per-request via x-opencode-directory header — no
  // ambient project InstanceContext needed at startup.
  instance: false,
  handler: Effect.fn("Cli.web")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const opts = yield* resolveNetworkOptions(args)
    // #192113: a server nobody gave a password to makes its own, and the browser arrives signed in.
    // The link holds the token, so it is opened and never printed.
    const { LocalAuth } = yield* Effect.promise(() => import("../../server/shared/local-auth"))
    const auth = LocalAuth.prepareListener({ hostname: opts.hostname })
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      UI.println(
        UI.Style.TEXT_WARNING_BOLD + `!  ${LocalAuth.AUTH_ENV}=off; any process on this machine can reach this server.`,
      )
    }
    const server = yield* Effect.promise(() => Server.listen(opts))
    if (auth.generated) {
      LocalAuth.publishRecord({ port: server.port, hostname: opts.hostname, password: auth.password })
      UI.println(
        UI.Style.TEXT_INFO_BOLD + "  Password:         ",
        UI.Style.TEXT_NORMAL,
        `username ${LocalAuth.USERNAME}, in ${LocalAuth.recordPath(server.port)}`,
      )
    }
    const signIn = (url: string) => {
      const password = Flag.OPENCODE_SERVER_PASSWORD
      if (!password) return url
      const token = Buffer.from(`${Flag.OPENCODE_SERVER_USERNAME ?? LocalAuth.USERNAME}:${password}`).toString("base64")
      return `${url.replace(/\/$/, "")}/?auth_token=${encodeURIComponent(token)}`
    }
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    if (opts.hostname === "0.0.0.0") {
      // Show localhost for local access
      const localhostUrl = `http://localhost:${server.port}`
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostUrl)

      // Show network IPs for remote access
      const networkIPs = getNetworkIPs()
      if (networkIPs.length > 0) {
        for (const ip of networkIPs) {
          UI.println(
            UI.Style.TEXT_INFO_BOLD + "  Network access:    ",
            UI.Style.TEXT_NORMAL,
            `http://${ip}:${server.port}`,
          )
        }
      }

      if (opts.mdns) {
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  mDNS:              ",
          UI.Style.TEXT_NORMAL,
          `${opts.mdnsDomain}:${server.port}`,
        )
      }

      // Open localhost in browser
      open(signIn(localhostUrl)).catch(() => {})
    } else {
      const displayUrl = server.url.toString()
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
      open(signIn(displayUrl)).catch(() => {})
    }

    yield* Effect.never
  }),
})
