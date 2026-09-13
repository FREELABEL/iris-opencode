import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { fetchAtlas, fetchHiveNodes } from "@/iris/platform"
import { RootHttpApi } from "../api"

/**
 * Handlers for the IRIS platform routes.
 *
 * These sit on RootHttpApi, not InstanceHttpApi, deliberately: Atlas and the Hive belong to the
 * ACCOUNT, not to a workspace or a session. Putting them on the instance API would scope them to
 * whichever project the window happens to have open, which is exactly the bug the TUI's Pages
 * tab had — a per-user list rendered under a project header, unable to change when you switched
 * project.
 *
 * Sitting on RootHttpApi also means they inherit its Authorization middleware rather than
 * inventing their own. These routes return leads-adjacent account data over a localhost socket;
 * "localhost is safe" is an assumption, and the existing middleware is a decision someone
 * already made on purpose.
 */
export const irisHandlers = HttpApiBuilder.group(RootHttpApi, "iris", (handlers) =>
  Effect.gen(function* () {
    const atlas = Effect.fn("IrisHttpApi.atlas")((ctx: { params: { bloqID: number } }) =>
      Effect.promise(() => fetchAtlas(ctx.params.bloqID)).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, lists: r.data.lists })),
      ),
    )

    const hive = Effect.fn("IrisHttpApi.hive")(() =>
      Effect.promise(() => fetchHiveNodes()).pipe(
        Effect.map((r) => ({ measured: r.measured, reason: r.reason, nodes: r.data.nodes })),
      ),
    )

    return handlers.handle("atlas", atlas).handle("hive", hive)
  }),
)
