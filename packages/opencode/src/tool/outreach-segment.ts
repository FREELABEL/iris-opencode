import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Session } from "@/session/session"
import { InstanceState } from "@/effect/instance-state"
import { Panel } from "@/iris/panel"
import {
  addFilter,
  changeDraft,
  FILTER_KEYS,
  findPeople,
  isFilterKey,
  previewSegment,
  readDraft,
  removeFilter,
  saveDraft,
  stepText,
  unsaved,
  type Draft,
  type Preview,
  type SegmentFilter,
} from "@/iris/segments"
import type { SessionID } from "../session/schema"

/**
 * THE AGENT BUILDS AN AUDIENCE WHERE THE PERSON CAN SEE IT (#193534 U2b, epic #193481).
 *
 * outreach_show opens the person's panel on Outreach › a view through the same `show` command
 * side_panel sends (iris/panel.ts → use-panel-control.ts → the panel's requested surface). The
 * segment_* tools edit the engine's draft segment (iris/segments.ts) — the SAME object the
 * Audiences view renders and polls — so each filter the agent adds lands on the person's screen.
 *
 * NO SEND TOOL. Nothing in this file sends a message. segment_find adds leads to a board and asks
 * first; segment_save writes the segment to fl-api and asks first.
 */

export const OUTREACH_VIEWS = ["today", "campaigns", "scripts", "audiences"] as const
export type OutreachView = (typeof OUTREACH_VIEWS)[number]

/** The panel command outreach_show sends: the Outreach product, on this view. */
export function outreachShowCommand(view: OutreachView): Panel.Command {
  return { action: "show", surface: "outreach", sub: view }
}

const n = (v: number) => v.toLocaleString("en-US")
const valueText = (v: SegmentFilter["value"]) => (Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "yes" : "no") : String(v))

/** One line per filter, in order, with what is left after it — the same words the panel shows. */
export function describeBreakdown(filters: SegmentFilter[], p: Preview | null): string {
  if (!filters.length) return "No filters yet: the segment is the whole board."
  return filters
    .map((f, i) => {
      const r = p?.breakdown.find((x) => x.key === f.key)
      return `${i + 1}. ${f.key} = ${valueText(f.value)} → ${r ? stepText(r) : "not counted"}`
    })
    .join("\n")
}

function draftHead(d: Draft): string {
  const name = d.name ? `"${d.name}"` : "unnamed draft"
  const saved = d.segment_id ? `segment #${d.segment_id}${unsaved(d) ? ", unsaved changes" : ""}` : "not saved"
  return `Board #${d.bloq} · ${name} · ${saved}`
}

const BloqParam = Schema.optional(Schema.Number).annotate({
  description: "Board id. Default: the board of the draft changed last (the one on the person's screen).",
})

type Meta = { bloq?: number; rev?: number; total?: number | null; reason?: string }

/** The board a call means: the one given, else the draft the person is looking at. */
async function boardOf(bloq: number | undefined): Promise<number | string> {
  if (bloq) return bloq
  const d = await readDraft()
  return d.data?.bloq ?? "No draft segment is open yet: pass bloq (the board id), or call outreach_show with view=audiences and a bloq first."
}

/** The draft, previewed — what every segment_* tool answers with. */
async function report(d: Draft, lead: string) {
  const p = await previewSegment(d.bloq, d.filters)
  const total = p.data?.total ?? null
  const lines = [
    lead,
    draftHead(d),
    describeBreakdown(d.filters, p.data),
    p.measured ? `In the segment now: ${total === null ? "—" : n(total)}` : `Counts unavailable: ${p.reason}`,
  ]
  return { title: `${lead}${total === null ? "" : ` · ${n(total)}`}`, output: lines.join("\n"), metadata: { bloq: d.bloq, rev: d.rev, total } satisfies Meta }
}

// ─── outreach_show ────────────────────────────────────────────────────────────

const ShowParams = Schema.Struct({
  view: Schema.Literals(OUTREACH_VIEWS).annotate({ description: "today, campaigns, scripts or audiences" }),
  segment_id: Schema.optional(Schema.Number).annotate({ description: "audiences: open this saved segment in the draft" }),
  bloq: BloqParam,
})

export const OutreachShowTool = Tool.define<typeof ShowParams, Meta & { answered?: boolean }, Session.Service>(
  "outreach_show",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const rootOf = (id: SessionID) =>
      Effect.gen(function* () {
        let current = yield* sessions.get(id)
        for (let hops = 0; current.parentID && hops < 16; hops++) current = yield* sessions.get(current.parentID)
        return current.id
      }).pipe(Effect.orElseSucceed(() => id))
    return {
      description: [
        "Open the person's IRIS Desktop panel on Outreach › a view, so they watch what you do there.",
        "Views: today (replies and drafts waiting), campaigns, scripts, audiences (build a segment: filters with counts, and its members).",
        "With view=audiences, segment_id opens that saved segment in the draft; bloq opens that board's draft. Then use segment_add_filter / segment_remove_filter: each change shows on their screen.",
        "Returns what the desktop reports after applying it. Sends nothing.",
      ].join("\n"),
      parameters: ShowParams,
      execute: (params: Schema.Schema.Type<typeof ShowParams>, ctx: Tool.Context<Meta & { answered?: boolean }>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const session = String(yield* rootOf(ctx.sessionID))
          // The draft first: the panel reads it the moment Audiences mounts.
          const focused =
            params.view === "audiences" && (params.segment_id || params.bloq)
              ? yield* Effect.promise(() => changeDraft({ bloq: params.bloq ?? 0, load: params.segment_id, by: "agent" }))
              : undefined
          if (focused && !focused.measured) return { title: "segment not opened", output: focused.reason ?? "", metadata: { reason: focused.reason } }
          const sent = yield* Effect.promise(() => Panel.send({ directory: instance.directory, session, command: outreachShowCommand(params.view) }))
          if (!sent.state) return { title: "desktop did not answer", output: Panel.explainSilence(sent, session), metadata: { answered: false } }
          const head = focused?.data ? `${draftHead(focused.data)}\n` : ""
          return {
            title: sent.state.error ? "partly applied" : `Outreach › ${params.view}`,
            output: head + Panel.describe(sent.state),
            metadata: { answered: true, bloq: focused?.data.bloq, rev: focused?.data.rev },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof ShowParams, Meta & { answered?: boolean }>
  }),
)

// ─── segment_preview / add / remove ──────────────────────────────────────────

const PreviewParams = Schema.Struct({ bloq: BloqParam })

export const SegmentPreviewTool = Tool.define<typeof PreviewParams, Meta, never>(
  "segment_preview",
  Effect.succeed({
    description:
      "Count the draft segment: for each filter in order, how many leads are left, and for demographic filters (niche, role, city, followers) how many are known vs unknown. Saves nothing, changes nothing.",
    parameters: PreviewParams,
    execute: (params: Schema.Schema.Type<typeof PreviewParams>) =>
      Effect.promise(async () => {
        const b = await boardOf(params.bloq)
        if (typeof b === "string") return { title: "no draft", output: b, metadata: { reason: b } }
        const d = await readDraft(b)
        return report(d.data!, "Draft segment")
      }),
  }),
)

const AddParams = Schema.Struct({
  key: Schema.Literals(FILTER_KEYS).annotate({
    description:
      "source_post (post URL or shortcode), comment_contains, discovery_mode (comments|followers|profiles|inbox), status_in (comma list), replied (yes/no), contacted (yes/no), niche_in, role_in (comma lists), city_contains, followers_min, followers_max, has_email (yes/no)",
  }),
  value: Schema.String.annotate({ description: 'The value as text, e.g. "roadmap", "5000", "yes", "Coach, Creator"' }),
  bloq: BloqParam,
})

export const SegmentAddFilterTool = Tool.define<typeof AddParams, Meta, never>(
  "segment_add_filter",
  Effect.succeed({
    description:
      "Add a filter to the draft segment the person is looking at (Outreach › Audiences), or change the value of one already there. The panel shows it within a moment, with its count. Returns every filter's count after the change. Saves nothing.",
    parameters: AddParams,
    execute: (params: Schema.Schema.Type<typeof AddParams>) =>
      Effect.promise(async () => {
        const b = await boardOf(params.bloq)
        if (typeof b === "string") return { title: "no draft", output: b, metadata: { reason: b } }
        const d = await addFilter(b, params.key, params.value, "agent")
        if (!d.measured) return { title: "not added", output: d.reason ?? "", metadata: { bloq: b, reason: d.reason } }
        return report(d.data, `Added ${params.key}`)
      }),
  }),
)

const RemoveParams = Schema.Struct({ key: Schema.String.annotate({ description: "The filter key to remove" }), bloq: BloqParam })

export const SegmentRemoveFilterTool = Tool.define<typeof RemoveParams, Meta, never>(
  "segment_remove_filter",
  Effect.succeed({
    description: "Remove a filter from the draft segment the person is looking at. Returns every filter's count after the change. Saves nothing.",
    parameters: RemoveParams,
    execute: (params: Schema.Schema.Type<typeof RemoveParams>) =>
      Effect.promise(async () => {
        if (!isFilterKey(params.key)) return { title: "no such filter", output: `one of: ${FILTER_KEYS.join(", ")}`, metadata: {} }
        const b = await boardOf(params.bloq)
        if (typeof b === "string") return { title: "no draft", output: b, metadata: { reason: b } }
        const d = await removeFilter(b, params.key, "agent")
        if (!d.measured) return { title: "not removed", output: d.reason ?? "", metadata: { bloq: b, reason: d.reason } }
        return report(d.data, `Removed ${params.key}`)
      }),
  }),
)

// ─── segment_save ─────────────────────────────────────────────────────────────

const SaveParams = Schema.Struct({ name: Schema.String.annotate({ description: 'e.g. "Roadmap commenters, course creators"' }), bloq: BloqParam })

export const SegmentSaveTool = Tool.define<typeof SaveParams, Meta, never>(
  "segment_save",
  Effect.succeed({
    description:
      "Save the draft segment to the board (a new segment, or the one it was opened from), after the person approves. `iris segment show <id>` then shows the same filters. Sends nothing; no campaign changes.",
    parameters: SaveParams,
    execute: (params: Schema.Schema.Type<typeof SaveParams>, ctx: Tool.Context<Meta>) =>
      Effect.gen(function* () {
        const b = yield* Effect.promise(() => boardOf(params.bloq))
        if (typeof b === "string") return { title: "no draft", output: b, metadata: { reason: b } }
        const d = yield* Effect.promise(() => readDraft(b))
        yield* ctx.ask({
          permission: "segment_save",
          patterns: [`bloq:${b}`],
          always: [`bloq:${b}`],
          metadata: { bloq: b, name: params.name, filters: d.data?.filters ?? [], segment_id: d.data?.segment_id ?? null },
        })
        const saved = yield* Effect.promise(() => saveDraft(b, params.name, "agent"))
        if (!saved.measured) return { title: "not saved", output: saved.reason ?? "", metadata: { bloq: b, reason: saved.reason } }
        return yield* Effect.promise(() => report(saved.data, `Saved as segment #${saved.data.segment_id}`))
      }),
  }),
)

// ─── segment_find ─────────────────────────────────────────────────────────────

const FindParams = Schema.Struct({
  bloq: Schema.Number.annotate({ description: "The board the leads land on" }),
  post_url: Schema.optional(Schema.String).annotate({ description: "An Instagram post: its commenters become leads" }),
  scrape_urls: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Public pages (team, about, directories): the people on them become leads" }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Add at most this many" }),
})

export const SegmentFindTool = Tool.define<typeof FindParams, Meta & { added?: number | null }, never>(
  "segment_find",
  Effect.succeed({
    description: [
      "Find new people and ADD them to a board as leads, after the person approves: an Instagram post's commenters (post_url) or the people on public pages (scrape_urls).",
      "Runs `iris reachr scrape <bloq> … --write` on this computer; Instagram needs that computer's logged-in session.",
      "It never sends a message. With post_url, the draft segment also gets that post as its source_post filter.",
    ].join("\n"),
    parameters: FindParams,
    execute: (params: Schema.Schema.Type<typeof FindParams>, ctx: Tool.Context<Meta & { added?: number | null }>) =>
      Effect.gen(function* () {
        const source = params.post_url ?? (params.scrape_urls ?? []).join(", ")
        yield* ctx.ask({
          permission: "segment_find",
          patterns: [source || "*"],
          always: [`bloq:${params.bloq}`],
          metadata: { bloq: params.bloq, post_url: params.post_url, scrape_urls: params.scrape_urls, adds: "leads", sends: "nothing" },
        })
        const r = yield* Effect.promise(() => findPeople({ bloq: params.bloq, post_url: params.post_url, urls: params.scrape_urls ? [...params.scrape_urls] : undefined, limit: params.limit }))
        if (!r.measured || !r.data) return { title: "nothing added", output: r.reason ?? "", metadata: { bloq: params.bloq, reason: r.reason } }
        const f = r.data
        const said = `Added ${f.added ?? "?"} lead(s) to board #${params.bloq} from ${f.source}${f.already ? ` · ${f.already} already there` : ""}${f.failed ? ` · ${f.failed} failed` : ""}. Nothing was sent.`
        if (!params.post_url) return { title: said, output: said, metadata: { bloq: params.bloq, added: f.added } }
        const d = yield* Effect.promise(() => addFilter(params.bloq, "source_post", params.post_url, "agent"))
        const out = yield* Effect.promise(() => report(d.data, said))
        return { ...out, metadata: { ...out.metadata, added: f.added } }
      }),
  }),
)
