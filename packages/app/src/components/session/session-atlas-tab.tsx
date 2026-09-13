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

interface AtlasItem {
  id: number
  title: string
  type?: string
  status?: string
  description?: string
}
interface AtlasList {
  id: number
  name: string
  items: AtlasItem[]
}
interface Measured {
  measured: boolean
  reason?: string
}

const LAST_BLOQ_KEY = "iris.atlas.bloq"

/**
 * What the panel should show, as a pure decision.
 *
 * Extracted so it can be tested without mounting Solid, because this is the branch that
 * matters and it is one `&&` away from being wrong: an unreachable Atlas and an empty one both
 * arrive as `lists: []`, and rendering the first as the second tells someone their board is
 * empty when the network is down. "empty" must be reachable ONLY when measured is true.
 */
export function atlasView(input: {
  loading: boolean
  bloqs?: Measured
  atlas?: (Measured & { lists?: unknown[] }) | undefined
}): "loading" | "unreachable" | "board-error" | "lists" | "empty" {
  if (input.loading) return "loading"
  if (input.bloqs && !input.bloqs.measured) return "unreachable"
  if (input.atlas && !input.atlas.measured) return "board-error"
  if (input.atlas?.lists?.length) return "lists"
  return "empty"
}

export function SessionAtlasTab() {
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

  const [atlas] = createResource(
    () => {
      const id = activeBloq()
      return id ? ([base(), id] as const) : undefined
    },
    async ([, id]) => {
      const res = await doFetch(`/iris/atlas/${id}`)
      return (await res.json()) as Measured & { lists: AtlasList[] }
    },
  )

  const view = createMemo(() =>
    atlasView({ loading: atlas.loading || bloqs.loading, bloqs: bloqs(), atlas: atlas() }),
  )

  function choose(id: number) {
    setSelected(id)
    try {
      localStorage.setItem(LAST_BLOQ_KEY, String(id))
    } catch {}
  }

  return (
    <div class="flex flex-col h-full min-h-0 gap-2 px-3 pb-3 text-sm">
      <Show when={(bloqs()?.bloqs?.length ?? 0) > 0}>
        <select
          class="bg-transparent border border-border rounded px-2 py-1 text-sm"
          value={activeBloq() ?? ""}
          onChange={(e) => choose(Number(e.currentTarget.value))}
        >
          <For each={bloqs()!.bloqs}>{(b) => <option value={b.id}>{b.name}</option>}</For>
        </select>
      </Show>

      <div class="flex-1 min-h-0 overflow-y-auto">
        <Switch>
          <Match when={view() === "loading"}>
            <p class="text-text-muted">Loading…</p>
          </Match>

          {/* NOT MEASURED. Deliberately not rendered as an empty Atlas — see atlasView. */}
          <Match when={view() === "unreachable"}>
            <p class="text-text-muted">Could not reach IRIS — {bloqs()?.reason ?? "unknown"}.</p>
          </Match>
          <Match when={view() === "board-error"}>
            <p class="text-text-muted">Could not load this board — {atlas()?.reason ?? "unknown"}.</p>
          </Match>

          <Match when={view() === "lists"}>
            <For each={atlas()!.lists}>
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
                        <Show when={item.type}>
                          <span class="ml-2 opacity-60">{item.type}</span>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </Match>

          {/* Only reachable when measured===true — a genuine empty board. */}
          <Match when={view() === "empty"}>
            <p class="text-text-muted">No lists on this board.</p>
          </Match>
        </Switch>
      </div>
    </div>
  )
}
