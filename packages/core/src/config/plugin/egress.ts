export * as ConfigEgressPlugin from "./egress.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Document } from "@opencode/schema/config"
import { Effect } from "effect"
import { Config } from "../../config.js"
import { Model } from "../../model.js"
import { Egress } from "../../permission/egress.js"
import { Provider } from "../../provider.js"
import { Session } from "../../session.js"
import { Wildcard } from "../../util/wildcard.js"
import { ConfigEntryObserver } from "./entry-observer.js"

// Turns the default allow into an ask for tools that send data out of a local or private session
// (#192114). A hook, so it runs where policy does: after the agent's rules, on every tool's assert.
export const Plugin = define({
  id: "opencode.config.egress",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const models = yield* Model.Service
    const providers = yield* Provider.Service
    const sessions = yield* Session.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, Effect.void)

    const documents = () => loaded.entries.filter((entry): entry is Document => entry.type === "document")

    const modelUrl = Effect.fnUntraced(function* (ref: { providerID: Provider.ID; id: Model.ID } | undefined) {
      if (!ref) return undefined
      const model = yield* models.get(ref.providerID, ref.id)
      const provider = yield* providers.get(ref.providerID)
      return model?.settings?.baseURL ?? provider?.settings?.baseURL
    })

    // The rules the person wrote, global, for this agent, or set on the session by the client that
    // created it: never the built-in `*: allow`.
    const written = (
      action: string,
      resource: string,
      agent: string | undefined,
      session: ReadonlyArray<{ action: string; resource: string; effect: string }>,
    ) =>
      [
        ...documents().flatMap((document) => [
          ...(document.info.permissions ?? []),
          ...(agent ? (document.info.agents?.[agent]?.permissions ?? []) : []),
        ]),
        ...session,
      ].findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource))

    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.gen(function* () {
        // Only ever tightens: a deny or an ask from any rule above stays what it is.
        if (event.effect !== "allow" || !Egress.sendsDataOut(event.action)) return
        const session = yield* sessions.get(event.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
        const fallback = yield* models.default().pipe(Effect.catch(() => Effect.succeed(undefined)))
        const ref = session?.model ?? (fallback ? { providerID: fallback.providerID, id: fallback.id } : undefined)
        const mode = Egress.mode({ modelUrl: yield* modelUrl(ref) })
        if (mode === "normal") return
        if (mode === "local") {
          if (event.saved) return
          const chosen = event.resources.map((resource) => written(event.action, resource, event.agent, session?.permissions ?? [])?.effect)
          if (chosen.length > 0 && chosen.every((effect) => effect === "allow")) return
        }
        event.effect = "ask"
      }),
    )
  }),
})
