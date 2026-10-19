import { createEffect, onCleanup, untrack } from "solid-js"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { focusArtifact, irisOpenArtifact, irisPanelView, requestIrisNav } from "./iris-nav"
import { IRIS_PANEL_CATALOG, irisActiveSurface } from "./session-iris-tab"
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

/** How long a command may take to show up before the ack says it did not. Under the engine's 4 s. */
const SETTLE_MS = 3200
/** How long the panel must hold the asked-for state before it counts. */
const STABLE_MS = 300
const REAPPLY_GAP_MS = 250
const MAX_REAPPLY = 6
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
    }
  }

  const post = (body: Record<string, unknown>) => {
    if (!body.session) return
    const base = serverSDK().url.replace(/\/$/, "")
    void (platform.fetch ?? globalThis.fetch)(`${base}/iris/panel/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, catalog: IRIS_PANEL_CATALOG }),
    }).catch(() => {})
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
        requestIrisNav({ surface: cmd.surface, sub: cmd.sub, bloqId: cmd.bloq })
        showTab("iris")
        return
      case "artifact":
        requestIrisNav({ surface: "pages", sub: "artifacts", artifactId: cmd.id })
        focusArtifact(cmd.id)
        showTab("iris")
        return
      case "tab":
        showTab(cmd.tab)
        return
      case "browse":
        navigateWeb(cmd.url)
        showTab(WEB_TAB)
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
        return s.tab === WEB_TAB ? undefined : "the Browser tab did not open"
    }
  }

  /**
   * Ack only once the panel has STAYED where it was asked for STABLE_MS — a first glance can be
   * undone a frame later. While it is wrong, apply again (spaced, bounded). Two measured causes of
   * being undone: the remounting strip (see showTab), and an UNPINNED product — showing it adds its
   * trigger, and while the strip rebuilds, Kobalte falls back to its first tab and reports that as
   * a choice (traced: onSelectionChange → activateTab("review")). A later try finds the trigger.
   */
  const settle = (cmd: Command, ack: string) => {
    const started = Date.now()
    let applied = 0
    let lastApply = started
    let okSince: number | undefined
    const tick = () => {
      const now = Date.now()
      const why = mismatch(cmd)
      if (!why) okSince ??= now
      else okSince = undefined
      if ((okSince !== undefined && now - okSince >= STABLE_MS) || now - started > SETTLE_MS) {
        post({ ...untrack(snapshot), ack, error: why })
        return
      }
      if (why && untrack(input.open) && applied < MAX_REAPPLY && now - lastApply >= REAPPLY_GAP_MS) {
        applied++
        lastApply = now
        apply(cmd)
      }
      setTimeout(tick, 50)
    }
    // Two frames: let the tab mount and the nav request be consumed before the first look.
    requestAnimationFrame(() => requestAnimationFrame(tick))
  }

  const stop = serverSDK().event.listen((e: any) => {
    const event = e?.details
    if (event?.type !== PANEL_COMMAND_EVENT) return
    const props = event.properties as { id?: string; session?: string; command?: Command } | undefined
    if (!props?.id || !props.command || !params.id || props.session !== params.id) return
    const command: Command = props.command.action === "show" ? { ...props.command, ...resolveShow(props.command) } : props.command
    try {
      apply(command)
    } catch (err) {
      post({ ...untrack(snapshot), ack: props.id, error: `could not apply: ${err instanceof Error ? err.message : String(err)}` })
      return
    }
    settle(command, props.id)
  })
  onCleanup(stop)
}
