import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    // #186171: the desktop app starting its engine is the desktop's app_open. Only when the
    // desktop is the client (spawn_sidecar sets OPENCODE_CLIENT=desktop), so a headless
    // `serve` is never counted as someone opening the app. Fire-and-forget; see usage-beacon.ts.
    if (process.env.OPENCODE_CLIENT === "desktop") {
      void (async () => {
        const [{ UsageBeacon }, platform, { InstallationVersion }] = await Promise.all([
          import("../../iris/usage-beacon"),
          import("../../iris/platform"),
          import("@opencode-ai/core/installation/version"),
        ])
        await UsageBeacon.send("app_open", { token: platform.resolveToken(), apiBase: platform.IRIS_API, version: InstallationVersion })
      })().catch(() => {})
    }

    yield* Effect.never
  }),
})
