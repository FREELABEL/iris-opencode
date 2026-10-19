import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./side-panel.txt"
import { Session } from "@/session/session"
import { InstanceState } from "@/effect/instance-state"
import { Panel } from "@/iris/panel"
import type { SessionID } from "../session/schema"

/**
 * The agent's hands on the desktop side panel (#190093). The mechanism is in iris/panel.ts; this
 * is the typed surface over it.
 *
 * ROOT SESSION, like genesis_artifact: the user is looking at the top of the subagent chain, so a
 * subagent asking "what is on screen" asks about that session, and a subagent opening an artifact
 * opens it where the user will see it.
 *
 * EVERY CHANGE IS CONFIRMED. The tool waits for the desktop's report and returns it, so the agent
 * says "it's showing Atlas › Schemas" because the panel said so — never because it asked.
 */
export const Parameters = Schema.Struct({
  action: Schema.Literals(["state", "open", "close", "show", "artifact", "tab", "browse"]).annotate({
    description: "What to do",
  }),
  surface: Schema.optional(Schema.String).annotate({ description: "show: product id or label (atlas, Genesis, agents, …)" }),
  sub: Schema.optional(Schema.String).annotate({ description: "show: view id or label within the product (lists, schemas, …)" }),
  bloq: Schema.optional(Schema.Number).annotate({ description: "show: board id to switch the panel to" }),
  id: Schema.optional(Schema.String).annotate({ description: "artifact: the genesis_artifact id" }),
  tab: Schema.optional(Schema.String).annotate({ description: "tab: review or context" }),
  url: Schema.optional(Schema.String).annotate({ description: "browse: http(s) address" }),
})

type Metadata = { answered?: boolean; refused?: string; state?: Panel.Stored }

export const SidePanelTool = Tool.define<typeof Parameters, Metadata, Session.Service>(
  "side_panel",
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    const rootOf = (id: SessionID) =>
      Effect.gen(function* () {
        let current = yield* sessions.get(id)
        for (let hops = 0; current.parentID && hops < 16; hops++) current = yield* sessions.get(current.parentID)
        return current.id
      }).pipe(Effect.orElseSucceed(() => id))

    const toCommand = (p: Schema.Schema.Type<typeof Parameters>): Panel.Command | string => {
      switch (p.action) {
        case "open":
        case "close":
          return { action: p.action }
        case "show":
          if (!p.surface) return "show needs a surface — see action=state for the list"
          return { action: "show", surface: p.surface, sub: p.sub, bloq: p.bloq }
        case "artifact":
          if (!p.id) return "artifact needs an id — see genesis_artifact action=list"
          return { action: "artifact", id: p.id }
        case "tab":
          if (!p.tab) return "tab needs tab: review or context"
          return { action: "tab", tab: p.tab }
        case "browse":
          if (!p.url) return "browse needs a url"
          return { action: "browse", url: p.url }
      }
      return `unknown action ${p.action}`
    }

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const session = String(yield* rootOf(ctx.sessionID))
          const known = Panel.get(session)

          if (params.action === "state") {
            const catalog = Panel.describeCatalog(known?.catalog)
            return {
              title: known ? `panel ${known.open ? "open" : "closed"}` : "no desktop panel",
              output: Panel.describe(known) + (catalog ? `\n\nproducts and views:\n${catalog}` : ""),
              metadata: { answered: !!known, state: known },
            }
          }

          const built = toCommand(params)
          if (typeof built === "string") return yield* Effect.fail(new Error(built))
          const refused = Panel.refuse(built, known?.catalog)
          if (refused) return { title: "refused", output: refused, metadata: { refused } }
          const command = Panel.canonical(built, known?.catalog)

          const after = yield* Effect.promise(() => Panel.send({ directory: instance.directory, session, command }))
          if (!after) {
            return {
              title: "no desktop answered",
              output:
                "No IRIS Desktop panel answered within 4s. The user is not looking at this session in the desktop app (they may be in the terminal, or on another session). Nothing changed.",
              metadata: { answered: false },
            }
          }
          return {
            title: after.error ? "partly applied" : "done",
            output: Panel.describe(after),
            metadata: { answered: true, state: after },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
