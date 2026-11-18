import { SessionWebTab } from "@/components/session/session-web-tab"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { IrisPanelBoundary } from "@/components/iris-panel-boundary"
import { useIrisPanelScope } from "@/context/iris-panel-scope"
import { IrisProductIcon } from "@/components/session/iris-product-icon"
import {
  IRIS_SURFACE_CHOICES,
  filterSurfaceChoices,
  SessionIrisTab,
  irisPinned,
  toggleIrisPin,
  irisStripTabs,
  useIrisActiveSurface,
  useRequestIrisSurface,
  registerBrowserPane,
  registerHomeTerminalPane,
} from "@/components/session/session-iris-tab"
import { HomeTerminalPane } from "@/pages/session/terminal-pane"

// #193062: the IRIS panel draws the Browser product with this pane (see registerBrowserPane).
registerBrowserPane(SessionWebTab)
// #193785: with no chat on screen the Terminal runs in the home folder (a chat's side panel
// registers its own, in the chat's project, while it is mounted).
registerHomeTerminalPane(HomeTerminalPane)

/**
 * The IRIS panel itself — one component, for every host (#192535). It used to exist only inside a
 * chat's side panel, so anything opened from Home first had to land in whichever chat was last open.
 * Its state is the panel scope (window-wide, or the split column's), never the chat.
 */
export function IrisPanelBody() {
  return (
    <IrisPanelBoundary label="The IRIS panel">
      <SessionIrisTab />
    </IrisPanelBoundary>
  )
}

/**
 * What the panel is scoped to — a project (with its board id, and a picker), a session or the
 * account. Both hosts show it: the chat in its tab row, Home in the panel's own row.
 */
export function IrisScopeChip() {
  const scope = useIrisPanelScope()
  return (
    <Show when={scope.chip()}>
      {(chip) => (
        <div class="iris-scopechip" data-testid="iris-scope-chip" data-scope={chip().scope}>
          <Show
            when={chip().pick}
            fallback={
              <span class="iris-scopechip__body" title={`Scope: ${chip().label}`}>
                <span class="iris-scopechip__name">{chip().label}</span>
              </span>
            }
          >
            {(pick) => (
              <button
                type="button"
                class="iris-scopechip__body"
                title={`Project: ${chip().label}${chip().id != null ? ` (#${chip().id})` : ""} — change`}
                onClick={() => pick()()}
              >
                <span class="iris-scopechip__name">{chip().label}</span>
                <Show when={chip().id != null}>
                  <span class="iris-scopechip__id">#{chip().id}</span>
                </Show>
                <span class="iris-scopechip__chev" aria-hidden="true">
                  ▾
                </span>
              </button>
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}

/**
 * The products under the panel's "+" — pin one into the strip (pinning also opens it), the ✓ is
 * whether it is there. One list for every host (#192535): the chat's "+" adds its own file items
 * above it, Home and the new-chat page show it alone.
 */
export function IrisPinItems(props: { onOpen: (id: string) => void }) {
  // The list passed fifteen products (2026-11-18): typing narrows it, Enter opens the first match.
  const [query, setQuery] = createSignal("")
  let box: HTMLDivElement | undefined
  const matches = createMemo(() => filterSurfaceChoices(IRIS_SURFACE_CHOICES, query()))
  let searched = false
  const pick = (id: string) => {
    // From the search, a tab already in the strip is opened, not unpinned: you searched to GO to it.
    if (searched && irisPinned().includes(id as any)) return props.onOpen(id)
    if (toggleIrisPin(id)) props.onOpen(id)
  }
  // Enter from the search selects the first match the way the menu's own Enter does — the item
  // gets the key — so the menu closes exactly as it does for a pick. (A click() does not select:
  // the menu acts on pointer-up and keys.)
  const enter = () => {
    const first = matches()[0]
    const item = first && box?.parentElement?.querySelector<HTMLElement>(`[data-pin-id="${first.id}"]`)
    if (!item) return
    searched = true
    item.focus()
    item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    searched = false
  }
  /*
   * Typing goes to the search wherever focus is. The menu keeps focus on its items (it took it back
   * from the field, measured 2026-11-18), so the field is fed from a capture listener on the menu:
   * letters filter, Backspace deletes, Enter opens the first match; arrows and Esc stay the menu's.
   */
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (searched) return
    if (e.target instanceof HTMLInputElement && e.target.classList.contains("iris-pinsearch__input")) return
    if (e.key.length === 1 && (e.key !== " " || query())) {
      e.preventDefault()
      e.stopPropagation()
      setQuery(query() + e.key)
    } else if (e.key === "Backspace" && query()) {
      e.preventDefault()
      e.stopPropagation()
      setQuery(query().slice(0, -1))
    } else if (e.key === "Enter" && query()) {
      e.preventDefault()
      e.stopPropagation()
      enter()
    }
  }
  onMount(() => {
    const menu = box?.closest<HTMLElement>("[role='menu']") ?? box?.parentElement
    menu?.addEventListener("keydown", onKey, true)
    onCleanup(() => menu?.removeEventListener("keydown", onKey, true))
  })
  return (
    <>
      <div ref={box} class="iris-pinsearch" onPointerDown={(e) => e.stopPropagation()}>
        <input
          type="search"
          class="iris-pinsearch__input"
          placeholder="Type to search tabs"
          aria-label="Search tabs"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (["ArrowDown", "ArrowUp", "Escape", "Tab"].includes(e.key)) return
            e.stopPropagation()
            if (e.key === "Enter") {
              e.preventDefault()
              enter()
            }
          }}
        />
      </div>
      <Show when={matches().length > 0} fallback={<div class="iris-pinsearch__none">No tab matches “{query()}”</div>}>
        <For each={matches()}>
          {(surface) => (
            <MenuV2.Item data-pin-id={surface.id} onSelect={() => pick(surface.id)}>
              <span class="inline-flex w-4 shrink-0">{irisPinned().includes(surface.id as any) ? "✓" : ""}</span>
              <span class="inline-flex items-center gap-2">
                <IrisProductIcon id={surface.id} />
                {surface.label}
              </span>
            </MenuV2.Item>
          )}
        </For>
      </Show>
    </>
  )
}
/** The panel for a host with no side-panel chrome of its own (Home): a row of the same surfaces, then the body. */
export function IrisPanel(props: { onClose?: () => void }) {
  const active = useIrisActiveSurface()
  const request = useRequestIrisSurface()
  let strip: HTMLDivElement | undefined
  // A tab opened from the + menu may be past the strip's edge: bring it into the strip's view.
  createEffect(
    on(active, () =>
      requestAnimationFrame(() =>
        strip?.querySelector<HTMLElement>("[aria-selected='true']")?.scrollIntoView({ block: "nearest", inline: "nearest" }),
      ),
    ),
  )
  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex h-10 shrink-0 items-center gap-1 border-b border-v2-border-border-base px-2">
        {/*
         * The tabs scroll in their OWN strip (2026-11-18). They used to overflow the panel, so
         * focus landing on "+" (the menu hands it back on close) scrolled the whole panel sideways
         * and the body slid under Home — MCP's server names were off-screen to the left.
         */}
        <div ref={strip} class="iris-homestrip flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist">
        <For each={irisStripTabs(active())}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={active() === tab.id}
              class="flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-[12.5px] text-v2-text-text-muted hover:text-v2-text-text-base aria-selected:bg-v2-background-bg-layer-02 aria-selected:text-v2-text-text-base"
              onClick={() => request(tab.id)}
            >
              <IrisProductIcon id={tab.id} />
              {tab.label}
            </button>
          )}
        </For>
        </div>
        <MenuV2 gutter={6} modal={false} placement="bottom-end">
          <MenuV2.Trigger
            as={IconButtonV2}
            icon={<Icon name="plus-small" />}
            variant="ghost-muted"
            size="large"
            aria-label="Add a tab"
          />
          <MenuV2.Portal>
            <MenuV2.Content style={{ "min-width": "190px" }}>
              <IrisPinItems onOpen={(id) => request(id as any)} />
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
        <IrisScopeChip />
        <Show when={props.onClose}>
          <IconButton
            icon="close-small"
            variant="ghost"
            class="h-6 w-6"
            aria-label="Close the panel"
            onClick={() => props.onClose?.()}
          />
        </Show>
      </div>
      <div class="min-h-0 flex-1">
        <IrisPanelBody />
      </div>
    </div>
  )
}
