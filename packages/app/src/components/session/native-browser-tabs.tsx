import { createEffect, For, on, onCleanup, Show } from "solid-js"
import type { NativeBrowser } from "@/context/platform"
import { NativeWebTab } from "./native-web-tab"
import {
  activeTab,
  addTab,
  closeTab,
  forgetTabPage,
  fromPageKey,
  labelForUrl,
  MAX_TABS,
  noteTabPage,
  pageKey,
  setActiveTab,
  setPendingOpen,
  tabName,
  tabsOf,
} from "./browser-tabs"

/**
 * The Browser with tabs (#193328): a row of this chat's tabs over the page of the one showing.
 *
 * Only the showing tab's NativeWebTab is mounted — it hides its page when it unmounts and the
 * next one shows its own, the same path switching chats already takes. Background pages stay
 * alive (hidden) so the agent can read them; the strip listens to every tab's page for its title.
 */
export function NativeBrowserTabs(props: {
  chat: string
  native: (key: string) => NativeBrowser
  zoom: () => number
  openExternal: (url: string) => void
  /** A page asked for a new window (target=_blank / window.open). */
  onNewTab?: (handler: (e: { chat: string; url: string }) => void) => () => void
}) {
  const tabs = () => tabsOf(props.chat)
  const active = () => activeTab(props.chat)

  // Every tab's title, also the ones not showing: one listener per tab, re-made when the row changes.
  createEffect(
    on(
      () => tabs().map((t) => t.id).join(","),
      () => {
        const offs = tabs().map((t) => {
          const key = pageKey(props.chat, t.id)
          const nb = props.native(key)
          void nb
            .state()
            .then((s) => s && noteTabPage(key, s))
            .catch(() => undefined)
          return nb.onState((s) => noteTabPage(key, s))
        })
        onCleanup(() => offs.forEach((off) => off()))
      },
    ),
  )

  // A link that asked for a new window opens a tab in ITS chat; past the limit it opens in the
  // tab it came from, as before tabs (never lost, never a window without the Browser's gates).
  if (props.onNewTab) {
    const off = props.onNewTab((e) => {
      const from = fromPageKey(e.chat)
      if (!from || from.chat !== props.chat) return
      const id = addTab(props.chat, labelForUrl(e.url))
      if (id) return setPendingOpen(pageKey(props.chat, id), e.url)
      void props.native(e.chat).navigate(e.url).catch(() => undefined)
    })
    onCleanup(off)
  }

  const close = (id: string) => {
    const key = pageKey(props.chat, id)
    if (closeTab(props.chat, id) === undefined) return
    forgetTabPage(key)
    void props.native(key).close?.().catch(() => undefined)
  }

  return (
    <div class="session-web session-web--tabs" data-component="browser-tabs">
      <div class="session-web__tabs" role="tablist" aria-label="Browser tabs">
        <For each={tabs()}>
          {(t) => (
            <div
              class="session-web__tab"
              role="tab"
              data-active={t.id === active() ? "true" : undefined}
              aria-selected={t.id === active()}
              title={tabName(props.chat, t)}
              onClick={() => setActiveTab(props.chat, t.id)}
              onAuxClick={(e) => {
                if (e.button === 1) close(t.id)
              }}
            >
              <span class="session-web__tab-name">{tabName(props.chat, t)}</span>
              <Show when={tabs().length > 1}>
                <button
                  type="button"
                  class="session-web__tab-close"
                  aria-label={`Close ${tabName(props.chat, t)}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    close(t.id)
                  }}
                >
                  ×
                </button>
              </Show>
            </div>
          )}
        </For>
        <Show when={tabs().length < MAX_TABS}>
          <button
            type="button"
            class="session-web__tab-new"
            aria-label="New tab"
            title="New tab"
            onClick={() => addTab(props.chat)}
          >
            +
          </button>
        </Show>
      </div>
      <Show when={pageKey(props.chat, active())} keyed>
        {(key) => (
          <NativeWebTab browser={props.native(key)} pageKey={key} zoom={props.zoom} openExternal={props.openExternal} />
        )}
      </Show>
    </div>
  )
}
