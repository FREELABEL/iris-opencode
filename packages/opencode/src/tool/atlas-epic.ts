import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./atlas-epic.txt"
import { EPIC_ACTIONS, EPIC_KINDS, EPIC_STATUSES, countItems, normalizeEpic, saveEpic, type EpicList } from "@/iris/atlas-epic"

/**
 * `atlas_epic` — the agent shows a multi-list plan as a card in the chat and (by default) saves it
 * to Atlas as one list of cards.
 *
 * THE CARD NEVER DEPENDS ON THE SAVE. A failed save returns the plan with `saved: false` and a
 * plain reason; the call itself only fails on input that is not a plan at all (no title, no
 * lists). The work the agent did — the drafts — must not vanish because a board was unreachable.
 *
 * NOTHING HERE SENDS ANYTHING. Drafts live in `body`; the card's buttons put a request in the
 * composer for the person to send, and the agent acts on that as a separate turn.
 */
export const Parameters = Schema.Struct({
  title: Schema.String.annotate({ description: 'The goal, e.g. "Reply to people waiting on me"' }),
  summary: Schema.optional(Schema.String).annotate({
    description: 'One line, e.g. "4 things ready for you to review. Nothing was sent."',
  }),
  lists: Schema.Array(
    Schema.Struct({
      title: Schema.String.annotate({ description: 'e.g. "Draft replies to people waiting on you"' }),
      source: Schema.optional(Schema.String).annotate({
        description: 'The app this list touched: "gmail", "outlook", "stripe", "calendar", "slack", "books", "leads", "iris"…',
      }),
      status: Schema.optional(Schema.Literals(EPIC_STATUSES)).annotate({
        description: "ready = waiting for the user's review · needs = needs their input · done · none",
      }),
      label: Schema.optional(Schema.String).annotate({ description: 'Badge text, e.g. "4 drafts to review"' }),
      items: Schema.Array(
        Schema.Struct({
          title: Schema.String.annotate({ description: 'e.g. "Maria Lopez"' }),
          subtitle: Schema.optional(Schema.String).annotate({ description: `e.g. "Rescheduling Thursday's cleaning"` }),
          body: Schema.optional(Schema.String).annotate({ description: "The drafted reply or the detail. Never sent by this tool." }),
          kind: Schema.optional(Schema.Literals(EPIC_KINDS)),
          actions: Schema.optional(Schema.Array(Schema.Literals(EPIC_ACTIONS))),
          ref: Schema.optional(
            Schema.Struct({ type: Schema.String, id: Schema.String }).annotate({
              description: 'What this item points at, e.g. { type: "gmail_message", id: "1a11ee985e3dc9b1" }',
            }),
          ),
        }),
      ),
    }),
  ),
  save: Schema.optional(Schema.Boolean).annotate({ description: "Save to Atlas (default true)" }),
  bloq_id: Schema.optional(Schema.Number).annotate({
    description: 'Board to save into. Default: the configured default board, else one named "Plans".',
  }),
})

export type Metadata = {
  title: string
  summary?: string
  lists: (EpicList & { items: { id?: number }[] })[]
  saved: boolean
  bloqId?: number
  listIds?: number[]
  url?: string
  reason?: string
}

export const AtlasEpicTool = Tool.define<typeof Parameters, Metadata, never>(
  "atlas_epic",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        const norm = normalizeEpic(params)
        if ("error" in norm) return yield* Effect.fail(new Error(`atlas_epic: ${norm.error}`))
        const { epic, dropped } = norm

        const wantSave = params.save !== false
        const res = wantSave
          ? yield* Effect.promise(() => saveEpic(epic, { bloqId: params.bloq_id, signal: ctx.abort }))
          : { saved: false, reason: "not saved (save: false)" as string | undefined }

        const ids = "itemIds" in res ? res.itemIds : undefined
        const lists = epic.lists.map((l, li) => ({
          ...l,
          items: l.items.map((it, ii) => ({ ...it, id: ids?.[li]?.[ii], done: l.status === "done" || undefined })),
        }))
        const metadata: Metadata = {
          title: epic.title,
          summary: epic.summary,
          lists,
          saved: res.saved,
          bloqId: "bloqId" in res ? res.bloqId : undefined,
          listIds: "listIds" in res ? res.listIds : undefined,
          reason: res.reason,
        }

        const n = countItems(epic)
        const where = res.saved
          ? `Saved to Atlas board ${metadata.bloqId} as one list (id ${metadata.listIds?.[0]}).`
          : `Not saved to Atlas: ${res.reason}.`
        const output = [
          `Showing epic "${epic.title}": ${epic.lists.length} list(s), ${n} item(s). ${where}`,
          res.saved && res.reason ? `Partial: ${res.reason}.` : "",
          dropped.length ? `Dropped: ${dropped.join("; ")}.` : "",
          "The user sees it as a card in the chat. Nothing was sent; wait for them to ask before acting on any item.",
        ]
          .filter(Boolean)
          .join("\n")

        return { title: epic.title, output, metadata }
      }).pipe(Effect.orDie),
  } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>),
)
