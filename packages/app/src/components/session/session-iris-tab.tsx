import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
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

interface AtlasList {
  id: number
  name: string
  items: { id: number; title: string; type?: string; status?: string }[]
}

/** Whatever the active surface returned, beside its measured flags. */
type SurfacePayload = Measured & Record<string, unknown>
interface Measured {
  measured: boolean
  reason?: string
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

  const activeBloq = createMemo(() => selected() ?? bloqs()?.bloqs?.[0]?.id)

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

  /** The rows of whichever surface is active — every response names its own array. */
  const rows = createMemo<any[]>(() => {
    const d = data()
    if (!d) return []
    const key = surface() === "atlas" ? "lists" : surface()
    const v = d[key]
    return Array.isArray(v) ? v : []
  })

  const view = createMemo(() =>
    surfaceView({ loading: data.loading || bloqs.loading, bloqs: bloqs(), data: data(), rows: rows() }),
  )

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
    <div class="flex flex-col h-full min-h-0 gap-2 px-3 pb-3 text-sm">
      <div class="flex items-center gap-2 flex-wrap">
        <Show when={(bloqs()?.bloqs?.length ?? 0) > 0}>
          <select
            class="bg-transparent border border-border rounded px-2 py-1 text-sm min-w-0 flex-1"
            value={activeBloq() ?? ""}
            onChange={(e) => choose(Number(e.currentTarget.value))}
          >
            <For each={bloqs()!.bloqs}>{(b) => <option value={b.id}>{b.name}</option>}</For>
          </select>
        </Show>
      </div>

      {/* The switcher. Four surfaces behind one 37px tab — see SURFACES. */}
      <div class="flex items-center gap-1 shrink-0">
        <For each={SURFACES}>
          {(def) => (
            <button
              type="button"
              class="px-2 py-0.5 rounded text-xs"
              classList={{
                "bg-background-element text-text": surface() === def.id,
                "text-text-muted": surface() !== def.id,
              }}
              onClick={() => chooseSurface(def.id)}
            >
              {def.label}
            </button>
          )}
        </For>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto">
        <Switch>
          <Match when={view() === "loading"}>
            <p class="text-text-muted">Loading…</p>
          </Match>

          {/* NOT MEASURED. Never rendered as an empty surface — see surfaceView. */}
          <Match when={view() === "unreachable"}>
            <p class="text-text-muted">Could not reach IRIS — {bloqs()?.reason ?? "unknown"}.</p>
          </Match>
          <Match when={view() === "surface-error"}>
            <p class="text-text-muted">Could not load {surface()} — {data()?.reason ?? "unknown"}.</p>
          </Match>

          <Match when={view() === "rows"}>
            {/* A partial answer says so: agents can load while their schedules do not, and
                "no schedules" and "schedules unavailable" are different facts. */}
            <Show when={data()?.measured && data()?.reason}>
              <p class="text-text-muted pb-2">{data()!.reason}</p>
            </Show>

            <Switch>
              <Match when={surface() === "atlas"}>
                <For each={rows() as AtlasList[]}>
                  {(list) => (
                    <div class="mb-3">
                      <div class="flex items-baseline gap-2">
                        <span class="font-medium">{list.name}</span>
                        <span class="text-text-muted tabular-nums">{list.items.length}</span>
                      </div>
                      <For each={list.items}>
                        {(item) => (
                          <div class="pl-3 py-0.5 text-text-muted">
                            <span class="mr-1">{item.status === "completed" ? "✓" : "·"}</span>
                            <span>{item.title}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </Match>

              <Match when={surface() === "agents"}>
                <For each={rows()}>
                  {(a) => (
                    <div class="py-0.5">
                      <div class="flex items-baseline gap-2">
                        <span>{a.name}</span>
                        <span class="text-text-muted text-xs">{a.status}</span>
                      </div>
                      <div class="text-text-muted text-xs pl-3">
                        {a.heartbeat ? `heartbeat${a.schedule ? ` · ${a.schedule}` : ""}` : "on demand"}
                        {a.model ? ` · ${a.model}` : ""}
                      </div>
                    </div>
                  )}
                </For>
              </Match>

              <Match when={surface() === "leads"}>
                <For each={rows()}>
                  {(l) => (
                    <div class="py-0.5">
                      <div class="flex items-baseline gap-2">
                        <span classList={{ "text-text": true }}>{l.hot ? "🔥 " : ""}{l.name}</span>
                        <Show when={l.status}>
                          <span class="text-text-muted text-xs">{l.status}</span>
                        </Show>
                      </div>
                      <Show when={l.company || l.email}>
                        <div class="text-text-muted text-xs pl-3">{[l.company, l.email].filter(Boolean).join(" · ")}</div>
                      </Show>
                    </div>
                  )}
                </For>
              </Match>

              <Match when={surface() === "pages"}>
                <For each={rows()}>
                  {(pg) => (
                    <div class="py-0.5">
                      <div class="flex items-baseline gap-2">
                        <span class={pg.status === "published" ? "text-text" : "text-text-muted"}>
                          {pg.status === "published" ? "●" : "○"}
                        </span>
                        <span>{pg.title}</span>
                      </div>
                      <Show when={pg.slug}>
                        <div class="text-text-muted text-xs pl-3">/{pg.slug}</div>
                      </Show>
                    </div>
                  )}
                </For>
              </Match>
            </Switch>
          </Match>

          {/* Only reachable when measured===true — a genuine empty surface. */}
          <Match when={view() === "empty"}>
            <p class="text-text-muted">Nothing in {surface()} on this board.</p>
          </Match>
        </Switch>
      </div>
    </div>
  )
}
