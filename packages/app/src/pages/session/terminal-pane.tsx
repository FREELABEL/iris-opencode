import { For, Show, createEffect, on, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Terminal } from "@/components/terminal"
import { useLanguage } from "@/context/language"
import { useTerminal } from "@/context/terminal"
import { terminalTabLabel } from "@/pages/session/terminal-label"
import { focusTerminalById } from "@/pages/session/helpers"
import { useSessionLayout } from "@/pages/session/session-layout"

/**
 * THE SIDE PANEL'S TERMINAL TAB (#193785).
 *
 * Not a second terminal. These are the same terminals as the dock under the chat — the workspace's
 * PTYs from `useTerminal()` — drawn in the side panel instead. A terminal is on screen in ONE place:
 * two xterm views on one PTY both resize it and both save its scrollback on the way out, and the
 * last one to close wins. So:
 *
 * - opening this tab moves the terminals here (the dock under the chat closes);
 * - "Move under the chat" opens the dock, and this tab says where they went, with a way back;
 * - the dock opening by itself (its keybind, the header button) does the same.
 */
export function SessionTerminalPane() {
  const terminal = useTerminal()
  const language = useLanguage()
  const { view } = useSessionLayout()
  const docked = () => view().terminal.opened()
  const t = language.t as (key: string, vars?: Record<string, string | number | boolean>) => string
  const [store, setStore] = createStore({ autoCreated: false, recovered: {} as Record<string, boolean> })

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

  return (
    <div class="iris-terminal" data-component="iris-terminal-pane">
      <Show
        when={!docked()}
        fallback={
          <div class="iris-empty iris-terminal__away">
            <div>Your terminals are open under the chat.</div>
            <button type="button" class="iris-terminal__link" onClick={showHere}>
              Show them here
            </button>
          </div>
        }
      >
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
                    classList={{ "iris-subnav__item--active": terminal.active() === pty.id }}
                    onClick={() => {
                      terminal.open(pty.id)
                      terminal.requestFocus(pty.id)
                    }}
                  >
                    {label(pty)}
                  </button>
                  <button
                    type="button"
                    class="iris-terminal__close"
                    aria-label={`Close ${label(pty)}`}
                    title={`Close ${label(pty)}`}
                    onClick={() => void terminal.close(pty.id)}
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
          <IconButton
            icon="layout-bottom"
            variant="ghost"
            onClick={() => view().terminal.open()}
            aria-label="Move under the chat"
            title="Move under the chat"
          />
        </div>
        <div class="iris-terminal__body">
          <Show
            when={terminal.ready()}
            fallback={<div class="iris-empty">{language.t("terminal.loading")}</div>}
          >
            <Show
              when={terminal.active()}
              keyed
              fallback={
                <div class="iris-empty iris-terminal__away">
                  <div>No terminal is open.</div>
                  <button type="button" class="iris-terminal__link" onClick={() => terminal.new({ focus: true })}>
                    Open a terminal
                  </button>
                </div>
              }
            >
              {(id) => {
                const ops = terminal.bind()
                return (
                  <Show when={terminal.all().find((pty) => pty.id === id)}>
                    {(pty) => (
                      <div id={`terminal-wrapper-${id}`} class="absolute inset-0">
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
                    )}
                  </Show>
                )
              }}
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  )
}
