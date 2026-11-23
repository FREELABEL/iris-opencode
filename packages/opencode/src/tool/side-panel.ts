import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./side-panel.txt"
import { Session } from "@/session/session"
import { InstanceState } from "@/effect/instance-state"
import { Panel } from "@/iris/panel"
import { HiveSim } from "@/iris/hive-sim"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
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
  action: Schema.Literals(["state", "open", "close", "show", "artifact", "card", "dataset", "tab", "browse", "simulate"]).annotate({
    description: "What to do",
  }),
  surface: Schema.optional(Schema.String).annotate({ description: "show: product id or label (atlas, Genesis, agents, …)" }),
  sub: Schema.optional(Schema.String).annotate({ description: "show: view id or label within the product (lists, schemas, …)" }),
  bloq: Schema.optional(Schema.Number).annotate({
    description: "show: board id to switch the panel to. card: the card's board (?project=). dataset: the dataset's board",
  }),
  schema: Schema.optional(Schema.String).annotate({ description: "dataset: the dataset's schema slug (e.g. rental-candidates)" }),
  item: Schema.optional(Schema.Number).annotate({ description: "card: the Atlas card id to open (?card=)" }),
  list: Schema.optional(Schema.Number).annotate({ description: "card: optional list id the card is in (?row=)" }),
  id: Schema.optional(Schema.String).annotate({ description: "artifact: the genesis_artifact id" }),
  tab: Schema.optional(Schema.String).annotate({ description: "tab: review or context" }),
  url: Schema.optional(Schema.String).annotate({ description: "browse: http(s) address" }),
  engine: Schema.optional(Schema.String).annotate({
    description: "simulate: path to the hive-simulations engine (.py), absolute or relative to the project directory",
  }),
  worlds: Schema.optional(Schema.Number).annotate({ description: "simulate: worlds per arm (default 4000)" }),
  cohort: Schema.optional(Schema.Number).annotate({ description: "simulate: population per world (default 1000)" }),
  days: Schema.optional(Schema.Number).annotate({ description: "simulate: window to pull, in days (default 30)" }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: "simulate: re-pull the real data first (default true); false runs on the dataset already on disk",
  }),
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
  /** simulate: the run's id and how it ended (running = the wait ended first). */
  simulation?: string
  simulationStatus?: HiveSim.RunStatus
}


export const SidePanelTool = Tool.define<typeof Parameters, Metadata, Session.Service | ChildProcessSpawner>(
  "side_panel",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const spawner = yield* ChildProcessSpawner

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
        case "dataset":
          if (p.bloq === undefined || !p.schema) return "dataset needs bloq (the board) and schema (the dataset's slug)"
          return { action: "dataset", bloq: p.bloq, schema: p.schema }
        case "tab":
          if (!p.tab) return "tab needs tab: review or context"
          return { action: "tab", tab: p.tab }
        case "browse":
          if (!p.url) return "browse needs a url"
          return { action: "browse", url: p.url }
        case "simulate":
          return "simulate is not a panel command"
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

          if (params.action === "simulate") {
            // HIVE SIMULATIONS, LIVE (#194084): the playbook's shell steps as one run the person
            // watches in Hive › Simulations, while this call waits for it to end and returns the
            // results. The run is not this call's: if the chat moves on, it keeps going.
            const started = HiveSim.start(
              {
                sessionID: session,
                directory: instance.directory,
                engine: params.engine ?? "",
                worlds: params.worlds,
                cohort: params.cohort,
                days: params.days,
                refresh: params.refresh,
              },
              HiveSim.spawnExec(spawner),
            )
            if (typeof started === "string") return yield* Effect.fail(new Error(started))
            const run = started
            yield* ctx.metadata({ title: `simulating ${run.engine}`, metadata: { simulation: run.id, simulationStatus: run.status } })
            const show: Panel.Command = { action: "show", surface: "hive", sub: "simulations" }
            const refusedShow = Panel.refuse(show, known?.catalog)
            const shown =
              !refusedShow && Panel.openStreams() > 0
                ? Panel.send({ directory: instance.directory, session, command: Panel.canonical(show, known?.catalog) })
                : undefined
            yield* Effect.promise(() => HiveSim.wait(run, HiveSim.TIMEOUT_MS + 10_000, ctx.abort))
            const panel = shown ? yield* Effect.promise(() => shown) : undefined
            const where = refusedShow
              ? `panel: this desktop has no Hive › Simulations view (${refusedShow}) — describe the results in words.`
              : !shown
                ? "panel: no desktop is connected — describe the results in words."
                : panel?.state && !panel.state.error
                  ? "panel: showing Hive › Simulations on this run."
                  : `panel: ${panel?.state?.error ?? "the desktop did not confirm Hive › Simulations"}.`
            const still =
              run.status === "running"
                ? `\nThe run is STILL RUNNING (this call stopped waiting${ctx.abort.aborted ? " because the turn was stopped" : ""}); it continues in Hive › Simulations.`
                : ""
            return {
              title: `simulation ${run.status}`,
              output: `${HiveSim.report(run)}\n\n${where}${still}`,
              metadata: { simulation: run.id, simulationStatus: run.status, answered: !!panel?.state },
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
