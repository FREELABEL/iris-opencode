import {
  Show,
  Suspense,
  lazy,
  createContext,
  createEffect,
  createSignal,
  onMount,
  onCleanup,
  untrack,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js"
import { Portal } from "solid-js/web"
import { createMediaQuery } from "@solid-primitives/media"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useTitlebarRightMount } from "@/components/titlebar"
// Its own chunk: the panel (Atlas, Genesis, agents, editors) is most of what Home used to parse.
const irisPanel = () => import("@/components/iris-panel")
const IrisPanel = lazy(() => irisPanel().then((m) => ({ default: m.IrisPanel })))
import { clearIrisPanelOpen, irisPanelOpenRequest } from "@/components/session/iris-nav"
import { irisSplitShare, setIrisSplitShare } from "@/components/iris-split"
import {
  IRIS_SHELL_PANEL_MIN,
  IRIS_SHELL_PHONE_QUERY,
  irisShellPanelLayout,
  irisShellPanelMax,
} from "@/components/iris-shell-layout"
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
  // The panel is the heaviest thing on screen (Atlas fetches, renders and polls). It mounts once
  // the page on the left has had its turn — the first idle moment, 2 s at most — so it never
  // competes with Home or the composer for the first paint. Once mounted it stays mounted.
  const [settled, setSettled] = createSignal(false)
  onMount(() => {
    const done = () => {
      setSettled(true)
      // Fetch the chat page and the panel while nothing else is happening, so the first click on
      // either is instant even though neither is in the bundle Home starts with.
      void irisPanel().catch(() => {})
      void import("@/pages/session").catch(() => {})
    }
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(done, { timeout: 2000 })
      onCleanup(() => cancelIdleCallback(id))
    } else {
      const id = setTimeout(done, 300)
      onCleanup(() => clearTimeout(id))
    }
  })
  const visible = () => {
    const open = claimed()
    return open ? open() : panelOpen()
  }
  const [rowWidth, setRowWidth] = createSignal(window.innerWidth)
  let row: HTMLDivElement | undefined
  const observer = new ResizeObserver(() => row && setRowWidth(row.clientWidth))
  onCleanup(() => observer.disconnect())
  // On a phone the panel is a sheet over the page, not a column beside it (#194511).
  const phone = createMediaQuery(IRIS_SHELL_PHONE_QUERY)
  const layout = () => irisShellPanelLayout({ phone: phone(), row: rowWidth(), share: irisSplitShare() })
  const overlay = () => layout().overlay
  const panelWidth = () => layout().width
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
    // A sheet takes no room from the page.
    width: () => (visible() && !overlay() ? panelWidth() : 0),
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
        class="relative flex min-h-0 min-w-0 flex-1 self-stretch"
      >
        <div data-component="iris-shell-page" class="flex min-h-0 min-w-0 flex-1 flex-col">
          {props.children}
        </div>
        {/* Hidden, never unmounted: the container (and what is portaled into it) survives. */}
        <div
          data-component="iris-shell-panel"
          data-overlay={overlay() ? "" : undefined}
          class="flex min-h-0"
          classList={{
            hidden: !visible(),
            "relative shrink-0": !overlay(),
            // A sheet over the page, under the titlebar (whose toggle shows it pressed); its own
            // header has the close. The layout already pads top and bottom by the safe area;
            // the sides matter once the phone is turned.
            "absolute inset-0 z-40 flex-col bg-v2-background-bg-deep": overlay(),
          }}
          style={
            overlay()
              ? {
                  "padding-left": "env(safe-area-inset-left, 0px)",
                  "padding-right": "env(safe-area-inset-right, 0px)",
                }
              : { width: `${panelWidth()}px` }
          }
        >
          {/* Nothing to resize on a phone, and an edge handle there sat over the page. */}
          <Show when={!overlay()}>
            <ResizeHandle
              direction="horizontal"
              edge="start"
              size={panelWidth()}
              min={IRIS_SHELL_PANEL_MIN}
              max={irisShellPanelMax(rowWidth())}
              onResize={(width) => setIrisSplitShare(1 - width / rowWidth())}
            />
          </Show>
          <div ref={setSlot} class="flex min-h-0 min-w-0 flex-1 py-2 pr-2" classList={{ hidden: !claimed() }} />
          {/* Closed means unmounted: a hidden panel kept fetching and polling Atlas behind Home. */}
          <Show when={!claimed() && panelOpen()}>
            <aside
              aria-label="IRIS"
              class="min-h-0 min-w-0 flex-1 overflow-hidden bg-v2-background-bg-base"
              classList={{
                "m-2 ml-0 rounded-[10px] shadow-[var(--v2-elevation-raised)]": !overlay(),
              }}
            >
              <Show when={settled()}>
                <Suspense>
                  <IrisPanel onClose={() => setPanelOpen(false)} />
                </Suspense>
              </Show>
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
                data-callout="iris-panel"
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
