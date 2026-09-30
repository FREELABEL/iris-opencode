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
    // `serve` is never counted as someone opening the app. After that, the usage tracker turns
    // the engine's own event stream into usage events (usage-tracker.ts). Fire-and-forget.
    if (process.env.OPENCODE_CLIENT === "desktop") {
      void (async () => {
        const [{ UsageBeacon }, { UsageTracker }, { GlobalBus }, platform, { InstallationVersion }] = await Promise.all([
          import("../../iris/usage-beacon"),
          import("../../iris/usage-tracker"),
          import("../../bus/global"),
          import("../../iris/platform"),
          import("@opencode-ai/core/installation/version"),
        ])
        await UsageBeacon.send("app_open", { token: platform.resolveToken(), apiBase: platform.IRIS_API, version: InstallationVersion })
        const tracker = UsageTracker.create({ token: platform.resolveToken, apiBase: platform.IRIS_API, version: InstallationVersion })
        GlobalBus.on("event", (e) => tracker.observe(e.payload))
        tracker.start()
        // Flush on quit, then re-raise: a listener suppresses Node's default exit, and the engine
        // must still die when the app closes. `once` has already removed this listener, so the
        // re-raised signal gets the default behaviour. Capped at 1.5 s — quitting is not negotiable.
        for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
          process.once(signal, () => {
            void Promise.race([tracker.stop(), new Promise((r) => setTimeout(r, 1500))]).finally(() =>
              process.kill(process.pid, signal),
            )
          })
      })().catch(() => {})
    }

    yield* Effect.never
  }),
})
