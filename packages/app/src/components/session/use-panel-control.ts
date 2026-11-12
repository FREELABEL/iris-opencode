import { createEffect, onCleanup, untrack } from "solid-js"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { focusArtifact, irisOpenArtifact, irisOpenCard, irisOpenDataset, irisPanelView, requestIrisNav } from "./iris-nav"
import { nativeBrowserEnabled } from "./native-browser-model"
import {
  browserGrants,
  confirmAct,
  hostOf,
  noteActivity,
  noteAsked,
  browserMode,
  recentlyDeclined,
  originOf,
  pageRefusal,
  takenOverSites,
  clearHumanCheck,
} from "./browser-grants"
import { HUMAN_CHECK_WAIT, humanCheckShowing } from "./human-check"
import type { NativeBrowser } from "@/context/platform"
import { deliverReport } from "./panel-report"
import { IRIS_PANEL_CATALOG, useIrisActiveSurface } from "./session-iris-tab"
import { navigateWeb, WEB_TAB, webUrl } from "./web-nav"

/**
 * THE AGENT'S SIDE PANEL, DESKTOP HALF (#190093). The engine half is src/iris/panel.ts.
 *
 * Two jobs, both in the page rather than the panel — the panel unmounts when it closes, and a
 * closed panel is exactly the one an agent most needs to open:
 *
 * 1. APPLY `iris.panel.command` events addressed to this session, by the same steps the chat
 *    cards take (genesis-artifact-card.tsx, web-link-intercept.ts). There is no second way to
 *    open a product; an agent and a click land on the same screen.
 *
 * 2. REPORT what the panel shows (POST /iris/panel/state) — on every change, debounced, and once
 *    after each command with `ack` set, so the agent learns where the panel ENDED UP. The ack
 *    waits until the panel shows what was asked, or says what it shows instead.
 */
export const PANEL_COMMAND_EVENT = "iris.panel.command"

type Command =
  | { action: "open" }
  | { action: "close" }
  | { action: "show"; surface: string; sub?: string; bloq?: number }
  | { action: "artifact"; id: string }
  | { action: "tab"; tab: string }
  | { action: "browse"; url: string }
  | { action: "card"; bloq: number; item: number; list?: number }
  | { action: "dataset"; bloq: number; schema: string }
  | { action: "report" }
  | PageCommand

/** The Browser pane's page (#193145): run a browser-tool script there, or open an address. */
type PageCommand =
  | {
      action: "page"
      op: "eval"
      script: string
      mode: "read" | "act"
      /** Set on an irreversible click (#193186): its label. The person allows it once, or not. */
      confirm?: string
      /** What the strip says the agent is doing ("clicking 'Search'"). */
      doing?: string
    }
  | { action: "page"; op: "open"; url: string }
  | { action: "page"; op: "screenshot" }

/** How long a command may take to show up before the ack says it did not. Under the engine's 6 s: the IRIS tab mounts lazily, measured 1.6 s after a reopen. */
const SETTLE_MS = 5000
/** How long the panel must hold the asked-for state before it counts. */
const STABLE_MS = 300
const REAPPLY_GAP_MS = 250
const MAX_REAPPLY = 6

/** Commands already applied, by id — one application per command, however many pages listen. */
const handled = new Set<string>()
/**
 * The answer sent for each handled command (#191506). The engine re-sends a command it has not
 * heard back about; a re-send of one already answered gets that answer again rather than being
 * applied twice — the first answer may be the thing that was lost.
 */
const answered = new Map<string, { error?: string; result?: string }>()
const REPORT_DEBOUNCE_MS = 250

/**
 * Labels to ids ("Genesis" → pages, "Schemas" → schemas), case-insensitively, from the catalog
 * the switcher draws. The engine does this too once it has a report — but a command can arrive
 * before the first report does (a cold start), and "Atlas › Schemas" must still mean Schemas.
 */
export function resolveShow(cmd: { surface: string; sub?: string }): { surface: string; sub?: string } {
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const s = IRIS_PANEL_CATALOG.find((x) => eq(x.id, cmd.surface) || eq(x.label, cmd.surface))
  if (!s) return cmd
  const sub = cmd.sub ? (s.subs.find((v) => eq(v.id, cmd.sub!) || eq(v.label, cmd.sub!))?.id ?? cmd.sub) : undefined
  return { surface: s.id, sub }
}

export function usePanelControl(input: { open: () => boolean }) {
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const layout = useLayout()
  const { params, tabs, view } = useSessionLayout()
  const irisActiveSurface = useIrisActiveSurface()

  const snapshot = () => {
    const v = irisPanelView()
    return {
      session: params.id,
      open: input.open(),
      tab: tabs().active() ?? undefined,
      tabs: tabs().all(),
      surface: irisActiveSurface(),
      sub: v.sub,
      bloq: v.bloq,
      artifact: irisOpenArtifact(),
      url: webUrl() ?? undefined,
      card: irisOpenCard(),
      dataset: irisOpenDataset(),
      // The Browser pane can take the agent's page commands (#193145): the engine's browser tool
      // defaults to it instead of a hidden Chrome when this is true.
      browser: !!platform.nativeBrowser && nativeBrowserEnabled(globalThis.localStorage, true),
    }
  }

  // Confirmed delivery, retried, the second try by the engine's other loopback name — see panel-report.ts.
  const post = (body: Record<string, unknown>) => {
    if (!body.session) return
    if (typeof body.ack === "string") {
      answered.set(body.ack, { error: body.error as string | undefined, result: body.result as string | undefined })
    }
    if (answered.size > 500) answered.delete(answered.keys().next().value!)
    void deliverReport(platform.fetch ?? globalThis.fetch, serverSDK().url, { ...body, catalog: IRIS_PANEL_CATALOG })
  }

  // 2. Report on change.
  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const s = snapshot()
    clearTimeout(timer)
    timer = setTimeout(() => post(s), REPORT_DEBOUNCE_MS)
  })
  onCleanup(() => clearTimeout(timer))

  // 1. Apply.
  // Open only when absent: open() re-orders the strip, and a re-ordered strip is a rebuilt Kobalte
  // collection — which falls back to its first tab and reports it (see settle). Selecting alone
  // changes nothing but the selection.
  const selectTab = (tab: string) => {
    if (!untrack(() => tabs().all()).includes(tab)) void tabs().open(tab)
    tabs().setActive(tab)
  }
  /**
   * OPEN FIRST, SELECT AFTER MOUNT. The panel unmounts when closed; opening it and selecting a
   * tab in the same tick lets the remounting tab strip report its stale first selection as a
   * choice and overwrite ours — measured: close from Files & changes, then show Integrations,
   * landed on Files & changes. So when the panel was closed, the tab is chosen two frames later.
   */
  const showTab = (tab: string) => {
    const wasOpen = untrack(input.open)
    view().reviewPanel.open("other")
    if (layout.fileTree.opened() && layout.fileTree.tab() !== "all") layout.fileTree.setTab("all")
    selectTab(tab)
    if (!wasOpen) requestAnimationFrame(() => requestAnimationFrame(() => selectTab(tab)))
  }

  const apply = (cmd: Command) => {
    switch (cmd.action) {
      case "open":
        view().reviewPanel.open("other")
        return
      case "close":
        view().reviewPanel.close()
        return
      case "show":
        // The request FIRST: opening the tab is what mounts the component that reads it.
        requestIrisNav({ surface: cmd.surface, sub: cmd.sub, bloqId: cmd.bloq, session: params.id })
        showTab("iris")
        return
      case "artifact":
        requestIrisNav({ surface: "pages", sub: "artifacts", artifactId: cmd.id, session: params.id })
        focusArtifact(cmd.id)
        showTab("iris")
        return
      case "tab":
        showTab(cmd.tab)
        return
      case "browse":
        navigateWeb(cmd.url)
        if (platform.nativeBrowser && nativeBrowserEnabled(globalThis.localStorage, true)) {
          requestIrisNav({ surface: "browser", session: params.id })
          showTab("iris")
          return
        }
        showTab(WEB_TAB)
        return
      case "card":
        // The board, then the card — the same request a notification about a card makes (#189799).
        requestIrisNav({ surface: "atlas", sub: "lists", bloqId: cmd.bloq, itemId: cmd.item, session: params.id })
        showTab("iris")
        return
      case "dataset":
        // The board, the Schemas view, then the dataset on its Records tab — its rows, not its fields.
        requestIrisNav({ surface: "atlas", sub: "schemas", bloqId: cmd.bloq, schema: cmd.schema, session: params.id })
        showTab("iris")
        return
      case "report":
        return
    }
  }

  /** Why the panel is not (yet) where the command asked, or undefined when it is. */
  const mismatch = (cmd: Command): string | undefined => {
    const s = untrack(snapshot)
    switch (cmd.action) {
      case "open":
        return s.open ? undefined : "the panel did not open (the window may be too narrow for it)"
      case "close":
        return s.open ? "the panel is still open" : undefined
      case "show":
        if (!s.open) return "the panel did not open (the window may be too narrow for it)"
        if (s.tab !== "iris") return `the panel is on ${s.tab}, not the IRIS products`
        if (s.surface !== cmd.surface) return `the panel shows ${s.surface}, not ${cmd.surface}`
        if (cmd.sub && s.sub !== cmd.sub) return `${s.surface} shows ${s.sub ?? "its default view"}, not ${cmd.sub}`
        if (cmd.bloq && s.bloq?.id !== cmd.bloq) return `the board is #${s.bloq?.id ?? "?"}, not #${cmd.bloq}`
        return undefined
      case "artifact":
        if (s.tab !== "iris" || s.surface !== "pages") return "Genesis › Artifacts did not open"
        return s.artifact === cmd.id ? undefined : `artifact ${cmd.id} is not in this session's list`
      case "tab":
        return s.tab === cmd.tab ? undefined : `the panel is on ${s.tab}, not ${cmd.tab}`
      case "browse":
        return s.tab === WEB_TAB || (s.tab === "iris" && s.surface === "browser") ? undefined : "the Browser tab did not open"
      case "card":
        if (!s.open) return "the panel did not open (the window may be too narrow for it)"
        if (s.tab !== "iris" || s.surface !== "atlas") return "Atlas did not open"
        if (s.bloq?.id !== cmd.bloq) return `the board is #${s.bloq?.id ?? "?"}, not #${cmd.bloq}`
        return s.card?.id === cmd.item ? undefined : `card ${cmd.item} did not open on board #${cmd.bloq}`
      case "dataset":
        if (!s.open) return "the panel did not open (the window may be too narrow for it)"
        if (s.tab !== "iris" || s.surface !== "atlas" || s.sub !== "schemas") return "Atlas › Schemas did not open"
        if (s.bloq?.id !== cmd.bloq) return `the board is #${s.bloq?.id ?? "?"}, not #${cmd.bloq}`
        return s.dataset?.slug === cmd.schema
          ? undefined
          : `dataset ${cmd.schema} is not open — it may not be on board #${cmd.bloq}'s first page of schemas`
      case "report":
        return undefined
    }
  }

  /**
   * Ack only once the panel has STAYED where it was asked for STABLE_MS — a first glance can be
   * undone a frame later. Until it has matched ONCE, apply again (spaced, bounded): a freshly
   * mounted IRIS tab takes over a second to read the request, and the strip can bounce while it
   * rebuilds (see session-side-panel's looksLikeFallback).
   *
   * NEVER AGAINST THE USER. Once the panel has matched, nothing is re-applied — a later difference
   * is the person clicking, and the ack simply reports where they went. A new command cancels a
   * settle still running. The first version re-applied on any mismatch for five seconds and put
   * the panel back each time the user clicked a tab.
   */
  let cancelSettle: (() => void) | undefined
  onCleanup(() => cancelSettle?.())
  const settle = (cmd: Command, ack: string) => {
    cancelSettle?.()
    let cancelled = false
    cancelSettle = () => (cancelled = true)
    const started = Date.now()
    let applied = 0
    let lastApply = started
    let matchedOnce = false
    let okSince: number | undefined
    const tick = () => {
      if (cancelled) return
      const now = Date.now()
      const why = mismatch(cmd)
      if (!why) {
        matchedOnce = true
        okSince ??= now
      } else okSince = undefined
      const settled = okSince !== undefined && now - okSince >= STABLE_MS
      // Matched, then moved: the user took over. Report where they are; do not chase it.
      if (settled || (matchedOnce && why) || now - started > SETTLE_MS) {
        cancelSettle = undefined
        post({ ...untrack(snapshot), ack, error: matchedOnce && why ? undefined : why })
        return
      }
      if (!matchedOnce && untrack(input.open) && applied < MAX_REAPPLY && now - lastApply >= REAPPLY_GAP_MS) {
        applied++
        lastApply = now
        apply(cmd)
      }
      setTimeout(tick, 50)
    }
    // Two frames: let the tab mount and the nav request be consumed before the first look.
    requestAnimationFrame(() => requestAnimationFrame(tick))
  }

  /**
   * A page command (#193145). THE GRANT IS CHECKED HERE, on the person's side: the engine asks,
   * this decides. `open` navigates the pane like a chat link (no grant: the person sees it
   * happen, and reading the new page needs that site's grant); `eval` needs the site granted and
   * `read` mode.
   */
  const runPage = async (cmd: PageCommand, ack: string) => {
    const reply = (r: { result?: string; error?: string }) => post({ ...untrack(snapshot), ack, ...r })
    // This chat's own page: an agent in one chat never reads or drives another chat's.
    const nb = params.id ? platform.nativeBrowser?.(params.id) : undefined
    if (!nb || !nativeBrowserEnabled(globalThis.localStorage, true)) {
      return reply({ error: "this IRIS has no Browser pane (it is desktop only, or turned off with iris.browser.native=0)" })
    }
    try {
      if (cmd.op === "open") {
        const before = (await nb.state())?.url
        navigateWeb(cmd.url)
        requestIrisNav({ surface: "browser", session: params.id })
        showTab("iris")
        const landed = await waitForPage(nb, cmd.url, before)
        // Landed on a "prove you're human" page: ask the person now; the agent's next look waits.
        const o = originOf(landed.url)
        if (o && (await humanCheckShowing((x) => nb.eval(x)))) noteAsked(o, "check")
        return reply({ result: JSON.stringify({ ok: true, value: landed }) })
      }
      const s = await nb.state()
      const origin = originOf(s?.url)
      // A "prove you're human" page is for the PERSON (human-check.ts): never read or click it.
      // The agent waits on this answer the way it waits for Allow.
      if (await humanCheckShowing((x) => nb.eval(x))) {
        if (recentlyDeclined(origin)) {
          return reply({ error: `the person chose not to finish ${hostOf(origin)}'s human check. Don't try again unless they ask` })
        }
        if (origin) noteAsked(origin, "check")
        return reply({ error: HUMAN_CHECK_WAIT })
      }
      clearHumanCheck(origin)
      if (cmd.op === "screenshot") {
        // Looking is reading: the same per-site Allow (or Always allow).
        const no = pageRefusal({ mode: "read", url: s?.url, grants: browserGrants(), takenOver: takenOverSites(), always: browserMode() === "always" })
        if (no && recentlyDeclined(origin)) return reply({ error: `the person chose Not now for ${hostOf(origin)}. Don't try again unless they ask` })
        if (no) {
          if (origin && !takenOverSites().includes(origin)) noteAsked(origin, "read")
          return reply({ error: no })
        }
        if (!nb.screenshot) return reply({ error: "this IRIS can't take pictures of the Browser yet: use read or find" })
        noteActivity(origin!, "looking at the page", "read")
        return reply({ result: JSON.stringify({ ok: true, value: await nb.screenshot() }) })
      }
      const why = pageRefusal({ mode: cmd.mode, url: s?.url, grants: browserGrants(), takenOver: takenOverSites(), always: browserMode() === "always" })
      if (why && recentlyDeclined(origin)) {
        return reply({ error: `the person chose Not now for ${hostOf(origin)}. Don't try again unless they ask` })
      }
      if (why) {
        // Offer the missing permission right there in the strip (never while the person has the wheel).
        if (origin && !takenOverSites().includes(origin)) noteAsked(origin, cmd.mode)
        return reply({ error: why })
      }
      if (cmd.mode === "act" && cmd.confirm) {
        noteActivity(origin!, `waiting for you to allow "${cmd.confirm}"`, "act")
        const ok = await confirmAct(origin!, cmd.confirm)
        if (!ok) {
          return reply({ error: `the person did not allow clicking "${cmd.confirm}" on ${hostOf(origin)}. Do not try it again unless they ask` })
        }
        // They may have taken over or stopped while the prompt was up.
        const again = pageRefusal({ mode: "act", url: (await nb.state())?.url, grants: browserGrants(), takenOver: takenOverSites(), always: browserMode() === "always" })
        if (again) return reply({ error: again })
      }
      noteActivity(origin!, cmd.doing ?? (cmd.mode === "act" ? "working" : "reading"), cmd.mode)
      reply({ result: await nb.eval(cmd.script) })
    } catch (err) {
      reply({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  const stop = serverSDK().event.listen((e: any) => {
    const event = e?.details
    if (event?.type !== PANEL_COMMAND_EVENT) return
    const props = event.properties as { id?: string; session?: string; command?: Command } | undefined
    if (!props?.id || !props.command || !params.id || props.session !== params.id) return
    if (handled.has(props.id)) {
      // A re-send: answer again if we already did; a settle still running will answer itself.
      const prior = answered.get(props.id)
      if (prior) post({ ...untrack(snapshot), ack: props.id, error: prior.error, result: prior.result })
      return
    }
    handled.add(props.id)
    if (handled.size > 500) handled.delete(handled.values().next().value!)
    const command: Command =
      props.command.action === "show" ? { ...props.command, ...resolveShow(props.command) } : props.command
    // The Browser pane's page answers with a value, not a panel state to settle on.
    if (command.action === "page") {
      void runPage(command, props.id)
      return
    }
    // A live read changes nothing, so there is nothing to wait for.
    if (command.action === "report") {
      post({ ...untrack(snapshot), ack: props.id })
      return
    }
    try {
      apply(command)
    } catch (err) {
      post({
        ...untrack(snapshot),
        ack: props.id,
        error: `could not apply: ${err instanceof Error ? err.message : String(err)}`,
      })
      return
    }
    settle(command, props.id)
  })
  onCleanup(stop)
}

/**
 * Wait until the pane shows the asked-for site and has settled (#193145). A redirect is fine
 * (youtube.com → www.youtube.com, x.com → x.com/home): matched by host without "www.". 20 s.
 */
export function sameSite(a: string | undefined, b: string | undefined): boolean {
  const host = (u?: string) => {
    try {
      return new URL(u ?? "").hostname.replace(/^www\./, "")
    } catch {
      return ""
    }
  }
  return !!host(a) && host(a) === host(b)
}

async function waitForPage(nb: NativeBrowser, url: string, before: string | undefined) {
  const started = Date.now()
  const stillOn = (u?: string) => (u && u !== "about:blank" ? ` The pane still shows ${u}.` : "")
  while (Date.now() - started < 20_000) {
    await new Promise((r) => setTimeout(r, 300))
    const s = await nb.state().catch(() => null)
    if (s && sameSite(s.url, url) && (s.url !== before || Date.now() - started > 1500)) {
      // The address changes before the page has painted: give it a moment, then read the title.
      await new Promise((r) => setTimeout(r, 800))
      const now = (await nb.state().catch(() => null)) ?? s
      // A page that fails to load puts the pane back on the page it was on: never report THAT
      // page as where we landed (Vonlane, 2026-11-11: www.vonlane.com "opened" Google Maps).
      if (!sameSite(now.url, url)) {
        throw new Error(`${url} didn't load (the site didn't answer or refused).${stillOn(now.url)} Try the address without www, or the site's main page.`)
      }
      return { url: now.url, title: now.title ?? "" }
    }
    // Gave up loading and went back: say so now, not after 20 s.
    if (s && !s.loading && s.url === before && Date.now() - started > 6_000) {
      throw new Error(`${url} didn't load (the site didn't answer or refused).${stillOn(s.url)} Try the address without www, or the site's main page.`)
    }
  }
  const last = await nb.state().catch(() => null)
  throw new Error(`${url} didn't load within 20 s.${stillOn(last?.url)}`)
}
