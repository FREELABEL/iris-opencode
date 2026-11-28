import { Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import "./sessions-drawer.css"
import { sessionsDrawerOpen, setSessionsDrawerOpen } from "./sessions-drawer-state"
import { useLocation } from "@solidjs/router"
import { useTabs } from "@/context/tabs"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { createHomeController } from "@/pages/home/home-controller"
import { createHomeScrollController } from "@/pages/home/home-scroll-controller"
import { createHomeSessionSearchController } from "@/pages/home/home-session-search-controller"
import { createHomeSessionsController, type HomeSessionGroup } from "@/pages/home/home-sessions-controller"
import { HomeSessions } from "@/pages/home/home-sessions"

/**
 * EVERY CHAT, WITHOUT LEAVING THIS ONE (#190273).
 *
 * The Home page's session list — search, Today / Yesterday / Older, live status, the open-tab
 * marker — shown as a drawer over the chat instead of as a page. Not a second list: the same
 * controllers and the same view, so a fix to one is a fix to both, and folders (next) land in
 * both at once.
 *
 * Opened by the IRIS cube in the title bar. Closes on Esc, a click outside, its ✕, or when a chat
 * is opened from it (the route changes). On a phone it is a full-screen sheet with a ✕ you can
 * reach: "outside" was a few pixels beside it (#194511). It slides in from the cube's side and
 * back out again (sessions-drawer.css).
 */
const open = sessionsDrawerOpen
const setOpen = setSessionsDrawerOpen

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
  const language = useLanguage()
  // Play the slide out, then unmount; at once when the system asks for less motion.
  const [closing, setClosing] = createSignal(false)
  const close = () => {
    if (closing()) return
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setOpen(false)
    setClosing(true)
    setTimeout(() => setOpen(false), 180)
  }
  const page = createHomeController()
  // ALWAYS every project. The Home page's project filter is shared state; following it made the
  // drawer show one project's chats to someone who had once clicked that project on Home.
  const home = { ...page, project: { ...page.project, selected: () => undefined } }
  const tabs = useTabs()
  const all = createHomeSessionsController(home)
  /*
   * OPEN TABS FIRST, THEN EVERYTHING. The tab strip is what you are working on; the history is
   * everything you have. Open tabs lead in the strip's own order, and stay in the history below
   * too — the history is the whole record, not "the rest".
   */
  const openGroup = createMemo((): HomeSessionGroup | undefined => {
    const records = all.data.records()
    const open = tabs.store.flatMap((tab) => {
      if (tab.type !== "session") return []
      const record = records.find((r) => r.session.id === tab.sessionId)
      return record ? [record] : []
    })
    return open.length ? { id: "open", title: "Open tabs", sessions: open } : undefined
  })
  const groups = createMemo(() => {
    const open = openGroup()
    return open ? [open, ...all.data.groups()] : all.data.groups()
  })
  const sessions = { ...all, data: { ...all.data, groups } }
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(groups)
  return (
    <div
      class="absolute inset-x-0 bottom-0 top-[var(--titlebar-height,44px)] z-40"
      data-component="sessions-drawer"
      data-closing={closing() ? "" : undefined}
    >
      <div data-slot="sessions-drawer-backdrop" class="absolute inset-0 bg-black/20" aria-hidden onClick={close} />
      <div
        role="dialog"
        aria-label="All chats"
        data-slot="sessions-drawer-sheet"
        class={`
          absolute bottom-2 left-2 top-0 flex w-[min(440px,calc(100vw-16px))] flex-col overflow-hidden rounded-[10px]
          bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]
          max-md:inset-0 max-md:w-full max-md:rounded-none max-md:shadow-none
        `}
      >
        <div class="flex shrink-0 justify-end px-2 pt-2">
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="large"
            icon={<Icon name="outline-xmark" />}
            onClick={close}
            aria-label={language.t("common.close")}
          />
        </div>
        <ScrollView
          class="min-h-0 flex-1 [container-type:size]"
          thumbContainer={scroll.viewport.thumbTrack}
          thumbHoverTarget={scroll.viewport.hoverTarget}
          viewportRef={scroll.viewport.setViewport}
          onScroll={(event) => scroll.viewport.update(event.currentTarget.scrollTop)}
          onWheel={scroll.viewport.containOuterWheel}
        >
          <div class="px-3">
            <HomeSessions sessions={sessions} search={search} scroll={scroll} compact />
          </div>
        </ScrollView>
      </div>
    </div>
  )
}
