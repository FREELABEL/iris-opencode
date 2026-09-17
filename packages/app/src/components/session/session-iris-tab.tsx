import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import "./session-iris-tab.css"
import { pageSummary, type PageEnvelope } from "./use-paged-surface"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { SegmentedControlV2, SegmentedControlItemV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { IrisForceGraph, type ForceEdge, type ForceNode } from "./iris-force-graph"
import { graphBoardIsIsolated, scopeGraphRows, type GraphScope } from "./iris-graph-scope"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { IrisCardEditor } from "./iris-card-editor"
import { itemCommands, renderMarkdown } from "./iris-item"

// Re-exported: the panel tests assert on these, and they were defined here before the card
// editor needed them too.
export { itemCommands, renderMarkdown }

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
  if (pane === "graph") return "rows"
  if (pane === "catalog") return "catalog"
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
  if (surface === "sites")
    return {
      title: r.name,
      fields: fieldsOf([
        ["id", r.id], ["slug", r.slug], ["status", r.status],
        ["pages", r.pagesCount], ["home page", r.homePageId],
        ["owner", r.owner], ["requires auth", r.requiresAuth],
        ["description", r.description], ["updated", r.updatedAt],
      ]),
      command: r.slug ? `iris pages sites show ${r.slug}` : undefined,
    }
  if (surface === "catalog")
    return {
      title: r.name,
      fields: fieldsOf([
        ["type", r.type], ["category", r.category],
        // The MODE is the thing worth knowing before you start: these are not the same job.
        ["connect by", r.mode], ["opens a browser", r.oauthRequired],
        ["functions", r.functionsCount], ["about", r.description],
      ]),
      command: r.command,
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
      fields: fieldsOf([
        ["attached to this board", r.attached],
        ["scope", r.scope], ["access", r.accessType], ["version", r.version],
        ["active", r.active],
        ["steps", (r.steps ?? []).length || undefined],
        ["arguments", (r.args ?? []).length || undefined],
        ["installed here", r.hasLocal],
        ["installs", r.installs], ["views", r.views],
        ["published", r.publishedAt], ["landing page", r.publicUrl],
        ["description", r.description],
      ]),
      command: `iris playbook run ${r.name}`,
    }
  if (surface === "integrations")
    return {
      title: r.name,
      fields: fieldsOf([
        ["id", r.id], ["provider", r.provider], ["type", r.type], ["category", r.category],
        ["scope", r.scope], ["brand", r.brandId], ["auth", r.authMode],
        ["your connection", r.status], ["connected", r.connected],
        // TWO DIFFERENT QUESTIONS, said separately. "Is the provider up" and "does your
        // credential work" get confused constantly, and the confusion always resolves in the
        // reassuring direction — people read an operational provider as a working connection.
        ["provider status", r.health?.state],
        ["provider checked", r.health?.lastVerifiedAt ? relativeAge(r.health.lastVerifiedAt) : undefined],
        ["checked by", r.health?.basis],
        ["account", r.account],
        ["last tested", r.lastTested ? relativeAge(r.lastTested) : undefined],
        // An untested credential's `status` is a claim, not a measurement. Worth saying.
        ["never tested", r.needsTesting === true ? "yes — status is unverified" : undefined],
        ["functions", r.functionsCount],
        ["usage (30d)", r.usage?.band],
        ["last error", r.lastError],
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


/**
 * JSON with the TYPE carried in the colour.
 *
 * Unlike the markdown reader — which deliberately spends one accent on links, because five hues
 * in a paragraph taught the reader nothing — hue here IS information: it says what kind of value
 * you are looking at. Still drawn from the existing token ramp rather than a new palette.
 *
 * Escaped before it is marked up. This renders a record fetched through the user's own sidecar,
 * but a title or description containing "<script>" would otherwise execute, and the raw view is
 * exactly where hostile-looking content ends up being inspected.
 */
export function highlightJson(value: unknown): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  let json: string
  try {
    json = JSON.stringify(value, null, 2) ?? "null"
  } catch {
    return ""
  }
  return esc(json).replace(
    // A string (key or value), then the other literals. Key vs value is decided by the colon.
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (m) => {
      let cls = "iris-json__num"
      if (m.startsWith('"')) cls = m.trimEnd().endsWith(":") ? "iris-json__key" : "iris-json__str"
      else if (m === "true" || m === "false") cls = "iris-json__bool"
      else if (m === "null") cls = "iris-json__null"
      return `<span class="${cls}">${m}</span>`
    },
  )
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
 * WHOSE graph you are looking at.
 *
 * The graph endpoint is account-wide — `/user/{id}/bloqs/graph`, every board you own — so it
 * drew the same picture no matter which board was selected. Everything else in this panel is
 * scoped to the board in the picker; the graph silently was not, which makes the board picker
 * look broken on this one pane.
 */
const GRAPH_SCOPE_KEY = "iris.panel.graphScope"

const GRAPH_SCOPES = [
  // Default. The reason the pane exists is "what does THIS project touch".
  { id: "project", label: "Project", hint: "this board and what it links to" },
  { id: "connected", label: "Connected", hint: "everything reachable from this board" },
  { id: "full", label: "Full atlas", hint: "every board in the account" },
] as const

function normalizeGraphScope(v: unknown): GraphScope {
  return GRAPH_SCOPES.some((g) => g.id === v) ? (v as GraphScope) : "project"
}

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
  /*
   * GENESIS, not "Pages".
   *
   * The surface holds pages AND sites, and a site is not a page — it groups them under shared
   * navigation and owns settings, a form inbox and a comms thread. Labelling the pair after one
   * of its halves made the other half look like a sub-kind of the first.
   *
   * The ID stays `pages`. It is the localStorage key and the route segment; renaming it would
   * strand everyone whose panel remembers the old value for the sake of a word on screen.
   */
  { id: "pages", label: "Genesis", path: (b: number) => `/iris/pages/${b}` },
  // Hive is NOT bloq-scoped — machines belong to the account, not to a board — so its path
  // ignores the argument. Kept in the same list anyway so the switcher stays one mechanism;
  // a second code path for one surface is how surfaces drift apart.
  { id: "hive", label: "Hive", path: (_b: number) => `/iris/hive` },
  { id: "playbooks", label: "Playbooks", path: (b: number) => `/iris/playbooks/${b}` },
  { id: "integrations", label: "Integrations", path: (b: number) => `/iris/integrations/${b}` },
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
    // Board-to-board relations. Account-wide rather than this board, which the empty state
    // says out loud so it is not read as "this board has no relations".
    { id: "graph", label: "Graph", pane: "graph", path: () => `/iris/graph` },
  ],
  agents: [
    { id: "all", label: "All", pane: "agents", path: (b) => `/iris/agents/${b}` },
    { id: "scheduled", label: "Scheduled", pane: "agents", path: (b) => `/iris/agents/${b}?mode=scheduled` },
    { id: "ondemand", label: "On demand", pane: "agents", path: (b) => `/iris/agents/${b}?mode=ondemand` },
  ],
  pages: [
    { id: "pages", label: "Pages", pane: "pages", path: (b) => `/iris/pages/${b}` },
    // A SITE IS NOT A PAGE. It groups pages under shared navigation and owns settings, a
    // contact-form inbox and a comms thread that a page does not have at all. Showing only
    // pages made every one of those invisible and made a nine-page site look like nine
    // unrelated rows. Not board-scoped — sites are owned by a user OR a bloq.
    { id: "sites", label: "Sites", pane: "sites", path: (b) => `/iris/sites/${b}` },
  ],
  playbooks: [
    // "Which playbooks does this project use" and "what could I install" are different
    // questions; one flat list of 128 was the wrong answer to both.
    { id: "project", label: "Project", pane: "playbooks", path: (b) => `/iris/playbooks/${b}?view=project` },
    { id: "marketplace", label: "Marketplace", pane: "playbooks", path: (b) => `/iris/playbooks/${b}?view=marketplace` },
  ],
  integrations: [
    // A connected account is not automatically a board's to use. Narrowed server-side so the
    // footer counts the scope on screen — see rule 1 in NAVIGATION-TEMPLATE.md.
    { id: "project", label: "Project", pane: "integrations", path: (b) => `/iris/integrations/${b}?scope=project` },
    { id: "organization", label: "Org", pane: "integrations", path: (b) => `/iris/integrations/${b}?scope=organization` },
    { id: "user", label: "Personal", pane: "integrations", path: (b) => `/iris/integrations/${b}?scope=user` },
    // "What can I add" is a different question from "what do I have", so it is a view rather
    // than a "+" that opens a modal over the list you were reading.
    { id: "add", label: "+ Add", pane: "catalog", path: () => `/iris/catalog` },
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
    // The page's own document, editable. Separate from the JSON tab, which shows the RECORD
    // (id, slug, status) rather than the content — two different things that both look like
    // "the json".
    { id: "edit", label: "Edit" },
    { id: "json", label: "JSON" },
  ],
  playbooks: [
    { id: "info", label: "Info" },
    { id: "steps", label: "Steps" },
    // The real document, read off THIS machine. Playbook content never leaves the machine, so
    // this is both richer than the API summary and the only place the instructions live.
    { id: "doc", label: "Document" },
    { id: "json", label: "JSON" },
  ],
  sites: [
    { id: "info", label: "Info" },
    // The site's own navigation, as links. NOT a "Preview" tab: every published site 404s at
    // its documented public route /s/{slug} on both hosts, while the pages it links to serve
    // fine. An iframe pointed at that would render a 404 and look like a broken preview rather
    // than the routing gap it is.
    { id: "sitepages", label: "Pages" },
    { id: "json", label: "JSON" },
  ],
  agents: [
    { id: "info", label: "Info" },
    // ATTACHMENT IS NOT ASSIGNMENT. The Info tab shows which board an agent belongs to; this
    // shows what it has actually been given. An agent attached to a 400-item board is attached
    // to all of it and assigned none of it, and those looked identical from every surface.
    { id: "tasks", label: "Tasks" },
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

/**
 * A provider's two-letter mark.
 *
 * No icon assets and no network: the CSP blocks remote images and a broken <img> is worse than
 * a letter. `type` is the provider key — "social-instagram", "gmail" — so the last segment is
 * the brand. Explicit for the ones whose initials are unhelpful ("X" is one character, "in" is
 * how LinkedIn writes itself), initials otherwise.
 */
const PROVIDER_MARKS: Record<string, string> = {
  instagram: "IG",
  tiktok: "TT",
  linkedin: "in",
  x: "X",
  threads: "@",
  gmail: "M",
  calendar: "31",
  drive: "Dr",
}
/**
 * The best mark for one integration type — mirrors the sidecar's own resolution.
 *
 * Exported and tested here because the CHOICE is the part that can be wrong: `social-instagram`
 * maps to a /name/ lookup that renders a generic glyph, while the real Instagram mark sits in
 * the same map under a plain key. Never constructs a URL: the token belongs to the platform's
 * payload, and building one here would let the panel show marks without the attribution that is
 * a condition of using them.
 */
export function logoFor(logos: Record<string, string>, type: string | undefined): string | undefined {
  if (!type) return undefined
  const brand = type.startsWith("social-") ? type.slice("social-".length) : ""
  const aliased = brand === "x" ? "twitter" : brand
  return (aliased && logos[aliased]) || logos[type] || undefined
}

export function providerMark(type: string | undefined, name: string): string {
  const brand = String(type ?? "").split("-").pop() ?? ""
  if (PROVIDER_MARKS[brand]) return PROVIDER_MARKS[brand]
  const src = brand || name
  return src.slice(0, 2).toUpperCase() || "?"
}

/**
 * THREE STATES, NOT TWO.
 *
 * "live" and "not live" is the obvious reading and it is missing the one that matters: an
 * integration that is failing. `error` is not the same as disconnected — the credential is
 * there and something is wrong with it, which is the row you opened this list to find.
 */
export function integrationHealth(i: { status: string; connected: boolean }): "live" | "error" | "off" {
  if (i.status === "error") return "error"
  return i.connected ? "live" : "off"
}

/**
 * Which panes have a search box, and what it says.
 *
 * ONE control, declared once. Search arrived on Atlas first and lived inside it; the second
 * surface asking for it is the moment that becomes a pattern or becomes duplication, and
 * duplicated search means two ideas of what "matches" is — one tab searching bodies while
 * another silently searches titles.
 *
 * A pane is in here only when the SERVER filters it before paging. Adding a placeholder
 * without that would give a box that quietly searches the current page.
 */
const SEARCH_PLACEHOLDER: Record<string, string> = {
  atlas: "Search this board's lists and items…",
  playbooks: "Search playbooks by name, description or step…",
  schemas: "Search schemas and their fields…",
  agents: "Search agents…",
  leads: "Search leads…",
  pages: "Search pages…",
  integrations: "Search integrations…",
  catalog: "Search what you could add…",
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
  /** Every request to the sidecar. `init` exists because this panel now WRITES (page saves). */
  const doFetch = (path: string, init?: RequestInit) =>
    (platform.fetch ?? globalThis.fetch)(`${base()}${path}`, init)

  const [bloqs] = createResource(base, async () => {
    /*
     * ALL of them, not the first page.
     *
     * This asked for /iris/bloqs with no paging, so it got the server default of 25 out of 156.
     * Two consequences, both silent: a board outside the first 25 could be SELECTED and loading
     * its data perfectly while the picker label read "Select a board" — the label could not
     * find it — and the searchable picker only ever searched 25 boards, so typing a name that
     * exists returned "No boards match".
     *
     * 200 is the server's clamp (iris/pagination.ts MAX_PER_PAGE); this is one list of names
     * and ids, not rows.
     */
    const res = await doFetch("/iris/bloqs?page=1&perPage=200")
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

  const [graphScope, setGraphScope] = createSignal<GraphScope>(
    (() => {
      try {
        return normalizeGraphScope(localStorage.getItem(GRAPH_SCOPE_KEY))
      } catch {
        return "project" as GraphScope
      }
    })(),
  )
  const chooseGraphScope = (id: GraphScope) => {
    setGraphScope(id)
    try {
      localStorage.setItem(GRAPH_SCOPE_KEY, id)
    } catch {}
  }

  /**
   * The Atlas search box.
   *
   * `query` is what is typed; `applied` is what has been asked for. Separating them is what
   * stops a keystroke becoming a request: the resource keys off `applied`, which trails the
   * input by a debounce, so typing "accounting" fetches once rather than ten times.
   */
  const [query, setQuery] = createSignal("")
  const [applied, setApplied] = createSignal("")
  let debounce: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const q = query()
    clearTimeout(debounce)
    debounce = setTimeout(() => setApplied(q), 250)
  })
  onCleanup(() => clearTimeout(debounce))

  const resolved = createMemo(() => resolvePane(surface(), subviews()[surface()]))
  /** Which renderer draws the rows, and which array key they arrive under. */
  const pane = createMemo(() => resolved().pane)

  /**
   * Accumulated pages. Reset whenever the surface or board changes — see the effect below.
   *
   * DECLARED ABOVE THE RESOURCE THAT READS IT, and that is load-bearing. `createResource`
   * evaluates its source function IMMEDIATELY, and that source calls `page()`. This signal used
   * to sit 160 lines further down, which survived only because the source short-circuits when
   * `activeBloq()` is undefined — true on a first-ever visit, false for anyone whose board is
   * remembered in localStorage. So the panel was one reload away from a TDZ crash that takes the
   * whole app down with it, for every returning user, and the only reason nobody had hit it is
   * that the crash needs a remembered board to reach the `page()` call at all.
   */
  const [page, setPage] = createSignal(1)

  const [data, { refetch: refetchSurface }] = createResource(
    () => {
      const id = activeBloq()
      // The sub-view is IN the key. Without it, switching Atlas › Lists to Atlas › Schemas
      // changes nothing the resource can see and the old rows stay on screen under the new tab.
      return id ? ([base(), id, surface(), resolved().sub?.id ?? "", page(), applied()] as const) : undefined
    },
    async ([, id, , , pageNo, q], info): Promise<SurfacePayload> => {
      const { pane: which, path } = resolved()
      const url = path(id)
      const sep = url.includes("?") ? "&" : "?"
      // The query goes to the SERVER, which filters the whole board before paging. Filtering
      // the rows already on screen would leave the footer counting a set it never searched.
      // Sent for any pane the server filters — see SEARCH_PLACEHOLDER.
      const search = q && SEARCH_PLACEHOLDER[which] ? `&q=${encodeURIComponent(q)}` : ""
      /*
       * A GRAPH CANNOT BE PAGED.
       *
       * At 25 a page it drew 25 of 39 connected boards and silently dropped every edge whose
       * other end was on page 2 — the edge filter below keeps only links with both ends on
       * screen, so a truncated node list becomes a truncated PICTURE that looks complete. The
       * footer said "25 of 39"; the graph said nothing.
       *
       * The whole set is 39 rows and 45 edges. There is nothing to page.
       */
      const perPage = which === "graph" ? 500 : 25
      const res = await doFetch(`${url}${sep}page=${pageNo}&perPage=${perPage}${search}`)
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

  /**
   * The graph rows, turned back into nodes and edges.
   *
   * Derived rather than fetched separately: the /iris/graph payload already carries every link
   * from both ends, so a second call would be a second source of truth about the same 45 edges.
   * Deduplicated on the unordered pair, because an edge appears on both of its endpoints' rows
   * and drawing it twice doubles its apparent weight.
   */
  /**
   * The rows the graph actually draws, narrowed to the selected board.
   *
   * A LENS over the payload, not a second request, and the template's rule 1 ("a sub-view is a
   * different endpoint, never a filter over rows already on screen") is argued rather than
   * ignored here. That rule exists because filtering a PAGE leaves the footer counting the
   * unfiltered set. This payload is not paged — the graph pane asks for 500 and the account has
   * 40 connected boards — so every board and every edge is already in hand, and the count under
   * the drawing is recomputed from the same narrowed set below. Nothing can describe a set it
   * did not search.
   *
   * `project` is radius 1: the board and its direct relations. `connected` walks the whole
   * component, which is the honest answer to "what is this project part of" when the link is
   * two hops away.
   */
  const graphScopedRows = createMemo<any[]>(() => scopeGraphRows(rows() as any[], activeBloq(), graphScope()))

  /** True when the selected board has no relation to anything — the common case, not an error. */
  const graphBoardIsolated = createMemo(() => graphBoardIsIsolated(rows() as any[], activeBloq(), graphScope()))

  /**
   * EXPANDED BOARDS AND THEIR INTERIORS.
   *
   * Lazy on purpose. Elon assembles a board's interior from a Vuex store its board view has
   * already filled, so the graph is free there. The sidecar has no such store — /iris/graph/:id
   * fans out to five per-board fetchers — so doing this for every connected board on open would
   * be dozens of round trips and thousands of nodes before the first frame.
   *
   * Keyed by board id, and the entry is kept after collapse: re-expanding the board you just
   * closed is the common gesture, and re-fetching it would make that feel broken.
   */
  const [expanded, setExpanded] = createSignal<Set<number>>(new Set())
  const [interiors, setInteriors] = createSignal<Record<number, { nodes: any[]; edges: any[] }>>({})
  const [expanding, setExpanding] = createSignal<Set<number>>(new Set())

  async function toggleExpand(boardId: number) {
    const open = expanded()
    if (open.has(boardId)) {
      setExpanded((prev) => {
        const next = new Set(prev)
        next.delete(boardId)
        return next
      })
      return
    }
    // Cached from a previous expand — show it without a round trip.
    if (interiors()[boardId]) {
      setExpanded((prev) => new Set(prev).add(boardId))
      return
    }
    setExpanding((prev) => new Set(prev).add(boardId))
    try {
      const res = await doFetch(`/iris/graph/${boardId}`, { headers: { Accept: "application/json" } })
      if (!res.ok) return
      const j = await res.json()
      // `measured: false` is NOT an empty board — it is "could not read". Expanding to nothing
      // would say the board is empty, which is the one answer we know we do not have.
      if (j?.measured === false) return
      setInteriors((prev) => ({ ...prev, [boardId]: { nodes: j?.nodes ?? [], edges: j?.edges ?? [] } }))
      setExpanded((prev) => new Set(prev).add(boardId))
    } catch {
      // Swallowed deliberately: a failed expand leaves the board collapsed, which is the state
      // it was already in. Nothing is lost and nothing is claimed.
    } finally {
      setExpanding((prev) => {
        const next = new Set(prev)
        next.delete(boardId)
        return next
      })
    }
  }

  /**
   * THE PROJECT GRAPH IS THE ACTIVE BOARD'S INTERIOR — shown, not hidden behind a click.
   *
   * ELON opens its graph on the project itself: ATLAS at the centre, Memory -> every list ->
   * every card, the agents/leads/workflows hubs, and the related boards around it.
   * /iris/graph/:id already builds exactly that by ELON's own rules (pinned by a golden generated
   * from ELON's code), related boards included. The Project tab was drawing the board-to-board
   * web instead, and the graph ELON shows only appeared after clicking a board — so it read as
   * "not the same graph" when it was the same graph behind a door.
   *
   * Connected and Full atlas stay the board-to-board webs: they are desktop's own account-wide
   * views, which ELON does not have, and expanding a board there still works.
   */
  const projectScope = () => pane() === "graph" && graphScope() === "project" && activeBloq() != null
  const [projectInterior] = createResource(
    () => (projectScope() ? Number(activeBloq()) : undefined),
    async (boardId: number) => {
      if (interiors()[boardId]) return { measured: true, ...interiors()[boardId] }
      const res = await doFetch(`/iris/graph/${boardId}`, { headers: { Accept: "application/json" } })
      // Not ok, or not JSON: NOT MEASURED. Rendering it as an empty graph would claim the board
      // holds nothing, which is the one thing we do not know.
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return { measured: false, nodes: [], edges: [] }
      const j = await res.json()
      if (j?.measured === false) return { measured: false, reason: j?.reason, nodes: [], edges: [] }
      const got = { nodes: j?.nodes ?? [], edges: j?.edges ?? [] }
      setInteriors((prev) => ({ ...prev, [boardId]: got }))
      return { measured: true, ...got }
    },
  )
  const project = () => (projectScope() ? (projectInterior.latest ?? projectInterior()) : undefined)

  /** Lists as the card editor wants them, read off the graph's own `list-<id>` nodes. */
  const projectLists = () =>
    (project()?.nodes ?? [])
      .filter((n: any) => typeof n.id === "string" && n.id.startsWith("list-"))
      .map((n: any) => ({ id: Number(n.id.slice("list-".length)), name: String(n.name) }))

  const graphNodes = createMemo<ForceNode[]>(() => {
    if (projectScope()) return (project()?.nodes ?? []) as ForceNode[]
    const boards: ForceNode[] = graphScopedRows().map((r) => ({
      id: r.id,
      name: r.name,
      degree: r.degree,
      // A board sizes by degree — the only signal that exists BETWEEN boards. Elon's sizes
      // (Atlas 28, hub 20, cluster log2) are roles inside one board and arrive with the
      // interior payload below.
      type: "bloq",
      meta: expanded().has(r.id) ? "expanded — click to collapse" : "click to expand",
      size: Math.max(12, Math.min(26, 11 + r.degree * 1.5)),
    }))
    const extra: ForceNode[] = []
    for (const id of expanded()) {
      // Only for boards actually ON SCREEN. A scope change can narrow the board set while an
      // expansion is still open, and its interior would otherwise float unattached.
      if (!graphScopedRows().some((r) => r.id === id)) continue
      for (const n of interiors()[id]?.nodes ?? []) extra.push(n as ForceNode)
    }
    return [...boards, ...extra]
  })

  const graphEdges = createMemo<ForceEdge[]>(() => {
    if (projectScope()) return (project()?.edges ?? []) as ForceEdge[]
    const known = new Set(graphScopedRows().map((r) => r.id))
    const seen = new Set<string>()
    const out: ForceEdge[] = []
    for (const r of graphScopedRows()) {
      for (const l of r.links ?? []) {
        // Only edges whose BOTH ends are on screen. A link to a board on the next page would
        // otherwise anchor at the origin and read as a real relation to nothing.
        if (!known.has(l.id)) continue
        const [a, b] = r.id < l.id ? [r.id, l.id] : [l.id, r.id]
        const key = `${a}-${b}-${l.type}`
        if (seen.has(key)) continue
        seen.add(key)
        // Direction preserved from the row that owns the outbound end.
        out.push(
          l.direction === "out"
            ? { source: r.id, target: l.id, type: l.type }
            : { source: l.id, target: r.id, type: l.type },
        )
      }
    }
    for (const id of expanded()) {
      if (!graphScopedRows().some((r) => r.id === id)) continue
      for (const e of interiors()[id]?.edges ?? []) out.push(e as ForceEdge)
      // The seam: the board node to its own Atlas centre. Without it the interior is a second
      // disconnected graph that the force layout pushes off to one side, which reads as two
      // unrelated pictures rather than one board opened up.
      out.push({ source: id, target: `bloq-${id}`, type: "parent", label: "contains" })
    }
    return out
  })

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
  /** What the open agent is holding. Fetched only when the tab is on, like the records table. */
  const [agentTasks] = createResource(
    () => {
      const r = openRow()
      return r?.pane === "agents" && detailTab() === "tasks" && r.raw?.id
        ? ([base(), Number(r.raw.id)] as const)
        : undefined
    },
    async ([, agentID]) => {
      const res = await doFetch(`/iris/agents/${agentID}/tasks`)
      return (await res.json()) as Measured & {
        counts: { itemTasks: number; leadTasks: number; scheduledJobs: number; heartbeatBloqs: number; total: number }
        tasks: {
          source: string
          id: number
          title: string
          status?: string
          done: boolean
          dueDate?: string
          itemId?: number
          itemTitle?: string
          bloqId?: number
          leadId?: number
          nextRunAt?: string
          frequency?: string
        }[]
      }
    },
  )

  /** The open playbook's local PLAYBOOK.md. A file read through the sidecar, not a fetch. */
  const [playbookDoc] = createResource(
    () => {
      const r = openRow()
      return r?.pane === "playbooks" && detailTab() === "doc" && r.raw?.name
        ? ([base(), String(r.raw.name)] as const)
        : undefined
    },
    async ([, name]) => {
      const res = await doFetch(`/iris/playbooks/doc/${encodeURIComponent(name)}`)
      return (await res.json()) as {
        found: boolean
        name: string
        path: string
        source: "local" | "published" | "none"
        content: string
      }
    },
  )

  /** The open page's json_content, and the version to pin a save to. */
  const [pageDoc, { mutate: mutatePageDoc }] = createResource(
    () => {
      const r = openRow()
      return r?.pane === "pages" && detailTab() === "edit" && r.raw?.id ? ([base(), Number(r.raw.id)] as const) : undefined
    },
    async ([, id]) => {
      const res = await doFetch(`/iris/page/${id}`)
      return (await res.json()) as Measured & {
        id: number
        title: string
        status: string
        currentVersion?: number
        publicUrl?: string
        json: string
      }
    },
  )

  /** The editor buffer. Null means "not touched" — the loaded document is the value. */
  const [draft, setDraft] = createSignal<string | null>(null)
  const [saving, setSaving] = createSignal(false)
  const [saveNote, setSaveNote] = createSignal<{ ok: boolean; text: string } | null>(null)
  createEffect(() => {
    openRow()
    detailTab()
    setDraft(null)
    setSaveNote(null)
  })

  async function savePage() {
    const doc = pageDoc.latest
    const body = draft()
    if (!doc || body == null || saving()) return
    setSaving(true)
    setSaveNote(null)
    try {
      const res = await doFetch(`/iris/page/${doc.id}/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body, expectedVersion: doc.currentVersion }),
      })
      const out = (await res.json()) as { ok: boolean; reason?: string; version?: number }
      if (out.ok) {
        // Adopt the new version so a SECOND save is pinned to what we just wrote, rather than
        // to the version we opened — otherwise the save after a save always conflicts.
        mutatePageDoc((d) => (d ? { ...d, json: body, currentVersion: out.version ?? d.currentVersion } : d))
        setDraft(null)
        setSaveNote({ ok: true, text: `Saved${out.version != null ? ` · version ${out.version}` : ""}` })
      } else {
        setSaveNote({ ok: false, text: out.reason ?? "save failed" })
      }
    } catch (e) {
      setSaveNote({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  const [records] = createResource(
    () => {
      const r = openRow()
      const slug = r?.raw?.slug
      const b = activeBloq()
      return r?.pane === "schemas" && detailTab() === "records" && slug && b
        ? ([base(), Number(b), String(slug), recordPage()] as const)
        : undefined
    },
    // The BOARD is in the path, not decoration: the server refuses a dataset that belongs
    // elsewhere, and it can only do that if we say which board we are asking as.
    async ([, bloqID, slug, pageNo]) => {
      const res = await doFetch(`/iris/records/${bloqID}/${encodeURIComponent(slug)}?page=${pageNo}&perPage=25`)
      return (await res.json()) as Measured & {
        columns: { key: string; label: string; type: string; visibility?: string }[]
        rows: { id: number; data: Record<string, unknown>; updatedAt?: string }[]
        total: number | null
        totalIsExact: boolean
        hasMore: boolean
      }
    },
  )


  // Leaving the surface or the board must close the reader — otherwise you switch to Leads and
  // are still looking at an Atlas item.
  /**
   * The last subject we reset for. Compared, not just tracked.
   *
   * `activeBloq()` is undefined until the bloqs list lands, then becomes a number — a change
   * this effect saw as "the board changed", so it closed whatever the reader had open. Opening
   * a record while that request was still in flight meant the detail shut by itself a moment
   * later, which is indistinguishable from the panel blanking. Reported as "the whole page
   * hides and does that black hiccup" (#185119).
   *
   * Resolving from nothing to something is not a change of subject. Going from board A to
   * board B is.
   */
  let lastSubject = ""
  createEffect(() => {
    const subject = [surface(), resolved().sub?.id ?? "", activeBloq() ?? ""].join("/")
    // Nothing to leave yet: the first run just records where we are.
    if (lastSubject === "" || lastSubject === subject || activeBloq() == null) {
      if (activeBloq() != null) lastSubject = subject
      return
    }
    lastSubject = subject
    setOpenRow(null)
    // A query for one board is not a query for the next.
    setQuery("")
    setApplied("")
    // Paging resets with the thing being paged. Without this, switching surface while on page 3
    // asks the next surface for ITS page 3 and silently skips its first rows.
    setPage(1)
  })

  /**
   * THE CARD EDITOR (#185485). A row opens the item in a modal — read, edit, tasks — and the
   * modal returns to this row. Every item opens, including one with no body: a title, a status
   * and a list are things you change on a card that has nothing written in it yet.
   *
   * Lists come from the payload already on screen, so the List picker costs no request. On any
   * write the surface is re-read so the row behind the dialog shows what was saved; a page
   * beyond the first drops back to page 1, because a refetch returns only the page it asked for.
   */
  function openCard(itemId: number, fromGraph?: { id: number; name: string }[]) {
    const b = activeBloq()
    if (b == null) return
    // The Graph pane never loads the Atlas payload, so reading lists from `data` there gives the
    // List picker nothing. The graph already holds every list as a `list-<id>` node.
    const lists =
      fromGraph ?? ((data.latest ?? data())?.lists as AtlasList[] | undefined ?? []).map((l) => ({ id: l.id, name: l.name }))
    dialog.show(() => (
      <IrisCardEditor
        itemId={itemId}
        bloqId={Number(b)}
        lists={lists}
        doFetch={doFetch}
        onChanged={() => {
          if (page() !== 1) setPage(1)
          else void refetchSurface()
        }}
      />
    ))
  }

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
  // Hive machines and Integrations belong to the ACCOUNT. Everything else, Sites included
  // since it was narrowed, is this board.
  const boardScoped = createMemo(
    () => surface() !== "hive" && surface() !== "integrations" && pane() !== "graph" && pane() !== "catalog",
  )

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

      {/* SEARCH, for the pane that has enough in it to need one: a board's lists run to
          hundreds of items and the reader is the only way in. Server-side — see the `q` param. */}
      <Show when={SEARCH_PLACEHOLDER[pane()] && !openRow()}>
        <div class="iris-search shrink-0">
          <input
            class="iris-search__input"
            type="search"
            placeholder={SEARCH_PLACEHOLDER[pane()]}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <Show when={applied()}>
            <button
              type="button"
              class="iris-search__clear"
              title="Clear"
              onClick={() => {
                setQuery("")
                setApplied("")
              }}
            >
              clear
            </button>
          </Show>
        </div>
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
                {/* THE UPTIME STRIP — the provider's recent history, one bar per window.
                    Shown above the fields because "has this been flapping" is a shape, not a
                    value, and a column of dates cannot answer it. */}
                <Show when={openRow()!.raw?.health?.bars?.length}>
                  <div class="pb-3">
                    <div class="iris-bars">
                      <For each={openRow()!.raw.health.bars}>
                        {(b: any) => (
                          <span
                            class="iris-bars__bar"
                            classList={{
                              "iris-bars__bar--up": b.state === "up",
                              "iris-bars__bar--down": b.state === "down",
                            }}
                            title={`${b.state}${b.from ? ` · from ${b.from}` : ""}`}
                          />
                        )}
                      </For>
                    </div>
                    <p class="text-11-regular text-text-weaker pt-1">
                      Provider {openRow()!.raw.health.state}
                      {openRow()!.raw.health.basis ? ` · by ${openRow()!.raw.health.basis}` : ""}
                      {/* Said plainly, because this is the sentence people get wrong. */}
                      {openRow()!.raw.status === "error" && openRow()!.raw.health.state === "operational"
                        ? " — the service is fine; it is your credential that is failing"
                        : ""}
                    </p>
                  </div>
                </Show>
                <Show when={openRow()!.command}>
                  <button
                    type="button"
                    class="iris-command"
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
                <pre class="iris-json text-11-regular" innerHTML={highlightJson(openRow()!.raw)} />
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

              {/* EDIT THE PAGE. The document itself, saved back pinned to the version it was
                  read at — see /iris/page/:id/save. */}
              <Match when={detailTab() === "edit"}>
                <Switch>
                  <Match when={pageDoc.loading && !pageDoc.latest}>
                    <p class="text-12-regular text-text-weak py-2">Loading page…</p>
                  </Match>
                  <Match when={pageDoc.latest && !pageDoc.latest!.measured}>
                    <p class="text-12-regular text-text-weak py-2">
                      Could not load this page — {pageDoc.latest!.reason ?? "unknown"}.
                    </p>
                  </Match>
                  <Match when={pageDoc.latest}>
                    <div class="flex items-baseline gap-2 pb-2">
                      <span class="font-mono text-11-regular text-text-weaker">
                        {pageDoc.latest!.status}
                        {pageDoc.latest!.currentVersion != null ? ` · v${pageDoc.latest!.currentVersion}` : ""}
                      </span>
                      {/* The save is PINNED. Said on screen, because "why did my save fail" is
                          otherwise a mystery and the answer is a good one. */}
                      <Show when={pageDoc.latest!.currentVersion == null}>
                        <span class="text-11-regular text-text-weaker">
                          no version — a save here cannot detect a conflict
                        </span>
                      </Show>
                      <button
                        type="button"
                        class="ms-auto px-2 py-0.5 rounded text-11-regular cursor-pointer disabled:cursor-default"
                        classList={{
                          "text-text-weaker": draft() == null || saving(),
                          "text-text-strong hover:bg-background-element": draft() != null && !saving(),
                        }}
                        disabled={draft() == null || saving()}
                        onClick={savePage}
                      >
                        {saving() ? "Saving…" : draft() == null ? "No changes" : "Save"}
                      </button>
                    </div>
                    <Show when={saveNote()}>
                      {(n) => (
                        <p
                          class="text-11-regular pb-2"
                          classList={{ "text-text-base": n().ok, "text-text-weak": !n().ok }}
                        >
                          {n().text}
                        </p>
                      )}
                    </Show>
                    <textarea
                      class="iris-editor"
                      spellcheck={false}
                      value={draft() ?? pageDoc.latest!.json}
                      onInput={(e) => setDraft(e.currentTarget.value)}
                    />
                  </Match>
                </Switch>
              </Match>

              {/* THE STEPS. What the playbook will actually do, and what it needs from you. */}
              <Match when={detailTab() === "steps"}>
                <Show
                  when={(openRow()!.raw?.steps?.length ?? 0) > 0 || (openRow()!.raw?.args?.length ?? 0) > 0}
                  fallback={
                    <p class="text-12-regular text-text-weak py-2">
                      This playbook publishes no step summary. The Document tab has the real thing when it
                      is installed on this machine.
                    </p>
                  }
                >
                  <Show when={(openRow()!.raw?.args?.length ?? 0) > 0}>
                    <h4 class="text-11-regular text-text-weaker pb-1">Arguments</h4>
                    <For each={openRow()!.raw.args}>
                      {(a: any) => (
                        <div class="flex items-baseline gap-2 px-2 py-1 border-b border-border-weaker-base last:border-0">
                          <span class="font-mono text-11-regular text-text-base shrink-0">{a.name}</span>
                          <span class="font-mono text-11-regular text-text-weaker shrink-0">{a.type ?? "?"}</span>
                          {/* Required is said out loud — a missing required arg is the most
                              common reason a run dies on its first step. */}
                          <Show when={a.required}>
                            <span class="iris-table__phi shrink-0">required</span>
                          </Show>
                          <span class="text-11-regular text-text-weak min-w-0 flex-1 truncate" title={a.description}>
                            {a.description}
                          </span>
                        </div>
                      )}
                    </For>
                  </Show>
                  <Show when={(openRow()!.raw?.steps?.length ?? 0) > 0}>
                    <h4 class="text-11-regular text-text-weaker pt-3 pb-1">
                      Steps · {openRow()!.raw.steps.length}
                    </h4>
                    <For each={openRow()!.raw.steps}>
                      {(st: any, i) => (
                        <div class="flex items-baseline gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0">
                          <span class="font-mono tabular-nums text-11-regular text-text-weaker shrink-0">
                            {i() + 1}
                          </span>
                          <div class="min-w-0 flex-1">
                            <p class="text-12-regular text-text-base">{st.title}</p>
                            <p class="font-mono text-11-regular text-text-weaker truncate">
                              {st.id}
                              {st.integrations?.length ? ` · ${st.integrations.join(", ")}` : ""}
                            </p>
                          </div>
                          {/* shell vs prompt is the difference between running a command and
                              asking a model, which is the whole character of a step. */}
                          <span class="shrink-0 font-mono text-11-regular text-text-weaker">{st.mode ?? "?"}</span>
                        </div>
                      )}
                    </For>
                  </Show>
                </Show>
              </Match>

              {/* THE DOCUMENT itself, rendered. */}
              <Match when={detailTab() === "doc"}>
                <Switch>
                  <Match when={playbookDoc.loading && !playbookDoc.latest}>
                    <p class="text-12-regular text-text-weak py-2">Reading…</p>
                  </Match>
                  <Match when={playbookDoc.latest && !playbookDoc.latest!.found}>
                    {/* Neither copy exists: not installed here AND not published. */}
                    <p class="text-12-regular text-text-weak py-2">
                      No document — this playbook is not installed on this machine and has not been
                      published.
                      <br />
                      <span class="font-mono text-11-regular">iris playbook install {openRow()!.raw?.name}</span>
                    </p>
                  </Match>
                  <Match when={playbookDoc.latest?.found}>
                    {/* WHICH COPY you are reading. The local file and the published one can
                        differ — that is the whole reason `playbook publish` can lie — so the
                        source is stated rather than left to be assumed. */}
                    <p class="font-mono text-11-regular text-text-weaker pb-2 truncate" title={playbookDoc.latest!.path}>
                      {playbookDoc.latest!.source === "local" ? "local · " : "published · "}
                      {playbookDoc.latest!.path}
                    </p>
                    <div class="iris-markdown text-12-regular" innerHTML={renderMarkdown(playbookDoc.latest!.content)} />
                  </Match>
                </Switch>
              </Match>

              {/* WHAT THIS AGENT IS HOLDING. Four sources in one list — a task on a bloq item,
                  a task on a lead, a scheduled job, or a whole board it heartbeats. The last is
                  the one most likely to be forgotten, because nothing about the board mentions
                  it, so it is shown alongside the rest rather than inferred. */}
              <Match when={detailTab() === "tasks"}>
                <Switch>
                  <Match when={agentTasks.loading && !agentTasks.latest}>
                    <p class="text-12-regular text-text-weak py-2">Loading tasks…</p>
                  </Match>
                  <Match when={agentTasks.latest && !agentTasks.latest!.measured}>
                    <p class="text-12-regular text-text-weak py-2">
                      Could not load tasks — {agentTasks.latest!.reason ?? "unknown"}.
                    </p>
                  </Match>
                  <Match when={(agentTasks.latest?.tasks?.length ?? 0) === 0}>
                    {/* A GENUINE zero, and it says what it means: attached to a board is not
                        the same as given something to do. */}
                    <p class="text-12-regular text-text-weak py-2">
                      Nothing assigned. This agent belongs to a board but has not been handed any
                      work — assign an item with{" "}
                      <span class="font-mono text-11-regular">iris agents assign</span>.
                    </p>
                  </Match>
                  <Match when={agentTasks.latest}>
                    <div class="flex items-baseline gap-2 pb-2 text-11-regular text-text-weaker">
                      <span class="font-mono tabular-nums">{agentTasks.latest!.counts.total} assigned</span>
                      <Show when={agentTasks.latest!.counts.heartbeatBloqs > 0}>
                        <span>· {agentTasks.latest!.counts.heartbeatBloqs} board heartbeat</span>
                      </Show>
                    </div>
                    <For each={agentTasks.latest!.tasks}>
                      {(t) => (
                        <div class="flex items-baseline gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0">
                          <span class="shrink-0" classList={{ "text-text-weaker": t.done, "text-text-base": !t.done }}>
                            {t.done ? "✓" : "·"}
                          </span>
                          <div class="min-w-0 flex-1">
                            <p class="text-12-regular" classList={{ "text-text-weak": t.done, "text-text-base": !t.done }}>
                              {t.title}
                            </p>
                            {/* WHERE the work lives. A task title with no context is the same
                                problem as an attached agent with no assignment. */}
                            <p class="text-11-regular text-text-weaker truncate">
                              {t.source === "bloq_item_task" && t.itemTitle ? `on ${t.itemTitle}` : ""}
                              {t.source === "lead_task" ? `lead #${t.leadId}` : ""}
                              {t.source === "scheduled_job"
                                ? `${t.frequency ?? "scheduled"}${t.nextRunAt ? ` · next ${relativeAge(t.nextRunAt) ?? t.nextRunAt}` : ""}`
                                : ""}
                              {t.source === "heartbeat_bloq" ? "runs on this whole board" : ""}
                              {t.dueDate ? ` · due ${t.dueDate}` : ""}
                            </p>
                          </div>
                          <span class="shrink-0 font-mono text-11-regular text-text-weaker">
                            {t.status ?? t.source.replace(/_/g, " ")}
                          </span>
                        </div>
                      )}
                    </For>
                  </Match>
                </Switch>
              </Match>

              {/* The site's navigation, as links you can actually open. Each entry is a
                  /p/<slug> page, which serves fine — it is the site route itself that does not. */}
              <Match when={detailTab() === "sitepages"}>
                <Show
                  when={(openRow()!.raw?.navItems?.length ?? 0) > 0}
                  fallback={
                    <p class="text-12-regular text-text-weak py-2">
                      This site has {openRow()!.raw?.pagesCount ?? 0} page(s) attached but no navigation defined.
                    </p>
                  }
                >
                  <For each={openRow()!.raw.navItems}>
                    {(n: any) => (
                      <a
                        href={`https://heyiris.io${n.url}`}
                        target="_blank"
                        rel="noreferrer"
                        class="flex items-baseline gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0 hover:bg-background-element"
                      >
                        <span class="text-12-regular text-text-base min-w-0 flex-1">{n.label}</span>
                        <span class="shrink-0 font-mono text-11-regular text-text-weaker">{n.url}</span>
                      </a>
                    )}
                  </For>
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
                    {/* ABSENCE OF A PHI FLAG IS NOT A CLAIM OF SAFETY.
                        `cases` declares no visibility on any column, and one of them is
                        patient_name. Rendering those identically to columns that explicitly
                        declare "public" turns "nobody said" into "it is fine", which is the
                        exact three-states-as-two mistake this panel exists to avoid. */}
                    <Show when={records.latest!.columns.some((c) => !c.visibility)}>
                      <p class="text-11-regular text-text-weaker pb-2">
                        {records.latest!.columns.filter((c) => !c.visibility).length} of{" "}
                        {records.latest!.columns.length} columns declare no visibility — unlabelled is
                        not the same as safe to share.
                      </p>
                    </Show>
                    <div class="iris-table-wrap">
                      <table class="iris-table">
                        <thead>
                          <tr>
                            <th class="iris-table__num">id</th>
                            <For each={records.latest!.columns}>
                              {(c) => (
                                <th
                                  title={
                                    c.visibility
                                      ? `${c.key} · ${c.type} · visibility: ${c.visibility}`
                                      : `${c.key} · ${c.type} · no visibility declared — nobody has said what this column is, which is not the same as saying it is safe to share`
                                  }
                                >
                                  {c.label}
                                  {/* THREE STATES, DRAWN AS THREE (#185139).
                                      Declared phi, declared something else, and nobody said.
                                      Only the first two were ever drawn, so silence rendered
                                      identically to an explicit "public" — and silence is the
                                      common case: 670 of 720 columns across this account
                                      declare nothing, `Pathways Cases` among them, whose
                                      columns include patient_name and law_firm.

                                      The undeclared mark is quiet on purpose. It is not an
                                      accusation that the column is sensitive; it is the
                                      absence of a claim either way, and the tooltip says so. */}
                                  <Show when={c.visibility === "phi"}>
                                    <span class="iris-table__phi">phi</span>
                                  </Show>
                                  <Show when={!c.visibility}>
                                    <span class="iris-table__undeclared" aria-label="no visibility declared">
                                      ?
                                    </span>
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

      {/* The graph OWNS the pane: a column that does not scroll, so the canvas can take the
          height instead of sitting in a box inside a scroller. Everything else scrolls as before. */}
      <div
        class="flex-1 min-h-0"
        classList={{
          hidden: !!openRow(),
          "overflow-y-auto": pane() !== "graph",
          "flex flex-col overflow-hidden": pane() === "graph",
        }}
      >
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
                            class="w-full flex gap-2 px-2 py-1 text-start rounded cursor-pointer hover:bg-background-element"
                            title="Open this card"
                            onClick={() => openCard(item.id)}
                          >
                            <span class="text-12-regular text-text-weak shrink-0">
                              {item.status === "done" || item.status === "completed" ? "✓" : "·"}
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

              <Match when={pane() === "sites"}>
                <For each={rows()}>
                  {(st) => (
                    <button type="button" data-slot="iris-site-row" class="w-full text-start px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow("sites", st))}>
                      <div class="flex items-baseline gap-2">
                        <span class="shrink-0" classList={{ "text-text-base": st.status === "published", "text-text-weak": st.status !== "published" }}>
                          {st.status === "published" ? "●" : "○"}
                        </span>
                        <span class="text-12-regular text-text-base min-w-0 flex-1">{st.name}</span>
                        {/* The page count IS the reason a site exists. Leading with it says
                            what kind of thing this row is at a glance. */}
                        <span class="shrink-0 font-mono tabular-nums text-11-regular text-text-weaker">
                          {st.pagesCount}p
                        </span>
                      </div>
                      <p class="text-11-regular text-text-weaker ps-4 pt-0.5 truncate">
                        /{st.slug}
                        {st.owner ? ` · ${st.owner}` : ""}
                        {st.requiresAuth ? " · gated" : ""}
                      </p>
                    </button>
                  )}
                </For>
              </Match>

              {/* WHAT YOU COULD ADD. Same mark treatment as the connected list, greyed —
                  these are real services you do not have yet, not a different kind of thing. */}
              {/* THE GRAPH, as rows rather than a drawing.
                  160 nodes and 41 edges in a 500px column is a hairball that answers nothing,
                  and 123 of those nodes have no edge at all — a force layout would spend its
                  whole area rendering that fact. Sorted by degree, the same data answers "what
                  is central here" at a glance, and the isolated count is stated instead. */}
              <Match when={pane() === "graph"}>
                {/* WHOSE graph. Chips, not a plate: this narrows the pane you are already on,
                    it does not change the subject — the same reason sub-views get a rule and
                    surfaces get a plate. */}
                <div class="iris-scope shrink-0" role="tablist" aria-label="Graph scope">
                  <For each={GRAPH_SCOPES}>
                    {(sc) => (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={graphScope() === sc.id}
                        title={sc.hint}
                        class="iris-detailnav__item"
                        classList={{ "iris-detailnav__item--active": graphScope() === sc.id }}
                        onClick={() => chooseGraphScope(sc.id)}
                      >
                        {sc.label}
                      </button>
                    )}
                  </For>
                </div>

                {/* Counts row removed — the legend chips under the graph now carry the same
                    numbers, and the isolated-board case is handled by its own block below. */}
                {/* THE PICTURE, then the list.
                    Both, because they answer different halves: the layout shows how the
                    connected boards cluster, and the list is the only thing that can show a
                    board with no edges — 76% of them — which a force graph renders as absence. */}
                <Show when={projectScope() && !project() && projectInterior.loading}>
                  <p class="px-2 py-6 text-12-regular text-text-weak">Loading this board's graph…</p>
                </Show>
                <Show when={projectScope() && project()?.measured === false}>
                  <p class="px-2 py-6 text-12-regular text-text-weak">
                    Not connected — this board's graph could not be read{(project() as any)?.reason ? ` (${(project() as any).reason})` : ""}.
                  </p>
                </Show>
                <Show when={projectScope() ? (project()?.nodes?.length ?? 0) > 0 : graphScopedRows().length}>
                  <IrisForceGraph
                    nodes={graphNodes()}
                    edges={graphEdges()}
                    /* Only a BOARD selects a board. Interior nodes carry namespaced string ids
                       (`hub-agents-12`), and `choose` takes a board id — passing one through
                       would select nothing and clear the pane you were reading. */
                    /*
                      A BOARD NODE EXPANDS; it does not navigate.
                      Selecting a board is what the picker above is for, and it replaces the
                      whole pane — doing that on a graph click means one misplaced tap loses the
                      layout you were reading. Expanding is reversible and keeps you where you
                      are. Interior nodes carry namespaced string ids and are inert for now.
                    */
                    onNodeClick={(n) => {
                      // ELON's rule, exactly: only a CARD responds, and it opens that card's
                      // editor. Hubs, lists and related boards are inert (Board.vue
                      // onGraphNodeClick returns unless the id starts with `item-`).
                      if (typeof n.id === "string" && n.id.startsWith("item-")) {
                        const itemId = Number(n.id.slice("item-".length))
                        if (Number.isFinite(itemId)) openCard(itemId, projectScope() ? projectLists() : undefined)
                        return
                      }
                      // The account-wide webs keep expand-on-click.
                      if (!projectScope() && typeof n.id === "number") void toggleExpand(n.id)
                    }}
                  />
                </Show>
                {/* An isolated board would otherwise leave the canvas blank, which reads as a
                    failed load rather than the finding it is. Offer the way out instead. */}
                <Show when={!projectScope() && graphBoardIsolated()}>
                  <div class="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
                    <p class="text-12-regular text-text-weak">Nothing links to this board yet.</p>
                    <button type="button" class="iris-detailnav__item" onClick={() => chooseGraphScope("full")}>
                      Show the full atlas
                    </button>
                  </div>
                </Show>
                <details class="iris-rows shrink-0">
                  <summary class="iris-rows__summary">
                    {graphScopedRows().length} connected{" "}
                    {graphScopedRows().length === 1 ? "board" : "boards"}, as a list
                  </summary>
                  <div class="iris-rows__body">
                    <For each={graphScopedRows()}>
                      {(n) => (
                        <div class="px-2 py-1.5 border-b border-border-weaker-base last:border-0">
                          <div class="flex items-baseline gap-2">
                            <span class="text-12-regular text-text-base min-w-0 flex-1 truncate">{n.name}</span>
                            <span class="shrink-0 font-mono tabular-nums text-11-regular text-text-weaker">
                              {n.degree}
                            </span>
                          </div>
                          <For each={n.links}>
                            {(l: any) => (
                              <p class="text-11-regular text-text-weaker ps-3 pt-0.5 truncate">
                                {/* Direction is drawn, because feeds_into read backwards is a
                                    different claim about the same pair. */}
                                <span class="font-mono">{l.direction === "out" ? "→" : "←"}</span> {l.name}
                                <span class="font-mono"> · {l.type}</span>
                              </p>
                            )}
                          </For>
                        </div>
                      )}
                    </For>
                  </div>
                </details>
              </Match>

              <Match when={pane() === "catalog"}>
                <For each={rows()}>
                  {(c) => (
                    <button type="button" class="w-full text-start flex items-center gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow("catalog", c))}>
                      <span class="iris-int__mark iris-int__mark--off shrink-0" title={c.type}>
                        <Show when={c.logoUrl}>
                          <img class="iris-int__logo" src={c.logoUrl} alt="" aria-hidden="true" loading="lazy" decoding="async" onError={(e) => e.currentTarget.remove()} />
                        </Show>
                        {providerMark(c.type, c.name)}
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="block text-12-regular text-text-base truncate">{c.name}</span>
                        <span class="block text-11-regular text-text-weaker truncate">
                          {c.category}
                          {/* Says what connecting involves, because a key and an OAuth round
                              trip are different jobs and only one of them needs a browser. */}
                          {c.mode ? ` · ${c.mode}` : ""}
                          {c.functionsCount ? ` · ${c.functionsCount} functions` : ""}
                        </span>
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
                  {(pb, i) => (
                    <>
                      {/* NOT YOURS starts here. The server sorts owned first, so the boundary is
                          the first row whose owner is not you — drawn once, as a heading, rather
                          than badged on every row. A list that mixes them undifferentiated reads
                          as "all of this is mine to change". */}
                      <Show when={!pb.owned && (i() === 0 || rows()[i() - 1]?.owned)}>
                        {/* NAMES THE OWNER rather than calling it "not yours".
                            Every one of these on this account belongs to user 2945 — the same
                            person's second login. "Not yours" would be a confident false
                            statement about their own work; an account number is a fact they
                            can act on. The boundary is drawn once, where the sort flips. */}
                        <h4 class="text-11-regular text-text-weaker px-2 pt-3 pb-1 border-t border-border-weaker-base">
                          Owned by another account
                          {pb.ownerUserId ? ` · #${pb.ownerUserId}` : ""} — you can run these, not edit them
                        </h4>
                      </Show>
                      <button type="button" class="w-full text-start px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow(pane(), pb))}>
                        <div class="flex items-baseline gap-2">
                          <span class="shrink-0" classList={{ "text-text-base": pb.attached, "text-text-weaker": !pb.attached }}>
                            {pb.attached ? "★" : "·"}
                          </span>
                          <span class="text-12-regular min-w-0 flex-1" classList={{ "text-text-base": pb.owned, "text-text-weak": !pb.owned }}>
                            {pb.name}
                          </span>
                          <Show when={pb.hasLocal}>
                            <span class="font-mono text-11-regular text-text-weaker shrink-0">installed</span>
                          </Show>
                          <Show when={pb.attached}>
                            <span class="font-mono text-11-regular text-text-weaker shrink-0">this board</span>
                          </Show>
                        </div>
                        <Show when={pb.description}>
                          <p class="text-11-regular text-text-weak ps-4 pt-0.5 line-clamp-2">{pb.description}</p>
                        </Show>
                      </button>
                    </>
                  )}
                </For>
              </Match>

              <Match when={pane() === "integrations"}>
                <For each={rows()}>
                  {(i) => (
                    <button type="button" class="w-full text-start flex items-center gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0 cursor-pointer hover:bg-background-element" onClick={() => setOpenRow(describeRow(pane(), i))}>
                      {/* The provider mark carries the identity; the ring carries the state.
                          Twenty-five identical grey dots was a list you could not scan and
                          could not triage. */}
                      <span
                        class="iris-int__mark shrink-0"
                        classList={{
                          "iris-int__mark--live": integrationHealth(i) === "live",
                          "iris-int__mark--error": integrationHealth(i) === "error",
                          "iris-int__mark--off": integrationHealth(i) === "off",
                        }}
                        title={i.type ?? i.name}
                      >
                        {/* The real brand mark when the platform has one, the monogram when it
                            does not. The monogram sits UNDERNEATH rather than being replaced:
                            logo.dev answers 200 with its own generic glyph for an unknown name,
                            so `onerror` fires only on a network failure — and a row that loses
                            its mark to a dropped request should still say which service it is. */}
                        <Show when={i.logoUrl}>
                          <img
                            class="iris-int__logo"
                            src={i.logoUrl}
                            alt=""
                            aria-hidden="true"
                            loading="lazy"
                            decoding="async"
                            onError={(e) => e.currentTarget.remove()}
                          />
                        </Show>
                        {providerMark(i.type, i.name)}
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="block text-12-regular text-text-base truncate">{i.name}</span>
                        {/* An error says WHY here. A red mark with no reason is not actionable. */}
                        <Show when={i.lastError}>
                          <span class="block text-11-regular text-text-weaker truncate" title={i.lastError}>
                            {i.lastError}
                          </span>
                        </Show>
                      </span>
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
                          {/* `key`, not `name`. The server parse was fixed so fields arrive as
                              {key,label,type,visibility}; this line still read f.name, and
                              undefined joined by " · " is a row of separators with nothing
                              between them. The fix and the regression were the same change. */}
                          {sc.fields.map((f: any) => f.label || f.key).join(" · ")}
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
              {/* "This board is empty" and "your search matched nothing" are different facts,
                  and the first one is alarming when it is not true. */}
              <Show
                when={applied() && SEARCH_PLACEHOLDER[pane()]}
                fallback={`Nothing in ${paneLabel()}${boardScoped() ? " on this board" : ""}.`}
              >
                Nothing in {paneLabel()} matches “{applied()}”.
              </Show>
            </p>
          </Match>
        </Switch>

        {/* Logo.dev attribution. A CONDITION of the free tier, so it renders from the same
            payload that supplies the marks — the panel cannot show logos without the credit.
            The string is the platform's own, served beside the logo map. */}
        <Show when={pane() === "integrations" && (current() as any)?.attribution}>
          <p
            class="iris-attr px-2 pb-2 text-11-regular text-text-weaker"
            innerHTML={(current() as any).attribution}
          />
        </Show>

        {/* The shared footer. Says how many of how many, and offers the next page only when the
            server said there is one — never as a permanent button that sometimes does nothing. */}
        {/* No footer on the graph: it is never partial, so "39 of 39" and a dead Load more
            would both be noise. */}
        <Show when={view() === "rows" && pane() !== "graph"}>
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
