import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./side-panel.txt"
import { Session } from "@/session/session"
import { InstanceState } from "@/effect/instance-state"
import { Panel } from "@/iris/panel"
import * as HiveScripts from "@/iris/hive-scripts"
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
  action: Schema.Literals(["state", "open", "close", "show", "artifact", "card", "dataset", "tab", "browse", "script"]).annotate({
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
  slug: Schema.optional(Schema.String).annotate({ description: "script: the script's slug in Hive › Scripts (yours or shared with you)" }),
  args: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "script: the script's settings for this run (its `# iris: arg=` names), e.g. {\"worlds\":\"4000\"}",
  }),
  run: Schema.optional(Schema.Boolean).annotate({ description: "script: true presses Run and waits for the task to end" }),
  node: Schema.optional(Schema.String).annotate({ description: "script: the computer to run on, by name; default: the one Scripts picks" }),
  task: Schema.optional(Schema.String).annotate({
    description: "script: read this Hive task's status and output instead (changes nothing on screen)",
  }),
})

/**
 * How long `script` with run waits for the task, and how often it asks. The playbook's own limit
 * is 900 s; a run still going then is reported as running, with its task id to read again.
 * Mutable, and the reader swappable, for tests only.
 */
export const ScriptWait = { waitMs: 900_000, pollMs: 2_000, sendMs: 20_000, fetchTask: HiveScripts.fetchTask }

/** A Hive task as the agent reads it: where, how it ended, then everything it printed. */
export function describeTask(t: HiveScripts.TaskView): string {
  const lines = [
    `task ${t.id}: ${t.held ? "HELD for approval" : t.status}${t.exitCode !== null ? ` · exit ${t.exitCode}` : ""}${t.nodeName ? ` · ${t.nodeName}` : ""}${t.durationMs !== null ? ` · ${Math.round(t.durationMs / 1000)} s` : ""}`,
  ]
  if (t.held)
    lines.push(
      `Constellation Gate held this run: ${t.gate?.explanation ?? "it needs its owner's approval"}. The person approves or rejects it in Hive › Scripts — do not approve it for them.`,
    )
  if (t.error) lines.push(`error: ${t.error}`)
  if (t.stdout.trim()) lines.push("--- stdout ---", t.stdout.trimEnd())
  if (t.stderr.trim()) lines.push("--- stderr ---", t.stderr.trimEnd())
  return lines.join("\n")
}

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
  /** script: the Hive task a Run started (or the one read), and its status when the call ended. */
  taskId?: string
  taskStatus?: string
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
        case "dataset":
          if (p.bloq === undefined || !p.schema) return "dataset needs bloq (the board) and schema (the dataset's slug)"
          return { action: "dataset", bloq: p.bloq, schema: p.schema }
        case "tab":
          if (!p.tab) return "tab needs tab: review or context"
          return { action: "tab", tab: p.tab }
        case "browse":
          if (!p.url) return "browse needs a url"
          return { action: "browse", url: p.url }
        case "script":
          if (!p.slug) return "script needs a slug — the script's name in Hive › Scripts"
          return {
            action: "script",
            slug: p.slug,
            ...(p.args && Object.keys(p.args).length ? { args: p.args } : {}),
            ...(p.run ? { run: true } : {}),
            ...(p.node ? { node: p.node } : {}),
          }
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

          // Reading a task changes nothing on screen: straight to the Hive, as the Scripts tab reads it.
          if (params.action === "script" && params.task) {
            const r = yield* Effect.promise(() => ScriptWait.fetchTask(params.task!))
            if (!r.data.task) return yield* Effect.fail(new Error(`could not read task ${params.task}: ${r.reason ?? "not found"}`))
            return { title: `task ${r.data.task.status}`, output: describeTask(r.data.task), metadata: { taskId: r.data.task.id, taskStatus: r.data.task.status } }
          }

          const built = toCommand(params)
          if (typeof built === "string") return yield* Effect.fail(new Error(built))
          const refused = Panel.refuse(built, known?.catalog)
          if (refused) return { title: "refused", output: refused, metadata: { refused } }
          const command = Panel.canonical(built, known?.catalog)

          // A Run waits for the tab to mount, read the script and dispatch: longer than a switch.
          const sent = yield* Effect.promise(() =>
            Panel.send({ directory: instance.directory, session, command, ...(command.action === "script" && command.run ? { timeoutMs: ScriptWait.sendMs } : {}) }),
          )
          const facts = { elapsedMs: sent.elapsedMs, attempts: sent.attempts, streams: sent.streams }
          const after = sent.state
          if (!after) {
            return {
              title: "desktop did not answer",
              output: Panel.explainSilence(sent, session),
              metadata: { answered: false, ...facts, state: sent.heard },
            }
          }
          if (command.action === "script") {
            const meta = { answered: true, live: true, ageSeconds: age(after), state: after, ...facts }
            const x = after.script
            if (!x || x.slug !== command.slug)
              return {
                title: "script not selected",
                output: `${Panel.describe(after)}\nThe desktop did not report selecting ${command.slug}${x ? "" : " — it may be an older desktop without this command"}.`,
                metadata: meta,
              }
            if (!command.run || !x.taskId) return { title: x.error ? "not run" : "selected", output: Panel.describe(after), metadata: meta }
            // PRESSED: the person watches the run in Scripts; this waits on the same task the tab polls.
            yield* ctx.metadata({ title: `running ${x.slug}${x.computer ? ` on ${x.computer}` : ""}`, metadata: { taskId: x.taskId } })
            const until = Date.now() + ScriptWait.waitMs
            let task: HiveScripts.TaskView | null = null
            let reason: string | undefined
            while (!ctx.abort.aborted) {
              const r = yield* Effect.promise(() => ScriptWait.fetchTask(x.taskId!))
              if (r.data.task) task = r.data.task
              reason = r.reason
              if (task?.terminal || task?.held || Date.now() >= until) break
              yield* Effect.sleep(ScriptWait.pollMs)
            }
            const still = task && !task.terminal && !task.held
            const tail = !task
              ? `\nCould not read task ${x.taskId}${reason ? `: ${reason}` : ""}. Read it later with side_panel script task=${x.taskId}.`
              : still
                ? `\nSTILL RUNNING — this call stopped waiting${ctx.abort.aborted ? " because the turn was stopped" : ""}. It continues in Hive › Scripts; read it again with side_panel script task=${x.taskId}. Do not run it again.`
                : ""
            return {
              title: task ? `${x.slug} ${task.held ? "held" : task.status}` : `${x.slug} sent`,
              output: `${Panel.describe(after)}\n\n${task ? describeTask(task) : ""}${tail}`,
              metadata: { ...meta, taskId: x.taskId, taskStatus: task?.status },
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
