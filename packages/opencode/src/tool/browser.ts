import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser.txt"
import { Session } from "@/session/session"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { Artifacts } from "@/iris/artifacts"
import { KEYS, PageSession, savedProfileDir, type Key, type ScriptedPage } from "@/iris/browser-driver"
import { PanelPage } from "@/iris/panel-page"
import { Panel } from "@/iris/panel"
import {
  clampPageText,
  describeChange,
  errorPageReason,
  RECOVER,
  findInPage,
  humanCheckAdvice,
  humanCheckReason,
  looksIrreversible,
  refuseNavigationReason,
  refuseOptionReason,
  refuseScrollReason,
  refuseTargetReason,
  refuseUrlReason,
  listingFooter,
  renderElements,
  renderInspect,
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
    "inspect",
    "click",
    "type",
    "select",
    "press",
    "scroll",
    "screenshot",
    "close",
    "tabs",
  ]).annotate({ description: "What to do" }),
  target: Schema.optional(Schema.Literals(["agent", "panel"])).annotate({
    description:
      "Which browser. Leave it out to use the one the person can see: in IRIS Desktop that is panel (the Browser pane, signed in as them, only on sites they allowed); elsewhere agent. agent: your own separate Chrome, invisible and logged out unless you pass profile/visible",
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
  query: Schema.optional(Schema.String).annotate({ description: "Text to search the page for (find), or the words on the control you want (elements)" }),
  title: Schema.optional(Schema.String).annotate({ description: "Title for the saved screenshot (screenshot)" }),
  max_chars: Schema.optional(Schema.Number).annotate({
    description: "Budget for page text, default 3000 (read). Past it, use find.",
  }),
  line: Schema.optional(Schema.Number).annotate({ description: "Line number to read around (window)" }),
  radius: Schema.optional(Schema.Number).annotate({ description: "Lines either side, default 5 (window)" }),
  ref: Schema.optional(Schema.Number).annotate({ description: "Element number from `elements` (click, type, select, inspect)" }),
  text: Schema.optional(Schema.String).annotate({ description: "What to type (type)" }),
  value: Schema.optional(Schema.String).annotate({ description: "Option to choose (select)" }),
  key: Schema.optional(Schema.Literals(Object.keys(KEYS) as [Key, ...Key[]])).annotate({
    description: "Key to press (press): Enter, Escape, Tab, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Backspace",
  }),
  direction: Schema.optional(Schema.Literals(["up", "down", "top", "bottom"])).annotate({
    description: "Where to scroll (scroll)",
  }),
  confirm: Schema.optional(Schema.Boolean).annotate({
    description: "Required for a click that cannot be undone (delete, pay, send…)",
  }),
  tab: Schema.optional(Schema.Union([Schema.String, Schema.Number])).annotate({
    description:
      "Browser pane only: which of this chat's tabs, by number (1, 2…) or label (\"Map\"). Leave it out for the tab the person is looking at. A click or type in another tab brings it to the front first. With close: closes that tab",
  }),
  new_tab: Schema.optional(Schema.Boolean).annotate({
    description: "open, Browser pane: open the address in a NEW tab of this chat instead of replacing the page (at most 6 tabs)",
  }),
  label: Schema.optional(Schema.String).annotate({
    description: "open with new_tab: a short name for the tab the person sees (\"Car rental\", \"Map\", \"Itinerary\")",
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
  /** The address changed during this call (a click, a route change inside the site). */
  navigated?: boolean
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

/** This chat's tabs, one line: which is showing, what each is (#193328). */
export function renderTabs(tabs: { n: number; label?: string; title?: string; url?: string; active: boolean }[]): string {
  if (!tabs.length) return ""
  const name = (t: (typeof tabs)[number]) => {
    let host = ""
    try {
      host = t.url ? new URL(t.url).hostname.replace(/^www\./, "") : ""
    } catch {}
    const what = t.label ?? t.title?.slice(0, 40) ?? (host || "new tab")
    return `${t.n} ${what}${t.label && host ? ` (${host})` : ""}${t.active ? " ← the person is looking at this one" : ""}`
  }
  return `tabs: ${tabs.map(name).join(" · ")}. Name one with tab: N.`
}

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
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) => {
        // The page this call worked on, and where it was when the call began: every answer ends
        // with where the page is NOW, read fresh (#193242: an Indeed click changed the address
        // and nothing said so).
        let used: { page: ScriptedPage; startUrl?: string } | undefined
        // The pane this call used, for the closing list of the chat's tabs (#193328).
        let pane: PanelPage | undefined
        return Effect.gen(function* () {
          const session = String(yield* rootOf(ctx.sessionID))
          const target = params.target ?? Panel.defaultBrowser(Panel.get(session))
          // One page per target per root session: the pane and the agent's Chrome never share.
          const key = target === "panel" ? `${session}:panel` : session
          let page = sessionsOpen.get(key)

          if (target === "panel") {
            // The pane is the person's, signed in as them. Whether the agent may click or type
            // there is THEIR call, made in the app per site (#193186), not this tool's.
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

          const tabRef = params.tab === undefined ? undefined : String(params.tab).trim() || undefined
          if (target !== "panel" && (tabRef || params.new_tab || params.action === "tabs")) {
            return yield* Effect.fail(
              new Error("tabs are in the person's Browser pane (target panel). Your own browser (target agent) has one page"),
            )
          }
          if (page instanceof PanelPage) {
            page.tab = tabRef
            pane = page
          }

          if (params.action === "tabs") {
            if (!(page instanceof PanelPage)) return yield* Effect.fail(new Error("no Browser pane is open"))
            const got = yield* attempt(() => (page as PanelPage).listTabs())
            if (!got.ok) return yield* Effect.fail(new Error(got.message))
            pane = undefined // the list IS the answer
            return { title: `${got.value.length} tabs`, output: renderTabs(got.value) || "One tab.", metadata: {} }
          }

          if (params.action === "close" && tabRef && page instanceof PanelPage) {
            const got = yield* attempt(() => (page as PanelPage).closeTab(tabRef))
            if (!got.ok) return yield* Effect.fail(new Error(got.message))
            pane = undefined
            return { title: `closed tab ${tabRef}`, output: `Closed tab ${tabRef}.\n${renderTabs(got.value)}`, metadata: {} }
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
            const opened = yield* attempt(() =>
              p instanceof PanelPage ? p.open(params.url!, { newTab: params.new_tab, label: params.label }) : p.open(params.url!),
            )
            if (!opened.ok) {
              if (target !== "panel") yield* attempt(() => p.close())
              return yield* Effect.fail(new Error(opened.message))
            }
            const landed = opened.value
            sessionsOpen.set(key, p)
            if (p instanceof PanelPage) pane = p

            const how =
              p instanceof PageSession
                ? `\n(${p.kind.visible ? "a window on the person's screen" : "invisible"}, ${p.kind.saved ? "saved profile: their earlier sign-ins in it apply" : "fresh profile: logged out"})`
                : "\n(in the person's Browser pane)"
            // A bot check is not the page: say so before the agent reads it as one (#193355).
            // The pane recognises its own checks and waits for the person (app human-check.ts).
            const sig = target === "panel" ? undefined : yield* attempt(() => p.signals())
            const check = sig?.ok ? humanCheckReason(sig.value) : null
            // An address that answers with an error page did not open the site (#193442).
            const st = check ? undefined : yield* attempt(() => p.state())
            const bad = st?.ok ? errorPageReason(st.value) : undefined
            return {
              title: landed.title || landed.url,
              output: check
                ? `opened ${landed.url}\ntitle: ${landed.title || "(none)"}${how}\n\n${humanCheckAdvice(check, target === "panel" ? "panel" : "agent")}`
                : bad
                  ? `FAILED: ${landed.url} answered with ${bad}${landed.title ? ` ("${landed.title.slice(0, 80)}")` : ""}, not the site.${how}\n\n${RECOVER}`
                  : `opened ${landed.url}\ntitle: ${landed.title || "(none)"}${how}\n\nRead it with action=read, or search it with action=find.`,
              metadata: { url: landed.url, title: landed.title },
            }
          }

          if (!page) {
            return yield* Effect.fail(new Error("no page is open — call action=open with a url first"))
          }
          used = { page, startUrl: page.currentUrl ?? undefined }

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
            const got = yield* attempt(() => page.elements(150, { query: params.query }))
            if (!got.ok) return yield* Effect.fail(new Error(got.message))
            const footer = listingFooter(got.value.length, page.lastListing)
            const check = humanCheckReason(page.lastListing?.signals)
            if (check) {
              return {
                title: "human check",
                output: humanCheckAdvice(check, target === "panel" ? "panel" : "agent"),
                metadata: { elements: got.value.length, url: page.currentUrl ?? undefined },
              }
            }

            return {
              title: `${got.value.length} elements`,
              output: `${renderElements(got.value, page.currentUrl ?? undefined)}${footer ? `\n\n${footer}` : ""}\n\nUse the number: {"action":"click","ref":N} or {"action":"type","ref":N,"text":"…"}. To see where an item leads or its id without clicking: {"action":"inspect","ref":N}.`,
              metadata: { elements: got.value.length, url: page.currentUrl ?? undefined },
            }
          }

          if (params.action === "inspect") {
            if (!params.ref) return yield* Effect.fail(new Error("inspect needs a ref — run action=elements first"))
            const got = yield* attempt(() => page.inspect(params.ref!))
            if (!got.ok) return yield* Effect.fail(new Error(got.message))
            if (!got.value) return yield* Effect.fail(new Error(`[${params.ref}] is no longer on the page — run action=elements again`))
            return {
              title: `inspect [${params.ref}]`,
              output: renderInspect(params.ref, got.value),
              metadata: { ref: params.ref },
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
            const listed = yield* attempt(() => page.elements(150, { include: params.ref }))
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

          if (params.action === "press") {
            if (!params.key) return yield* Effect.fail(new Error(`press needs a key: ${Object.keys(KEYS).join(", ")}`))
            const key = params.key
            if (params.ref) {
              const listed = yield* attempt(() => page.elements(150, { include: params.ref }))
              if (!listed.ok) return yield* Effect.fail(new Error(listed.message))
              if (!listed.value.some((e) => e.ref === params.ref)) {
                return yield* Effect.fail(new Error(`there is no [${params.ref}] on this page — run elements again`))
              }
            }
            // Enter can submit a form or send a message: the same gate as clicking its button.
            if (key === "Enter") {
              const fx = yield* attempt(() => page.enterEffect(params.ref))
              if (!fx.ok) return yield* Effect.fail(new Error(fx.message))
              if (!fx.value.found) {
                return yield* Effect.fail(new Error(`[${params.ref}] is no longer on the page — run action=elements again`))
              }
              const gated = fx.value.kind === "newline" || (fx.value.kind !== "none" && looksIrreversible(fx.value.label))
              if (gated && !params.confirm) {
                return yield* Effect.fail(
                  new Error(
                    fx.value.kind === "newline"
                      ? `Enter in "${fx.value.label}" may SEND it. If you mean to send, repeat with confirm: true — and tell the user what you are sending first. For a new line inside the text, type it with \\n instead.`
                      : `Enter here would ${fx.value.kind === "submit" ? "submit" : "press"} "${fx.value.label}", which looks like it cannot be undone. If you mean it, repeat with confirm: true — and tell the user what you are about to do first.`,
                  ),
                )
              }
              if (gated && page instanceof PanelPage) page.confirmNext = (fx.value.label || "Enter").slice(0, 80)
            }
            page.takeNotes()
            const before = yield* attempt(() => page.state())
            if (!before.ok) return yield* Effect.fail(new Error(before.message))
            const pressed = yield* attempt(() => page.pressKey(params.ref, key))
            if (!pressed.ok) return yield* Effect.fail(new Error(pressed.message))
            if (!pressed.value) {
              return yield* Effect.fail(new Error(`[${params.ref}] is no longer on the page — run action=elements again`))
            }
            const after = yield* attempt(() => page.state())
            if (!after.ok) return yield* Effect.fail(new Error(after.message))
            const offOrigin = refuseNavigationReason(before.value.url, after.value.url)
            if (offOrigin && after.value.url !== before.value.url) {
              yield* attempt(() => page.open(before.value.url))
              return {
                title: "navigation refused",
                output: `that key went to ${after.value.url} — ${offOrigin}. Came back to ${before.value.url}. Open it deliberately if you meant to.`,
                metadata: { url: before.value.url, changed: false },
              }
            }
            const changed = describeChange(before.value, after.value)
            const notes = page.takeNotes()
            return {
              title: `press ${key}${params.ref ? ` [${params.ref}]` : ""}`,
              output: [changed, ...notes].join("\n"),
              metadata: { ref: params.ref, url: after.value.url, changed: !changed.startsWith("nothing changed") },
            }
          }

          if (params.action === "click" || params.action === "type") {
            if (!params.ref) return yield* Effect.fail(new Error(`${params.action} needs a ref — run action=elements first`))
            if (params.action === "type" && params.text === undefined) {
              return yield* Effect.fail(new Error("type needs text"))
            }

            // The menu is rebuilt for every action, because after one click the legal set has
            // changed and a stale action space is a stale decision.
            const listed = yield* attempt(() => page.elements(150, { include: params.ref }))
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
            page.takeNotes()
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
            // What the diff cannot show: a new tab kept in this one, a field that refused the
            // text, an overlay a person's click would have hit instead (#193355).
            const notes = [
              ...page.takeNotes(),
              ...(el.covered ? [`note: [${params.ref}] was covered by "${el.covered}" — a person's click would have landed on that.`] : []),
            ]

            return {
              title: `${params.action} [${params.ref}] ${el.name.slice(0, 40)}`,
              output: [changed, ...notes].join("\n"),
              metadata: { ref: params.ref, url: after.value.url, changed: !changed.startsWith("nothing changed") },
            }
          }

          // screenshot → a Genesis artifact, so it lands in the pane the user is watching (ADR-04).
          const shot = yield* attempt(() => page.screenshot())
          if (!shot.ok) return yield* Effect.fail(new Error(shot.message))
          const png = shot.value
          // The pane answers with JPEG, Chrome with PNG: read the bytes, not an assumption.
          const mime = png[0] === 0xff && png[1] === 0xd8 ? "image/jpeg" : "image/png"
          const dataUri = `data:${mime};base64,${Buffer.from(png).toString("base64")}`
          // The pane is already on the person's screen: the agent looks, nothing is saved, and the
          // side panel stays on the Browser (an artifact would switch it to Genesis).
          if (target === "panel") {
            return {
              title: `Looked at ${page.currentUrl ?? "the page"}`,
              output: "Here is the Browser pane as the person sees it (attached).",
              attachments: [{ type: "file" as const, mime, url: dataUri, filename: "browser.jpg" }],
              metadata: { bytes: png.length, url: page.currentUrl ?? undefined },
            }
          }
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
            output: `Here is the page as the person sees it (attached). Also saved to the Artifacts pane as ${meta.id} (revision ${meta.revision}).`,
            // The agent SEES it: a map, a chart, a canvas has no text to read.
            attachments: [{ type: "file" as const, mime, url: dataUri, filename: "screenshot" }],
            metadata: { artifact: meta.id, bytes: png.length, url: page.currentUrl ?? undefined },
          }
        }).pipe(
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              const tabsLine = pane?.tabs && pane.tabs.length > 1 ? `\n\n${renderTabs(pane.tabs)}` : ""
              if (!used) return tabsLine ? { ...result, output: result.output + tabsLine } : result
              const now = yield* attempt(() => used!.page.where())
              if (!now.ok || !now.value.url) return result
              const moved = !!used.startUrl && now.value.url !== used.startUrl
              const where = `\n\npage: ${now.value.url}${now.value.title ? ` ("${now.value.title.slice(0, 80)}")` : ""}${moved ? ` · the address changed (was ${used.startUrl})` : ""}`
              return {
                ...result,
                output: result.output + where + tabsLine,
                metadata: { ...result.metadata, url: now.value.url, ...(moved ? { navigated: true } : {}) },
              }
            }),
          ),
          // One line per call in engine.log, so a slow or silent Browser leaves a trace (2026-11-11:
          // a 45 s stall on Vonlane left none). No page text, no typed text: action, target, timing.
          Effect.tap(() =>
            Effect.logInfo("browser", { action: params.action, target: params.target ?? "default", ok: true, ref: params.ref, tab: params.tab }),
          ),
          Effect.tapError((e) =>
            Effect.logWarning("browser", {
              action: params.action,
              target: params.target ?? "default",
              ok: false,
              error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
            }),
          ),
          Effect.withLogSpan("browser"),
          Effect.orDie,
        )
      },
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
