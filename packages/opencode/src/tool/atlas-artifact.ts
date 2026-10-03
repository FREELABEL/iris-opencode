import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./atlas-artifact.txt"
import { atlasNoteUrl, noteTitle } from "@/iris/atlas-note"

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
  title: Schema.optional(Schema.String).annotate({ description: "Title on the card; defaults to the note's own" }),
  summary: Schema.optional(Schema.String).annotate({ description: "One line saying what the note is" }),
})

type Metadata = { url?: string; title?: string; summary?: string }

const FETCH_TIMEOUT_MS = 8000

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

        const page = yield* Effect.tryPromise({
          try: async () => {
            const res = await fetch(url, {
              signal: AbortSignal.any([ctx.abort, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
              headers: { accept: "text/html" },
            })
            return { status: res.status, html: res.ok ? (await res.text()).slice(0, 200_000) : "" }
          },
          catch: (e) => new Error(`could not reach ${url}: ${e instanceof Error ? e.message : String(e)}`),
        })
        if (page.status !== 200) {
          return yield* Effect.fail(
            new Error(
              `${url} answered HTTP ${page.status} — the note is missing or not public. Publish it first (iris bloqs make-public <id> --force).`,
            ),
          )
        }

        const title = params.title?.trim() || noteTitle(page.html) || "Atlas note"
        const summary = params.summary?.trim().slice(0, 300) || undefined
        return {
          title,
          output: `Showing Atlas note "${title}" (${url}). It is open in Atlas › Artifacts, and the chat has a card for it.`,
          metadata: { url, title, summary },
        }
      }).pipe(Effect.orDie),
  } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>),
)
