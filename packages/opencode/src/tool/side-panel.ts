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
  action: Schema.Literals(["state", "open", "close", "show", "artifact", "card", "tab", "browse"]).annotate({
    description: "What to do",
  }),
  surface: Schema.optional(Schema.String).annotate({ description: "show: product id or label (atlas, Genesis, agents, …)" }),
  sub: Schema.optional(Schema.String).annotate({ description: "show: view id or label within the product (lists, schemas, …)" }),
  bloq: Schema.optional(Schema.Number).annotate({ description: "show: board id to switch the panel to. card: the card's board (?project=)" }),
  item: Schema.optional(Schema.Number).annotate({ description: "card: the Atlas card id to open (?card=)" }),
  list: Schema.optional(Schema.Number).annotate({ description: "card: optional list id the card is in (?row=)" }),
  id: Schema.optional(Schema.String).annotate({ description: "artifact: the genesis_artifact id" }),
  tab: Schema.optional(Schema.String).annotate({ description: "tab: review or context" }),
  url: Schema.optional(Schema.String).annotate({ description: "browse: http(s) address" }),
})

type Metadata = {
  answered?: boolean
  refused?: string
  state?: Panel.Stored
  /** state: true when the desktop answered just now; false when this is the last report, replayed. */
  live?: boolean
  /** Seconds since the desktop sent the report this result describes. */
  ageSeconds?: number
  elapsedMs?: number
  attempts?: number
  streams?: number
}


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
        case "card":
          if (p.bloq === undefined || p.item === undefined)
            return "card needs bloq (the board, ?project=) and item (the card, ?card=)"
          return { action: "card", bloq: p.bloq, item: p.item, ...(p.list !== undefined ? { list: p.list } : {}) }
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

          const age = (st: Panel.Stored) => Math.max(0, Math.round((Date.now() - st.received) / 1000))

          if (params.action === "state") {
            // LIVE, NOT REPLAYED (#191506): ask the desktop what it shows now. Only when it does
            // not answer is the last report used — and then the result says so, in a field.
            const asked =
              Panel.openStreams() > 0
                ? yield* Effect.promise(() =>
                    Panel.send({ directory: instance.directory, session, command: { action: "report" }, timeoutMs: Panel.timing.liveReadMs, resendMs: Panel.timing.liveResendMs }),
                  )
                : undefined
            const now = asked?.state ?? Panel.get(session)
            const live = !!asked?.state
            const catalog = Panel.describeCatalog(now?.catalog)
            const head = !now
              ? ""
              : live
                ? "live: the desktop answered just now.\n"
                : `CACHED: this is the desktop's last report, ${age(now)}s old — ${asked ? `it did not answer a live read within ${Math.round(Panel.timing.liveReadMs / 1000)}s` : "no desktop is connected to ask"}. The panel may have changed since.\n`
            return {
              title: now ? `panel ${now.open ? "open" : "closed"}${live ? "" : ` (cached ${age(now)}s)`}` : "no desktop panel",
              output: head + Panel.describe(now) + (catalog ? `\n\nproducts and views:\n${catalog}` : ""),
              metadata: {
                answered: !!now,
                live,
                state: now,
                ageSeconds: now ? age(now) : undefined,
                streams: Panel.openStreams(),
              },
            }
          }

          const built = toCommand(params)
          if (typeof built === "string") return yield* Effect.fail(new Error(built))
          const refused = Panel.refuse(built, known?.catalog)
          if (refused) return { title: "refused", output: refused, metadata: { refused } }
          const command = Panel.canonical(built, known?.catalog)

          const sent = yield* Effect.promise(() => Panel.send({ directory: instance.directory, session, command }))
          const facts = { elapsedMs: sent.elapsedMs, attempts: sent.attempts, streams: sent.streams }
          const after = sent.state
          if (!after) {
            return {
              title: "desktop did not answer",
              output: Panel.explainSilence(sent, session),
              metadata: { answered: false, ...facts, state: sent.heard },
            }
          }
          const link = command.action === "card" ? `\nweb link: ${Panel.cardLink(command)}` : ""
          return {
            title: after.error ? "partly applied" : "done",
            output: Panel.describe(after) + link,
            metadata: { answered: true, live: true, ageSeconds: age(after), state: after, ...facts },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
