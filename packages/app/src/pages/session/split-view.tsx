import { base64Encode } from "@opencode-ai/core/util/encode"
import { useNavigate, useParams } from "@solidjs/router"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { batch, createEffect, createMemo, createSignal, For, on, Show, Suspense, untrack, type Component, type ParentProps } from "solid-js"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { SessionPaneProvider, type SessionPane } from "@/context/session-pane"
import { SplitActionsProvider } from "@/context/split-actions"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useSplit } from "@/context/split"
import { useTabs } from "@/context/tabs"
import { requireServerKey, sessionHref } from "@/utils/session-route"
import { showToast } from "@/utils/toast"
import { closeColumn, maxColumns, open, paneKey, PANE_GAP, PANE_MAX, prune, reconcile, samePane, visible, type PaneRef } from "./split-model"

type ServerRoute = Component<ParentProps<{ serverKey?: () => string }>>

const fromKey = (key: string): PaneRef => {
  const at = key.indexOf("\n")
  return { server: key.slice(0, at), sessionId: key.slice(at + 1) }
}

/**
 * TWO OR THREE SESSIONS SIDE BY SIDE (#191484). The route names the focused column; the split
 * (context/split.tsx) names the rest. With fewer than two columns on screen this renders exactly
 * what the route rendered before — no pane, no extra chrome.
 *
 * Columns are keyed by session, so moving focus (which changes the route) never remounts one.
 * Columns on the route's server share its sync and event stream; only a column on another
 * server mounts its own.
 */
export function SessionSplitRoute(props: { server: ServerRoute; content: Component }) {
  const params = useParams<{ serverKey: string; id: string }>()
  const split = useSplit()
  const tabs = useTabs()
  const command = useCommand()
  const language = useLanguage()
  const navigate = useNavigate()
  const route = createMemo((): PaneRef => ({ server: requireServerKey(params.serverKey), sessionId: params.id }), undefined, {
    equals: samePane,
  })

  const [width, setWidth] = createSignal<number>()
  let row: HTMLDivElement | undefined
  createResizeObserver(
    () => row,
    // A hidden row measures 0 (the route's Suspense hides it while a column loads). Taken
    // literally, 0 fits one column: the split fell back to one, that page's loading kept the
    // row hidden, and the window stayed on one column. Only a real width changes the layout.
    ({ width }) => {
      if (width > 0) setWidth(width)
    },
  )

  // A tab picked from the strip while in a split lands in the column you were last in. Also runs
  // when the stored split arrives: on a reload or deep link the route is known first, and a check
  // that ran only on route changes left the split stuck off screen.
  createEffect(
    on([route, split.ready] as const, ([r, ready]) => {
      if (!ready) return
      const panes = untrack(split.panes)
      const next = reconcile(panes, r, untrack(split.last))
      if (next !== panes) split.set(next)
      const at = next.findIndex((p) => samePane(p, r))
      if (at >= 0) split.setLast(at)
    }),
  )

  // Where focus is going. A navigation is a router transition: the URL moves at once, but the
  // route's params only when the transition commits. Layout reads this, not the route — reading
  // the route, a close showed the split without the (lagging) route in it, fell back to one
  // column, mounted a fresh session page that suspended, which held the transition open, which
  // kept the route stale: the window stuck on one column for good. Actions read it too.
  const [moving, setMoving] = createSignal<PaneRef>()
  // Cleared by any route change, so a navigation that lands elsewhere cannot leave it stale.
  createEffect(on(route, () => setMoving(undefined), { defer: true }))
  const focused = createMemo(() => moving() ?? route(), undefined, { equals: samePane })

  // A column outlives nothing: close a session's tab (or the session is deleted and its tab
  // closed) and its column goes too. The route's own session is exempt — it becomes a tab a
  // moment after the route moves to it.
  createEffect(() => {
    if (!tabs.ready() || !split.ready()) return
    const open = new Set(tabs.store.flatMap((t) => (t.type === "session" ? [paneKey({ server: t.server, sessionId: t.sessionId })] : [])))
    const panes = split.panes()
    // Spare where focus is going, not only the route: a new chat's tab is added in a transition,
    // so for a moment its column has no tab yet — pruned on the route alone, it vanished.
    const kept = prune(panes, untrack(focused), open)
    if (kept !== panes) split.set(kept)
  })

  // What is drawn: the stored split with the focused session already placed. Derived, not written
  // by an effect first — an effect runs after the render, so for one render after a tab click the
  // focused session was missing, the view fell back to one column, and that mount stuck the
  // window blank. The effect above only saves this so it survives a restart.
  const drawn = createMemo(() => (split.ready() ? reconcile(split.panes(), focused(), split.last()) : split.panes()))
  const shown = createMemo(() => visible(drawn(), focused(), maxColumns(width())))
  const keys = createMemo(() => shown().map(paneKey))
  const multi = createMemo(() => keys().length >= 2 && keys().includes(paneKey(focused())))
  const focusPane = (p: PaneRef) => {
    setMoving(p)
    navigate(sessionHref(p.server as never, p.sessionId))
  }
  // One update: written one after the other, the split briefly held [Y, Z] while focus was still
  // the closed X — "not in the split" — so the view swapped to one column, began mounting a
  // session page, swapped straight back, and the half-mounted page left the route's Suspense
  // waiting on a load nobody would finish: a blank window.
  const closePane = (p: PaneRef) => {
    const next = closeColumn(drawn(), p, focused())
    batch(() => {
      split.set(next.panes)
      if (next.focus) setMoving(next.focus)
    })
    if (next.focus) navigate(sessionHref(next.focus.server as never, next.focus.sessionId))
  }

  // A new chat for the column, when no other tab is waiting: splitting is never a dead end. Set
  // by SplitNewSession, which lives under the server providers this component sits above.
  let createSession: ((besideSessionID: string) => Promise<string | undefined>) | undefined
  const columnsFree = () => drawn().length < Math.min(PANE_MAX, maxColumns(width()))
  const canSplit = createMemo(() => maxColumns(width()) >= 2 && (drawn().length < 2 || columnsFree()))

  const splitRight = async (fromSessionID?: string) => {
    const onScreen = drawn()
    const current = onScreen.find((p) => p.sessionId === fromSessionID) ?? focused()
    if (maxColumns(width()) < 2) {
      showToast({ title: language.t("split.narrow.title"), description: language.t("split.narrow.description") })
      return
    }
    if (onScreen.length >= 2 && !columnsFree()) {
      showToast({ title: language.t("split.full.title"), description: language.t("split.full.description") })
      return
    }
    const waiting = tabs.store.find(
      (t) =>
        t.type === "session" &&
        !samePane({ server: t.server, sessionId: t.sessionId }, current) &&
        !onScreen.some((p) => samePane(p, { server: t.server, sessionId: t.sessionId })),
    )
    if (waiting && waiting.type === "session") {
      split.set(open(onScreen, current, { server: waiting.server, sessionId: waiting.sessionId }))
      return
    }
    const id = await createSession?.(current.sessionId)
    if (!id) {
      showToast({ title: language.t("split.none.title"), description: language.t("split.none.description") })
      return
    }
    const next = { server: current.server, sessionId: id }
    tabs.addSessionTab({ server: current.server as never, sessionId: id })
    batch(() => {
      split.set(open(drawn(), current, next))
      setMoving(next)
    })
    navigate(sessionHref(next.server as never, next.sessionId))
  }
  const step = (by: number) => {
    const list = shown()
    const at = list.findIndex((p) => samePane(p, focused()))
    const next = list[at + by]
    if (next) focusPane(next)
  }

  command.register("split", () => [
    {
      id: "split.right",
      title: language.t("split.right"),
      category: language.t("command.category.view"),
      keybind: "mod+alt+\\",
      description: language.t("split.right.description"),
      onSelect: () => void splitRight(),
    },
    {
      id: "split.close",
      title: language.t("split.close"),
      category: language.t("command.category.view"),
      keybind: "mod+alt+w",
      disabled: !multi(),
      onSelect: () => closePane(focused()),
    },
    {
      id: "split.focus.left",
      title: language.t("split.focus.left"),
      category: language.t("command.category.view"),
      keybind: "mod+alt+arrowleft",
      disabled: !multi(),
      onSelect: () => step(-1),
    },
    {
      id: "split.focus.right",
      title: language.t("split.focus.right"),
      category: language.t("command.category.view"),
      keybind: "mod+alt+arrowright",
      disabled: !multi(),
      onSelect: () => step(1),
    },
  ])

  const Server = props.server
  const Content = props.content
  return (
    <div ref={row} class="size-full min-h-0 min-w-0 flex">
      {/* Mounted once, outside the split switch: these providers are gated on ready, and a second
          copy mounted when a split starts never came ready — the window went blank. */}
      <Server>
        <SplitNewSession register={(fn) => (createSession = fn)} />
        <SplitActionsProvider actions={{ splitRight: (id) => void splitRight(id), canSplit }}>
        <Show when={multi()} fallback={<Content />}>
          <div class="size-full min-h-0 min-w-0 flex" style={{ gap: `${PANE_GAP}px` }} data-component="session-split">
            <For each={keys()}>
              {(key) => {
                const pane = fromKey(key)
                return (
                  <SplitColumn
                    pane={pane}
                    focused={() => samePane(pane, focused())}
                    focus={() => focusPane(pane)}
                    close={() => closePane(pane)}
                    sameServer={() => pane.server === focused().server}
                    server={Server}
                    content={Content}
                  />
                )
              }}
            </For>
          </div>
        </Show>
        </SplitActionsProvider>
      </Server>
    </div>
  )
}

/** Creates the chat a new column opens on, in the same project as the session it opens beside. */
function SplitNewSession(props: { register: (create: (besideSessionID: string) => Promise<string | undefined>) => void }) {
  const serverSDK = useServerSDK()
  const sync = useServerSync()
  props.register(async (besideSessionID) => {
    const directory = sync().session.lineage.peek(besideSessionID)?.session.directory
    if (!directory) return
    const created = await serverSDK()
      .client.session.create({ directory })
      .catch(() => undefined)
    return created?.data?.id
  })
  return null
}

function SplitColumn(props: {
  pane: PaneRef
  focused: () => boolean
  focus: () => void
  close: () => void
  sameServer: () => boolean
  server: ServerRoute
  content: Component
}) {
  const pane: SessionPane = {
    // The route's form: session code decodes it with requireServerKey, as it does the URL's.
    params: () => ({ serverKey: base64Encode(props.pane.server), id: props.pane.sessionId }),
    focused: props.focused,
    focus: props.focus,
  }
  const Server = props.server
  const Content = props.content
  return (
    <div
      class="relative min-w-0 min-h-0 flex-1 basis-0 flex flex-col rounded-[10px] transition-opacity duration-150"
      classList={{ "opacity-80 hover:opacity-100": !props.focused() }}
      data-component="session-split-column"
      data-focused={props.focused() ? "" : undefined}
      // Focus on click, after the column's own controls have handled it — focusing on pointerdown
      // navigated first, re-rendered the column, and the click landed on a button that was gone
      // (a deleted session's "Close tab" did nothing). Typing into a composer focuses too.
      onClick={() => {
        if (!props.focused()) props.focus()
      }}
      onFocusIn={(e) => {
        const t = e.target as HTMLElement
        if (!props.focused() && (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "INPUT")) props.focus()
      }}
    >
      <SessionPaneProvider pane={pane}>
        {/* Its own boundary: a column still loading must not blank the others (the route's
            Suspense would otherwise hide the whole split). */}
        <Suspense fallback={<div class="flex-1" data-slot="session-split-loading" />}>
        <Show
          when={props.sameServer()}
          fallback={
            <Server serverKey={() => base64Encode(props.pane.server)}>
              <ColumnBar focused={props.focused} close={props.close} />
              <Content />
            </Server>
          }
        >
          <ColumnBar focused={props.focused} close={props.close} />
          <Content />
        </Show>
        </Suspense>
      </SessionPaneProvider>
    </div>
  )
}

/**
 * Which column has focus, and a way out of it. No title: the session's own header sits right
 * below and already says which session this is.
 */
function ColumnBar(props: { focused: () => boolean; close: () => void }) {
  const language = useLanguage()
  return (
    <div class="shrink-0 h-6 pl-3 pr-1 flex items-center gap-2" data-slot="session-split-bar">
      <span
        class="flex-1 h-0.5 rounded-full transition-colors duration-150"
        classList={{
          "bg-[var(--v2-border-border-focus,var(--border-interactive-base))]": props.focused(),
          "bg-transparent": !props.focused(),
        }}
      />
      <IconButtonV2
        type="button"
        variant="ghost-muted"
        size="small"
        icon={<IconV2 name="xmark-small" class="text-v2-icon-icon-muted" />}
        aria-label={language.t("split.close")}
        title={language.t("split.close")}
        onClick={(e: MouseEvent) => {
          // the column's own click would focus the column being closed
          e.stopPropagation()
          props.close()
        }}
      />
    </div>
  )
}
