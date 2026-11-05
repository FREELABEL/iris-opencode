import {
  Show,
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  untrack,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js"
import { Portal } from "solid-js/web"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useTitlebarRightMount } from "@/components/titlebar"
import { IrisPanel } from "@/components/iris-panel"
import { clearIrisPanelOpen, irisPanelOpenRequest } from "@/components/session/iris-nav"
import { irisSplitShare, setIrisSplitShare } from "@/components/iris-split"
/**
 * ONE SHELL: the page on the left, the panel on the right (#192535).
 *
 * Home, the new-chat page and a chat were sibling routes, each drawing its own right side — so
 * every click between them rebuilt that side, and each saved its size its own way. The shell is
 * the parent route of all three: it is mounted once, owns the right container (its size, its
 * handle, open, the titlebar toggle), and only the left side changes with the route.
 *
 * What fills the right side: the IRIS panel by default. A chat that is the only column on screen
 * CLAIMS it and portals its own side panel (review, files, terminal) in; split-view columns keep
 * their own panels. Open is remembered under the key Home always used; the split is iris-split.
 */
type Shell = {
  /** Where a claiming page portals its right side. */
  slot: Accessor<HTMLDivElement | undefined>
  /** Take the right side for as long as the calling owner lives; `open` says whether to show it. */
  claim: (open: Accessor<boolean>) => void
  /** THE open state — Home's, and the one a claiming chat follows and reports back. */
  open: Accessor<boolean>
  setOpen: (open: boolean) => void
  /** How wide the right side is on screen right now (0 when hidden). */
  width: Accessor<number>
}
const ShellContext = createContext<Shell>()
export const useIrisShell = () => useContext(ShellContext)

const PANEL_KEY = "iris.home.panel"
const [panelOpen, setPanelOpenSig] = createSignal(
  (() => {
    try {
      return (JSON.parse(localStorage.getItem(PANEL_KEY) ?? "{}") as { open?: boolean }).open === true
    } catch {
      return false
    }
  })(),
)
const setPanelOpen = (open: boolean) => {
  setPanelOpenSig(open)
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify({ open }))
  } catch {}
}

export function IrisShell(props: ParentProps) {
  const titlebarRight = useTitlebarRightMount()
  const [slot, setSlot] = createSignal<HTMLDivElement>()
  // A list, not one slot: split-view columns each claim, and one closing must not release the rest.
  const [claims, setClaims] = createSignal<Accessor<boolean>[]>([])
  const claimed = () => claims().at(-1)
  const visible = () => {
    const open = claimed()
    return open ? open() : panelOpen()
  }
  const [rowWidth, setRowWidth] = createSignal(window.innerWidth)
  let row: HTMLDivElement | undefined
  const observer = new ResizeObserver(() => row && setRowWidth(row.clientWidth))
  onCleanup(() => observer.disconnect())
  const maxWidth = () => Math.max(360, Math.round(rowWidth() * 0.8))
  const panelWidth = () => Math.min(maxWidth(), Math.max(360, Math.round(rowWidth() * (1 - irisSplitShare()))))
  // A claiming chat's own side panel answers "open IRIS" itself; only the default panel does here.
  createEffect(() => {
    if (!irisPanelOpenRequest() || untrack(claimed)) return
    untrack(() => setPanelOpen(true))
    clearIrisPanelOpen()
  })
  const shell: Shell = {
    slot,
    open: panelOpen,
    setOpen: setPanelOpen,
    width: () => (visible() ? panelWidth() : 0),
    claim(open) {
      setClaims((list) => [...list, open])
      onCleanup(() => setClaims((list) => list.filter((item) => item !== open)))
    },
  }
  return (
    <ShellContext.Provider value={shell}>
      <div
        ref={(el) => {
          row = el
          observer.observe(el)
        }}
        class="flex min-h-0 min-w-0 flex-1 self-stretch"
      >
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">{props.children}</div>
        {/* Hidden, never unmounted: the container (and what is portaled into it) survives. */}
        <div
          class="relative flex min-h-0 shrink-0"
          classList={{ hidden: !visible() }}
          style={{ width: `${panelWidth()}px` }}
        >
          <ResizeHandle
            direction="horizontal"
            edge="start"
            size={panelWidth()}
            min={360}
            max={maxWidth()}
            onResize={(width) => setIrisSplitShare(1 - width / rowWidth())}
          />
          <div ref={setSlot} class="flex min-h-0 min-w-0 flex-1 py-2 pr-2" classList={{ hidden: !claimed() }} />
          <Show when={!claimed()}>
            <aside
              aria-label="IRIS"
              class={`
                m-2 ml-0 min-h-0 min-w-0 flex-1 overflow-hidden rounded-[10px]
                bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]
              `}
            >
              <IrisPanel onClose={() => setPanelOpen(false)} />
            </aside>
          </Show>
        </div>
        {/* A claiming chat has its own toggle in its header; this one is for the default panel. */}
        <Show when={!claimed() && titlebarRight()}>
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
    </ShellContext.Provider>
  )
}
