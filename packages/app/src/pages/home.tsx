import { Show, createMemo, createSignal } from "solid-js"
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
import { HomeDashboard } from "./home/home-dashboard"
import { HomeFirstRun, createSignedOut, firstRunPending } from "./home/home-first-run"
import { ServerConnection } from "@/context/server"

export function NewHome() {
  const tabs = useTabs()
  const home = createHomeController()
  const signedOut = createSignedOut()
  // No launch redirect (#192535). Home used to jump to the last tab (or open a new chat) once the
  // engine confirmed sign-in — on a slow machine that answer took ~10 s, so people were pulled out
  // of Home mid-use. Restored tabs are already in the strip: picking up where you left off is one
  // click on them. Nothing on this page navigates unless the person asks it to.

  // First run (D4/D5 #188245/#188243): a brand-new install — no tabs, no project, onboarding
  // neither finished nor skipped — gets "Connect your inbox → Here's what I see → Start" instead
  // of an empty project list. Anyone with a project never sees it.
  const [firstRun, setFirstRun] = createSignal(firstRunPending())
  // Set when onboarding hands off to its session. Keeps the first-run screen ("Setting up your
  // workspace…") up until the session tab takes over: opening the project makes the condition
  // below false a moment before navigation, which flashed the empty project list.
  const [launching, setLaunching] = createSignal(false)
  // Signed out always means sign-in, here, whatever the first-run flag or the tabs say.
  const showFirstRun = createMemo(
    () =>
      signedOut() === true ||
      launching() ||
      (firstRun() && tabs.ready() && tabs.store.length === 0 && !home.project.newSession()),
  )
  const startFirstSession = (directory: string, prompt: string) => {
    const conn = home.server.focused()
    if (!conn) return
    setLaunching(true)
    const ctx = home.server.context(conn)
    ctx.projects.open(directory)
    ctx.projects.touch(directory)
    // Released once the draft has navigated, so coming back to Home later shows Home.
    void tabs
      .newDraft({ server: ServerConnection.key(conn), directory }, prompt, undefined, { send: true })
      .finally(() => setLaunching(false))
  }

  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(sessions.data.groups)
  return (
    <div class="flex min-h-0 min-w-0 flex-1 self-stretch">
      <div
        class={`
          m-2 min-h-0 min-w-0 flex-1 overflow-hidden rounded-[10px]
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
          <Show when={showFirstRun()}>
            <HomeFirstRun onStart={startFirstSession} onDone={() => setFirstRun(false)} />
          </Show>
          <Show when={!showFirstRun()}>
            <HomeDashboard
              class="mx-auto w-full max-w-[1080px] px-3 pt-5 pb-2 lg:px-6"
              onSettings={projects.utility.settings}
              onNewChat={() => {
                const conn = home.server.focused()
                const project = home.project.newSession()
                if (conn && project) home.project.openProjectNewSession(conn, project.worktree)
              }}
            />
          </Show>
          <div
            classList={{ hidden: showFirstRun() }}
            class={`
              mx-auto grid w-full max-w-[1080px] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 px-3
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
    </div>
  )
}
