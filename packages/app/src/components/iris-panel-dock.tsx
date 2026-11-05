import { Show, createEffect, createSignal, onCleanup, untrack, type ParentProps } from "solid-js"
import { Portal } from "solid-js/web"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useTitlebarRightMount } from "@/components/titlebar"
import { IrisPanel } from "@/components/iris-panel"
import { clearIrisPanelOpen, irisPanelOpenRequest } from "@/components/session/iris-nav"
import { irisSplitShare, setIrisSplitShare } from "@/components/iris-split"
/**
 * The IRIS panel beside a page that has no side panel of its own — Home and the new-chat page
 * (#192535). Open and width live at module scope, not in the page: both pages show the SAME
 * panel, so "New chat" replaces the left side and the panel stays exactly where it was.
 * Open is remembered under the key Home always used; the split is the shared one (iris-split).
 */
const PANEL_KEY = "iris.home.panel"
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(PANEL_KEY) ?? "{}") as { open?: boolean }
  } catch {
    return {}
  }
})()
const [panelOpen, setPanelOpenSig] = createSignal(saved.open === true)
const save = () => {
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify({ open: panelOpen() }))
  } catch {}
}
const setPanelOpen = (open: boolean) => {
  setPanelOpenSig(open)
  save()
}
export function IrisPanelDock(props: ParentProps<{ class?: string }>) {
  const titlebarRight = useTitlebarRightMount()
  // The panel's pixels come from the shared share and this row's width, measured — not saved.
  const [rowWidth, setRowWidth] = createSignal(window.innerWidth)
  let row: HTMLDivElement | undefined
  const observer = new ResizeObserver(() => row && setRowWidth(row.clientWidth))
  onCleanup(() => observer.disconnect())
  const maxWidth = () => Math.max(360, Math.round(rowWidth() * 0.8))
  const panelWidth = () => Math.min(maxWidth(), Math.max(360, Math.round(rowWidth() * (1 - irisSplitShare()))))
  const setPanelWidth = (width: number) => setIrisSplitShare(1 - width / rowWidth())
  createEffect(() => {
    if (!irisPanelOpenRequest()) return
    untrack(() => setPanelOpen(true))
    clearIrisPanelOpen()
  })
  return (
    <div
      ref={(el) => {
        row = el
        observer.observe(el)
      }}
      class={`flex min-h-0 min-w-0 flex-1 self-stretch ${props.class ?? ""}`}
    >
      {props.children}
      <Show when={panelOpen()}>
        <div class="relative flex min-h-0 shrink-0" style={{ width: `${panelWidth()}px` }}>
          <ResizeHandle
            direction="horizontal"
            edge="start"
            size={panelWidth()}
            min={360}
            max={maxWidth()}
            onResize={setPanelWidth}
          />
          <aside
            aria-label="IRIS"
            class={`
              m-2 ml-0 min-h-0 min-w-0 flex-1 overflow-hidden rounded-[10px]
              bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]
            `}
          >
            <IrisPanel onClose={() => setPanelOpen(false)} />
          </aside>
        </div>
      </Show>
      {/* The same toggle, with the same icon, as a chat's side panel (session-header). */}
      <Show when={titlebarRight()}>
        {(mount) => (
          <Portal mount={mount()}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="large"
              class="!w-9 shrink-0"
              state={panelOpen() ? "pressed" : undefined}
              onClick={() => setPanelOpen(!panelOpen())}
              aria-label="Toggle the IRIS panel"
              aria-expanded={panelOpen()}
              title="IRIS panel"
              icon={<IconV2 name="sidebar-right" />}
            />
          </Portal>
        )}
      </Show>
    </div>
  )
}
