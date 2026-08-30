import { createEffect } from "solid-js"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useTabs } from "@/context/tabs"
import { createHomeController } from "./home/home-controller"
import { createHomeProjectsController } from "./home/home-projects-controller"
import { HomeUtilityNav } from "./home/home-projects-view"
import { HomeProjects } from "./home/home-projects"
import { createHomeScrollController } from "./home/home-scroll-controller"
import { createHomeSessionSearchController } from "./home/home-session-search-controller"
import { createHomeSessionsController } from "./home/home-sessions-controller"
import { HomeSessions } from "./home/home-sessions"

/**
 * Cold-boot routing runs ONCE per app load, not once per visit to "/".
 *
 * Module scope is deliberate. If this lived in component state it would re-fire every time
 * someone navigated back to Home, and clicking "Home" would bounce them straight out of it —
 * a landing page you cannot land on.
 */
let bootRouted = false

export function NewHome() {
  const tabs = useTabs()
  const home = createHomeController()

  // On launch, land where the user actually was — not on a list of everything.
  //
  // The desktop shell performs no initial navigation, so the SPA always came up at "/" even
  // when tabs had been restored from disk. You would reopen the app with five sessions
  // waiting and be shown an index of them instead of the one you were in.
  //
  // Three cases, and they do NOT all want the same answer:
  //
  //   tabs restored      -> the last-used tab. `toggleHome({home:true})` already resolves it
  //                         from the persisted `tabs.recent` key; reusing it means focus
  //                         restoration behaves identically here and in the titlebar.
  //   no tabs, a project -> a fresh session in the most recently used project. This is the
  //                         "open ready to type" behaviour, and the one worth having.
  //   no tabs, no project-> STAY on Home. A session needs a directory to run in, so with no
  //                         project there is nothing to open — the project picker IS the
  //                         correct first screen for a brand-new install.
  createEffect(() => {
    if (bootRouted) return
    // Both stores are async-loaded; acting before they settle would read "no tabs" for a
    // user who has plenty and strand them in a new draft on every launch.
    if (!tabs.ready() || !tabs.recentReady()) return

    if (tabs.store.length > 0) {
      bootRouted = true
      tabs.toggleHome({ home: true })
      return
    }

    const conn = home.server.focused()
    const project = home.project.newSession()
    if (!conn || !project) return // no project yet — Home is right; try again if one appears
    bootRouted = true
    home.project.openProjectNewSession(conn, project.worktree)
  })

  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(sessions.data.groups)
  return (
    <div
      class={`
        m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[10px]
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
        <div
          class={`
            mx-auto grid min-h-full w-full max-w-[1080px] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 px-3
            lg:grid-cols-[280px_minmax(0,720px)] lg:grid-rows-1 lg:gap-8 lg:px-6
          `}
        >
          <HomeProjects projects={projects} scroll={scroll} />
          <HomeSessions sessions={sessions} search={search} scroll={scroll} />
          <HomeUtilityNav
            class="flex lg:hidden"
            onOpenSettings={projects.utility.settings}
            onOpenHelp={projects.utility.help}
            language={projects.copy.language}
          />
        </div>
      </ScrollView>
    </div>
  )
}
