import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./genesis-artifact.txt"
import { Session } from "@/session/session"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { Artifacts } from "@/iris/artifacts"
import type { SessionID } from "../session/schema"

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

          let meta: Artifacts.Meta
          try {
            meta = Artifacts.write(where.dir, {
              session,
              id: params.action === "update" ? params.id : undefined,
              title: params.title ?? prev?.title ?? "Untitled",
              kind,
              content: params.content,
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
            output: `${params.action === "create" ? "Created" : "Updated"} Genesis artifact ${meta.id}, revision ${meta.revision}. It is showing in Genesis › Artifacts, and the chat has a card for it.`,
            metadata: {
              id: meta.id,
              revision: meta.revision,
              title: meta.title,
              kind: meta.kind,
              session,
              created: params.action === "create",
            },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
