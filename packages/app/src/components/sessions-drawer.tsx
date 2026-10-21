import { Show, createEffect, createSignal, on, onCleanup } from "solid-js"
import { useLocation } from "@solidjs/router"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { createHomeController } from "@/pages/home/home-controller"
import { createHomeScrollController } from "@/pages/home/home-scroll-controller"
import { createHomeSessionSearchController } from "@/pages/home/home-session-search-controller"
import { createHomeSessionsController } from "@/pages/home/home-sessions-controller"
import { HomeSessions } from "@/pages/home/home-sessions"

/**
 * EVERY CHAT, WITHOUT LEAVING THIS ONE (#190273).
 *
 * The Home page's session list — search, Today / Yesterday / Older, live status, the open-tab
 * marker — shown as a drawer over the chat instead of as a page. Not a second list: the same
 * controllers and the same view, so a fix to one is a fix to both, and folders (next) land in
 * both at once.
 *
 * Opened by the IRIS cube in the title bar. Closes on Esc, a click outside, or when a chat is
 * opened from it (the route changes).
 */
const [open, setOpen] = createSignal(false)
export const sessionsDrawerOpen = open
export const toggleSessionsDrawer = () => setOpen((v) => !v)
export const closeSessionsDrawer = () => setOpen(false)

export function SessionsDrawer() {
  const location = useLocation()
  // Picking a chat navigates; the drawer has done its job.
  createEffect(on(() => location.pathname, () => setOpen(false), { defer: true }))

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open()) {
      e.stopPropagation()
      setOpen(false)
    }
  }
  document.addEventListener("keydown", onKey, true)
  onCleanup(() => document.removeEventListener("keydown", onKey, true))

  return (
    <Show when={open()}>
      <SessionsDrawerBody />
    </Show>
  )
}

/** Mounted only while open: the controllers subscribe to the session index for as long as they live. */
function SessionsDrawerBody() {
  const home = createHomeController()
  const sessions = createHomeSessionsController(home)
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(sessions.data.groups)
  return (
    <div class="absolute inset-x-0 bottom-0 top-[var(--titlebar-height,44px)] z-40" data-component="sessions-drawer">
      <div class="absolute inset-0 bg-black/20" aria-hidden onClick={() => setOpen(false)} />
      <div
        role="dialog"
        aria-label="All chats"
        class={`
          absolute bottom-2 left-2 top-0 w-[min(440px,calc(100vw-16px))] overflow-hidden rounded-[10px]
          bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]
        `}
      >
        <ScrollView
          class="h-full [container-type:size]"
          thumbContainer={scroll.viewport.thumbTrack}
          thumbHoverTarget={scroll.viewport.hoverTarget}
          viewportRef={scroll.viewport.setViewport}
          onScroll={(event) => scroll.viewport.update(event.currentTarget.scrollTop)}
          onWheel={scroll.viewport.containOuterWheel}
        >
          <div class="px-3">
            <HomeSessions sessions={sessions} search={search} scroll={scroll} />
          </div>
        </ScrollView>
      </div>
    </div>
  )
}
