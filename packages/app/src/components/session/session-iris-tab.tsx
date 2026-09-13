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
/**
 * Which array key a PANE's response uses. One mapping, used by both the reader and paging.
 *
 * Keyed on the pane rather than the top-level surface because two panes now live under one
 * surface — Atlas holds Lists and Schemas, Hive holds Machines and Inbox — and those return
 * `lists`, `schemas`, `nodes` and `items` respectively. Keying this on the surface would have
 * read `d["atlas"]` for the schemas pane and found nothing, which renders as an empty board.
 */
function arrayKeyFor(pane: string): string {
  if (pane === "atlas") return "lists"
  if (pane === "hive") return "nodes"
  if (pane === "inbox") return "items"
  return pane
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

function describeRow(
  surface: string,
  r: any,
): { title: string; fields: [string, string][]; command?: string; raw?: any; pane?: string } | null {
  const out = describeFields(surface, r)
  return out ? { ...out, raw: r, pane: surface } : null
}

function describeFields(surface: string, r: any): { title: string; fields: [string, string][]; command?: string } | null {
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
  if (surface === "inbox")
    return {
      title: r.label,
      fields: fieldsOf([
        ["from", r.from], ["type", r.type], ["read", r.read],
        ["received", r.receivedAt ? relativeAge(r.receivedAt) : undefined],
        ["manifest position", r.index],
      ]),
      // `index` is the MANIFEST position, not the position in the list above — the list is
      // sorted unread-first, so the two differ the moment anything has been read. This command
      // takes the manifest number, so printing the row's position would open a different message.
      command: `iris hive inbox read ${r.index}`,
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
        ["display field", r.displayField],
        ["fields", (r.fields ?? []).map((f: any) => `${f.key}:${f.type}`).join(", ")],
        // Said out loud rather than left to the column list: some of these datasets carry PHI,
        // and which ones is not something to make someone infer.
        ["phi fields", (r.fields ?? []).filter((f: any) => f.visibility === "phi").map((f: any) => f.key).join(", ")],
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
 * A MAP of surface -> sub-view, not a single value.
 *
 * Elon's console keeps one scalar for the section it is on and resets it on every reload, and
 * the consequence is the thing people complain about most: you are looking at Hive › Inbox,
 * you check a machine under Atlas, you come back, and you are on Machines again. Storing the
 * choice per surface makes each surface remember where you were in it, which is what you
 * expect from a tab you left open.
 */
const LAST_SUBVIEW_KEY = "iris.panel.subviews"

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
] as const

type SurfaceId = (typeof SURFACES)[number]["id"]

interface SubView {
  id: string
  label: string
  /** Which renderer draws it, and therefore which array key its payload uses. */
  pane: string
  path: (bloqID: number) => string
}

/**
 * LEVEL TWO. Schemas used to be a ninth top-level tab; it is a way of looking at Atlas.
 *
 * Two rules, both learned from Elon's console rather than invented here:
 *
 * 1. A sub-view is a DIFFERENT ENDPOINT, never a filter applied to rows already on screen.
 *    Filtering a page client-side leaves the footer counting the unfiltered set, so "12 of 40"
 *    sits under nine rows and describes something else. Where a narrower view was wanted and no
 *    endpoint existed — Agents by schedule — the narrowing was added to the server instead, in
 *    front of the paging, so `total` stays a true statement about what you are looking at.
 *
 * 2. Level two does NOT get a second plate. Elon draws the mode switcher as a filled segmented
 *    control and the section switcher as a rule underneath, and that difference is the only
 *    thing telling you which of the two you are about to change. Two identical-looking strips
 *    stacked is a menu with no hierarchy in it.
 *
 * Deliberately NOT copied from Elon: its `badge: count > 0 ? count : null`, which renders zero,
 * unknown and errored as the same blank tab.
 */
const SUBVIEWS: Partial<Record<SurfaceId, readonly SubView[]>> = {
  atlas: [
    { id: "lists", label: "Lists", pane: "atlas", path: (b) => `/iris/atlas/${b}` },
    { id: "schemas", label: "Schemas", pane: "schemas", path: (b) => `/iris/schemas/${b}` },
  ],
  agents: [
    { id: "all", label: "All", pane: "agents", path: (b) => `/iris/agents/${b}` },
    { id: "scheduled", label: "Scheduled", pane: "agents", path: (b) => `/iris/agents/${b}?mode=scheduled` },
    { id: "ondemand", label: "On demand", pane: "agents", path: (b) => `/iris/agents/${b}?mode=ondemand` },
  ],
  hive: [
    { id: "machines", label: "Machines", pane: "hive", path: () => `/iris/hive` },
    // The inbox was the original ask — "I want to see the inbox and all of the other machines
    // on the network in this tab". It belongs under Hive, not beside it: it is Hive traffic.
    { id: "inbox", label: "Inbox", pane: "inbox", path: () => `/iris/inbox` },
  ],
}

/**
 * LEVEL THREE — the tabs INSIDE a record.
 *
 * Every one of these records is three things at once and the panel only ever showed the first:
 * a set of readable facts, the raw thing underneath, and — for the ones that are published or
 * queryable — the actual content. A page has a live URL nobody could see from here; a schema
 * has 7,964 rows nobody could see from here.
 *
 * `info` is always present and always first, so a detail never opens on a tab that turns out to
 * be empty. The rest are declared per pane rather than probed, because "does this record have a
 * preview" is a fact about the KIND of record, not about the instance.
 */
export interface DetailTab {
  id: string
  label: string
}
const DETAIL_TABS: Record<string, readonly DetailTab[]> = {
  schemas: [
    { id: "info", label: "Info" },
    // The database table. This is the one that turns a schema from a description of data into
    // the data.
    { id: "records", label: "Records" },
    { id: "json", label: "JSON" },
  ],
  pages: [
    { id: "info", label: "Info" },
    { id: "preview", label: "Preview" },
    { id: "json", label: "JSON" },
  ],
  agents: [
    { id: "info", label: "Info" },
    { id: "json", label: "JSON" },
  ],
  integrations: [
    { id: "info", label: "Info" },
    { id: "json", label: "JSON" },
  ],
}
const DEFAULT_DETAIL_TABS: readonly DetailTab[] = [{ id: "info", label: "Info" }]

export function detailTabsFor(pane: string): readonly DetailTab[] {
  return DETAIL_TABS[pane] ?? DEFAULT_DETAIL_TABS
}

/** A cell value, rendered so an empty one is visibly empty rather than the string "undefined". */
export function cellText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—"
  if (typeof v === "boolean") return v ? "yes" : "no"
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

/** A persisted surface from an older build must not render a blank panel. */
export function normalizeSurface(value: unknown): SurfaceId {
  return SURFACES.some((s) => s.id === value) ? (value as SurfaceId) : "atlas"
}

/**
 * Level one plus level two -> the endpoint AND the renderer, resolved together.
 *
 * One resolver rather than two lookups, because the failure mode of two is that they disagree:
 * fetch `/iris/schemas/674` and draw it with the Atlas renderer and you get an empty panel over
 * a full response. An unknown or missing sub-view falls back to the first, so a value persisted
 * by an older build cannot strand anyone on a blank pane.
 */
export function resolvePane(
  surface: SurfaceId,
  sub: string | undefined,
): { sub?: SubView; pane: string; path: (b: number) => string } {
  const list = SUBVIEWS[surface]
  if (list?.length) {
    const chosen = list.find((s) => s.id === sub) ?? list[0]
    return { sub: chosen, pane: chosen.pane, path: chosen.path }
  }
  return { pane: surface, path: SURFACES.find((s) => s.id === surface)!.path }
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
  /** Which pane the held payload was fetched for, and which pane is on screen. */
  dataPane?: string
  pane?: string
}): "loading" | "unreachable" | "surface-error" | "rows" | "empty" {
  if (input.loading) return "loading"
  if (input.bloqs && !input.bloqs.measured) return "unreachable"
  /*
   * A payload from the PREVIOUS pane is not an answer about this one.
   *
   * `data.latest` deliberately holds the old payload through a refetch so the panel does not
   * blink through nothing. That is right when both panes name their rows the same way, and
   * actively wrong when they do not: switching Hive › Machines to Hive › Inbox left the
   * machines payload in hand, which has no `items` key, so the panel rendered "Nothing in
   * Hive › Inbox" — a confident false statement about data it had not looked at yet. Worse
   * than the blank it replaced, because a blank does not claim anything.
   */
  if (input.pane && input.dataPane && input.dataPane !== input.pane) return "loading"
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

  // Remembered PER SURFACE — see LAST_SUBVIEW_KEY. A malformed or missing entry is not an
  // error worth surfacing; resolvePane falls back to the first sub-view of whatever you open.
  const [subviews, setSubviews] = createSignal<Record<string, string>>(
    (() => {
      try {
        const raw = JSON.parse(localStorage.getItem(LAST_SUBVIEW_KEY) ?? "{}")
        return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string>) : {}
      } catch {
        return {}
      }
    })(),
  )

  const resolved = createMemo(() => resolvePane(surface(), subviews()[surface()]))
  /** Which renderer draws the rows, and which array key they arrive under. */
  const pane = createMemo(() => resolved().pane)

  const [data] = createResource(
    () => {
      const id = activeBloq()
      // The sub-view is IN the key. Without it, switching Atlas › Lists to Atlas › Schemas
      // changes nothing the resource can see and the old rows stay on screen under the new tab.
      return id ? ([base(), id, surface(), resolved().sub?.id ?? "", page()] as const) : undefined
    },
    async ([, id, , , pageNo], info): Promise<SurfacePayload> => {
      const { pane: which, path } = resolved()
      const url = path(id)
      const sep = url.includes("?") ? "&" : "?"
      const res = await doFetch(`${url}${sep}page=${pageNo}&perPage=25`)
      // Stamped with the pane it was fetched FOR, so a held payload can be told apart from an
      // answer about what is currently on screen. See surfaceView.
      const next = { ...((await res.json()) as SurfacePayload), __pane: which } as SurfacePayload

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

  /** The rows of whichever pane is active — every response names its own array. */
  const rows = createMemo<any[]>(() => {
    const d = current()
    if (!d) return []
    // Never read rows out of another pane's payload — the keys differ and the answer is empty.
    if (d["__pane"] && d["__pane"] !== pane()) return []
    const key = arrayKeyFor(pane())
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
    surfaceView({
      loading: firstLoad(),
      bloqs: bloqs.latest ?? bloqs(),
      data: current(),
      rows: rows(),
      dataPane: current()?.["__pane"] as string | undefined,
      pane: pane(),
    }),
  )

  const activeBloqName = createMemo(
    () => (bloqs.latest ?? bloqs())?.bloqs?.find((b) => b.id === activeBloq())?.name ?? "Select a board",
  )

  /** A non-Atlas row being inspected. Atlas has its own reader because it has a BODY; the rest
   *  are records, so they get a field list rather than prose. */
  const [openRow, setOpenRow] = createSignal<{
    title: string
    fields: [string, string][]
    command?: string
    /** The raw record — JSON, Preview and Records all read it rather than the flattened fields. */
    raw?: any
    /** Which pane it came from, which is what decides its detail tabs. */
    pane?: string
  } | null>(null)

  const [detailTab, setDetailTab] = createSignal("info")
  const detailTabs = createMemo(() => detailTabsFor(openRow()?.pane ?? ""))

  // A record always opens on Info. Carrying the previous record's tab over lands you on
  // "Records" for a page that has none, which renders as a broken detail rather than a choice.
  createEffect(() => {
    openRow()
    setDetailTab("info")
  })

  /**
   * The records table for the open schema.
   *
   * Its own resource and its own page cursor: this is a second, independent list living inside
   * a row of the first, and sharing the outer `page` signal would make "next page of records"
   * also ask for the next page of schemas.
   */
  const [recordPage, setRecordPage] = createSignal(1)
  createEffect(() => {
    openRow()
    setRecordPage(1)
  })
  const [records] = createResource(
    () => {
      const r = openRow()
      const slug = r?.raw?.slug
      return r?.pane === "schemas" && detailTab() === "records" && slug
        ? ([base(), String(slug), recordPage()] as const)
        : undefined
    },
    async ([, slug, pageNo]) => {
      const res = await doFetch(`/iris/records/${encodeURIComponent(slug)}?page=${pageNo}&perPage=25`)
      return (await res.json()) as Measured & {
        columns: { key: string; label: string; type: string; visibility?: string }[]
        rows: { id: number; data: Record<string, unknown>; updatedAt?: string }[]
        total: number | null
        totalIsExact: boolean
        hasMore: boolean
      }
    },
  )

  /** The item being read, if any. Opening one replaces the list; there is no second panel. */
  const [openItem, setOpenItem] = createSignal<AtlasItem | null>(null)

  /** Accumulated pages. Reset whenever the surface or board changes — see the effect below. */
  const [page, setPage] = createSignal(1)

  // Leaving the surface or the board must close the reader — otherwise you switch to Leads and
  // are still looking at an Atlas item.
  createEffect(() => {
    surface()
    // The sub-view too: Hive › Machines to Hive › Inbox is as much a change of subject as
    // Hive to Atlas is, and leaving a machine's detail panel open over the inbox is nonsense.
    resolved().sub?.id
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

  function chooseSub(id: string) {
    const next = { ...subviews(), [surface()]: id }
    setSubviews(next)
    try {
      localStorage.setItem(LAST_SUBVIEW_KEY, JSON.stringify(next))
    } catch {}
  }

  /**
   * What to call the thing on screen, in a sentence.
   *
   * Also the place the scoping gets told the truth: Hive machines and Integrations belong to the
   * ACCOUNT, and the empty state said "Nothing in hive on this board" about both of them — a
   * sentence that describes a filter which does not exist.
   */
  const paneLabel = createMemo(() => {
    const s = SURFACES.find((x) => x.id === surface())!
    const sv = resolved().sub
    return sv ? `${s.label} › ${sv.label}` : s.label
  })
  const boardScoped = createMemo(() => surface() !== "hive" && surface() !== "integrations")

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

      {/* LEVEL 2 — a rule underneath, deliberately NOT a second plate.
          The filled segmented control above says "which product surface"; this says "which way
          of looking at it". Drawn the same way, the two strips read as one eight-item menu that
          happens to wrap, and nothing tells you that picking from the lower one keeps you where
          you are. Rendered only where a surface has sub-views, so the panel does not grow a
          permanent empty row. */}
      <Show when={SUBVIEWS[surface()]}>
        {(list) => (
          <div class="iris-subnav shrink-0" role="tablist" aria-label={`${paneLabel()} views`}>
            <For each={list()}>
              {(sv) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={resolved().sub?.id === sv.id}
                  class="iris-subnav__item"
                  classList={{ "iris-subnav__item--active": resolved().sub?.id === sv.id }}
                  onClick={() => chooseSub(sv.id)}
                >
                  {sv.label}
                </button>
              )}
            </For>
          </div>
        )}
      </Show>

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
          <h3 class="text-13-medium text-text-strong px-2 pb-1.5 shrink-0">{openRow()!.title}</h3>

          {/* LEVEL 3 — chips, because levels 1 and 2 are already a plate and a rule, and a
              third thing drawn like either of them stops the stack reading as a hierarchy.
              Rendered only when there is more than one, so a record with nothing but Info does
              not grow a decorative single-tab row. */}
          <Show when={detailTabs().length > 1}>
            <div class="iris-detailnav shrink-0" role="tablist" aria-label={`${openRow()!.title} views`}>
              <For each={detailTabs()}>
                {(t) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={detailTab() === t.id}
                    class="iris-detailnav__item"
                    classList={{ "iris-detailnav__item--active": detailTab() === t.id }}
                    onClick={() => setDetailTab(t.id)}
                  >
                    {t.label}
                  </button>
                )}
              </For>
            </div>
          </Show>

          <div class="flex-1 min-h-0 overflow-auto px-2 pb-4">
            <Switch>
              <Match when={detailTab() === "info"}>
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
              </Match>

              {/* The raw record. What the info tab flattens, in the shape the API actually
                  returned — the thing you need when a field is missing and you want to know
                  whether the server omitted it or this panel dropped it. */}
              <Match when={detailTab() === "json"}>
                <button
                  type="button"
                  class="mb-2 px-2 py-0.5 rounded text-11-regular text-text-weak hover:text-text-base hover:bg-background-element cursor-pointer"
                  onClick={() => navigator.clipboard?.writeText(JSON.stringify(openRow()!.raw, null, 2))}
                >
                  Copy JSON
                </button>
                <pre class="iris-json text-11-regular">{JSON.stringify(openRow()!.raw, null, 2)}</pre>
              </Match>

              {/* The page itself. An unpublished page has no URL to show, and saying so beats
                  an iframe pointed at nothing. */}
              <Match when={detailTab() === "preview"}>
                <Show
                  when={openRow()!.raw?.url}
                  fallback={
                    <p class="text-12-regular text-text-weak py-2">
                      No public URL yet — this page is {openRow()!.raw?.status ?? "unpublished"}.
                    </p>
                  }
                >
                  <div class="flex items-baseline gap-2 pb-2">
                    <a
                      href={openRow()!.raw.url}
                      target="_blank"
                      rel="noreferrer"
                      class="text-11-regular text-text-interactive-base hover:underline truncate"
                    >
                      {openRow()!.raw.url}
                    </a>
                  </div>
                  <iframe
                    src={openRow()!.raw.url}
                    class="iris-preview"
                    title={openRow()!.title}
                    sandbox="allow-scripts allow-same-origin"
                  />
                </Show>
              </Match>

              {/* THE TABLE. Columns from the schema, rows from the dataset, paged upstream. */}
              <Match when={detailTab() === "records"}>
                <Switch>
                  <Match when={records.loading && !records.latest}>
                    <p class="text-12-regular text-text-weak py-2">Loading records…</p>
                  </Match>
                  <Match when={records.latest && !records.latest!.measured}>
                    <p class="text-12-regular text-text-weak py-2">
                      Could not load records — {records.latest!.reason ?? "unknown"}.
                    </p>
                  </Match>
                  <Match when={(records.latest?.rows?.length ?? 0) === 0}>
                    <p class="text-12-regular text-text-weak py-2">This dataset has no records.</p>
                  </Match>
                  <Match when={records.latest}>
                    <div class="iris-table-wrap">
                      <table class="iris-table">
                        <thead>
                          <tr>
                            <th class="iris-table__num">id</th>
                            <For each={records.latest!.columns}>
                              {(c) => (
                                <th title={`${c.key} · ${c.type}`}>
                                  {c.label}
                                  {/* PHI is named on the column, not left to be inferred from
                                      the content. */}
                                  <Show when={c.visibility === "phi"}>
                                    <span class="iris-table__phi">phi</span>
                                  </Show>
                                </th>
                              )}
                            </For>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={records.latest!.rows}>
                            {(r) => (
                              <tr>
                                <td class="iris-table__num">{r.id}</td>
                                <For each={records.latest!.columns}>
                                  {(c) => (
                                    <td
                                      class="iris-table__cell"
                                      classList={{ "iris-table__num": c.type === "number" || c.type === "integer" }}
                                      title={cellText(r.data[c.key])}
                                    >
                                      {cellText(r.data[c.key])}
                                    </td>
                                  )}
                                </For>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                    <div class="flex items-center gap-2 py-2 text-11-regular text-text-weaker">
                      <span class="font-mono tabular-nums">
                        {pageSummary({
                          shown: (recordPage() - 1) * 25 + records.latest!.rows.length,
                          env: records.latest as unknown as PageEnvelope,
                        })}
                      </span>
                      <Show when={records.latest!.hasMore}>
                        <button
                          type="button"
                          class="ms-auto px-2 py-0.5 rounded cursor-pointer text-text-weak hover:text-text-base hover:bg-background-element"
                          disabled={records.loading}
                          onClick={() => setRecordPage((n) => n + 1)}
                        >
                          {records.loading ? "Loading…" : "Next page"}
                        </button>
                      </Show>
                    </div>
                  </Match>
                </Switch>
              </Match>
            </Switch>
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
            <p class="px-2 py-2 text-12-regular text-text-weak">Could not load {paneLabel()} — {current()?.reason ?? "unknown"}.</p>
          </Match>

          <Match when={view() === "rows"}>
            <Show when={current()?.measured && current()?.reason}>
              <p class="px-2 pb-2 text-12-regular text-text-weak">{current()!.reason}</p>
            </Show>

            <Switch>
              <Match when={pane() === "atlas"}>
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

              <Match when={pane() === "agents"}>
                <For each={rows()}>
                  {(a) => (
                    <button type="button" class="w-full text-start flex items-baseline gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow(pane(), a))}>
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

              <Match when={pane() === "leads"}>
                <For each={rows()}>
                  {(l) => (
                    <button type="button" class="w-full text-start flex items-baseline gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow(pane(), l))}>
                      <span class="shrink-0">{l.hot ? "🔥" : "·"}</span>
                      <span class="text-12-regular text-text-base min-w-0 flex-1">{l.name}</span>
                      <Show when={l.status}>
                        <span class="font-mono tabular-nums text-11-regular text-text-weak shrink-0">{l.status}</span>
                      </Show>
                    </button>
                  )}
                </For>
              </Match>

              <Match when={pane() === "hive"}>
                <For each={rows()}>
                  {(n) => (
                    <button type="button" class="w-full text-start flex items-baseline gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow(pane(), n))}>
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

              <Match when={pane() === "inbox"}>
                <For each={rows()}>
                  {(m) => (
                    <button type="button" class="w-full text-start px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow("inbox", m))}>
                      <div class="flex items-baseline gap-2">
                        {/* Filled means UNREAD — the one thing you are scanning this list for. */}
                        <span class="shrink-0" classList={{ "text-text-base": !m.read, "text-text-weaker": m.read }}>
                          {m.read ? "○" : "●"}
                        </span>
                        <span
                          class="text-12-regular min-w-0 flex-1 truncate"
                          classList={{ "text-text-strong": !m.read, "text-text-weak": m.read }}
                        >
                          {m.label}
                        </span>
                        {/* The manifest number, shown because it is the argument you need to
                            read the thing — and because it is NOT the row's position here. */}
                        <span class="shrink-0 font-mono tabular-nums text-11-regular text-text-weaker">{m.index}</span>
                      </div>
                      <p class="text-11-regular text-text-weaker ps-4 pt-0.5 truncate">
                        {m.from}
                        {m.receivedAt ? ` · ${relativeAge(m.receivedAt)}` : ""}
                        {m.type && m.type !== "file" ? ` · ${m.type}` : ""}
                      </p>
                    </button>
                  )}
                </For>
              </Match>

              <Match when={pane() === "playbooks"}>
                <For each={rows()}>
                  {(pb) => (
                    <button type="button" class="w-full text-start px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow(pane(), pb))}>
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

              <Match when={pane() === "integrations"}>
                <For each={rows()}>
                  {(i) => (
                    <button type="button" class="w-full text-start flex items-baseline gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow(pane(), i))}>
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

              <Match when={pane() === "schemas"}>
                <For each={rows()}>
                  {(sc) => (
                    <button type="button" class="w-full text-start px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow(pane(), sc))}>
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

              <Match when={pane() === "pages"}>
                <For each={rows()}>
                  {(pg) => (
                    <button type="button" class="w-full text-start flex items-baseline gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow(pane(), pg))}>
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
            <p class="px-2 py-2 text-12-regular text-text-weak">
              Nothing in {paneLabel()}{boardScoped() ? " on this board" : ""}.
            </p>
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
