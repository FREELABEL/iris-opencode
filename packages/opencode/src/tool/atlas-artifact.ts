import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./atlas-artifact.txt"
import { atlasNoteUrl, probeAtlasNote } from "@/iris/atlas-note"

/**
 * The agent's side of Atlas › Artifacts (epic #187717) — the Atlas twin of `genesis_artifact`.
 *
 * DISPLAY-ONLY (ADR-01). A Genesis artifact is a local draft; an Atlas note is already live on the
 * internet, behind the CLI's PHI guard (`--force-public`). A `create` verb here would be a second
 * door around that guard, and would quietly turn "draw me a card" into "publish this to the web".
 * The agent publishes with the CLI, then shows the result with this.
 *
 * NO STORE (ADR-02). The panel's list is derived from this tool's parts in the session (and from
 * /n/ URLs in Shell output) — the content lives on heyiris.io, so there is nothing to keep on disk.
 *
 * IT CHECKS THE NOTE RESOLVES. A card for a 404 looks exactly like a card for a real note until
 * someone clicks it, so a note that does not answer 200 is refused here instead.
 */
export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The Atlas note URL — https://heyiris.io/n/<uuid>" }),
  title: Schema.optional(Schema.String).annotate({ description: "Used only when the note's page has no title of its own" }),
  summary: Schema.optional(Schema.String).annotate({ description: "One line saying what the note is" }),
})

type Metadata = { url?: string; title?: string; summary?: string }

export const AtlasArtifactTool = Tool.define<typeof Parameters, Metadata, never>(
  "atlas_artifact",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        const url = atlasNoteUrl(params.url)
        if (!url) {
          return yield* Effect.fail(
            new Error(`not an Atlas note URL: ${params.url} — it must be https://heyiris.io/n/<uuid>`),
          )
        }

        const probe = yield* Effect.promise(() => probeAtlasNote(url, ctx.abort))
        if (probe.state === "unreachable") {
          return yield* Effect.fail(
            new Error(`Couldn't reach heyiris.io to check this Atlas note (${probe.reason}). Try again in a moment.`),
          )
        }
        if (probe.state === "unavailable") {
          return yield* Effect.fail(
            new Error(
              `This Atlas note isn't public, or the link is wrong (heyiris.io answered HTTP ${probe.status} for ${url}). Make it public first — iris bloqs make-public <id> --force — then show it again.`,
            ),
          )
        }

        // The note's own title wins (#187717 follow-up). A title the model supplies is a guess at
        // what the note is called — it named this epic "Epic for this Feature" — and the card is
        // the one place a person reads it before clicking.
        const title = probe.title || params.title?.trim() || "Atlas note"
        const summary = params.summary?.trim().slice(0, 300) || undefined
        return {
          title,
          output: `Showing Atlas note "${title}" (${url}). It is open in Atlas › Artifacts, and the chat has a card for it.`,
          metadata: { url, title, summary },
        }
      }).pipe(Effect.orDie),
  } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>),
)
