import { For, Show } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { IrisPanelBoundary } from "@/components/iris-panel-boundary"
import { useIrisPanelScope } from "@/context/iris-panel-scope"
import { IrisProductIcon } from "@/components/session/iris-product-icon"
import {
  SessionIrisTab,
  irisStripTabs,
  useIrisActiveSurface,
  useRequestIrisSurface,
} from "@/components/session/session-iris-tab"

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

/** The panel for a host with no side-panel chrome of its own (Home): a row of the same surfaces, then the body. */
export function IrisPanel(props: { onClose?: () => void }) {
  const active = useIrisActiveSurface()
  const request = useRequestIrisSurface()
  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex h-10 shrink-0 items-center gap-1 border-b border-v2-border-border-base px-2" role="tablist">
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
        <div class="ml-auto" />
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
