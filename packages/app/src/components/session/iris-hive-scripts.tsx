import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  startTransition,
  Suspense,
  Switch,
} from "solid-js"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import "./iris-hive-scripts.css"
import { focusHiveNode, irisHiveNodeFocus } from "./iris-nav"
import {
  ago,
  commandFor,
  computerVerdict,
  defaultComputer,
  diskCritical,
  diskOf,
  elapsedSeconds,
  fileName,
  findComputer,
  LIST_RAIL,
  listWidth,
  groupComputers,
  isTestScript,
  lastLine,
  parseCommand,
  parseHeader,
  runArgs,
  missingRequired,
  inProject,
  projectTag,
  readiness,
  readView,
  scriptsInView,
  matchesQuery,
  sortScripts,
  pageOf,
  pageHolding,
  shortAgo,
  readSort,
  type ScriptSort,
  setArgDefault,
  withTag,
  skillsOf,
  plugged,
  STAGES,
  stageStates,
  taskStatusWord,
  taskSucceeded,
  topFix,
  type Computer,
  type Doctor,
  type HiveNodeRow,
  type ScriptRow,
  type ScriptView,
  type TaskView,
  highlightLine,
  langOf,
} from "./iris-hive-scripts-model"

/**
 * Hive › Scripts (#188817): write a script, send it to one of your computers, watch it run.
 *
 * Three columns: your scripts, the script, your computers. Edit shows the header as inputs above
 * the code; Run shows the five stages the Hive records, the code, and the console. The computer
 * the run went to is marked on the right with its latest output line.
 *
 * Everything comes from the sidecar's /iris/hive/scripts* routes — the same cloud calls as
 * `iris scripts`. What is NOT here, on purpose:
 *  - which line is running: nothing reports it, so nothing is highlighted;
 *  - live output while it runs: the task carries stdout once it finishes. The hub broadcasts
 *    lines over Pusher (`user.<id>.nodes` · NodeTaskOutput) but this app has no Pusher client,
 *    so the console polls the task every second and fills in at the end;
 *  - arguments: the daemon does not pass a header's `arg=` values to the script, so the inputs
 *    edit the declared default in the source and Run sends none.
 *
 * Every view reads its resources inside its OWN <Suspense>, and switching scripts happens in a
 * transition — a resource read before its first value otherwise suspends the boundary around the
 * whole side panel (the Playbooks trap).
 */

type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type IconName = IconProps["name"]
type ScriptsPayload = { measured: boolean; reason?: string | null; scripts: ScriptRow[]; account?: number | null }
type HivePayload = { measured: boolean; reason?: string | null; nodes: HiveNodeRow[] }
type SourcePayload = {
  measured: boolean
  reason?: string | null
  script: { slug: string; runtime: string; content: string; sha256: string; updatedAt?: string } | null
}
type RunPayload = { ok: boolean; reason?: string; taskId?: string; nodeId?: string; nodeName?: string; sha256?: string | null }
type TaskPayload = { measured: boolean; reason?: string | null; task: TaskView | null }
type SavePayload = { ok: boolean; reason?: string; sha256?: string; updatedAt?: string }
type MarketRow = { slug: string; name?: string; description?: string; author?: string; version?: number; requires: string[] }
type MarketPayload = { measured: boolean; reason?: string | null; scripts: MarketRow[] }
type MarketSourcePayload = {
  measured: boolean
  reason?: string | null
  script:
    | (MarketRow & { runtime?: string; content: string; timeout?: number; egress?: string; assets: number; checks: { title: string; status: string }[] })
    | null
}
type InstallPayload = SavePayload & { assetsLeft?: number }

type RunState = {
  slug: string
  computerId: string
  computerName: string
  taskId?: string
  task: TaskView | null
  reason?: string
}

const POLL_MS = 1_000
const SELECTED_KEY = "iris.hive.scripts.slug"
const LIST_KEY = "iris.hive.scripts.list"
const VIEW_KEY = "iris.hive.scripts.view"
const SORT_KEY = "iris.hive.scripts.sort"
const VIEW_WORD: Record<ScriptView, string> = { all: "All", project: "Project", market: "Marketplace" }
const NEW_TEMPLATE = "#!/bin/bash\n# iris: timeout=120\n# What this script does, in one line.\necho \"hello from $(hostname)\"\n"

function Ic(props: { name: IconName; title?: string; class?: string }) {
  return (
    <span class={`hsc-ic ${props.class ?? ""}`} title={props.title} aria-hidden={props.title ? undefined : "true"}>
      <Icon name={props.name} size="small" />
    </span>
  )
}

// The list column: { w, closed }, remembered across launches.
const rememberedList = (): { w: number; closed: boolean } => {
  try {
    const v = JSON.parse(localStorage.getItem(LIST_KEY) ?? "{}")
    return { w: listWidth(v.w), closed: v.closed === true }
  } catch {
    return { w: listWidth(undefined), closed: false }
  }
}

const remembered = () => {
  try {
    return localStorage.getItem(SELECTED_KEY) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * `bloqId` / `bloqName` are the board the Iris tab is on — the Project view lists the scripts that
 * board has claimed.
 */
export function IrisHiveScripts(props: { doFetch: Fetch; now?: () => number; bloqId?: number; bloqName?: string }) {
  const now = () => props.now?.() ?? Date.now()
  const getJson = async <T,>(path: string, fallback: T, init?: RequestInit): Promise<T> => {
    try {
      const res = await props.doFetch(path, init)
      return (await res.json()) as T
    } catch (e) {
      // A rejected fetch must stop at this pane, not take the panel down (iris-panel-boundary).
      return { ...fallback, reason: e instanceof Error ? e.message : String(e) }
    }
  }
  const post = <T,>(path: string, body: unknown, fallback: T) =>
    getJson<T>(path, fallback, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  // ── data ─────────────────────────────────────────────────────────────────────────────────────
  const [list, { refetch: refetchList }] = createResource(() =>
    getJson<ScriptsPayload>("/iris/hive/scripts", { measured: false, scripts: [] }),
  )
  const [hive] = createResource(() => getJson<HivePayload>("/iris/hive?perPage=200", { measured: false, nodes: [] }))

  const scripts = createMemo(() => list.latest?.scripts ?? [])
  const nodes = createMemo(() => hive.latest?.nodes ?? [])
  const computers = createMemo(() => groupComputers(nodes()))
  const online = createMemo(() => computers().filter((c) => c.online))
  const offline = createMemo(() => computers().filter((c) => !c.online))
  const onlineNames = createMemo(() => new Set(nodes().filter((n) => n.online).map((n) => n.name)))
  const real = createMemo(() => scripts().filter((s) => !isTestScript(s.slug)))
  const tests = createMemo(() => scripts().filter((s) => isTestScript(s.slug)))
  const fix = createMemo(() => topFix(scripts(), onlineNames()))
  const [showTests, setShowTests] = createSignal(false)
  const [showFix, setShowFix] = createSignal(false)

  // ── All · Project · Marketplace ──────────────────────────────────────────────────────────────
  const [view, setViewRaw] = createSignal<ScriptView>(
    readView(
      (() => {
        try {
          return localStorage.getItem(VIEW_KEY)
        } catch {
          return null
        }
      })(),
    ),
  )
  const setView = (v: ScriptView) => {
    setViewRaw(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {}
  }
  const tag = () => projectTag(props.bloqId)
  const boardName = () => props.bloqName ?? "this board"

  // ── which script ─────────────────────────────────────────────────────────────────────────────
  const [slug, setSlug] = createSignal<string | undefined>(remembered())
  const [creating, setCreating] = createSignal<string | undefined>()
  const choose = (s: string, transition = true) => {
    const apply = () => {
      setCreating(undefined)
      setSlug(s)
    }
    // A transition keeps the open script on screen while the next one loads, instead of
    // suspending. ⌘K `run` needs the switch to have happened before it dispatches, so it skips it.
    if (transition) void startTransition(apply)
    else apply()
    try {
      localStorage.setItem(SELECTED_KEY, s)
    } catch {}
  }
  createEffect(() => {
    const all = scripts()
    if (!all.length || creating()) return
    const cur = slug()
    if (cur && all.some((s) => s.slug === cur)) return
    if (cur && isTestScript(cur)) return
    const ready = real().find((s) => readiness(s.doctor, onlineNames()).state === "ok")
    const first = ready ?? real()[0] ?? all[0]
    if (first) setSlug(first.slug)
  })
  const current = createMemo(() => scripts().find((s) => s.slug === slug()))
  const doctor = createMemo<Doctor | null>(() => current()?.doctor ?? null)
  const listed = createMemo(() =>
    scriptsInView(scripts(), view(), tag(), { showTests: showTests(), open: current() ? slug() : undefined }),
  )

  // ── find · sort · page ───────────────────────────────────────────────────────────────────────
  const [query, setQuery] = createSignal("")
  const [sort, setSortRaw] = createSignal<ScriptSort>(
    readSort(
      (() => {
        try {
          return localStorage.getItem(SORT_KEY)
        } catch {
          return null
        }
      })(),
    ),
  )
  const setSort = (v: ScriptSort) => {
    setSortRaw(v)
    try {
      localStorage.setItem(SORT_KEY, v)
    } catch {}
  }
  // Searching looks through the hidden test scripts too: a person typing a name wants it found.
  const found = createMemo(() => {
    const q = query().trim()
    const pool = q && view() === "all" ? scripts() : listed()
    return sortScripts(q ? pool.filter((s) => matchesQuery(s, q)) : pool, sort())
  })
  const [page, setPage] = createSignal(1)
  const shown = createMemo(() => pageOf(found(), page()))
  // A new search, view or order starts at the top.
  createEffect(on([query, view, sort], () => setPage(1), { defer: true }))
  // Opening a script from elsewhere (⌘K, a remembered pick) turns to the page that holds it.
  createEffect(
    on(slug, (s) => {
      const at = pageHolding(found(), s)
      if (at && at !== shown().page) setPage(at)
    }),
  )
  // Opening Project lands on one of the board's scripts, not on whatever All had open.
  createEffect(
    on(
      [view, () => scripts().length],
      ([v]) => {
        if (v !== "project" || creating()) return
        const l = listed()
        if (l.length && !l.some((s) => s.slug === slug())) choose(l[0].slug)
      },
      { defer: true },
    ),
  )
  const pinned = () => !!current() && inProject(current()!, tag())

  // Marketplace: fetched the first time the tab is opened, then kept.
  const [marketOpened, setMarketOpened] = createSignal(view() === "market")
  createEffect(() => view() === "market" && setMarketOpened(true))
  const [market] = createResource(
    () => marketOpened() || undefined,
    () => getJson<MarketPayload>("/iris/hive/market", { measured: false, scripts: [] }),
  )
  const [mslug, setMslug] = createSignal<string | undefined>()
  createEffect(() => {
    if (view() === "market" && !mslug()) {
      const first = market.latest?.scripts?.[0]
      if (first) setMslug(first.slug)
    }
  })
  const [msrc] = createResource(
    () => (view() === "market" ? mslug() : undefined),
    (s) => getJson<MarketSourcePayload>(`/iris/hive/market/${encodeURIComponent(s)}`, { measured: false, script: null }),
  )
  const mine = (s: string | undefined) => !!s && scripts().some((x) => x.slug === s)

  const [source, { mutate: mutateSource }] = createResource(
    () => (creating() ? undefined : slug()),
    (s) => getJson<SourcePayload>(`/iris/hive/scripts/${encodeURIComponent(s)}`, { measured: false, script: null }),
  )

  // The editor's text. `null` = untouched, i.e. what was saved.
  const [draft, setDraft] = createSignal<string | null>(null)
  createEffect(on([slug, creating], () => setDraft(null), { defer: true }))
  const saved = () => (creating() ? "" : (source.latest?.script?.content ?? ""))
  const text = () => draft() ?? (creating() ? NEW_TEMPLATE : saved())
  const dirty = () => !!creating() || (draft() !== null && draft() !== saved())
  const header = createMemo(() => parseHeader(text()))
  const runtime = () => source.latest?.script?.runtime ?? current()?.runtime ?? "bash"
  const name = () => creating() ?? slug() ?? ""
  // The hub's parse of the SAVED header first — that is what the run will be held to.
  const timeoutSec = () => (dirty() ? header().timeout : null) ?? doctor()?.timeout ?? header().timeout ?? 120

  // ── where it runs ────────────────────────────────────────────────────────────────────────────
  const [pickedId, setPickedId] = createSignal<string | undefined>()
  createEffect(on(slug, () => setPickedId(undefined), { defer: true }))
  // Machines › "Send a task" names the computer; take it once that computer is in the list.
  createEffect(() => {
    const f = irisHiveNodeFocus()
    if (!f) return
    const c = computers().find((x) => x.ids.includes(f.id))
    if (!c) return
    setPickedId(c.id)
    focusHiveNode(null)
  })
  const picked = createMemo<Computer | undefined>(() => {
    const id = pickedId()
    return (id ? online().find((c) => c.id === id) : undefined) ?? defaultComputer(computers(), doctor())
  })

  // ── mode, runs ───────────────────────────────────────────────────────────────────────────────
  const [mode, setMode] = createSignal<"edit" | "run">("edit")
  const [runs, setRuns] = createSignal<Record<string, RunState>>({})
  const run = createMemo(() => runs()[name()])
  const putRun = (r: RunState) => setRuns((all) => ({ ...all, [r.slug]: r }))
  const [tick, setTick] = createSignal(0)
  onMount(() => {
    const t = setInterval(() => setTick((n) => n + 1), POLL_MS)
    onCleanup(() => clearInterval(t))
  })
  // Poll every live run once a second. A failed read keeps the last state on screen.
  createEffect(
    on(tick, () => {
      for (const r of Object.values(runs())) {
        if (!r.taskId || r.task?.terminal) continue
        void getJson<TaskPayload>(`/iris/hive/tasks/${encodeURIComponent(r.taskId)}`, { measured: false, task: null }).then(
          (p) => {
            if (!p.task) return
            const latest = runs()[r.slug]
            if (latest?.taskId !== r.taskId) return
            putRun({ ...latest, task: p.task })
            if (p.task.terminal) void startTransition(() => void refetchList())
          },
        )
      }
    }),
  )

  // Approve or reject a run Constellation Gate held (#189589). Approving starts a NEW task —
  // the panel follows that one, so what you watch is what actually runs.
  const [deciding, setDeciding] = createSignal(false)
  // Full-screen output (#189589 follow-up): a wide table printed by a script stays in its columns.
  const [fullOutput, setFullOutput] = createSignal(false)
  onMount(() => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && fullOutput() && setFullOutput(false)
    window.addEventListener("keydown", onEsc)
    onCleanup(() => window.removeEventListener("keydown", onEsc))
  })
  const decide = async (decision: "approve" | "reject" | "cancel") => {
    const r = run()
    if (!r?.taskId) return
    setDeciding(true)
    try {
      const p = await getJson<{ measured: boolean; reason?: string; taskId: string | null }>(
        `/iris/hive/tasks/${encodeURIComponent(r.taskId)}/${decision}`,
        { measured: false, taskId: null },
        { method: "POST" },
      )
      if (!p.measured) return putRun({ ...r, reason: p.reason ?? "The decision was not recorded." })
      if (decision === "approve" && p.taskId) return putRun({ ...r, taskId: p.taskId, task: null, reason: undefined })
      const error = decision === "cancel" ? "Stopped — the computer was told to end it." : "Rejected — it never ran."
      putRun({ ...r, task: r.task ? { ...r.task, held: false, terminal: true, status: "cancelled", error } : null })
    } finally {
      setDeciding(false)
    }
  }

  const [busy, setBusy] = createSignal<"save" | "run" | undefined>()
  const [note, setNote] = createSignal<string | undefined>()
  const [savedAt, setSavedAt] = createSignal<string | undefined>()

  const save = async (): Promise<boolean> => {
    const s = name()
    if (!s) return false
    setBusy("save")
    setNote(undefined)
    const body = text()
    // A script written in Project is the board's from the start.
    const claim = creating() && view() === "project" && tag() ? { tags: [tag()!] } : {}
    const r = await post<SavePayload>(`/iris/hive/scripts/${encodeURIComponent(s)}/save`, { content: body, ...claim }, { ok: false })
    setBusy(undefined)
    if (!r.ok) {
      setNote(`Not saved — ${r.reason ?? "the sidecar did not answer"}`)
      return false
    }
    setSavedAt(r.updatedAt ?? new Date(now()).toISOString())
    const wasNew = creating()
    mutateSource({ measured: true, script: { slug: s, runtime: runtime(), content: body, sha256: r.sha256 ?? "", updatedAt: r.updatedAt } })
    setDraft(null)
    if (wasNew) {
      setCreating(undefined)
      setSlug(s)
    }
    void startTransition(() => void refetchList())
    return true
  }

  const [pinning, setPinning] = createSignal(false)
  const togglePin = async () => {
    const c = current()
    const t = tag()
    if (!c || !t || pinning()) return
    setPinning(true)
    setNote(undefined)
    const r = await post<SavePayload>(
      `/iris/hive/scripts/${encodeURIComponent(c.slug)}/tags`,
      { tags: withTag(c.tags, t, !pinned()) },
      { ok: false },
    )
    if (!r.ok) setNote(`Not changed — ${r.reason ?? "the sidecar did not answer"}`)
    else await refetchList()
    setPinning(false)
  }

  const [installing, setInstalling] = createSignal(false)
  const install = async () => {
    const s = mslug()
    if (!s || installing()) return
    setInstalling(true)
    setNote(undefined)
    const r = await post<InstallPayload>(`/iris/hive/market/${encodeURIComponent(s)}/install`, {}, { ok: false })
    if (!r.ok) {
      setInstalling(false)
      return setNote(`Not added — ${r.reason ?? "the sidecar did not answer"}`)
    }
    await refetchList()
    setInstalling(false)
    setView("all")
    choose(s)
    if (r.assetsLeft) setNote(`Added. Its ${r.assetsLeft} attached file${r.assetsLeft === 1 ? " was" : "s were"} not copied.`)
  }

  // A script's settings for the next run (#189589), per script: what was typed or picked, else
  // the declared default. Sent with the run; the computer receives them as IRIS_ARG_<NAME>.
  const [argValues, setArgValues] = createSignal<Record<string, Record<string, string>>>({})
  const valuesFor = () => argValues()[name()] ?? {}
  const setArgValue = (k: string, v: string) => setArgValues((all) => ({ ...all, [name()]: { ...(all[name()] ?? {}), [k]: v } }))
  const valueOf = (a: { name: string; default?: string }) => valuesFor()[a.name] ?? a.default ?? ""

  const runOn = async (target: Computer | undefined, extra?: Record<string, string>) => {
    const s = name()
    if (!s || !target) return
    if (dirty() && !(await save())) return
    const values = { ...valuesFor(), ...(extra ?? {}) }
    const missing = missingRequired(header().args, values)
    setMode("run")
    if (missing.length) {
      putRun({ slug: s, computerId: target.id, computerName: target.name, task: null, reason: `Fill in ${missing.join(", ")} first — the script requires ${missing.length === 1 ? "it" : "them"}.` })
      return
    }
    const args = runArgs(header().args, values)
    setBusy("run")
    putRun({ slug: s, computerId: target.id, computerName: target.name, task: null })
    const r = await post<RunPayload>(
      `/iris/hive/scripts/${encodeURIComponent(s)}/run`,
      { node: target.id, timeout: timeoutSec(), ...(Object.keys(args).length ? { args } : {}) },
      { ok: false },
    )
    setBusy(undefined)
    if (!r.ok || !r.taskId) {
      putRun({ slug: s, computerId: target.id, computerName: target.name, task: null, reason: r.reason ?? "Dispatch failed" })
      return
    }
    putRun({ slug: s, computerId: target.id, computerName: r.nodeName ?? target.name, taskId: r.taskId, task: null })
  }

  const ready = createMemo(() => readiness(doctor(), onlineNames()))
  const canRun = () => !!picked() && computerVerdict(picked()!, doctor()).can !== false && busy() === undefined
  const runTitle = () => {
    if (!picked()) return ready().state === "blocked" ? (ready().fix ?? ready().label) : "No computer is online"
    const v = computerVerdict(picked()!, doctor())
    if (v.can === false) return `${picked()!.name} can't run it — ${v.why ?? ""}`
    return `Run on ${picked()!.name}${dirty() ? " (saves first — a computer runs the saved version)" : ""}`
  }

  // ── ⌘K ───────────────────────────────────────────────────────────────────────────────────────
  let cmdEl: HTMLInputElement | undefined
  let rootEl: HTMLDivElement | undefined
  const [cmd, setCmd] = createSignal("")
  const [cmdError, setCmdError] = createSignal<string | undefined>()
  const argDefaults = () => Object.fromEntries(header().args.map((a) => [a.name, a.default ?? ""]))
  const hint = () => (name() ? commandFor(name(), argDefaults(), picked()?.name) : "run <script> on <computer>")
  const runCommand = () => {
    const parsed = parseCommand(cmd() || hint())
    if (!parsed) return setCmdError("Try: run <script> name=value on <computer>")
    const target = scripts().find((s) => s.slug === parsed.slug)
    if (!target && parsed.slug !== name()) return setCmdError(`No script named ${parsed.slug}`)
    setCmdError(undefined)
    if (parsed.slug !== name()) choose(parsed.slug, parsed.verb !== "run")
    if (parsed.verb === "edit") return setMode("edit")
    if (parsed.verb === "open") return
    const where = parsed.node ? findComputer(computers(), parsed.node) : undefined
    if (parsed.node && !where) return setCmdError(`No computer named ${parsed.node}`)
    if (where && !where.online) return setCmdError(`${where.name} is offline`)
    if (where) setPickedId(where.id)
    // `run mambo mode=hop`: the typed settings are remembered for this script and sent.
    for (const [k, v] of Object.entries(parsed.args)) setArgValue(k, v)
    setCmd("")
    // Wait for the chosen script's doctor to be current before picking a default computer.
    queueMicrotask(() => void runOn(where ?? picked(), parsed.args))
  }
  // ⌘K inside this tab focuses the field. Window capture runs before the app's palette listener
  // (document capture), and only when focus is already in this pane — elsewhere ⌘K is the palette.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k" || e.shiftKey || e.altKey) return
      if (!rootEl || !(e.target instanceof Node) || !rootEl.contains(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      cmdEl?.focus()
      cmdEl?.select()
    }
    window.addEventListener("keydown", onKey, { capture: true })
    onCleanup(() => window.removeEventListener("keydown", onKey, { capture: true }))
  })

  // ── new script ───────────────────────────────────────────────────────────────────────────────
  const [naming, setNaming] = createSignal(false)
  const startNew = (raw: string) => {
    const s = raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
    setNaming(false)
    if (!s) return
    if (scripts().some((x) => x.slug === s)) return choose(s)
    setCreating(s)
    setMode("edit")
  }

  const stages = createMemo(() => stageStates(run()?.task))
  const elapsed = createMemo(() => {
    tick()
    return elapsedSeconds(run()?.task, now())
  })

  const [listW, setListW] = createSignal(rememberedList().w)
  const [listClosed, setListClosed] = createSignal(rememberedList().closed)
  const [dragging, setDragging] = createSignal(false)
  createEffect(() => {
    const v = JSON.stringify({ w: listW(), closed: listClosed() })
    try {
      localStorage.setItem(LIST_KEY, v)
    } catch {}
  })
  // Drag the edge to size the list; dragging it shut closes it, dragging a closed one opens it.
  const startDrag = (e: PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const x0 = e.clientX
    const w0 = listClosed() ? LIST_RAIL : listW()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    setDragging(true)
    const move = (m: PointerEvent) => {
      const raw = w0 + m.clientX - x0
      if (raw < LIST_RAIL + 40) return setListClosed(true)
      setListClosed(false)
      setListW(listWidth(raw))
    }
    const up = () => {
      setDragging(false)
      el.removeEventListener("pointermove", move)
      el.removeEventListener("pointerup", up)
      el.removeEventListener("pointercancel", up)
    }
    el.addEventListener("pointermove", move)
    el.addEventListener("pointerup", up)
    el.addEventListener("pointercancel", up)
  }
  const dragKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 40 : 10
    if (e.key === "ArrowLeft") {
      if (listClosed()) return
      if (listW() - step < listWidth(0)) return setListClosed(true)
      setListW(listWidth(listW() - step))
    } else if (e.key === "ArrowRight") {
      if (listClosed()) return setListClosed(false)
      setListW(listWidth(listW() + step))
    } else if (e.key === "Enter") setListClosed((v) => !v)
    else return
    e.preventDefault()
  }

  return (
    <div class="hsc-wrap" ref={rootEl}>
    <div
      class="hsc"
      classList={{ "hsc--closed": listClosed(), "hsc--drag": dragging() }}
      style={{ "--hsc-lw": `${listClosed() ? LIST_RAIL : listW()}px` }}
      data-mode={mode()}
      data-component="hive-scripts"
    >
      {/* ── left: scripts ── */}
      <aside class="hsc-col hsc-list" aria-label="Scripts">
        <div class="hsc-lhead">
          <button
            class="hsc-ib hsc-ib--bare hsc-fold"
            type="button"
            title={listClosed() ? "Show scripts" : "Hide scripts"}
            aria-expanded={!listClosed()}
            onClick={() => setListClosed((v) => !v)}
          >
            <Ic name={listClosed() ? "sidebar" : "sidebar-active"} />
          </button>
          <b class="hsc-lname">Scripts</b>
          <Show when={list.latest?.account}>
            <span
              class="hsc-acct hsc-num"
              title={`Scripts and computers belong to an IRIS account. This is account ${list.latest!.account}.`}
            >
              #{list.latest!.account}
            </span>
          </Show>
          <span class="hsc-spacer" />
          <button
            class="hsc-ib hsc-ib--bare"
            type="button"
            title="New script"
            onClick={() => {
              setListClosed(false)
              if (view() === "market") setView("all")
              setNaming(true)
            }}
          >
            <Ic name="plus" />
          </button>
        </div>
        <Show when={!listClosed()}>
        <div class="hsc-views" role="tablist" aria-label="Which scripts">
          <For each={["all", "project", "market"] as ScriptView[]}>
            {(v) => (
              <button
                type="button"
                role="tab"
                aria-selected={view() === v}
                title={
                  v === "all"
                    ? "Every script on your account"
                    : v === "project"
                      ? `The scripts ${boardName()} uses`
                      : "Public scripts anyone can add"
                }
                onClick={() => setView(v)}
              >
                {VIEW_WORD[v]}
              </button>
            )}
          </For>
        </div>
        <div class="hsc-find">
          <Ic name="magnifying-glass" />
          <input
            type="search"
            placeholder="Search"
            aria-label="Search scripts"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query()) {
                e.stopPropagation()
                setQuery("")
              }
              if (e.key === "Enter" && shown().rows[0]) choose(shown().rows[0].slug)
            }}
          />
          <Show when={query()}>
            <button type="button" class="hsc-ib" title="Clear search" aria-label="Clear search" onClick={() => setQuery("")}>
              <Ic name="close-small" />
            </button>
          </Show>
          <Show when={view() !== "market"}>
            <button
              type="button"
              class="hsc-ib hsc-sort"
              title={sort() === "recent" ? "Newest edit first — sort A–Z instead" : "A–Z — sort by newest edit instead"}
              aria-label={sort() === "recent" ? "Sorted by last edited" : "Sorted by name"}
              onClick={() => setSort(sort() === "recent" ? "name" : "recent")}
            >
              <Ic name={sort() === "recent" ? "clock" : "arrow-down-to-line"} />
              <span class="hsc-num">{sort() === "recent" ? "Recent" : "A–Z"}</span>
            </button>
          </Show>
        </div>
        <Show when={naming()}>
          <input
            class="hsc-newname hsc-mono"
            placeholder="new-script-name"
            aria-label="New script name"
            autofocus
            onKeyDown={(e) => {
              if (e.key === "Enter") startNew(e.currentTarget.value)
              if (e.key === "Escape") setNaming(false)
            }}
            onBlur={(e) => startNew(e.currentTarget.value)}
          />
        </Show>
        <Suspense fallback={<p class="hsc-muted hsc-pad">Reading…</p>}>
          <Show when={list() && !list()!.measured}>
            <p class="hsc-warn hsc-pad" title={list()!.reason ?? undefined}>
              Could not read your scripts{list()!.reason ? ` — ${list()!.reason}` : ""}
            </p>
          </Show>
          <Show when={view() === "all" && list() && list()!.measured && scripts().length === 0 && !creating()}>
            <p class="hsc-muted hsc-pad">No scripts on account {list()!.account ?? "?"} yet. Press + to write one.</p>
          </Show>
          <Show when={view() === "project" && !creating() && listed().length === 0}>
            <p class="hsc-muted hsc-pad hsc-empty">
              {tag()
                ? `${boardName()} has no scripts yet. Open one in All and pin it, or press + to write one here.`
                : "Pick a board to see the scripts it uses."}
            </p>
          </Show>
          <Show when={view() !== "market"}>
          <ul class="hsc-ilist" role="listbox">
            <Show when={creating()}>
              <li class="on" aria-selected="true" title="Not saved yet">
                <span class="hsc-mono">{creating()}</span>
                <i class="hsc-dot hsc-dot--draft" />
              </li>
            </Show>
            {/* A test script opened from ⌘K stays visible while it is open. */}
            <For each={shown().rows}>
              {(s) => {
                const r = () => readiness(s.doctor, onlineNames())
                return (
                  <li
                    role="option"
                    aria-selected={s.slug === slug() && !creating()}
                    classList={{
                      on: s.slug === slug() && !creating(),
                      bl: r().state === "blocked",
                      unk: r().state === "unknown",
                    }}
                    title={r().state === "blocked" ? (r().fix ?? r().label) : r().label}
                    tabIndex={0}
                    onClick={() => choose(s.slug)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && choose(s.slug)}
                  >
                    <span class="hsc-mono">{s.slug}</span>
                    <Show when={view() === "all" && inProject(s, tag())}>
                      <Ic name="pin" class="hsc-jade" title={`In ${boardName()}`} />
                    </Show>
                    <Show when={r().state === "blocked"}>
                      <Ic name="lock" class="hsc-amber" />
                    </Show>
                    <time class="hsc-age hsc-num" datetime={s.updatedAt} title={s.updatedAt ? `Edited ${ago(s.updatedAt, now())}` : "Never edited here"}>
                      {shortAgo(s.updatedAt, now())}
                    </time>
                  </li>
                )
              }}
            </For>
          </ul>
          <Show when={query().trim() && found().length === 0}>
            <p class="hsc-muted hsc-pad">Nothing matches “{query().trim()}”.</p>
          </Show>
          <Show when={shown().pages > 1}>
            <nav class="hsc-pager" aria-label="Pages of scripts">
              <button
                type="button"
                class="hsc-ib"
                aria-label="Previous page"
                disabled={shown().page <= 1}
                onClick={() => setPage(shown().page - 1)}
              >
                <Ic name="chevron-left" />
              </button>
              <span class="hsc-num">
                {shown().from}–{shown().to} of {shown().total}
              </span>
              <button
                type="button"
                class="hsc-ib"
                aria-label="Next page"
                disabled={shown().page >= shown().pages}
                onClick={() => setPage(shown().page + 1)}
              >
                <Ic name="chevron-right" />
              </button>
            </nav>
          </Show>
          </Show>
          <Show when={view() === "market"}>
            <Show when={market() && !market()!.measured}>
              <p class="hsc-warn hsc-pad" title={market()!.reason ?? undefined}>
                Could not reach the marketplace
              </p>
            </Show>
            <ul class="hsc-ilist" role="listbox" aria-label="Public scripts">
              <For each={(market.latest?.scripts ?? []).filter((m) => matchesQuery(m, query()))}>
                {(m) => (
                  <li
                    role="option"
                    aria-selected={m.slug === mslug()}
                    classList={{ on: m.slug === mslug() }}
                    title={m.description ?? m.name ?? m.slug}
                    tabIndex={0}
                    onClick={() => setMslug(m.slug)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setMslug(m.slug)}
                  >
                    <span class="hsc-mono">{m.slug}</span>
                    <Show when={mine(m.slug)}>
                      <Ic name="check" class="hsc-jade" title="Already in your scripts" />
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={view() === "all" && tests().length && !query().trim()}>
            <button
              class="hsc-more hsc-num"
              type="button"
              aria-pressed={showTests()}
              title={showTests() ? "Hide the Hive's own test scripts" : `${tests().length} test scripts hidden — show them`}
              onClick={() => setShowTests((v) => !v)}
            >
              {showTests() ? "hide tests" : `+${tests().length} tests`}
            </button>
          </Show>
        </Suspense>
        </Show>
      </aside>
      <div
        class="hsc-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the script list"
        aria-valuenow={listClosed() ? 0 : listW()}
        title="Drag to resize · double-click to hide or show"
        tabIndex={0}
        onPointerDown={startDrag}
        onDblClick={() => setListClosed((v) => !v)}
        onKeyDown={dragKey}
      />

      {/* ── middle: the script ── */}
      <section class="hsc-col hsc-ed" aria-label="Script">
        <form
          class="hsc-cmdk"
          onSubmit={(e) => {
            e.preventDefault()
            runCommand()
          }}
        >
          <Ic name="arrow-right" />
          <input
            ref={cmdEl}
            class="hsc-mono"
            value={cmd()}
            placeholder={hint()}
            aria-label="Command"
            spellcheck={false}
            onInput={(e) => {
              setCmd(e.currentTarget.value)
              setCmdError(undefined)
            }}
          />
          <kbd title="Focus this field from anywhere in the Scripts tab">⌘K</kbd>
        </form>
        <Show when={cmdError()}>
          <p class="hsc-warn">{cmdError()}</p>
        </Show>

        <Show when={view() === "market"}>
          <Suspense fallback={<p class="hsc-muted hsc-pad">Reading…</p>}>
            <Show when={mslug()} fallback={<p class="hsc-muted hsc-pad">Pick a public script to read it.</p>}>
              <Show
                when={msrc()?.script}
                fallback={<p class="hsc-warn">Could not read {mslug()}{msrc()?.reason ? ` — ${msrc()!.reason}` : ""}</p>}
              >
                {(m) => (
                  <>
                    <div class="hsc-edbar">
                      <span class="hsc-file hsc-mono">{fileName(m().slug, m().runtime)}</span>
                      <span class="hsc-chip" title={`Published by ${m().author ?? "someone"}`}>
                        <Ic name="globe" />
                        {m().author ?? "—"}
                      </span>
                      <Show when={m().version}>
                        <span class="hsc-chip hsc-num" title="Published version">
                          v{m().version}
                        </span>
                      </Show>
                      <span class="hsc-spacer" />
                      <Show
                        when={!mine(m().slug)}
                        fallback={
                          <button
                            class="hsc-run"
                            type="button"
                            title="You already have a script by this name"
                            onClick={() => {
                              setView("all")
                              choose(m().slug)
                            }}
                          >
                            <Ic name="pencil-line" />
                            Open mine
                          </button>
                        }
                      >
                        <button
                          class="hsc-run hsc-run--add"
                          type="button"
                          disabled={installing()}
                          title="Copy it to your scripts — then you can edit it and run it on your computers"
                          onClick={() => void install()}
                        >
                          <Ic name="plus" />
                          {installing() ? "Adding…" : "Add to my scripts"}
                        </button>
                      </Show>
                    </div>
                    <Show when={note()}>
                      <p class="hsc-warn">{note()}</p>
                    </Show>
                    <Show when={m().description}>
                      <p class="hsc-mdesc">{m().description}</p>
                    </Show>
                    <div class="hsc-argrow">
                      <Show when={m().timeout}>
                        <span class="hsc-chip" title={`Stops after ${m().timeout} seconds`}>
                          <Ic name="clock" />
                          <b class="hsc-num">{m().timeout}s</b>
                        </span>
                      </Show>
                      <For each={m().checks}>
                        {(c) => (
                          <span
                            class="hsc-chip"
                            classList={{ "hsc-chip--ok": c.status === "pass", "hsc-chip--warn": c.status !== "pass" }}
                            title={c.status === "pass" ? "Checked" : "Worth a look before you run it"}
                          >
                            <Ic name={c.status === "pass" ? "check" : "lock"} />
                            {c.title}
                          </span>
                        )}
                      </For>
                      <Show when={m().assets}>
                        <span class="hsc-chip hsc-chip--warn" title="Adding it copies the source, not these files">
                          {m().assets} attached file{m().assets === 1 ? "" : "s"}
                        </span>
                      </Show>
                    </div>
                    <CodeView value={m().content} headerLines={parseHeader(m().content).lines} runtime={m().runtime} />
                  </>
                )}
              </Show>
            </Show>
          </Suspense>
        </Show>
        <Show
          when={view() !== "market" && name()}
          fallback={
            <Show when={view() !== "market"}>
              <p class="hsc-muted hsc-pad">Pick a script, or press + to write one.</p>
            </Show>
          }
        >
          <div class="hsc-edbar">
            <span class="hsc-file hsc-mono">{fileName(name(), runtime())}</span>
            <i
              class="hsc-dot"
              classList={{ "hsc-dot--saved": !dirty(), "hsc-dot--draft": dirty() }}
              title={
                dirty()
                  ? creating()
                    ? "Not saved yet"
                    : "Unsaved changes"
                  : `Saved ${ago(savedAt() ?? source.latest?.script?.updatedAt ?? current()?.updatedAt, now())}`
              }
            />
            <span class="hsc-seg" role="group" aria-label="View">
              <button type="button" title="Edit" aria-pressed={mode() === "edit"} onClick={() => setMode("edit")}>
                <Ic name="pencil-line" />
              </button>
              <button type="button" title="Run view" aria-pressed={mode() === "run"} onClick={() => setMode("run")}>
                <Ic name="terminal" />
              </button>
            </span>
            <span class="hsc-spacer" />
            <Show when={tag() && current() && !creating()}>
              <button
                class="hsc-ib hsc-pin"
                classList={{ "hsc-ib--on": pinned() }}
                type="button"
                aria-pressed={pinned()}
                disabled={pinning()}
                title={pinned() ? `In ${boardName()} — click to take it out` : `Add to ${boardName()}`}
                onClick={() => void togglePin()}
              >
                <Ic name="pin" />
              </button>
            </Show>
            <button
              class="hsc-ib hsc-save"
              classList={{ "hsc-save--due": dirty() && busy() === undefined }}
              type="button"
              title={busy() === "save" ? "Saving…" : dirty() ? "Save (iris scripts push)" : "Saved"}
              disabled={!dirty() || busy() !== undefined}
              onClick={() => void save()}
            >
              <Ic name="save" />
            </button>
            <button class="hsc-run" type="button" title={runTitle()} disabled={!canRun()} onClick={() => void runOn(picked())}>
              <Ic name="play" />
              Run
            </button>
          </div>
          <Show when={note()}>
            <p class="hsc-warn">{note()}</p>
          </Show>

          <Suspense fallback={<p class="hsc-muted hsc-pad">Reading the script…</p>}>
            <Show when={!creating() && source() && !source()!.script}>
              <p class="hsc-warn">Could not read {name()}{source()!.reason ? ` — ${source()!.reason}` : ""}</p>
            </Show>
            <Switch>
              <Match when={mode() === "edit"}>
                <div class="hsc-argrow">
                  <For each={header().args}>
                    {(a) => (
                      <label
                        class="hsc-arg"
                        title={`Declared default (# iris: arg=${a.name}). Editing it edits that header line. The computer does not receive arguments yet — the script runs with its own fallback.`}
                      >
                        <span>{a.name}</span>
                        <input
                          class="hsc-mono"
                          value={a.default ?? ""}
                          placeholder={a.required ? "required" : "—"}
                          onChange={(e) => setDraft(setArgDefault(text(), a.name, e.currentTarget.value))}
                        />
                      </label>
                    )}
                  </For>
                  <span class="hsc-chip" title={`Stops the run after ${timeoutSec()} seconds`}>
                    <Ic name="clock" />
                    <b class="hsc-num">{timeoutSec()}s</b>
                  </span>
                  <span
                    class="hsc-chip"
                    title={
                      doctor()?.requires?.length
                        ? `Needs: ${doctor()!.requires!.join(", ")}`
                        : "Declares no special needs — any computer can run it"
                    }
                  >
                    <Ic name="chip" />
                    {doctor()?.requires?.length ? doctor()!.requires!.join(" · ") : "any"}
                  </span>
                  <Show when={doctor()?.manifest_errors?.length}>
                    <span class="hsc-chip hsc-chip--warn" title={doctor()!.manifest_errors!.join("\n")}>
                      <Ic name="warning" />
                      header ignored
                    </span>
                  </Show>
                </div>
                <CodeEditor value={text()} onInput={setDraft} headerLines={header().lines} />
              </Match>
              <Match when={mode() === "run"}>
                <ol class="hsc-track" aria-label="Stages">
                  <For each={STAGES}>
                    {(s) => {
                      const at = () => run()?.task?.[s.field]
                      return (
                        <li
                          data-state={stages()[s.id]}
                          title={`${s.label}${at() ? ` · ${new Date(at()!).toLocaleTimeString()}` : ""}`}
                        >
                          <i>
                            <Ic name={s.icon as IconName} />
                          </i>
                          <b>{s.label}</b>
                        </li>
                      )
                    }}
                  </For>
                </ol>
                <CodeView value={text()} headerLines={header().lines} runtime={runtime()} />
                <div class="hsc-console" data-state={run()?.task?.terminal ? "done" : run() ? "live" : "idle"} data-full={fullOutput() ? "" : undefined}>
                  <div class="hsc-chead">
                    <span
                      class="hsc-rstat"
                      data-ok={run()?.task?.terminal ? String(taskSucceeded(run()!.task)) : run()?.reason ? "false" : undefined}
                    >
                      <i />
                      <b>{run()?.reason ? "Not sent" : taskStatusWord(run()?.task)}</b>
                    </span>
                    {/* A script's settings (#189589): edit them here for the next run. A setting
                        with choices is a dropdown; a required one is marked until it has a value. */}
                    <For each={header().args}>
                      {(a) => (
                        <label class="hsc-setting" data-required={a.required && !valueOf(a) ? "" : undefined} title={a.required ? `${a.name} is required` : `Sent to the script as IRIS_ARG_${a.name.toUpperCase()}`}>
                          <span>{a.name}</span>
                          <Show
                            when={a.choices}
                            fallback={
                              <input
                                class="hsc-mono"
                                data-action="hive-setting"
                                value={valueOf(a)}
                                placeholder={a.required ? "required" : "—"}
                                onInput={(e) => setArgValue(a.name, e.currentTarget.value)}
                                size={Math.max(6, Math.min(24, valueOf(a).length + 1))}
                              />
                            }
                          >
                            <select class="hsc-mono" data-action="hive-setting" value={valueOf(a)} onChange={(e) => setArgValue(a.name, e.currentTarget.value)}>
                              <For each={a.choices}>{(c) => <option value={c}>{c}</option>}</For>
                            </select>
                          </Show>
                        </label>
                      )}
                    </For>
                    <span class="hsc-spacer" />
                    {/* Stop (#189589 follow-up): any run of yours that has not finished, including one
                        Gate is holding. The hub cancels it and tells the computer to end it. */}
                    <Show when={run()?.taskId && run()?.task && !run()!.task!.terminal}>
                      <button
                        type="button"
                        class="hsc-run hsc-run--stop"
                        data-action="hive-stop"
                        disabled={deciding()}
                        onClick={() => void decide("cancel")}
                        title="Stop this run on the computer"
                      >
                        <Ic name="stop" /> {deciding() ? "Stopping…" : "Stop"}
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="hsc-ib"
                      data-action="hive-output-full"
                      aria-pressed={fullOutput()}
                      title={fullOutput() ? "Exit full screen (Esc)" : "Full screen — long lines stay on one line"}
                      onClick={() => setFullOutput((v) => !v)}
                    >
                      <Ic name={fullOutput() ? "collapse" : "expand"} />
                    </button>
                    <span class="hsc-num hsc-clock" title="Since it was queued">
                      {elapsed().toFixed(1)} s
                    </span>
                  </div>
                  <div class="hsc-fbar" title={`Time used of the ${timeoutSec()} s limit`}>
                    <i style={{ width: `${Math.min(100, (elapsed() / timeoutSec()) * 100).toFixed(1)}%` }} />
                  </div>
                  <div class="hsc-term hsc-mono" aria-live="polite">
                    <Show when={run()} fallback={<div class="hsc-dim">Press Run to send {name()} to {picked()?.name ?? "a computer"}.</div>}>
                      <Show when={run()!.reason}>
                        <div class="hsc-err">{run()!.reason}</div>
                      </Show>

                      <Show when={run()!.task?.held}>
                        <div class="hsc-gate-held" data-action="hive-gate-held">
                          <div class="hsc-gate-title">Held by Constellation Gate — not sent</div>
                          <div>{run()!.task!.gate?.explanation || "This run needs your approval before it can start."}</div>
                          <Show when={run()!.task!.gate?.score != null && run()!.task!.gate?.reasons.includes("flagged")}>
                            <div class="hsc-dim">risk {run()!.task!.gate!.score!.toFixed(2)}</div>
                          </Show>
                          <div class="hsc-gate-actions">
                            <button type="button" class="hsc-run" disabled={deciding()} onClick={() => void decide("approve")}>
                              {deciding() ? "Sending…" : "Approve and run"}
                            </button>
                            <button type="button" class="hsc-run hsc-run--ghost" disabled={deciding()} onClick={() => void decide("reject")}>
                              Reject
                            </button>
                          </div>
                        </div>
                      </Show>
                      <Show when={run()!.task && !run()!.task!.terminal && !run()!.task!.held}>
                        <div class="hsc-dim">Output arrives when the run finishes.</div>
                      </Show>
                      <For each={(run()!.task?.stdout ?? "").split("\n").filter(Boolean)}>{(l) => <div>{l}</div>}</For>
                      <For each={(run()!.task?.stderr ?? "").split("\n").filter(Boolean)}>
                        {(l) => <div class="hsc-err">{l}</div>}
                      </For>
                      <Show when={run()!.task?.terminal}>
                        <div class="hsc-dim hsc-num">
                          {run()!.task!.exitCode != null
                            ? `exit ${run()!.task!.exitCode}${run()!.task!.exitCodeSource === "error_text" ? " (inferred)" : ""}`
                            : run()!.task!.status}
                          {" · "}
                          {elapsed().toFixed(0)} s · {run()!.computerName}
                        </div>
                        <Show when={run()!.task!.error}>
                          <div class="hsc-err">{run()!.task!.error}</div>
                        </Show>
                      </Show>
                    </Show>
                  </div>
                </div>
              </Match>
            </Switch>
          </Suspense>
        </Show>
      </section>

      {/* ── right: computers ── */}
      <aside class="hsc-col hsc-where" classList={{ "hsc-where--market": view() === "market" }} aria-label="Computers">
        <h5>
          <Ic name="server" />
          {mode() === "run" && run() ? "Sent to" : "Run on"}
        </h5>
        <Suspense fallback={<p class="hsc-muted">Reading…</p>}>
          <Show when={hive() && !hive()!.measured}>
            <p class="hsc-warn" title={hive()!.reason ?? undefined}>
              Could not see your computers
            </p>
          </Show>
          <Show when={view() === "market"}>
            <p class="hsc-muted hsc-empty">Add it to your scripts to run it on one of these.</p>
          </Show>
          <Show when={hive() && hive()!.measured && online().length === 0 && offline().length === 0}>
            <p class="hsc-muted hsc-empty">
              No computers on account {list.latest?.account ?? "?"}. A computer shows up here once its Hive is on and
              signed in to this account.
            </p>
          </Show>
          <For each={online()}>
            {(c) => {
              const v = () => computerVerdict(c, doctor())
              const isRun = () => mode() === "run" && run()?.computerId !== undefined && c.ids.includes(run()!.computerId)
              const sel = () =>
                view() === "market" ? false : isRun() ? true : mode() === "edit" || !run() ? picked()?.id === c.id : false
              const d = diskOf(c)
              return (
                <div
                  class="hsc-cc"
                  classList={{ go: sel(), no: v().can === false, live: isRun() && !run()?.task?.terminal }}
                  role="button"
                  tabIndex={0}
                  aria-pressed={sel()}
                  onClick={() => v().can !== false && setPickedId(c.id)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && v().can !== false && setPickedId(c.id)}
                >
                  <div class="hsc-ccl">
                    <i class="hsc-dot hsc-dot--on" />
                    <b title={c.names.join(" · ")}>{c.name}</b>
                    <Show when={c.regs > 1}>
                      <span class="hsc-x hsc-num" title={`Registered ${c.regs} times — the same computer`}>
                        ×{c.regs}
                      </span>
                    </Show>
                    <span class="hsc-spacer" />
                    <Show when={d && diskCritical(c)}>
                      <span class="hsc-dk" title={`Disk almost full — ${d!.free.toFixed(1)} GB free of ${d!.total.toFixed(0)} GB`}>
                        <Ic name="disk" />
                        <b class="hsc-num">{d!.free.toFixed(1)} GB</b>
                      </span>
                    </Show>
                  </div>
                  <Show when={plugged(c).length}>
                    <div class="hsc-cams" title="Plugged-in camera, reported by this computer's Hive">
                      <For each={plugged(c)}>
                        {(n) => (
                          <span class="hsc-cam">
                            <Ic name="camera" />
                            {n}
                          </span>
                        )}
                      </For>
                    </div>
                  </Show>
                  <div class="hsc-ccs">
                    <span class="hsc-skills">
                      <For each={skillsOf(c)}>{(s) => <Ic name={s.icon as IconName} title={s.word} class="hsc-skill" />}</For>
                    </span>
                    <span class="hsc-cctag" title={v().can === false ? v().why : undefined}>
                      <Switch fallback={<>Can run it</>}>
                        <Match when={isRun()}>
                          <Ic name="check" />
                          {run()?.task?.terminal ? "Ran here" : "Running here"}
                        </Match>
                        <Match when={v().can === false}>
                          <Ic name="lock" />
                          Can't run it
                        </Match>
                        <Match when={sel()}>
                          <Ic name="check" />
                          Selected
                        </Match>
                      </Switch>
                    </span>
                  </div>
                  <Show when={!isRun() && v().can === false && v().why}>
                    <div class="hsc-why" data-action="hive-cant-run-why">{v().why}</div>
                  </Show>
                  <Show when={isRun() && lastLine(run()?.task?.stdout)}>
                    <div class="hsc-dlog hsc-mono">{lastLine(run()?.task?.stdout)}</div>
                  </Show>
                </div>
              )
            }}
          </For>
          <Show when={offline().length}>
            <div
              class="hsc-offrow"
              title={offline()
                .map((c) => `${c.name} — seen ${ago(c.lastHeartbeat, now())}`)
                .join("\n")}
            >
              <i class="hsc-dot hsc-dot--off" />
              <b class="hsc-num">{offline().length}</b> offline
            </div>
          </Show>
          <Show when={fix()}>
            <button class="hsc-fixrow" type="button" title={fix()!.fix} aria-expanded={showFix()} onClick={() => setShowFix((v) => !v)}>
              <Ic name="lock" class="hsc-amber" />
              <span class="hsc-fixtext">
                <b class="hsc-num">{fix()!.slugs.length}</b> scripts wait on one fix
              </span>
              <Ic name={showFix() ? "chevron-down" : "arrow-right"} />
            </button>
            <Show when={showFix()}>
              <div class="hsc-fixbody">
                <p>{fix()!.fix}.</p>
                <p class="hsc-muted hsc-mono">{fix()!.slugs.join(" · ")}</p>
              </div>
            </Show>
          </Show>
        </Suspense>
      </aside>
    </div>
    </div>
  )
}

/** A textarea with a line-number gutter that scrolls with it. No editor dependency. */
function CodeEditor(props: { value: string; onInput: (v: string) => void; headerLines: number[] }) {
  let gutter: HTMLDivElement | undefined
  const count = () => Math.max(1, props.value.split("\n").length)
  return (
    <div class="hsc-code hsc-code--edit">
      <div class="hsc-gutter hsc-num" ref={gutter} aria-hidden="true">
        <For each={Array.from({ length: count() }, (_, i) => i + 1)}>
          {(n) => <span classList={{ h: props.headerLines.includes(n) }}>{n}</span>}
        </For>
      </div>
      <textarea
        class="hsc-mono"
        value={props.value}
        spellcheck={false}
        aria-label="Script source"
        wrap="off"
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onScroll={(e) => gutter && (gutter.scrollTop = e.currentTarget.scrollTop)}
        onKeyDown={(e) => {
          // Tab indents instead of leaving the editor.
          if (e.key !== "Tab" || e.shiftKey) return
          e.preventDefault()
          const el = e.currentTarget
          const at = el.selectionStart
          const next = el.value.slice(0, at) + "  " + el.value.slice(el.selectionEnd)
          props.onInput(next)
          queueMicrotask(() => el.setSelectionRange(at + 2, at + 2))
        }}
      />
    </div>
  )
}

/** The code, compact and read-only. No running-line highlight: nothing reports which line runs. */
function CodeView(props: { value: string; headerLines: number[]; runtime?: string | null }) {
  const lang = () => langOf(props.runtime)
  return (
    <ol class="hsc-code hsc-code--view hsc-mono">
      <For each={props.value.replace(/\n$/, "").split("\n")}>
        {(l, i) => (
          <li classList={{ h: props.headerLines.includes(i() + 1) }}>
            <span class="n hsc-num">{i() + 1}</span>
            <span class="src">
              <Show when={l} fallback={" "}>
                <For each={highlightLine(l, lang())}>{(t) => (t.k ? <span class={`hl-${t.k}`}>{t.t}</span> : t.t)}</For>
              </Show>
            </span>
          </li>
        )}
      </For>
    </ol>
  )
}
