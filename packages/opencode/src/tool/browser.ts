import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser.txt"
import { Session } from "@/session/session"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { Artifacts } from "@/iris/artifacts"
import { PageSession } from "@/iris/browser-driver"
import { clampPageText, findInPage, refuseNavigationReason, refuseUrlReason } from "@/iris/browser-verbs"
import { ARTIFACT_EVENT } from "./genesis-artifact"
import type { SessionID } from "../session/schema"

/**
 * The agent's side of Genesis › Browser (#186665, slice 1 — read-only).
 *
 * Shaped after `genesis_artifact`: typed actions, one clear result per call, and the thing the
 * user should see lands in the pane they are already watching. This is the other half of that
 * tool — artifacts are what the agent MAKES, a page is what the agent can SEE.
 *
 * WHY A TOOL AND NOT A SHELL COMMAND. On the CLI branch the only way to a browser is `bash` →
 * `iris browser`, which the model has to know exists; in the desktop app the bundled sidecar has
 * no such command at all, so the capability was simply absent. A tool is discoverable, typed, and
 * its output can be rendered instead of printed.
 *
 * WHY NO MODEL INSIDE IT (ADR-01). The daemon's browser agent runs its own observe → decide → act
 * loop. Here the agent IS the model: a second one doubles the bill and hides the reasoning from the
 * person watching. Verbs in, page facts out.
 *
 * THE GUARDS LIVE HERE, at the boundary (ADR-03), not in the driver — so the driver's own test can
 * point at 127.0.0.1 while the agent never can. Everything a page says is data; the description
 * tells the agent so, and `find` returns lines rather than a narrative to be persuaded by.
 */
export const Parameters = Schema.Struct({
  action: Schema.Literals(["open", "read", "find", "screenshot", "close"]).annotate({ description: "What to do" }),
  url: Schema.optional(Schema.String).annotate({ description: "The page to open (open)" }),
  query: Schema.optional(Schema.String).annotate({ description: "Text to search the page for (find)" }),
  title: Schema.optional(Schema.String).annotate({ description: "Title for the saved screenshot (screenshot)" }),
  max_chars: Schema.optional(Schema.Number).annotate({
    description: "Budget for page text, default 3000 (read). Past it, use find.",
  }),
})

type Metadata = {
  url?: string
  title?: string
  matches?: number
  truncated?: boolean
  artifact?: string
  bytes?: number
}

/**
 * Run a browser call and hand back a verdict instead of throwing.
 *
 * The tool's failures are all sentences the agent should read and act on ("no Chrome", "refused:
 * a private address") — so they travel as values and are turned into one Effect.fail at the call
 * site, rather than as exceptions crossing the Effect boundary with an unknown type.
 */
const attempt = <T>(fn: () => Promise<T>) =>
  Effect.promise(async (): Promise<{ ok: true; value: T } | { ok: false; message: string }> => {
    try {
      return { ok: true, value: await fn() }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

/** Default text budget. The cap is why `find` exists — see browser-verbs. */
const DEFAULT_MAX_CHARS = 3000

/**
 * One browser per session, opened on first use and closed with `close`.
 *
 * Keyed by the ROOT session for the same reason artifacts are: a subagent runs in its own child
 * session, and a browser it opened under that key would be invisible to the parent — and left
 * running. A process the user never started and cannot see is the thing to avoid.
 */
const sessionsOpen = new Map<string, PageSession>()

export const BrowserTool = Tool.define<typeof Parameters, Metadata, Session.Service>(
  "browser",
  Effect.gen(function* () {
    const sessions = yield* Session.Service

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
          const session = String(yield* rootOf(ctx.sessionID))
          const page = sessionsOpen.get(session)

          if (params.action === "close") {
            if (!page) return { title: "browser", output: "No browser was open.", metadata: {} }
            yield* attempt(() => page.close())
            sessionsOpen.delete(session)
            return { title: "browser closed", output: "The browser is closed.", metadata: {} }
          }

          if (params.action === "open") {
            if (!params.url) return yield* Effect.fail(new Error("open needs a url"))
            const refusal = page?.currentUrl
              ? refuseNavigationReason(page.currentUrl, params.url)
              : refuseUrlReason(params.url)
            if (refusal) return yield* Effect.fail(new Error(refusal))

            const p = page ?? new PageSession()
            const opened = yield* attempt(() => p.open(params.url!))
            if (!opened.ok) {
              yield* attempt(() => p.close())
              return yield* Effect.fail(new Error(opened.message))
            }
            const landed = opened.value
            sessionsOpen.set(session, p)

            return {
              title: landed.title || landed.url,
              output: `opened ${landed.url}\ntitle: ${landed.title || "(none)"}\n\nRead it with action=read, or search it with action=find.`,
              metadata: { url: landed.url, title: landed.title },
            }
          }

          if (!page) {
            return yield* Effect.fail(new Error("no page is open — call action=open with a url first"))
          }

          if (params.action === "read") {
            const got = yield* attempt(() => page.text())
            if (!got.ok) return yield* Effect.fail(new Error(got.message))
            const text = got.value
            const budget = Math.max(200, params.max_chars ?? DEFAULT_MAX_CHARS)
            const out = clampPageText(text, budget)

            return {
              title: `read ${page.currentUrl ?? ""}`,
              output: out,
              metadata: { url: page.currentUrl ?? undefined, truncated: out.length !== text.length },
            }
          }

          if (params.action === "find") {
            if (!params.query?.trim()) return yield* Effect.fail(new Error('find needs a query, e.g. {"query":"total"}'))
            const got = yield* attempt(() => page.text())
            if (!got.ok) return yield* Effect.fail(new Error(got.message))
            const hit = findInPage(got.value, params.query)

            return { title: `find "${params.query}"`, output: hit.text, metadata: { matches: hit.matches } }
          }

          // screenshot → a Genesis artifact, so it lands in the pane the user is watching (ADR-04).
          const shot = yield* attempt(() => page.screenshot())
          if (!shot.ok) return yield* Effect.fail(new Error(shot.message))
          const png = shot.value
          const dataUri = `data:image/png;base64,${Buffer.from(png).toString("base64")}`
          if (dataUri.length > Artifacts.MAX_CONTENT_BYTES) {
            return yield* Effect.fail(
              new Error(`the screenshot is ${Math.round(png.length / 1024)} KB, too large to save — narrow the page first`),
            )
          }
          const instance = yield* InstanceState.context
          const directory = instance.directory
          const where = Artifacts.rootFor(directory)
          const title = params.title ?? `Screenshot — ${page.currentUrl ?? "page"}`
          const meta = Artifacts.write(where.dir, {
            session,
            title,
            kind: "html",
            content: `<img alt="${title.replace(/"/g, "&quot;")}" src="${dataUri}" style="max-width:100%">`,
            author: { agent: ctx.agent, session: String(ctx.sessionID) },
          })
          GlobalBus.emit("event", {
            directory,
            payload: {
              type: ARTIFACT_EVENT,
              properties: { session, id: meta.id, revision: meta.revision, author: meta.author },
            },
          })

          return {
            title,
            output: `Saved the screenshot to the Artifacts pane as ${meta.id} (revision ${meta.revision}).`,
            metadata: { artifact: meta.id, bytes: png.length, url: page.currentUrl ?? undefined },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
