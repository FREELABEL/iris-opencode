import { Installation } from "@/installation"
import { Server } from "@/server/server"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import type { BunWebSocketData } from "hono/bun"
import { Config } from "@/config/config"
import { registerSelf, unregisterSelf } from "@/cli/cmd/hive-peer-registry"

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  level: (() => {
    if (Installation.isLocal()) return "DEBUG"
    return "INFO"
  })(),
})

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

let server: Bun.Server<BunWebSocketData>
export const rpc = {
  async server(input: { port: number; hostname: string; mdns?: boolean }) {
    if (server) await server.stop(true)
    try {
      server = Server.listen(input)
      const url = server.url.toString()
      // Announce this process so another agent can address it by NAME (epic #182718, S1).
      // Registered HERE and not at startup because the port is only real once listen()
      // returns — `input.port` is 0 when the caller asked for an ephemeral one, and an
      // entry advertising port 0 is worse than no entry.
      try {
        // server.port is typed optional; a listening server always has one, but an entry
        // advertising `undefined` would be a ghost that passes liveness and refuses delivery.
        const port = server.port ?? input.port
        if (port) registerSelf({ port, url, directory: process.cwd() })
      } catch (e) {
        // Never let the registry stop a TUI from starting. An unregistered session is
        // merely unaddressable; a TUI that refuses to boot is broken.
        Log.Default.warn("peer registry: register failed", {
          e: e instanceof Error ? e.message : e,
        })
      }
      return {
        url,
      }
    } catch (e) {
      console.error(e)
      throw e
    }
  },
  async checkUpgrade(input: { directory: string }) {
    await Instance.provide({
      directory: input.directory,
      init: InstanceBootstrap,
      fn: async () => {
        await upgrade().catch(() => {})
      },
    })
  },
  async reload() {
    Config.global.reset()
    await Instance.disposeAll()
  },
  async shutdown() {
    Log.Default.info("worker shutting down")
    unregisterSelf()
    await Instance.disposeAll()
    // TODO: this should be awaited, but ws connections are
    // causing this to hang, need to revisit this
    server.stop(true)
  },
}

Rpc.listen(rpc)
