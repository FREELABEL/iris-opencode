import { createEffect, createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { marked } from "marked"
import "./session-iris-tab.css"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { SegmentedControlV2, SegmentedControlItemV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"

/**
 * Atlas — the first IRIS platform surface in the desktop app.
 *
 * The data comes from the sidecar's `/iris/*` routes, not from the webview calling fl-api
 * itself. The webview *could* make that request — tauriFetch is wired and the capability
 * grants http/https — but the bearer token lives in the auth store on disk, which only the
 * sidecar process can read. Routing through it is not a detour; it is the only path that has
 * a token on it.
 *
 * WHY IT CHECKS `measured` BEFORE RENDERING ANYTHING. An account with an empty Atlas and an
 * Atlas we could not reach both arrive as `lists: []`. Rendering the second as the first shows
 * "nothing here" for "the network is down" — the reassuring reading, and the wrong one. The
 * server sends `measured` for this reason; throwing it away here would put the bug back.
 */

interface AtlasItem {
  id: number
  title: string
  type?: string
  status?: string
  content?: string
}
interface AtlasList {
  id: number
  name: string
  items: AtlasItem[]
}

/** Whatever the active surface returned, beside its measured flags. */
type SurfacePayload = Measured & Record<string, unknown>
interface Measured {
  measured: boolean
  reason?: string
}

/**
 * Markdown -> HTML, synchronously.
 *
 * `marked` is already an app dependency. The MarkedProvider in @opencode-ai/ui is not mounted
 * anywhere in this app, so useMarked() would throw — that provider adds shiki highlighting and
 * katex, which this panel does not need to read a board item.
 */
function renderMarkdown(md: string): string {
  try {
    return marked.parse(md, { async: false }) as string
  } catch {
    return ""
  }
}

const LAST_BLOQ_KEY = "iris.panel.bloq"
const LAST_SURFACE_KEY = "iris.panel.surface"

/**
 * FOUR SURFACES, ONE TAB — and that is a width decision, not a shortcut.
 *
 * Each tab in this strip costs 37px of fixed chrome before a single glyph
 * (packages/ui/src/components/tabs.css). Seven tabs plus Review, Context and the "+" is about
 * 883px of tab strip against a panel that is 864px at 1512 with the sidebar collapsed and 568
 * with it open — so it overflows in the BEST case, with no files open. Worse, that strip is
 * `overflow-x: auto` with its scrollbar explicitly hidden and none of the fade the session
 * strip at the top of the window has, so it would overflow silently and take the "+" with it.
 *
 * One tab with an internal switcher costs 37px once.
 */
const SURFACES = [
  { id: "atlas", label: "Atlas", path: (b: number) => `/iris/atlas/${b}` },
  { id: "agents", label: "Agents", path: (b: number) => `/iris/agents/${b}` },
  { id: "leads", label: "Leads", path: (b: number) => `/iris/leads/${b}` },
  { id: "pages", label: "Pages", path: (b: number) => `/iris/pages/${b}` },
] as const

type SurfaceId = (typeof SURFACES)[number]["id"]

/** A persisted surface from an older build must not render a blank panel. */
export function normalizeSurface(value: unknown): SurfaceId {
  return SURFACES.some((s) => s.id === value) ? (value as SurfaceId) : "atlas"
}

/**
 * What the panel should show, as a pure decision.
 *
 * Extracted so it can be tested without mounting Solid, because this is the branch that
 * matters and it is one `&&` away from being wrong: an unreachable Atlas and an empty one both
 * arrive as `lists: []`, and rendering the first as the second tells someone their board is
 * empty when the network is down. "empty" must be reachable ONLY when measured is true.
 */
export function surfaceView(input: {
  loading: boolean
  bloqs?: Measured
  rows?: unknown[]
  data?: Measured | undefined
}): "loading" | "unreachable" | "surface-error" | "rows" | "empty" {
  if (input.loading) return "loading"
  if (input.bloqs && !input.bloqs.measured) return "unreachable"
  if (input.data && !input.data.measured) return "surface-error"
  if (input.rows?.length) return "rows"
  return "empty"
}

export function SessionIrisTab() {
  const dialog = useDialog()
  const serverSDK = useServerSDK()
  const platform = usePlatform()

  const base = createMemo(() => serverSDK().url.replace(/\/$/, ""))
  const doFetch = (path: string) => (platform.fetch ?? globalThis.fetch)(`${base()}${path}`)

  const [bloqs] = createResource(base, async () => {
    const res = await doFetch("/iris/bloqs")
    return (await res.json()) as Measured & { bloqs: { id: number; name: string }[] }
  })

  // Remembered per viewer, not per session: which project you were looking at is a preference,
  // and re-picking it on every launch is how a panel stops being opened.
  const [selected, setSelected] = createSignal<number | undefined>(
    (() => {
      try {
        const v = Number(localStorage.getItem(LAST_BLOQ_KEY))
        return Number.isFinite(v) && v > 0 ? v : undefined
      } catch {
        return undefined
      }
    })(),
  )

  const activeBloq = createMemo(() => selected() ?? (bloqs.latest ?? bloqs())?.bloqs?.[0]?.id)

  const [surface, setSurface] = createSignal<SurfaceId>(
    (() => {
      try {
        return normalizeSurface(localStorage.getItem(LAST_SURFACE_KEY))
      } catch {
        return "atlas" as SurfaceId
      }
    })(),
  )

  const [data] = createResource(
    () => {
      const id = activeBloq()
      return id ? ([base(), id, surface()] as const) : undefined
    },
    async ([, id, which]) => {
      const def = SURFACES.find((s) => s.id === which)!
      const res = await doFetch(def.path(id))
      return (await res.json()) as SurfacePayload
    },
  )

  /**
   * The LAST GOOD payload, not the in-flight one.
   *
   * `data()` is undefined while a refetch is in flight, so switching surfaces emptied the panel
   * for the length of a network round trip — reported as "everything goes black and then it
   * shows again". `data.latest` keeps the previous value until the new one lands, which is the
   * whole point of it. The panel now swaps content instead of blinking through nothing.
   */
  const current = createMemo(() => data.latest ?? data())

  /** The rows of whichever surface is active — every response names its own array. */
  const rows = createMemo<any[]>(() => {
    const d = current()
    if (!d) return []
    const key = surface() === "atlas" ? "lists" : surface()
    const v = d[key]
    return Array.isArray(v) ? v : []
  })

  // Loading ONLY on the first load. A refetch with a previous payload in hand is not a loading
  // state — treating it as one is what caused the flash.
  const firstLoad = createMemo(() => (data.loading && !data.latest) || (bloqs.loading && !bloqs.latest))

  const view = createMemo(() =>
    surfaceView({ loading: firstLoad(), bloqs: bloqs.latest ?? bloqs(), data: current(), rows: rows() }),
  )

  const activeBloqName = createMemo(
    () => (bloqs.latest ?? bloqs())?.bloqs?.find((b) => b.id === activeBloq())?.name ?? "Select a board",
  )

  /** The item being read, if any. Opening one replaces the list; there is no second panel. */
  const [openItem, setOpenItem] = createSignal<AtlasItem | null>(null)

  // Leaving the surface or the board must close the reader — otherwise you switch to Leads and
  // are still looking at an Atlas item.
  createEffect(() => {
    surface()
    activeBloq()
    setOpenItem(null)
  })

  function chooseSurface(id: SurfaceId) {
    setSurface(id)
    try {
      localStorage.setItem(LAST_SURFACE_KEY, id)
    } catch {}
  }

  function choose(id: number) {
    setSelected(id)
    try {
      localStorage.setItem(LAST_BLOQ_KEY, String(id))
    } catch {}
  }

  return (
    <div class="flex flex-col h-full min-h-0 gap-2 px-2 pb-2">
      {/* A SEARCHABLE dialog, not a dropdown.
          This account has 153 bloqs. A plain option list is the wrong control for that at any
          styling — you cannot find "KMG — Kristen Montero" by scrolling past a hundred and
          fifty siblings. `List` is the app's filtered-list primitive and gives search for
          free; dialog-select-mcp and dialog-select-file are the same shape, so this is the
          house answer to "pick one of many" rather than a new idea. */}
      <Show when={((bloqs.latest ?? bloqs())?.bloqs?.length ?? 0) > 0}>
        <button
          type="button"
          class="flex items-center gap-2 px-2 py-1 text-12-regular text-text-base hover:bg-background-element rounded text-start min-w-0 cursor-pointer"
          onClick={() => {
            const all = (bloqs.latest ?? bloqs())?.bloqs ?? []
            dialog.show(() => (
              <Dialog title="Board" description={`${all.length} boards`}>
                <List
                  class="px-3"
                  search={{ placeholder: "Search boards…", autofocus: true }}
                  emptyMessage="No boards match."
                  key={(b) => String(b?.id ?? "")}
                  items={() => all}
                  filterKeys={["name"]}
                  onSelect={(b) => {
                    if (!b) return
                    choose(b.id)
                    // Close it. A picker that stays open after you have picked leaves you
                    // looking at a list of things you did not choose, with the result hidden
                    // behind it — dialog-select-mcp does not close because it is a TOGGLE
                    // list you keep working in, and copying its shape brought that along.
                    dialog.close()
                  }}
                >
                  {(b) => <span class="truncate">{b.name}</span>}
                </List>
              </Dialog>
            ))
          }}
        >
          <span class="truncate">{activeBloqName()}</span>
          <span class="text-text-weak shrink-0">⌄</span>
        </button>
      </Show>

      {/* full-width: the control is a FIXED 232px by default and four flex items inside it leave
          each label ~34px of room, so "Agents" and "Pages" were clipped on both sides. The
          modifier class exists in segmented-control-v2.css; there is no prop for it. */}
      <SegmentedControlV2 class="segmented-control-v2--full-width iris-surfaces shrink-0" value={surface()} onChange={(v) => v && chooseSurface(v as SurfaceId)}>
        <For each={SURFACES}>
          {(def) => <SegmentedControlItemV2 value={def.id}>{def.label}</SegmentedControlItemV2>}
        </For>
      </SegmentedControlV2>

      {/* THE READER. Replaces the list rather than opening beside it: the panel is ~500px wide
          and a master/detail split inside that leaves neither half readable. */}
      <Show when={openItem()}>
        <div class="flex-1 min-h-0 flex flex-col">
          <button
            type="button"
            class="flex items-center gap-1 px-2 py-1 text-12-regular text-text-weak hover:text-text-base shrink-0 text-start cursor-pointer"
            onClick={() => setOpenItem(null)}
          >
            ← Back
          </button>
          <div
            class="iris-markdown flex-1 min-h-0 overflow-y-auto px-2 pb-4 text-12-regular text-text-base"
            /* The body is the signed-in user's own Atlas content, fetched through their own
               sidecar — not third-party input. marked does not sanitise, so this would need a
               sanitiser the moment this panel renders anything someone else authored. */
            innerHTML={renderMarkdown(openItem()!.content ?? "")}
          />
        </div>
      </Show>

      <div class="flex-1 min-h-0 overflow-y-auto" classList={{ hidden: !!openItem() }}>
        <Switch>
          <Match when={view() === "loading"}>
            <p class="px-2 py-2 text-12-regular text-text-weak">Loading…</p>
          </Match>

          {/* NOT MEASURED. Never rendered as an empty surface — see surfaceView. */}
          <Match when={view() === "unreachable"}>
            <p class="px-2 py-2 text-12-regular text-text-weak">Could not reach IRIS — {(bloqs.latest ?? bloqs())?.reason ?? "unknown"}.</p>
          </Match>
          <Match when={view() === "surface-error"}>
            <p class="px-2 py-2 text-12-regular text-text-weak">Could not load {surface()} — {current()?.reason ?? "unknown"}.</p>
          </Match>

          <Match when={view() === "rows"}>
            <Show when={current()?.measured && current()?.reason}>
              <p class="px-2 pb-2 text-12-regular text-text-weak">{current()!.reason}</p>
            </Show>

            <Switch>
              <Match when={surface() === "atlas"}>
                <For each={rows() as AtlasList[]}>
                  {(list) => (
                    <section class="mb-4">
                      <header class="flex items-baseline gap-2 px-2 pb-1 pt-1">
                        <h3 class="text-12-medium text-text-base">{list.name}</h3>
                        {/* Counts in mono + tabular, so columns of numbers line up and read as data. */}
                        <span class="font-mono tabular-nums text-11-regular text-text-weak">
                          {list.items.length}
                        </span>
                      </header>
                      <For each={list.items}>
                        {(item) => (
                          <button
                            type="button"
                            class="w-full flex gap-2 px-2 py-1 text-start rounded cursor-pointer hover:bg-background-element disabled:cursor-default disabled:hover:bg-transparent"
                            disabled={!item.content}
                            title={item.content ? undefined : "This item has no body to show"}
                            onClick={() => item.content && setOpenItem(item)}
                          >
                            <span class="text-12-regular text-text-weak shrink-0">
                              {item.status === "completed" ? "✓" : "·"}
                            </span>
                            <span class="text-12-regular text-text-muted min-w-0">{item.title}</span>
                          </button>
                        )}
                      </For>
                    </section>
                  )}
                </For>
              </Match>

              <Match when={surface() === "agents"}>
                <For each={rows()}>
                  {(a) => (
                    <div class="flex items-baseline gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0">
                      <span class="shrink-0" classList={{ "text-text-base": a.status === "healthy", "text-text-weak": a.status !== "healthy" }}>
                        ●
                      </span>
                      <span class="text-12-regular text-text-base min-w-0 flex-1">{a.name}</span>
                      <span class="font-mono tabular-nums text-11-regular text-text-weak shrink-0">
                        {a.heartbeat ? (a.schedule ?? "heartbeat") : "on demand"}
                      </span>
                    </div>
                  )}
                </For>
              </Match>

              <Match when={surface() === "leads"}>
                <For each={rows()}>
                  {(l) => (
                    <div class="flex items-baseline gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0">
                      <span class="shrink-0">{l.hot ? "🔥" : "·"}</span>
                      <span class="text-12-regular text-text-base min-w-0 flex-1">{l.name}</span>
                      <Show when={l.status}>
                        <span class="font-mono tabular-nums text-11-regular text-text-weak shrink-0">{l.status}</span>
                      </Show>
                    </div>
                  )}
                </For>
              </Match>

              <Match when={surface() === "pages"}>
                <For each={rows()}>
                  {(pg) => (
                    <div class="flex items-baseline gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0">
                      <span
                        class="shrink-0"
                        classList={{ "text-text-base": pg.status === "published", "text-text-weak": pg.status !== "published" }}
                      >
                        {pg.status === "published" ? "●" : "○"}
                      </span>
                      <span class="text-12-regular text-text-base min-w-0 flex-1">{pg.title}</span>
                      <Show when={pg.slug}>
                        <span class="font-mono tabular-nums text-11-regular text-text-weak shrink-0">/{pg.slug}</span>
                      </Show>
                    </div>
                  )}
                </For>
              </Match>
            </Switch>
          </Match>

          {/* Only reachable when measured===true — a genuine empty surface. */}
          <Match when={view() === "empty"}>
            <p class="px-2 py-2 text-12-regular text-text-weak">Nothing in {surface()} on this board.</p>
          </Match>
        </Switch>
      </div>
    </div>
  )
}
