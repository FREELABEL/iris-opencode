import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./genesis-artifact.txt"
import { Session } from "@/session/session"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { Artifacts } from "@/iris/artifacts"
import type { SessionID } from "../session/schema"
import { fetchRecords } from "@/iris/platform"
import {
  BINDING_NAME,
  MAX_BINDINGS_BYTES,
  bindingsBytes,
  injectBindings,
  rowsFrom,
  toolResultValue,
  type Binding,
  type Bindings,
} from "@opencode-ai/core/util/iris-bindings"

/**
 * The agent's side of Genesis › Artifacts (epics #186508 / #186510).
 *
 * NAMED `genesis_artifact`. A bare `artifact` builtin reached for itself on unrelated work (asked
 * to run a smart-lights show, the agent called it), and "artifact" already meant a Genesis page.
 * The description scopes it to things the user will LOOK AT, and the drafts live under Genesis,
 * where publishing to /p/ is the next step.
 *
 * SHARED BY THE SESSION, NOT THE CALLER. A subagent runs in its own child session; keyed by
 * that, its artifacts would land in a folder the parent's pane never reads. Every write goes to
 * the ROOT session (the same parent walk task.ts does), and records the writer — agent name and
 * the session it ran in — so the pane can say which agent made what.
 *
 * LIVE, NOT ON RESTART. Each write emits `iris.artifact.updated` on the GlobalBus, which the
 * desktop receives over /global/event, so the pane refetches within one event instead of on the
 * next reload. The pane also polls, for writers outside this process.
 */
export const ARTIFACT_EVENT = "iris.artifact.updated"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "update", "read", "list"]).annotate({ description: "What to do" }),
  id: Schema.optional(Schema.String).annotate({ description: "The artifact id (update, read)" }),
  title: Schema.optional(Schema.String).annotate({ description: "Short title shown in the pane (create, update)" }),
  kind: Schema.optional(Schema.Literals(["html", "markdown", "csv", "code"])).annotate({
    description: "Content type (create; update if it changes)",
  }),
  content: Schema.optional(Schema.String).annotate({ description: "The FULL content (create, update)" }),
  language: Schema.optional(Schema.String).annotate({ description: "Language, for kind=code" }),
  base_revision: Schema.optional(Schema.Number).annotate({
    description: "update: the revision you last read. The update is refused if someone else wrote since.",
  }),
  display: Schema.optional(Schema.Literals(["inline", "card"])).annotate({
    description:
      "inline = draw it live INSIDE the chat message, full width and interactive (the answer IS the interface: a filterable table, a calculator, a chart to explore). card = a small preview that opens the pane (documents, long pages). Default card.",
  }),
  bindings: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        call_id: Schema.optional(Schema.String),
        dataset: Schema.optional(Schema.String),
        path: Schema.optional(Schema.String),
      }),
    ),
  ).annotate({
    description:
      "html only. Data for the page, by reference — never retype numbers into the HTML. {name: {call_id}} = the result of an earlier tool call in this conversation; {name: {dataset: slug}} = an Atlas dataset. Optional path digs into the value. The page reads it with iris.data.rows(name) / has(name) / meta(name).",
  }),
})

/** Everything the chat card needs to draw and open the artifact without asking the server first. */
type Metadata = {
  id?: string
  revision?: number
  count?: number
  conflict?: boolean
  title?: string
  kind?: Artifacts.Kind
  session?: string
  created?: boolean
  display?: "inline" | "card"
  /** The resolved data, so the card draws exactly what was written to the artifact. */
  bindings?: Bindings
}

/** The last completed call with this id in the conversation the tool was given. */
function findCall(messages: Tool.Context["messages"], callID: string) {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of messages[i]?.parts ?? []) {
      if (part.type === "tool" && part.callID === callID) return part
    }
  }
  return undefined
}

/**
 * Turn the agent's {name: {call_id | dataset}} into data, or fail with a reason the agent can act
 * on. A binding that cannot be resolved FAILS the call — an empty frame reads as "no data",
 * which is the one answer that is never true here.
 */
async function resolveBindings(
  specs: NonNullable<Schema.Schema.Type<typeof Parameters>["bindings"]>,
  messages: Tool.Context["messages"],
): Promise<Bindings> {
  const out: Bindings = {}
  for (const [name, spec] of Object.entries(specs)) {
    if (!BINDING_NAME.test(name))
      throw new Error(`binding name "${name}" must be an identifier (letters, digits, _ or -)`)
    if (!!spec.call_id === !!spec.dataset) throw new Error(`binding "${name}": give exactly one of call_id or dataset`)
    let b: Binding
    if (spec.call_id) {
      const part = findCall(messages, spec.call_id)
      if (!part) {
        throw new Error(
          `binding "${name}": no tool call ${spec.call_id} in this conversation. Use the id of a call that has already finished — a call made in this same step is not visible yet.`,
        )
      }
      if (part.state.status !== "completed") {
        throw new Error(
          `binding "${name}": tool call ${spec.call_id} (${part.tool}) is ${part.state.status}, not completed`,
        )
      }
      if (part.state.time.compacted) {
        throw new Error(
          `binding "${name}": the result of ${spec.call_id} was compacted away — run ${part.tool} again and bind the new call`,
        )
      }
      const data = rowsFrom(toolResultValue(part.state), spec.path)
      b = { data, meta: { source: `call:${part.tool}:${spec.call_id}`, rows: data.length } }
    } else {
      const slug = spec.dataset!
      const rows: unknown[] = []
      let total: number | null = null
      let truncated = false
      for (let page = 1; ; page++) {
        const r = await fetchRecords(slug, { page, perPage: 200 })
        if (!r.measured) throw new Error(`binding "${name}": dataset "${slug}" could not be read — ${r.reason}`)
        total = r.data.total
        for (const row of r.data.rows) rows.push({ id: row.id, external_id: row.externalId, ...row.data })
        if (!r.data.hasMore) break
        if (rows.length >= 1000) {
          truncated = true
          break
        }
      }
      const data = rowsFrom(rows, spec.path)
      b = { data, meta: { source: `dataset:${slug}`, rows: data.length, total, ...(truncated ? { truncated } : {}) } }
    }
    out[name] = b
  }
  const bytes = bindingsBytes(out)
  if (bytes > MAX_BINDINGS_BYTES) {
    throw new Error(
      `bindings are ${Math.round(bytes / 1024)} KB; a chat frame takes at most ${Math.round(MAX_BINDINGS_BYTES / 1024)} KB. Bind a narrower path, or summarise first.`,
    )
  }
  return out
}

const byline = (m: Artifacts.Meta) => `rev ${m.revision}${m.author ? ` by ${m.author.agent}` : ""}`

export const GenesisArtifactTool = Tool.define<typeof Parameters, Metadata, Session.Service>(
  "genesis_artifact",
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    /** The session at the top of the subagent chain — the one the user is looking at. */
    const rootOf = (id: SessionID) =>
      Effect.gen(function* () {
        let current = yield* sessions.get(id)
        for (let hops = 0; current.parentID && hops < 16; hops++) current = yield* sessions.get(current.parentID)
        return current.id
      }).pipe(Effect.orElseSucceed(() => id))

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const directory = instance.directory
          const where = Artifacts.rootFor(directory)
          const session = String(yield* rootOf(ctx.sessionID))

          if (params.action === "list") {
            const all = Artifacts.list(where.dir, session)
            const lines = all.map((m) => `${m.id}  ${m.kind.padEnd(8)} ${byline(m).padEnd(24)} ${m.title}`)
            return {
              title: `${all.length} artifact${all.length === 1 ? "" : "s"}`,
              output: all.length ? lines.join("\n") : "No artifacts in this session yet.",
              metadata: { count: all.length },
            }
          }

          if (params.action === "read") {
            if (!params.id) return yield* Effect.fail(new Error("read needs an id — see action=list"))
            const r = Artifacts.read(where.dir, session, params.id)
            if (!r) return yield* Effect.fail(new Error(`no artifact ${params.id} in this session — see action=list`))
            return {
              title: `${r.meta.title} (${byline(r.meta)})`,
              output: `revision: ${r.meta.revision}\nauthor: ${r.meta.author?.agent ?? "unknown"}\nkind: ${r.meta.kind}${
                r.truncated ? "\n(truncated at 2 MB)" : ""
              }\n\n${r.content}`,
              metadata: { id: r.meta.id, revision: r.meta.revision },
            }
          }

          // create / update
          if (params.content === undefined) return yield* Effect.fail(new Error(`${params.action} needs content`))
          if (params.action === "update" && !params.id) return yield* Effect.fail(new Error("update needs an id"))
          const prev = params.id ? Artifacts.read(where.dir, session, params.id)?.meta : undefined
          if (params.action === "update" && !prev) {
            return yield* Effect.fail(new Error(`no artifact ${params.id} in this session — create it instead`))
          }
          const kind = params.kind ?? prev?.kind
          if (!kind) return yield* Effect.fail(new Error("create needs a kind: html, markdown, csv or code"))
          const hasBindings = !!params.bindings && Object.keys(params.bindings).length > 0
          if (hasBindings && kind !== "html") {
            return yield* Effect.fail(new Error(`bindings are for html artifacts; this one is ${kind}`))
          }
          const bound = hasBindings
            ? yield* Effect.tryPromise({
                try: () => resolveBindings(params.bindings!, ctx.messages),
                catch: (e) => (e instanceof Error ? e : new Error(String(e))),
              })
            : undefined
          // New bindings REPLACE any block already in the content. No bindings = the content is
          // stored as given: an agent that read a bound artifact back and only changed its CSS
          // still carries the block, and the page keeps its data. Stripping it here would empty
          // the page on a styling edit, and an empty page reads as "no data".
          const content = bound ? injectBindings(params.content, bound) : params.content

          let meta: Artifacts.Meta
          try {
            meta = Artifacts.write(where.dir, {
              session,
              id: params.action === "update" ? params.id : undefined,
              title: params.title ?? prev?.title ?? "Untitled",
              kind,
              content,
              language: params.language ?? prev?.language,
              author: { agent: ctx.agent, session: String(ctx.sessionID) },
              baseRevision: params.action === "update" ? params.base_revision : undefined,
            })
          } catch (e) {
            if (e instanceof Artifacts.Conflict) {
              return {
                title: `conflict on ${e.id}`,
                output: e.message,
                metadata: { id: e.id, revision: e.current, conflict: true },
              }
            }
            return yield* Effect.fail(e instanceof Error ? e : new Error(String(e)))
          }

          GlobalBus.emit("event", {
            directory,
            payload: {
              type: ARTIFACT_EVENT,
              properties: { session, id: meta.id, revision: meta.revision, author: meta.author },
            },
          })

          return {
            title: `${meta.title} (${byline(meta)})`,
            output:
              `${params.action === "create" ? "Created" : "Updated"} Genesis artifact ${meta.id}, revision ${meta.revision}. ` +
              (params.display === "inline"
                ? "It is drawn live in the chat message, and in Genesis › Artifacts."
                : "It is showing in Genesis › Artifacts, and the chat has a card for it.") +
              (bound
                ? ` Bound: ${Object.entries(bound)
                    .map(
                      ([n, b]) =>
                        `${n} = ${b.meta.rows} row${b.meta.rows === 1 ? "" : "s"} from ${b.meta.source}${b.meta.truncated ? " (first 1000)" : ""}`,
                    )
                    .join("; ")}.`
                : ""),
            metadata: {
              id: meta.id,
              revision: meta.revision,
              title: meta.title,
              kind: meta.kind,
              session,
              created: params.action === "create",
              display: params.display ?? "card",
              ...(bound ? { bindings: bound } : {}),
            },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
