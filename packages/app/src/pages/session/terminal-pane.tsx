import { For, Show, createEffect, createMemo, on, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { createStore } from "solid-js/store"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Terminal } from "@/components/terminal"
import { useLanguage } from "@/context/language"
import { useTerminal } from "@/context/terminal"
import { terminalTabLabel } from "@/pages/session/terminal-label"
import { focusTerminalById } from "@/pages/session/helpers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { useIrisPanelScope } from "@/context/iris-panel-scope"
import { useRequestIrisSurface } from "@/components/session/session-iris-tab"
import { MAX_SPLIT, leaveSplit, shownTerminals, splitWith } from "@/pages/session/terminal-split"

/**
 * The tab each side panel showed before Terminal, so moving the terminals under the chat can hand
 * the panel back to it — not leave half the column saying where the terminals went. Keyed by the
 * column's panel scope (split view has one per column).
 */
const before = new WeakMap<object, string>()
export function rememberPanelSurface(scope: object, surface: string) {
  if (surface !== "terminal") before.set(scope, surface)
}

/**
 * THE SIDE PANEL'S TERMINAL TAB (#193785).
 *
 * Not a second terminal. These are the same terminals as the dock under the chat — the workspace's
 * PTYs from `useTerminal()` — drawn in the side panel instead. A terminal is on screen in ONE place:
 * two xterm views on one PTY both resize it and both save its scrollback on the way out, and the
 * last one to close wins. So:
 *
 * - opening this tab moves the terminals here (the dock under the chat closes);
 * - "Move to the bottom" opens the dock, and this tab says where they went, with a way back;
 * - the dock opening by itself (its keybind, the header button) does the same.
 *
 * Full screen draws the same tab over the whole window (a portal, so no panel ancestor clips it);
 * Split puts terminals side by side (terminal-split.ts). Esc is NOT the way out of full screen: a
 * shell owns Esc (vim, less, fzf), so the button is.
 */

// The split group per project folder, so it survives switching panel tabs (the pane remounts).
const groups = new Map<string, string[]>()
export function SessionTerminalPane() {
  const terminal = useTerminal()
  const language = useLanguage()
  const { view, workspaceKey } = useSessionLayout()
  const docked = () => view().terminal.opened()
  const panelScope = useIrisPanelScope()
  const requestSurface = useRequestIrisSurface()
  const t = language.t as (key: string, vars?: Record<string, string | number | boolean>) => string
  const [store, setStore] = createStore({
    autoCreated: false,
    recovered: {} as Record<string, boolean>,
    full: false,
    group: groups.get(workspaceKey()) ?? ([] as string[]),
    // What was on screen when Split was pressed; the next terminal to appear joins it.
    splitting: undefined as string[] | undefined,
  })
  const ids = createMemo(() => terminal.all().map((pty) => pty.id))
  const shown = createMemo(() => shownTerminals(store.group, ids(), terminal.active()))
  const setGroup = (group: string[]) => {
    setStore("group", group)
    groups.set(workspaceKey(), group)
  }
  const moveToDock = () => {
    setStore("full", false)
    view().terminal.open()
    requestSurface(before.get(panelScope) ?? "atlas")
  }
  const split = () => {
    if (shown().length >= MAX_SPLIT) return
    setStore("splitting", shown())
    terminal.new({ focus: true })
  }

  onMount(() => {
    if (docked()) view().terminal.close()
  })
  onCleanup(() => terminal.cancelFocus())

  // An empty tab is a shell waiting to start, not a page to read: start one, once.
  createEffect(() => {
    if (docked() || !terminal.ready() || terminal.all().length !== 0 || store.autoCreated) return
    setStore("autoCreated", true)
    terminal.new({ focus: true })
  })

  // The terminal Split asked for has arrived (it becomes active when created): put it beside.
  createEffect(
    on(ids, (now, was) => {
      const pending = store.splitting
      if (!pending || !was) return
      const added = now.find((id) => !was.includes(id))
      if (!added) return
      setStore("splitting", undefined)
      setGroup(splitWith(pending, added))
    }),
  )

  createEffect(
    on(
      () => [docked(), terminal.active(), terminal.focusRequested(terminal.active())] as const,
      ([dock, id, requested]) => {
        if (dock || !id || !requested) return
        requestAnimationFrame(() => focusTerminalById(id))
      },
    ),
  )

  const label = (pty: { title?: string; titleNumber?: number }) => {
    language.locale()
    return terminalTabLabel({ title: pty.title, titleNumber: pty.titleNumber, t })
  }
  const key = (pty: { id: string; title: string; titleNumber: number }) => String(pty.titleNumber || pty.title || pty.id)
  const showHere = () => {
    view().terminal.close()
    const id = terminal.active()
    if (id) terminal.requestFocus(id)
  }
  const pick = (id: string) => {
    if (terminal.active() !== id) terminal.open(id)
    terminal.requestFocus(id)
  }

  const cell = (id: string) => {
    const ops = terminal.bind()
    return (
      <Show when={terminal.all().find((pty) => pty.id === id)}>
        {(pty) => (
          <div
            class="iris-terminal__cell"
            classList={{ "iris-terminal__cell--active": shown().length > 1 && terminal.active() === id }}
            onPointerDown={() => terminal.active() !== id && terminal.open(id)}
          >
            <Show when={shown().length > 1}>
              <div class="iris-terminal__cellbar">
                <span class="iris-terminal__celltitle">{label(pty())}</span>
                <button
                  type="button"
                  class="iris-terminal__btn"
                  title="Take this terminal out of the split"
                  onClick={(e) => {
                    e.stopPropagation()
                    const rest = leaveSplit(store.group, id)
                    setGroup(rest)
                    if (terminal.active() === id && rest[0]) pick(rest[0])
                  }}
                >
                  Unsplit
                </button>
              </div>
            </Show>
            <div id={`terminal-wrapper-${id}`} class="iris-terminal__xterm">
              <Terminal
                pty={pty()}
                autoFocus={terminal.focusRequested(id)}
                onAutoFocus={() => terminal.consumeFocus(id)}
                class="!px-[10px]"
                onConnect={() => {
                  setStore("recovered", key(pty()), false)
                  ops.trim(id)
                }}
                onCleanup={ops.update}
                onConnectError={() => {
                  const k = key(pty())
                  if (store.recovered[k]) return
                  setStore("recovered", k, true)
                  void ops.clone(id)
                }}
              />
            </div>
          </div>
        )}
      </Show>
    )
  }

  const content = () => (
    <>
      <div class="iris-subrow shrink-0">
        <div class="iris-subnav" role="tablist" aria-label="Terminals">
          <For each={terminal.all()}>
            {(pty) => (
              <span class="iris-terminal__tab">
                <button
                  type="button"
                  role="tab"
                  aria-selected={terminal.active() === pty.id}
                  class="iris-subnav__item"
                  classList={{
                    "iris-subnav__item--active": terminal.active() === pty.id,
                    "iris-terminal__tab--shown": terminal.active() !== pty.id && shown().includes(pty.id),
                  }}
                  onClick={() => pick(pty.id)}
                >
                  {label(pty)}
                </button>
                <button
                  type="button"
                  class="iris-terminal__close"
                  aria-label={`Close ${label(pty)}`}
                  title={`Close ${label(pty)}`}
                  onClick={() => {
                    setGroup(leaveSplit(store.group, pty.id))
                    void terminal.close(pty.id)
                  }}
                >
                  ×
                </button>
              </span>
            )}
          </For>
        </div>
        <IconButton
          icon="plus-small"
          variant="ghost"
          onClick={() => terminal.new({ focus: true })}
          aria-label={language.t("command.terminal.new")}
          title={language.t("command.terminal.new")}
        />
        <button
          type="button"
          class="iris-terminal__btn"
          disabled={shown().length === 0 || shown().length >= MAX_SPLIT}
          onClick={split}
          title={shown().length >= MAX_SPLIT ? `Up to ${MAX_SPLIT} side by side` : "Open another terminal beside this one"}
        >
          Split
        </button>
        <IconButton
          icon={store.full ? "collapse" : "expand"}
          variant="ghost"
          onClick={() => setStore("full", !store.full)}
          aria-label={store.full ? "Back to the side panel" : "Full screen"}
          title={store.full ? "Back to the side panel" : "Full screen"}
        />
        <IconButton
          icon="layout-bottom"
          variant="ghost"
          onClick={moveToDock}
          aria-label="Move to the bottom"
          title="Move to the bottom"
        />
      </div>
      <div class="iris-terminal__body">
        <Show when={terminal.ready()} fallback={<div class="iris-empty">{language.t("terminal.loading")}</div>}>
          <Show
            when={shown().length > 0}
            fallback={
              <div class="iris-empty iris-terminal__away">
                <div>No terminal is open.</div>
                <button type="button" class="iris-terminal__link" onClick={() => terminal.new({ focus: true })}>
                  Open a terminal
                </button>
              </div>
            }
          >
            <div class="iris-terminal__cells">
              <For each={shown()}>{(id) => cell(id)}</For>
            </div>
          </Show>
        </Show>
      </div>
    </>
  )

  return (
    <div class="iris-terminal" data-component="iris-terminal-pane">
      <Show
        when={!docked()}
        fallback={
          <div class="iris-empty iris-terminal__away">
            <div>Your terminals are open at the bottom.</div>
            <button type="button" class="iris-terminal__link" onClick={showHere}>
              Show them here
            </button>
          </div>
        }
      >
        <Show
          when={store.full}
          fallback={content()}
        >
          <div class="iris-empty iris-terminal__away">
            <div>Your terminals are full screen.</div>
            <button type="button" class="iris-terminal__link" onClick={() => setStore("full", false)}>
              Back to the side panel
            </button>
          </div>
          <Portal>
            <div
              class="iris-terminal iris-terminal--full"
              data-component="iris-terminal-full"
              role="dialog"
              aria-label="Terminal"
              // Below the window's title bar, so the traffic lights, tabs and drag area stay usable.
              style={{ top: `${document.querySelector("header")?.getBoundingClientRect().bottom ?? 0}px` }}
            >
              {content()}
            </div>
          </Portal>
        </Show>
      </Show>
    </div>
  )
}
