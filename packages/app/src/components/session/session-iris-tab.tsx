import { createEffect, createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { marked } from "marked"
import "./session-iris-tab.css"
import { pageSummary, type PageEnvelope } from "./use-paged-surface"
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
type SurfacePayload = Measured & { [key: string]: unknown }
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
/** Which array key a surface's response uses. One mapping, used by both the reader and paging. */
function arrayKeyFor(surface: string): string {
  if (surface === "atlas") return "lists"
  if (surface === "hive") return "nodes"
  return surface
}

/** Non-empty fields only — a detail panel full of "—" teaches nothing. */
const fieldsOf = (pairs: [string, unknown][]): [string, string][] =>
  pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && !(typeof v === "number" && Number.isNaN(v)))
    .map(([k, v]) => [k, typeof v === "boolean" ? (v ? "yes" : "no") : String(v)])

/**
 * What clicking a row opens, per surface.
 *
 * One describer rather than five detail components: every one of these is "a record with some
 * fields and maybe a command", and five near-identical panels would drift apart the first time
 * one of them got a fix.
 */
/** "20h ago" — plain, so a stale reading announces its own age. */
function relativeAge(iso: string): string | undefined {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return undefined
  const mins = Math.floor((Date.now() - t) / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function describeRow(surface: string, r: any): { title: string; fields: [string, string][]; command?: string } | null {
  if (surface === "agents")
    return {
      title: r.name,
      fields: fieldsOf([
        ["id", r.id], ["status", r.status], ["model", r.model], ["active", r.active],
        ["mode", r.heartbeat ? "heartbeat" : "on demand"], ["schedule", r.schedule],
        ["last run", r.lastRun], ["consecutive failures", r.failures], ["created", r.createdAt],
        ["description", r.description],
      ]),
      command: `iris agents show ${r.id}`,
    }
  if (surface === "leads")
    return {
      title: r.name,
      fields: fieldsOf([
        ["id", r.id], ["status", r.status], ["company", r.company], ["email", r.email],
        ["score", r.score], ["hot", r.hot], ["type", r.type],
        ["city", r.city], ["country", r.country], ["replied", r.repliedAt],
        ["keywords", r.keywords], ["created", r.createdAt],
      ]),
      command: `iris leads show ${r.id}`,
    }
  if (surface === "pages")
    return {
      title: r.title,
      fields: fieldsOf([
        ["id", r.id], ["slug", r.slug], ["status", r.status], ["version", r.version],
        ["visibility", r.visibility], ["requires auth", r.requiresAuth], ["category", r.category],
        ["published", r.publishedAt], ["updated", r.updatedAt], ["url", r.url],
      ]),
      command: r.slug ? `iris pages view ${r.slug}` : undefined,
    }
  if (surface === "hive") {
    const hrs = r.uptimeSeconds != null ? Math.floor(r.uptimeSeconds / 3600) : undefined
    return {
      title: r.name,
      fields: fieldsOf([
        ["status", r.status], ["online", r.online],
        // "0/3" on the row meant active tasks over capacity and said so nowhere.
        ["running tasks", r.activeTasks], ["max concurrent", r.maxConcurrent],
        // The hardware block is a SNAPSHOT and says when it was taken. Without that, a
        // twenty-hour-old "0.1 GB free" reads as an emergency happening right now.
        ["hardware as of", r.hardwareDetectedAt ? relativeAge(r.hardwareDetectedAt) : undefined],
        ["machine", [r.cpu, r.cores ? `${r.cores} cores` : null].filter(Boolean).join(" · ")],
        ["memory", r.memoryGb ? `${r.memoryGb} GB` : undefined],
        // Disk free is here because a full disk is the failure that looks like everything else
        // breaking at once, and nothing in this fleet reported it until someone went looking.
        ["disk", r.diskTotalGb ? `${r.diskFreeGb ?? "?"} GB free of ${r.diskTotalGb} GB` : undefined],
        ["os", r.os], ["daemon", r.daemonVersion],
        ["uptime", hrs != null ? (hrs >= 1 ? `${hrs}h` : `${Math.floor((r.uptimeSeconds ?? 0) / 60)}m`) : undefined],
        // A crash-looping daemon heartbeats once per restart, so it never misses one and reads
        // as healthy. The restart count is what separates "up for hours" from "dying nightly".
        ["restarts seen", r.recentRestarts],
        ["tasks completed", r.tasksCompleted],
        ["can run", (r.capabilities ?? []).join(", ")],
        ["transport", r.transport], ["tailnet ip", r.tailscaleIp],
        ["last heartbeat", r.lastHeartbeat], ["id", r.id],
      ]),
      command: `iris hive nodes show ${r.id}`,
    }
  }
  if (surface === "playbooks")
    return {
      title: r.name,
      fields: fieldsOf([["attached to this board", r.attached], ["description", r.description]]),
      command: `iris playbook run ${r.name}`,
    }
  if (surface === "integrations")
    return {
      title: r.name,
      fields: fieldsOf([
        ["id", r.id], ["provider", r.provider], ["category", r.category],
        ["status", r.status], ["connected", r.connected], ["account", r.account],
      ]),
      command: r.provider ? `iris connect ${r.provider}` : undefined,
    }
  if (surface === "schemas")
    return {
      title: r.name,
      fields: fieldsOf([
        ["slug", r.slug], ["scope", r.scope], ["version", r.version], ["system", r.isSystem],
        ["fields", (r.fields ?? []).map((f: any) => `${f.name}:${f.type}`).join(", ")],
      ]),
      command: r.slug ? `iris atlas:datasets records list --schema ${r.slug}` : undefined,
    }
  return null
}

function renderMarkdown(md: string): string {
  try {
    return marked.parse(md, { async: false }) as string
  } catch {
    return ""
  }
}

/**
 * The board picker's chevron.
 *
 * Was the text character "⌄", which is a glyph with its own baseline and side bearings: it sat
 * low, would not align with the label, and rendered at whatever size the font felt like. This
 * is the same 16px currentColor SVG select-v2 uses for its own trigger, so the two look like
 * the same control.
 */
const ChevronDown = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" class="shrink-0">
    <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
)

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
  // Hive is NOT bloq-scoped — machines belong to the account, not to a board — so its path
  // ignores the argument. Kept in the same list anyway so the switcher stays one mechanism;
  // a second code path for one surface is how surfaces drift apart.
  { id: "hive", label: "Hive", path: (_b: number) => `/iris/hive` },
  { id: "playbooks", label: "Playbooks", path: (b: number) => `/iris/playbooks/${b}` },
  { id: "integrations", label: "Integrations", path: (_b: number) => `/iris/integrations` },
  { id: "schemas", label: "Schemas", path: (b: number) => `/iris/schemas/${b}` },
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
      return id ? ([base(), id, surface(), page()] as const) : undefined
    },
    async ([, id, which, pageNo], info): Promise<SurfacePayload> => {
      const def = SURFACES.find((s) => s.id === which)!
      const sep = def.path(id).includes("?") ? "&" : "?"
      const res = await doFetch(`${def.path(id)}${sep}page=${pageNo}&perPage=25`)
      const next = (await res.json()) as SurfacePayload

      // APPEND rather than replace when we asked for a later page of the same surface. The
      // previous value is the earlier pages; dropping it would make "Load more" a "Replace".
      // Annotated: the resource's own value type is still being inferred here, so info.value
      // lands as {} and every index below would be an implicit any.
      const prev = (info.refetching ? undefined : info.value) as SurfacePayload | undefined
      if (pageNo > 1 && prev) {
        const key = arrayKeyFor(which)
        const a = Array.isArray(prev[key]) ? (prev[key] as unknown[]) : []
        const b = Array.isArray(next[key]) ? (next[key] as unknown[]) : []
        return { ...next, [key]: [...a, ...b] } as SurfacePayload
      }
      return next
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
    const key = arrayKeyFor(surface())
    const v = d[key]
    return Array.isArray(v) ? v : []
  })

  // Loading ONLY on the first load. A refetch with a previous payload in hand is not a loading
  // state — treating it as one is what caused the flash.
  /** Anything in flight — a first load OR a refetch. The bar is the only thing that reports a
   *  refetch now that the content deliberately stays on screen through one. */
  const busy = createMemo(() => bloqs.loading || data.loading)

  const firstLoad = createMemo(() => (data.loading && !data.latest) || (bloqs.loading && !bloqs.latest))

  const view = createMemo(() =>
    surfaceView({ loading: firstLoad(), bloqs: bloqs.latest ?? bloqs(), data: current(), rows: rows() }),
  )

  const activeBloqName = createMemo(
    () => (bloqs.latest ?? bloqs())?.bloqs?.find((b) => b.id === activeBloq())?.name ?? "Select a board",
  )

  /** A non-Atlas row being inspected. Atlas has its own reader because it has a BODY; the rest
   *  are records, so they get a field list rather than prose. */
  const [openRow, setOpenRow] = createSignal<{ title: string; fields: [string, string][]; command?: string } | null>(
    null,
  )

  /** The item being read, if any. Opening one replaces the list; there is no second panel. */
  const [openItem, setOpenItem] = createSignal<AtlasItem | null>(null)

  /** Accumulated pages. Reset whenever the surface or board changes — see the effect below. */
  const [page, setPage] = createSignal(1)

  // Leaving the surface or the board must close the reader — otherwise you switch to Leads and
  // are still looking at an Atlas item.
  createEffect(() => {
    surface()
    activeBloq()
    setOpenItem(null)
    setOpenRow(null)
    // Paging resets with the thing being paged. Without this, switching surface while on page 3
    // asks the next surface for ITS page 3 and silently skips its first rows.
    setPage(1)
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
    <div class="relative flex flex-col h-full min-h-0 gap-2 px-2 pb-2">
      <Show when={busy()}>
        <div class="iris-activity" aria-hidden="true" />
      </Show>
      {/* A SEARCHABLE dialog, not a dropdown.
          This account has 153 bloqs. A plain option list is the wrong control for that at any
          styling — you cannot find "KMG — Kristen Montero" by scrolling past a hundred and
          fifty siblings. `List` is the app's filtered-list primitive and gives search for
          free; dialog-select-mcp and dialog-select-file are the same shape, so this is the
          house answer to "pick one of many" rather than a new idea. */}
      <Show when={((bloqs.latest ?? bloqs())?.bloqs?.length ?? 0) > 0}>
        <button
          type="button"
          class="flex items-center gap-1 px-2 py-1 text-12-regular text-text-base hover:bg-background-element rounded text-start min-w-0 cursor-pointer"
          onClick={() => {
            const all = (bloqs.latest ?? bloqs())?.bloqs ?? []
            dialog.show(() => (
              <Dialog title="Board" description={`${all.length} boards`}>
                <List
                  class="px-3"
                  search={{ placeholder: "Search boards or #id…", autofocus: true }}
                  emptyMessage="No boards match."
                  key={(b) => String(b?.id ?? "")}
                  items={() => all.map((b) => ({ ...b, ref: `#${b.id}` }))}
                  /* `ref` is in the filter keys so typing 674 finds the board. You refer to
                     these by number everywhere else — commits, tickets, conversation — and a
                     picker you can only search by name makes the number useless here. */
                  filterKeys={["name", "ref"]}
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
                  {(b) => (
                    <div class="w-full flex items-baseline gap-2 min-w-0">
                      <span class="truncate">{b.name}</span>
                      {/* AFTER the name, muted and mono. Leading with the number would make
                          every row start with noise and wreck scanning; trailing keeps the
                          names left-aligned and the ids in a column of their own. */}
                      <span class="ms-auto shrink-0 font-mono tabular-nums text-11-regular text-text-weaker">
                        {b.ref}
                      </span>
                    </div>
                  )}
                </List>
              </Dialog>
            ))
          }}
        >
          <span class="truncate">{activeBloqName()}</span>
          <span class="text-text-weak flex items-center shrink-0">
            <ChevronDown />
          </span>
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

      {/* THE RECORD PANEL — for the surfaces whose rows are records rather than prose.
          Every field, plus the command that does something with it. The command is selectable
          and copies on click, because "what do I type to act on this" was the actual question
          behind "nothing happens when I click it". */}
      <Show when={openRow()}>
        <div class="flex-1 min-h-0 flex flex-col">
          <button
            type="button"
            class="flex items-center gap-1 px-2 py-1 text-11-regular text-text-weak hover:text-text-base shrink-0 text-start cursor-pointer"
            onClick={() => setOpenRow(null)}
          >
            ← Back
          </button>
          <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-4">
            <h3 class="text-13-medium text-text-strong pb-2">{openRow()!.title}</h3>
            <Show when={openRow()!.command}>
              <button
                type="button"
                class="w-full text-start font-mono text-11-regular px-2 py-1.5 mb-3 rounded bg-background-element text-text-base cursor-pointer hover:text-text-strong"
                title="Click to copy"
                onClick={() => navigator.clipboard?.writeText(openRow()!.command!)}
              >
                {openRow()!.command}
              </button>
            </Show>
            <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <For each={openRow()!.fields}>
                {([k, v]) => (
                  <>
                    <dt class="text-11-regular text-text-weaker">{k}</dt>
                    <dd class="text-12-regular text-text-base min-w-0 break-words">{v}</dd>
                  </>
                )}
              </For>
            </dl>
          </div>
        </div>
      </Show>

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
          {/* A BREADCRUMB, not a title. Atlas bodies almost always open with their own "# H1",
              so printing the item title here too rendered it twice at the same size — which is
              exactly the flat hierarchy that made these unreadable. The markdown's H1 is the
              title; this row is just where you are and what to quote. */}
          <div class="flex items-baseline gap-2 px-2 pb-1">
            <span class="text-11-regular text-text-weaker min-w-0 truncate">{openItem()!.title}</span>
            <span class="ms-auto shrink-0 font-mono tabular-nums text-11-regular text-text-weaker">
              #{openItem()!.id}
            </span>
          </div>
          <div
            class="iris-markdown flex-1 min-h-0 overflow-y-auto px-2 pb-4 text-12-regular text-text-base"
            /* The body is the signed-in user's own Atlas content, fetched through their own
               sidecar — not third-party input. marked does not sanitise, so this would need a
               sanitiser the moment this panel renders anything someone else authored. */
            innerHTML={renderMarkdown(openItem()!.content ?? "")}
          />
        </div>
      </Show>

      <div class="flex-1 min-h-0 overflow-y-auto" classList={{ hidden: !!openItem() || !!openRow() }}>
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
                            <span class="text-12-regular text-text-muted min-w-0 flex-1">{item.title}</span>
                            <span class="shrink-0 font-mono tabular-nums text-11-regular text-text-weaker">
                              #{item.id}
                            </span>
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
                    <button type="button" class="w-full text-start flex items-baseline gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow(surface(), a))}>
                      <span class="shrink-0" classList={{ "text-text-base": a.status === "healthy", "text-text-weak": a.status !== "healthy" }}>
                        ●
                      </span>
                      <span class="text-12-regular text-text-base min-w-0 flex-1">{a.name}</span>
                      <span class="font-mono tabular-nums text-11-regular text-text-weak shrink-0">
                        {a.heartbeat ? (a.schedule ?? "heartbeat") : "on demand"}
                      </span>
                    </button>
                  )}
                </For>
              </Match>

              <Match when={surface() === "leads"}>
                <For each={rows()}>
                  {(l) => (
                    <button type="button" class="w-full text-start flex items-baseline gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow(surface(), l))}>
                      <span class="shrink-0">{l.hot ? "🔥" : "·"}</span>
                      <span class="text-12-regular text-text-base min-w-0 flex-1">{l.name}</span>
                      <Show when={l.status}>
                        <span class="font-mono tabular-nums text-11-regular text-text-weak shrink-0">{l.status}</span>
                      </Show>
                    </button>
                  )}
                </For>
              </Match>

              <Match when={surface() === "hive"}>
                <For each={rows()}>
                  {(n) => (
                    <button type="button" class="w-full text-start flex items-baseline gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow(surface(), n))}>
                      <span
                        class="shrink-0"
                        classList={{ "text-text-base": n.online, "text-text-weak": !n.online }}
                      >
                        {n.online ? "●" : "○"}
                      </span>
                      <span class="text-12-regular text-text-base min-w-0 flex-1">{n.name}</span>
                      <span class="font-mono tabular-nums text-11-regular text-text-weaker shrink-0">
                        {n.activeTasks}/{n.maxConcurrent}
                      </span>
                    </button>
                  )}
                </For>
              </Match>

              <Match when={surface() === "playbooks"}>
                <For each={rows()}>
                  {(pb) => (
                    <button type="button" class="w-full text-start px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow(surface(), pb))}>
                      <div class="flex items-baseline gap-2">
                        <span class="shrink-0" classList={{ "text-text-base": pb.attached, "text-text-weaker": !pb.attached }}>
                          {pb.attached ? "★" : "·"}
                        </span>
                        <span class="text-12-regular text-text-base min-w-0 flex-1">{pb.name}</span>
                        <Show when={pb.attached}>
                          <span class="font-mono text-11-regular text-text-weaker shrink-0">this board</span>
                        </Show>
                      </div>
                      <Show when={pb.description}>
                        <p class="text-11-regular text-text-weak ps-4 pt-0.5 line-clamp-2">{pb.description}</p>
                      </Show>
                    </button>
                  )}
                </For>
              </Match>

              <Match when={surface() === "integrations"}>
                <For each={rows()}>
                  {(i) => (
                    <button type="button" class="w-full text-start flex items-baseline gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow(surface(), i))}>
                      <span class="shrink-0" classList={{ "text-text-base": i.connected, "text-text-weak": !i.connected }}>
                        {i.connected ? "●" : "○"}
                      </span>
                      <span class="text-12-regular text-text-base min-w-0 flex-1">{i.name}</span>
                      <span class="font-mono text-11-regular text-text-weaker shrink-0">
                        {i.account || i.category || i.status}
                      </span>
                    </button>
                  )}
                </For>
              </Match>

              <Match when={surface() === "schemas"}>
                <For each={rows()}>
                  {(sc) => (
                    <button type="button" class="w-full text-start px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow(surface(), sc))}>
                      <div class="flex items-baseline gap-2">
                        <span class="text-12-regular text-text-base min-w-0 flex-1">{sc.name}</span>
                        {/* Scope is shown because 40 of these belong to the account, not the
                            board — hiding that would put account-wide schemas under a board
                            heading, which is the Pages bug again. */}
                        <span class="font-mono text-11-regular text-text-weaker shrink-0">
                          {sc.scope === "account" ? "account" : "board"} · {sc.fields.length}f
                        </span>
                      </div>
                      <Show when={sc.fields.length}>
                        <p class="font-mono text-11-regular text-text-weak ps-2 pt-0.5 truncate">
                          {sc.fields.map((f: any) => f.name).join(" · ")}
                        </p>
                      </Show>
                    </button>
                  )}
                </For>
              </Match>

              <Match when={surface() === "pages"}>
                <For each={rows()}>
                  {(pg) => (
                    <button type="button" class="w-full text-start flex items-baseline gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow(surface(), pg))}>
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
                    </button>
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

        {/* The shared footer. Says how many of how many, and offers the next page only when the
            server said there is one — never as a permanent button that sometimes does nothing. */}
        <Show when={view() === "rows"}>
          <div class="flex items-center gap-2 px-2 py-2 text-11-regular text-text-weaker">
            <Show when={pageSummary({ shown: rows().length, env: current() as PageEnvelope | undefined })}>
              {(text) => <span class="font-mono tabular-nums">{text()}</span>}
            </Show>
            <Show when={(current() as PageEnvelope | undefined)?.hasMore}>
              <button
                type="button"
                class="ms-auto px-2 py-0.5 rounded cursor-pointer text-text-weak hover:text-text-base hover:bg-background-element"
                disabled={data.loading}
                onClick={() => setPage((p) => p + 1)}
              >
                {data.loading ? "Loading…" : "Load more"}
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
