import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser.txt"
import { Session } from "@/session/session"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { Artifacts } from "@/iris/artifacts"
import { PageSession, savedProfileDir, type ScriptedPage } from "@/iris/browser-driver"
import { PanelPage } from "@/iris/panel-page"
import { Panel } from "@/iris/panel"
import {
  clampPageText,
  describeChange,
  findInPage,
  looksIrreversible,
  refuseNavigationReason,
  refuseOptionReason,
  refuseScrollReason,
  refuseTargetReason,
  refuseUrlReason,
  renderElements,
  windowOfLines,
} from "@/iris/browser-verbs"
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
  action: Schema.Literals([
    "open",
    "read",
    "find",
    "window",
    "elements",
    "click",
    "type",
    "select",
    "scroll",
    "screenshot",
    "close",
  ]).annotate({ description: "What to do" }),
  target: Schema.optional(Schema.Literals(["agent", "panel"])).annotate({
    description:
      "Which browser. agent (default): your own logged-out browser, invisible to the person. panel: the IRIS Browser pane the person is looking at, signed in as them; only on sites they allowed, read-only for now",
  }),
  profile: Schema.optional(Schema.Literals(["fresh", "saved"])).annotate({
    description:
      "target agent, on open: fresh (default) is logged out of everything and forgotten on close. saved keeps the logins the person made in your browser window, between runs",
  }),
  visible: Schema.optional(Schema.Boolean).annotate({
    description:
      "target agent, on open: true opens your browser as a window on the person's screen, so they can watch, take over, or sign in once (with profile saved). Default false: invisible",
  }),
  url: Schema.optional(Schema.String).annotate({ description: "The page to open (open)" }),
  query: Schema.optional(Schema.String).annotate({ description: "Text to search the page for (find)" }),
  title: Schema.optional(Schema.String).annotate({ description: "Title for the saved screenshot (screenshot)" }),
  max_chars: Schema.optional(Schema.Number).annotate({
    description: "Budget for page text, default 3000 (read). Past it, use find.",
  }),
  line: Schema.optional(Schema.Number).annotate({ description: "Line number to read around (window)" }),
  radius: Schema.optional(Schema.Number).annotate({ description: "Lines either side, default 5 (window)" }),
  ref: Schema.optional(Schema.Number).annotate({ description: "Element number from `elements` (click, type)" }),
  text: Schema.optional(Schema.String).annotate({ description: "What to type (type)" }),
  value: Schema.optional(Schema.String).annotate({ description: "Option to choose (select)" }),
  direction: Schema.optional(Schema.Literals(["up", "down", "top", "bottom"])).annotate({
    description: "Where to scroll (scroll)",
  }),
  confirm: Schema.optional(Schema.Boolean).annotate({
    description: "Required for a click that cannot be undone (delete, pay, send…)",
  }),
})

type Metadata = {
  url?: string
  line?: number
  ref?: number
  elements?: number
  changed?: boolean
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
const sessionsOpen = new Map<string, ScriptedPage>()

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
          const target = params.target ?? "agent"
          // One page per target per root session: the pane and the agent's Chrome never share.
          const key = target === "panel" ? `${session}:panel` : session
          let page = sessionsOpen.get(key)

          if (target === "panel") {
            // The pane is the person's, signed in as them. Whether the agent may click or type
            // there is THEIR call, made in the app per site (#193186), not this tool's.
            if (params.action === "screenshot") {
              return yield* Effect.fail(
                new Error("screenshots of the Browser pane aren't available yet: use read or find, or target agent"),
              )
            }
            if (!page && params.action !== "close") {
              const directory = (yield* InstanceState.context).directory
              const panel = new PanelPage(
                (command, timeoutMs) => Panel.send({ directory, session, command, timeoutMs }),
                (o) => Panel.explainSilence(o, session),
              )
              if (params.action !== "open") {
                const attached = yield* attempt(() => panel.attach())
                if (!attached.ok) return yield* Effect.fail(new Error(attached.message))
              }
              sessionsOpen.set(key, panel)
              page = panel
            }
          }

          if (params.action === "close") {
            if (!page) return { title: "browser", output: "No browser was open.", metadata: {} }
            yield* attempt(() => page!.close())
            sessionsOpen.delete(key)
            if (target === "panel") {
              return { title: "browser pane", output: "Done with the Browser pane. The page stays open there: it is the person's.", metadata: {} }
            }
            return { title: "browser closed", output: "The browser is closed.", metadata: {} }
          }

          if (params.action === "open") {
            if (!params.url) return yield* Effect.fail(new Error("open needs a url"))
            // The pane is opened by a person asking for a page, deliberately; the cross-origin rule
            // exists for navigation the PAGE chooses (clicks), which the pane can't do yet.
            const refusal =
              target !== "panel" && page?.currentUrl
                ? refuseNavigationReason(page.currentUrl, params.url)
                : refuseUrlReason(params.url)
            if (refusal) return yield* Effect.fail(new Error(refusal))

            // The agent's own Chrome (B3, #193187): which profile, and whether it has a window.
            // Asking for a different kind than the one open reopens it, never silently keeps the old.
            const want = { saved: params.profile === "saved", visible: params.visible === true }
            if (target === "agent" && page instanceof PageSession) {
              const have = page.kind
              if (have.saved !== want.saved || have.visible !== want.visible) {
                yield* attempt(() => page!.close())
                sessionsOpen.delete(key)
                page = undefined
              }
            }
            const p: ScriptedPage =
              page ??
              new PageSession({ headless: !want.visible, profileDir: want.saved ? savedProfileDir() : undefined })
            const opened = yield* attempt(() => p.open(params.url!))
            if (!opened.ok) {
              if (target !== "panel") yield* attempt(() => p.close())
              return yield* Effect.fail(new Error(opened.message))
            }
            const landed = opened.value
            sessionsOpen.set(key, p)

            const how =
              p instanceof PageSession
                ? `\n(${p.kind.visible ? "a window on the person's screen" : "invisible"}, ${p.kind.saved ? "saved profile: their earlier sign-ins in it apply" : "fresh profile: logged out"})`
                : "\n(in the person's Browser pane)"
            return {
              title: landed.title || landed.url,
              output: `opened ${landed.url}\ntitle: ${landed.title || "(none)"}${how}\n\nRead it with action=read, or search it with action=find.`,
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

          if (params.action === "window") {
            if (!params.line) return yield* Effect.fail(new Error('window needs a line, e.g. {"action":"window","line":142}'))
            const got = yield* attempt(() => page.text())
            if (!got.ok) return yield* Effect.fail(new Error(got.message))
            let out: string
            try {
              out = windowOfLines(got.value, params.line, params.radius ?? 5)
            } catch (e) {
              return yield* Effect.fail(e instanceof Error ? e : new Error(String(e)))
            }

            return { title: `window at line ${params.line}`, output: out, metadata: { line: params.line } }
          }

          if (params.action === "elements") {
            const got = yield* attempt(() => page.elements())
            if (!got.ok) return yield* Effect.fail(new Error(got.message))

            return {
              title: `${got.value.length} elements`,
              output: `${renderElements(got.value)}\n\nUse the number: {"action":"click","ref":N} or {"action":"type","ref":N,"text":"…"}.`,
              metadata: { elements: got.value.length, url: page.currentUrl ?? undefined },
            }
          }

          if (params.action === "scroll") {
            const dir = params.direction ?? "down"
            const bad = refuseScrollReason(dir)
            if (bad) return yield* Effect.fail(new Error(bad))
            const before = yield* attempt(() => page.state())
            if (!before.ok) return yield* Effect.fail(new Error(before.message))
            const done = yield* attempt(() => page.scroll(dir))
            if (!done.ok) return yield* Effect.fail(new Error(done.message))
            const after = yield* attempt(() => page.state())
            if (!after.ok) return yield* Effect.fail(new Error(after.message))
            const changed = describeChange(before.value, after.value)

            return {
              title: `scroll ${dir}`,
              output: `scrolled ${dir}. ${changed === "nothing changed — same url, same text, same field values" ? "The page text is unchanged (nothing new loaded); run elements to see what is in view." : changed}`,
              metadata: { url: after.value.url },
            }
          }

          if (params.action === "select") {
            if (!params.ref) return yield* Effect.fail(new Error("select needs a ref — run action=elements first"))
            if (params.value === undefined) return yield* Effect.fail(new Error("select needs a value"))
            const listed = yield* attempt(() => page.elements())
            if (!listed.ok) return yield* Effect.fail(new Error(listed.message))
            const wrongTarget = refuseTargetReason(listed.value, params.ref, "select")
            if (wrongTarget) return yield* Effect.fail(new Error(wrongTarget))
            const wrongOption = refuseOptionReason(listed.value, params.ref, params.value)
            if (wrongOption) return yield* Effect.fail(new Error(wrongOption))

            const before = yield* attempt(() => page.state())
            if (!before.ok) return yield* Effect.fail(new Error(before.message))
            const set = yield* attempt(() => page.selectRef(params.ref!, params.value!))
            if (!set.ok) return yield* Effect.fail(new Error(set.message))
            if (!set.value) {
              return yield* Effect.fail(new Error(`[${params.ref}] is no longer on the page — run action=elements again`))
            }
            const after = yield* attempt(() => page.state())
            if (!after.ok) return yield* Effect.fail(new Error(after.message))

            return {
              title: `select [${params.ref}] = ${params.value}`,
              output: describeChange(before.value, after.value),
              metadata: { ref: params.ref, url: after.value.url },
            }
          }

          if (params.action === "click" || params.action === "type") {
            if (!params.ref) return yield* Effect.fail(new Error(`${params.action} needs a ref — run action=elements first`))
            if (params.action === "type" && params.text === undefined) {
              return yield* Effect.fail(new Error("type needs text"))
            }

            // The menu is rebuilt for every action, because after one click the legal set has
            // changed and a stale action space is a stale decision.
            const listed = yield* attempt(() => page.elements())
            if (!listed.ok) return yield* Effect.fail(new Error(listed.message))
            const refusal = refuseTargetReason(listed.value, params.ref, params.action)
            if (refusal) return yield* Effect.fail(new Error(refusal))
            const el = listed.value.find((e) => e.ref === params.ref)!

            if (params.action === "click" && looksIrreversible(el.name) && !params.confirm) {
              return yield* Effect.fail(
                new Error(
                  `"${el.name}" looks like it cannot be undone. If you mean it, repeat with confirm: true — and tell the user what you are about to do first.`,
                ),
              )
            }

            // In the person's pane an irreversible click is theirs to allow, once, in the app:
            // `confirm: true` above only means the agent is asking (#193186).
            if (page instanceof PanelPage && params.action === "click" && looksIrreversible(el.name)) {
              page.confirmNext = el.name.slice(0, 80)
            }
            const before = yield* attempt(() => page.state())
            if (!before.ok) return yield* Effect.fail(new Error(before.message))
            const acted =
              params.action === "click"
                ? yield* attempt(() => page.clickRef(params.ref!))
                : yield* attempt(() => page.typeRef(params.ref!, params.text!))
            if (!acted.ok) return yield* Effect.fail(new Error(acted.message))
            if (!acted.value) {
              return yield* Effect.fail(new Error(`[${params.ref}] is no longer on the page — run action=elements again`))
            }

            const after = yield* attempt(() => page.state())
            if (!after.ok) return yield* Effect.fail(new Error(after.message))

            // A click may take the page somewhere the agent never chose. Same rule as open: the
            // page does not get to pick the next origin.
            const offOrigin = refuseNavigationReason(before.value.url, after.value.url)
            if (offOrigin && after.value.url !== before.value.url) {
              yield* attempt(() => page.open(before.value.url))

              return {
                title: "navigation refused",
                output: `that click went to ${after.value.url} — ${offOrigin}. Came back to ${before.value.url}. Open it deliberately if you meant to.`,
                metadata: { url: before.value.url, changed: false },
              }
            }

            const changed = describeChange(before.value, after.value)

            return {
              title: `${params.action} [${params.ref}] ${el.name.slice(0, 40)}`,
              output: changed,
              metadata: { ref: params.ref, url: after.value.url, changed: !changed.startsWith("nothing changed") },
            }
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
