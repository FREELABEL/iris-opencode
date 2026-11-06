import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import "./iris-panel-ui.css"
import "./iris-genesis-pages.css"
import {
  BRAND_BY,
  BRAND_BY_SHORT,
  isGuessed,
  confirmFor,
  DEVICES,
  exactTime,
  FILTERS,
  frameScale,
  matchBrand,
  moveFocus,
  narrowedNote,
  PAGES_VIEW_KEY,
  PER_PAGE,
  previewAddress,
  rangeLine,
  readView,
  relativeTime,
  statusOf,
  thumbSources,
  viewCommand,
  VISIBILITY,
  visibilityOf,
  type BrandMatch,
  type BrandSummary,
  type Confirm,
  type DeviceId,
  type GenesisPage,
  type PageAction,
  type PagesFilter,
  type PagesPayload,
  type Visibility,
} from "./iris-genesis-pages-model"
import { PAGE_ALLOW, PAGE_SANDBOX } from "./iris-pinned-page-model"
import { checkPin } from "./iris-marketing"
import { addPin, parsePins, pinsKey, serializePins } from "./iris-marketing-pins"

/**
 * GENESIS › PAGES (#192632). The account's pages as cards that show the page itself, a detail that
 * opens on the live preview, and the page's own controls — publish, who can read it, versions, pin —
 * each gated the way `iris pages` gates it. Built from the panel's shared pieces (iris-panel-ui.css).
 *
 * THUMBNAILS, cheapest first: the platform's own screenshot (`thumbnail_url`), then og:image, both
 * plain lazy <img>; a scaled, non-interactive live frame only when neither loads, only for a page
 * anyone can open, only once its card is in view, and never more than LIVE_FRAMES at a time. Which
 * source failed is remembered for the session, so scrolling back never re-tries a dead image.
 */
type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type IconName = IconProps["name"]
type PageInfo = {
  measured: boolean
  reason?: string
  previewUrl?: string
  brandName?: string
  renderMode?: string
  ownerName?: string
  creator?: { id: number; name: string }
  updater?: { id: number; name: string }
  page?: GenesisPage
}
type Versions = { measured: boolean; reason?: string; versions: { version: number; createdAt?: string; byId?: number; summary?: string }[]; total?: number; hasMore: boolean }
type VersionDoc = { measured: boolean; reason?: string; version: number; by?: string; createdAt?: string; renderMode?: string; html?: string }
type ActionResult = { ok: boolean; reason?: string; page?: GenesisPage }
type Tab = "preview" | "versions" | "edit" | "json"
type Note = { tone: "good" | "bad" | "info"; text: string }

const LIVE_FRAMES = 8
let liveFrames = 0
const deadImages = new Set<string>()

function Ic(props: { name: IconName; title?: string }) {
  return (
    <span class="iris-ui-ic" title={props.title} aria-hidden={props.title ? undefined : "true"}>
      <Icon name={props.name} size="small" />
    </span>
  )
}
const Svg = (p: { d: string }) => (
  <svg class="iris-ui-svg" viewBox="0 0 24 24" aria-hidden="true">
    <path d={p.d} />
  </svg>
)
const GRID = "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"
const LIST = "M4 6h16M4 12h16M4 18h16"
const DEVICE_PATH: Record<DeviceId, string> = {
  desktop: "M3 5h18v11H3zM9 20h6M12 16v4",
  tablet: "M6 3h12v18H6zM11 18h2",
  phone: "M8 3h8v18H8zM11 18h2",
}
const PAGE_GLYPH = "M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5"

export function IrisGenesisPages(props: {
  doFetch: Fetch
  bloqId?: number
  bloqName?: string
  boards?: { id: number | string; name: string }[]
  openExternal: (url: string) => void
}) {
  const json = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const res = await props.doFetch(path, init)
    const body = (await res.json().catch(() => null)) as T | null
    if (!body) throw new Error(`IRIS answered HTTP ${res.status}`)
    return body
  }
  const post = <T,>(path: string, body: unknown) =>
    json<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

  const [st, setSt] = createStore({
    view: readView((() => { try { return localStorage.getItem(PAGES_VIEW_KEY) } catch { return null } })()),
    scope: (props.bloqId != null ? "project" : "all") as "project" | "all",
    filter: "all" as PagesFilter,
    brand: undefined as number | undefined,
    q: "",
    page: 1,
  })
  // The board often arrives after the pane mounts: open on "This project" once it does, unless the
  // person already chose a scope.
  let scopeChosen = false
  createEffect(on(() => props.bloqId, (id) => !scopeChosen && setSt({ scope: id != null ? "project" : "all", page: 1 }), { defer: true }))
  const setView = (v: "grid" | "list") => {
    setSt("view", v)
    try { localStorage.setItem(PAGES_VIEW_KEY, v) } catch {}
  }

  // ── search: typed vs asked for ──
  const [input, setInput] = createSignal("")
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => timer && clearTimeout(timer))
  const onSearch = (v: string) => {
    setInput(v)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => setSt({ q: v.trim(), page: 1 }), 300)
  }
  let searchEl: HTMLInputElement | undefined

  // ── brands, and who is signed in ──
  const [brands, setBrands] = createSignal<BrandSummary[]>([])
  void json<{ measured: boolean; brands: BrandSummary[] }>("/iris/brands").then((r) => r.measured && setBrands(r.brands)).catch(() => {})
  const [me, setMe] = createSignal<{ id?: number | null; name?: string | null }>({})
  void json<{ id?: number | null; name?: string | null }>("/iris/me").then(setMe).catch(() => {})
  const brandFilter = () => brands().find((b) => b.id === st.brand)
  const brandOf = (p: GenesisPage, named?: string) => matchBrand(p, brands(), named)

  // ── the list ──
  const [data, setData] = createSignal<PagesPayload>()
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let latest = 0
  async function load() {
    const mine = ++latest
    setLoading(true)
    setError(undefined)
    const bf = brandFilter()
    // A brand on a board lists that board's pages (the platform filters); one without a board is searched by name.
    const board = bf?.bloqId ?? (st.scope === "project" ? props.bloqId : undefined)
    const scope = board != null ? "project" : "all"
    const q = st.q || (bf && bf.bloqId == null ? bf.slug.replace(/_/g, "-") : "")
    const qs = new URLSearchParams({ scope, filter: st.filter, page: String(st.page), perPage: String(PER_PAGE) })
    if (q) qs.set("q", q)
    try {
      const r = await json<PagesPayload>(`/iris/pages/${board ?? 0}?${qs}`)
      if (mine !== latest) return
      if (!r.measured) setError(r.reason ?? "IRIS could not read your pages")
      setData(r)
    } catch (e) {
      if (mine !== latest) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (mine === latest) setLoading(false)
    }
  }
  createEffect(on([() => props.bloqId, () => st.scope, () => st.filter, () => st.brand, () => st.q, () => st.page], () => void load()))
  const rows = createMemo(() => {
    const all = data()?.pages ?? []
    const bf = brandFilter()
    if (!bf || bf.bloqId != null) return all
    return all.filter((p) => brandOf(p)?.brand.id === bf.id)
  })
  const counts = () => data()?.counts ?? {}
  const boardName = (id?: number) => (id == null ? undefined : props.boards?.find((b) => Number(b.id) === id)?.name)

  // ── focus and keys ──
  const [focus, setFocus] = createSignal(-1)
  let listEl: HTMLDivElement | undefined
  const cols = () => {
    if (st.view === "list" || !listEl) return 1
    const t = getComputedStyle(listEl).gridTemplateColumns
    return Math.max(1, t.split(" ").filter(Boolean).length)
  }
  createEffect(on(rows, () => setFocus(-1)))
  const focusCard = (i: number) => {
    setFocus(i)
    listEl?.querySelectorAll<HTMLElement>("[data-slot='gp-card']")[i]?.focus()
  }

  // ── the open page ──
  const [open, setOpen] = createSignal<GenesisPage>()
  const [tab, setTab] = createSignal<Tab>("preview")
  const [device, setDevice] = createSignal<DeviceId>("desktop")
  const [reloadKey, setReloadKey] = createSignal(0)
  const [info, setInfo] = createSignal<PageInfo>()
  const [frame, setFrame] = createSignal<{ state: "checking" | "ok" | "refused"; title?: string; detail?: string }>({ state: "checking" })
  const [note, setNote] = createSignal<Note>()
  const [busy, setBusy] = createSignal<string>()
  const [confirm, setConfirm] = createSignal<{ action: PageAction; c: Confirm }>()
  const [visMenu, setVisMenu] = createSignal(false)
  const [brandMenu, setBrandMenu] = createSignal(false)
  const [pinned, setPinned] = createSignal(false)

  function openPage(p: GenesisPage) {
    setOpen(p)
    setTab("preview")
    setInfo(undefined)
    setNote(undefined)
    setVersions(undefined)
    setVersionView(undefined)
    setDraft(undefined)
    setDoc(undefined)
    void json<PageInfo>(`/iris/page/${p.id}/info`).then((i) => open()?.id === p.id && setInfo(i)).catch((e) => setInfo({ measured: false, reason: String(e?.message ?? e) }))
    setPinned(isPinned(p.slug))
  }
  const closePage = () => {
    setOpen(undefined)
    setConfirm(undefined)
    setVisMenu(false)
    requestAnimationFrame(() => focusCard(Math.max(0, focus())))
  }
  const shown = (): GenesisPage | undefined => {
    const p = open()
    const fresh = info()?.page
    return p && fresh && fresh.id === p.id ? { ...p, ...fresh } : p
  }
  const previewUrl = () => {
    const p = shown()
    return p ? previewAddress(p, info()?.previewUrl) : undefined
  }

  // Can it be framed? Asked of the sidecar: a refused frame fires load like a working one (#187864).
  createEffect(
    on(previewUrl, (url) => {
      if (!url) return setFrame({ state: "refused", title: "Nothing to preview yet", detail: "This draft has no preview address. Publish it, or open it with `iris pages preview`." })
      setFrame({ state: "checking" })
      const q = new URLSearchParams({ url, origin: location.origin })
      void json<{ state?: string; reason?: string; status?: number }>(`/iris/frame-check?${q}`)
        .then((a) => {
          if (previewUrl() !== url) return
          const host = (() => { try { return new URL(url).host } catch { return url } })()
          const appAllowed = /tauri:\/\/localhost|localhost|127\.0\.0\.1/.test(a.reason ?? "")
          if (a.state === "unreachable") return setFrame({ state: "refused", title: `Couldn't reach ${host}`, detail: a.reason ?? "no connection" })
          if (a.state === "refused" && !appAllowed) return setFrame({ state: "refused", title: "This page can't be shown inside IRIS", detail: a.reason ?? "the site refuses to be framed" })
          if (typeof a.status === "number" && a.status >= 400)
            return setFrame({ state: "refused", title: a.status === 404 ? "This page isn't live at its address" : `${host} answered ${a.status}`, detail: a.status === 404 ? "It may be a draft, renamed, or private." : url })
          setFrame({ state: "ok" })
        })
        .catch(() => setFrame({ state: "ok" }))
    }),
  )

  // ── versions ──
  const [versions, setVersions] = createSignal<Versions>()
  const [versionView, setVersionView] = createSignal<VersionDoc | { loading: number }>()
  createEffect(
    on([tab, open], ([t, p]) => {
      if (t !== "versions" || !p || versions()) return
      void json<Versions>(`/iris/page/${p.id}/versions`).then((v) => open()?.id === p.id && setVersions(v)).catch((e) => setVersions({ measured: false, reason: String(e?.message ?? e), versions: [], hasMore: false }))
    }),
  )
  function showVersion(v: number) {
    const p = open()
    if (!p) return
    setVersionView({ loading: v })
    void json<VersionDoc>(`/iris/page/${p.id}/versions/${v}`)
      .then((d) => open()?.id === p.id && setVersionView(d))
      .catch((e) => setVersionView({ measured: false, reason: String(e?.message ?? e), version: v }))
  }
  const personName = (id?: number) => {
    if (id == null) return undefined
    if (me().id === id) return "you"
    const i = info()
    if (i?.creator?.id === id) return i.creator.name
    if (i?.updater?.id === id) return i.updater.name
    return `user ${id}`
  }

  // ── edit ──
  const [doc, setDoc] = createSignal<{ measured: boolean; reason?: string; json: string; currentVersion?: number }>()
  const [draft, setDraft] = createSignal<string>()
  createEffect(
    on([tab, open], ([t, p]) => {
      if (t !== "edit" || !p || doc()) return
      void json<{ measured: boolean; reason?: string; json: string; currentVersion?: number }>(`/iris/page/${p.id}`).then((d) => open()?.id === p.id && setDoc(d)).catch((e) => setDoc({ measured: false, reason: String(e?.message ?? e), json: "" }))
    }),
  )
  async function saveDoc() {
    const p = open()
    const d = doc()
    const text = draft()
    if (!p || !d || text == null) return
    setBusy("save")
    try {
      const r = await post<{ ok: boolean; reason?: string; version?: number }>(`/iris/page/${p.id}/save`, { json: text, expectedVersion: d.currentVersion })
      if (!r.ok) return setNote({ tone: "bad", text: `Not saved — ${r.reason ?? "refused"}` })
      setDoc({ ...d, json: text, currentVersion: r.version ?? d.currentVersion })
      setDraft(undefined)
      setNote({ tone: "good", text: `Saved${r.version != null ? ` as version ${r.version}` : ""}.` })
      setReloadKey((k) => k + 1)
    } catch (e) {
      setNote({ tone: "bad", text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(undefined)
    }
  }

  // ── acting on it ──
  function ask(action: PageAction) {
    const p = shown()
    if (!p) return
    setVisMenu(false)
    const c = confirmFor(p, action)
    if (c) return setConfirm({ action, c })
    void perform(action, false)
  }
  async function perform(action: PageAction, confirmed: boolean) {
    const p = shown()
    if (!p) return
    setBusy(action.kind)
    setNote(undefined)
    try {
      const r =
        action.kind === "publish" || action.kind === "unpublish"
          ? await post<ActionResult>(`/iris/page/${p.id}/publish`, { publish: action.kind === "publish", ...(confirmed ? { confirm: true } : {}) })
          : action.kind === "visibility"
            ? await post<ActionResult>(`/iris/page/${p.id}/visibility`, { mode: action.to, ...(confirmed ? { confirm: true } : {}) })
            : await post<ActionResult>(`/iris/page/${p.id}/rollback`, { version: action.version, confirm: true })
      setConfirm(undefined)
      if (!r.ok) return setNote({ tone: "bad", text: `${actionWord(action)} didn't happen — ${r.reason ?? "the platform refused"}` })
      const next = { ...p, ...(r.page ?? {}) }
      setOpen(next)
      setInfo((i) => (i ? { ...i, page: next } : i))
      setData((d) => (d ? { ...d, pages: d.pages.map((x) => (x.id === next.id ? { ...x, ...next } : x)) } : d))
      setNote({ tone: "good", text: narrowedNote(p, action) ?? doneWord(action, next) })
      if (action.kind === "rollback") {
        setVersions(undefined)
        setVersionView(undefined)
        setTab("preview")
      }
      setReloadKey((k) => k + 1)
    } catch (e) {
      setNote({ tone: "bad", text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(undefined)
    }
  }

  // ── pin to Marketing (#192624's check) ──
  function isPinned(slug?: string) {
    const k = pinsKey(me().id)
    if (!slug || !k) return false
    try { return parsePins(localStorage.getItem(k)).pins.some((x) => x.slug === slug) } catch { return false }
  }
  async function pin() {
    const p = shown()
    const k = pinsKey(me().id)
    if (!p?.slug) return
    if (!k) return setNote({ tone: "bad", text: "Sign in to pin pages to Marketing." })
    setBusy("pin")
    const r = await checkPin(props.doFetch, p.slug)
    setBusy(undefined)
    if (!r.ok) return setNote({ tone: "bad", text: `Not pinned — ${r.reason}` })
    try {
      localStorage.setItem(k, serializePins(addPin(parsePins(localStorage.getItem(k)), r.pin)))
    } catch {}
    setPinned(true)
    setNote({ tone: "good", text: `Pinned to Marketing as “${r.pin.label}”.` })
  }

  const copy = async (text: string | undefined, what: string) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setNote({ tone: "info", text: `${what} copied.` })
    } catch {
      setNote({ tone: "bad", text: "The clipboard isn't available here." })
    }
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (!t || e.metaKey || e.ctrlKey || e.altKey) return
      if (!t.closest(".iris-gp") && t !== document.body) return
      const typing = !!t.closest("input,textarea,select,[contenteditable]")
      if (e.key === "Escape") {
        if (confirm() && !busy()) return (setConfirm(undefined), e.preventDefault())
        if (visMenu() || brandMenu()) return (setVisMenu(false), setBrandMenu(false), e.preventDefault())
        if (open() && !typing) return (closePage(), e.preventDefault())
        return
      }
      if (open() || typing) return
      if (e.key === "/") {
        searchEl?.focus()
        e.preventDefault()
      } else if (e.key.startsWith("Arrow")) {
        const n = moveFocus(focus(), e.key, rows().length, cols())
        if (n >= 0) focusCard(n)
        e.preventDefault()
      } else if (e.key === "Enter" && focus() >= 0 && rows()[focus()]) {
        openPage(rows()[focus()])
        e.preventDefault()
      }
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  const empty = (): JSX.Element => {
    const bf = brandFilter()
    if (st.q) return <>No pages match “{st.q}”{st.filter !== "all" ? ` in ${FILTERS.find((f) => f.id === st.filter)!.label}` : ""}.</>
    if (bf) return <>No pages found for {bf.name}.</>
    if (st.filter === "draft") return <>No drafts — everything here is published.</>
    if (st.filter === "published") return <>Nothing published yet.</>
    if (st.filter === "private") return <>Every page here is public.</>
    if (st.scope === "project")
      return (
        <>
          No pages on {props.bloqName ?? "this project's board"} yet. Ask the agent for one, or run <code>iris pages create</code>.
        </>
      )
    return <>No pages on this account yet.</>
  }

  return (
    <div class="iris-ui iris-gp" data-slot="iris-genesis-pages" data-view={st.view} data-open={open() ? "" : undefined}>
      <Show when={!open()}>
        {/* ── toolbar ── */}
        <div class="iris-ui-bar">
          <label class="iris-ui-search">
            <Ic name="magnifying-glass" />
            <input
              ref={searchEl}
              type="search"
              placeholder="Search pages"
              aria-label="Search pages"
              value={input()}
              onInput={(e) => onSearch(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && input()) {
                  e.stopPropagation()
                  onSearch("")
                } else if (e.key === "ArrowDown" && rows().length) {
                  e.preventDefault()
                  focusCard(0)
                }
              }}
            />
            <kbd>/</kbd>
          </label>
          <Show when={props.bloqId != null}>
            <div class="iris-ui-seg" role="tablist" aria-label="Which pages">
              <For each={[["all", "All"], ["project", "This project"]] as const}>
                {([v, label]) => (
                  <button type="button" role="tab" aria-selected={st.scope === v} onClick={() => ((scopeChosen = true), setSt({ scope: v, page: 1 }))}>
                    {label}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <span class="iris-ui-spacer" />
          <div class="iris-ui-seg" role="group" aria-label="Layout">
            <button type="button" aria-pressed={st.view === "grid"} title="Cards" aria-label="Cards" onClick={() => setView("grid")}>
              <Svg d={GRID} />
            </button>
            <button type="button" aria-pressed={st.view === "list"} title="List" aria-label="List" onClick={() => setView("list")}>
              <Svg d={LIST} />
            </button>
          </div>
          <button type="button" class="iris-ui-icon" title="Refresh" aria-label="Refresh" disabled={loading()} onClick={() => void load()}>
            <Show when={loading()} fallback={<Icon name="reset" size="small" />}>
              <Spinner class="iris-ui-spin" />
            </Show>
          </button>
        </div>

        {/* ── filter row with counts, and the brand filter ── */}
        <div class="iris-ui-tabs iris-gp-filters" role="toolbar" aria-label="Filter pages">
          <For each={FILTERS}>
            {(f) => (
              <button type="button" class="iris-ui-tab" title={f.hint} aria-pressed={st.filter === f.id} onClick={() => setSt({ filter: f.id, page: 1 })}>
                {f.label}
                <Show when={counts()[f.id] != null}>
                  <span class="n">{counts()[f.id]!.toLocaleString("en-US")}</span>
                </Show>
              </button>
            )}
          </For>
          <span class="iris-ui-spacer" />
          <div class="iris-gp-brandpick">
            <button
              type="button"
              class="iris-ui-tab"
              aria-pressed={st.brand != null}
              aria-haspopup="menu"
              aria-expanded={brandMenu()}
              disabled={brands().length === 0}
              onClick={() => setBrandMenu(!brandMenu())}
            >
              <Show when={brandFilter()} fallback={<>Any brand</>}>
                {(b) => (
                  <>
                    <BrandMark brand={b()} />
                    {b().name}
                  </>
                )}
              </Show>
              <Icon name="chevron-down" size="small" />
            </button>
            <Show when={brandMenu()}>
              <div class="iris-ui-menu iris-gp-brandmenu" role="menu" aria-label="Brand">
                <button type="button" role="menuitemradio" aria-checked={st.brand == null} onClick={() => (setSt({ brand: undefined, page: 1 }), setBrandMenu(false))}>
                  Any brand
                </button>
                <For each={brands()}>
                  {(b) => (
                    <button type="button" role="menuitemradio" aria-checked={st.brand === b.id} onClick={() => (setSt({ brand: b.id, page: 1 }), setBrandMenu(false))}>
                      <BrandMark brand={b} />
                      <span class="iris-gp-grow">{b.name}</span>
                      <Swatches brand={b} max={4} />
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>

        <Show when={error() && data()?.pages?.length}>
          <div class="iris-ui-callout iris-gp-banner" data-tone="bad" role="alert">
            <Ic name="warning" />
            <span>Couldn't refresh — {error()}. Showing what was read before.</span>
          </div>
        </Show>

        {/* ── the cards ── */}
        <div class="iris-gp-scroll">
          <Switch>
            <Match when={error() && !data()?.pages?.length}>
              <div class="iris-ui-empty" role="alert">
                <Ic name="warning" />
                <span>Couldn't read your pages — {error()}.</span>
                <button type="button" class="iris-ui-btn" onClick={() => void load()}>
                  Try again
                </button>
              </div>
            </Match>
            <Match when={!data() && loading()}>
              <div class="iris-ui-empty">
                <Spinner class="iris-ui-spin" />
              </div>
            </Match>
            <Match when={data() && rows().length === 0}>
              <div class="iris-ui-empty">
                <Svg d={PAGE_GLYPH} />
                <span>{empty()}</span>
              </div>
            </Match>
            <Match when={rows().length > 0}>
              <div class="iris-gp-cards" ref={listEl} role="listbox" aria-label="Pages" data-busy={loading() ? "" : undefined}>
                <For each={rows()}>
                  {(p, i) => (
                    <PageCard
                      page={p}
                      brand={brandOf(p)}
                      board={p.ownerType === "bloq" ? boardName(p.ownerId) : undefined}
                      focused={focus() === i()}
                      onFocus={() => setFocus(i())}
                      onOpen={() => openPage(p)}
                      onCopy={() => copy(p.url, "Link")}
                      onExternal={() => p.url && props.openExternal(p.url)}
                    />
                  )}
                </For>
              </div>
            </Match>
          </Switch>
        </div>

        <Show when={data()?.measured}>
          <div class="iris-gp-pager">
            <span class="iris-gp-range">
              {rangeLine({ page: st.page, perPage: PER_PAGE, shown: data()!.pages.length, total: data()!.total, totalIsExact: data()!.totalIsExact })}
              <Show when={brandFilter() && brandFilter()!.bloqId == null && rows().length !== data()!.pages.length}>
                {` · ${rows().length} match ${brandFilter()!.name}`}
              </Show>
            </span>
            <span class="iris-ui-spacer" />
            <button type="button" class="iris-ui-icon" title="Previous page" aria-label="Previous page" disabled={st.page <= 1 || loading()} onClick={() => setSt("page", st.page - 1)}>
              <Icon name="chevron-left" size="small" />
            </button>
            <button type="button" class="iris-ui-icon" title="Next page" aria-label="Next page" disabled={!data()!.hasMore || loading()} onClick={() => setSt("page", st.page + 1)}>
              <Icon name="chevron-right" size="small" />
            </button>
          </div>
        </Show>
      </Show>

      {/* ── the open page ── */}
      <Show when={shown()} keyed={false}>
        {(pg) => {
          const p = () => pg()
          const vis = () => visibilityOf(p())
          const status = () => statusOf(p())
          const brand = () => brandOf(p(), info()?.brandName)
          return (
            <div class="iris-gp-detail">
              <div class="iris-ui-bar iris-gp-dhead">
                <button type="button" class="iris-ui-icon" title="Back to pages (Esc)" aria-label="Back to pages" onClick={closePage}>
                  <Icon name="arrow-left" size="small" />
                </button>
                <div class="iris-gp-dtitle">
                  <h3 title={p().title}>{p().title}</h3>
                  <Show when={p().slug}>
                    <span class="iris-gp-slug">/{p().slug}</span>
                  </Show>
                </div>
                <span class="iris-ui-chip" data-tone={status().tone}>{status().label}</span>
                <span class="iris-ui-spacer" />
                <Show
                  when={p().status === "published"}
                  fallback={
                    <button type="button" class="iris-ui-btn" data-primary disabled={!!busy()} onClick={() => ask({ kind: "publish" })}>
                      <Show when={busy() === "publish"} fallback={<Icon name="cloud-upload" size="small" />}>
                        <Spinner class="iris-ui-spin" />
                      </Show>
                      Publish
                    </button>
                  }
                >
                  <button type="button" class="iris-ui-btn" disabled={!!busy()} title="Back to draft" onClick={() => ask({ kind: "unpublish" })}>
                    <Show when={busy() === "unpublish"} fallback={<Icon name="arrow-down-to-line" size="small" />}>
                      <Spinner class="iris-ui-spin" />
                    </Show>
                    Unpublish
                  </button>
                </Show>
                <div class="iris-gp-vis">
                  <button type="button" class="iris-ui-btn" aria-haspopup="menu" aria-expanded={visMenu()} disabled={!!busy()} title={VISIBILITY[vis()].hint} onClick={() => setVisMenu(!visMenu())}>
                    <Show when={busy() === "visibility"} fallback={<Icon name={VISIBILITY[vis()].icon} size="small" />}>
                      <Spinner class="iris-ui-spin" />
                    </Show>
                    {VISIBILITY[vis()].label}
                    <Icon name="chevron-down" size="small" />
                  </button>
                  <Show when={visMenu()}>
                    <div class="iris-ui-menu iris-gp-vismenu" role="menu" aria-label="Who can read it">
                      <For each={["public", "unlisted", "private"] as Visibility[]}>
                        {(m) => (
                          <button type="button" role="menuitemradio" aria-checked={vis() === m} onClick={() => (vis() === m ? setVisMenu(false) : ask({ kind: "visibility", to: m }))}>
                            <Ic name={VISIBILITY[m].icon} />
                            <span class="iris-gp-grow">
                              {VISIBILITY[m].label}
                              <span class="sub">{VISIBILITY[m].hint}</span>
                            </span>
                            <Show when={vis() === m}>
                              <Ic name="check-small" />
                            </Show>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
                <button type="button" class="iris-ui-icon" aria-pressed={pinned()} disabled={!p().slug || busy() === "pin"} title={pinned() ? "Pinned to Marketing" : "Pin to Marketing"} aria-label={pinned() ? "Pinned to Marketing" : "Pin to Marketing"} onClick={() => void pin()}>
                  <Show when={busy() === "pin"} fallback={<Icon name="pin" size="small" />}>
                    <Spinner class="iris-ui-spin" />
                  </Show>
                </button>
                <button type="button" class="iris-ui-icon" disabled={!p().url} title="Copy link" aria-label="Copy link" onClick={() => copy(p().url, "Link")}>
                  <Icon name="link" size="small" />
                </button>
                <button type="button" class="iris-ui-icon" disabled={!previewUrl()} title="Open in browser" aria-label="Open in browser" onClick={() => previewUrl() && props.openExternal(previewUrl()!)}>
                  <Icon name="square-arrow-top-right" size="small" />
                </button>
              </div>

              <div class="iris-ui-tabs iris-gp-dtabs" role="tablist" aria-label="Page views">
                <For each={[["preview", "Preview"], ["versions", "Versions"], ["edit", "Edit"], ["json", "JSON"]] as [Tab, string][]}>
                  {([id, label]) => (
                    <button type="button" role="tab" class="iris-ui-tab" aria-selected={tab() === id} onClick={() => setTab(id)}>
                      {label}
                      <Show when={id === "versions" && versions()?.measured && versions()!.total != null}>
                        <span class="n">{versions()!.total}</span>
                      </Show>
                    </button>
                  )}
                </For>
                <span class="iris-ui-spacer" />
                <Show when={tab() === "preview" || tab() === "versions"}>
                  <div class="iris-ui-seg" role="group" aria-label="Preview width">
                    <For each={DEVICES}>
                      {(d) => (
                        <button type="button" aria-pressed={device() === d.id} title={`${d.label} · ${d.width}px`} aria-label={d.label} onClick={() => setDevice(d.id)}>
                          <Svg d={DEVICE_PATH[d.id]} />
                        </button>
                      )}
                    </For>
                  </div>
                  <button type="button" class="iris-ui-icon" title="Reload preview" aria-label="Reload preview" onClick={() => setReloadKey((k) => k + 1)}>
                    <Icon name="reset" size="small" />
                  </button>
                </Show>
              </div>

              <Show when={note()}>
                {(n) => (
                  <div class="iris-ui-callout iris-gp-banner" data-tone={n().tone} role={n().tone === "bad" ? "alert" : "status"}>
                    <Ic name={n().tone === "bad" ? "warning" : n().tone === "good" ? "circle-check" : "check-small"} />
                    <span class="iris-gp-grow">{n().text}</span>
                    <button type="button" class="iris-ui-icon iris-gp-x" aria-label="Dismiss" onClick={() => setNote(undefined)}>
                      <Icon name="close-small" size="small" />
                    </button>
                  </div>
                )}
              </Show>

              <div class="iris-gp-dbody" data-tab={tab()}>
                <Switch>
                  <Match when={tab() === "preview"}>
                    <div class="iris-gp-stage">
                      <Switch>
                        <Match when={frame().state === "checking" || (!info() && p().status !== "published")}>
                          <div class="iris-ui-empty"><Spinner class="iris-ui-spin" /></div>
                        </Match>
                        <Match when={frame().state === "refused"}>
                          <div class="iris-ui-empty">
                            <Ic name="eye" />
                            <b class="iris-gp-strong">{frame().title}</b>
                            <span>{frame().detail}</span>
                            <Show when={previewUrl()}>
                              <button type="button" class="iris-ui-btn" onClick={() => props.openExternal(previewUrl()!)}>
                                <Icon name="square-arrow-top-right" size="small" />
                                Open in browser
                              </button>
                            </Show>
                          </div>
                        </Match>
                        <Match when={previewUrl()}>
                          {(url) => <DeviceFrame src={url()} title={p().title} device={device()} reloadKey={reloadKey()} />}
                        </Match>
                      </Switch>
                    </div>
                    <SideCard
                      page={p()}
                      info={info()}
                      brand={brand()}
                      board={boardName(p().ownerId)}
                      previewing={p().status !== "published" && !!info()?.previewUrl}
                      onCopy={copy}
                    />
                  </Match>

                  <Match when={tab() === "versions"}>
                    <div class="iris-gp-stage">
                      <Switch>
                        <Match when={!versionView()}>
                          <div class="iris-ui-empty">
                            <Ic name="clock" />
                            <span>Choose a version to see it here. The live page is not touched.</span>
                          </div>
                        </Match>
                        <Match when={"loading" in (versionView() as object) && versionView()}>
                          <div class="iris-ui-empty"><Spinner class="iris-ui-spin" /></div>
                        </Match>
                        <Match when={(versionView() as VersionDoc).html}>
                          {(html) => <DeviceFrame srcdoc={html()} title={`Version ${(versionView() as VersionDoc).version}`} device={device()} reloadKey={reloadKey()} />}
                        </Match>
                        <Match when={versionView()}>
                          <div class="iris-ui-empty">
                            <Ic name="eye" />
                            <b class="iris-gp-strong">Version {(versionView() as VersionDoc).version} can't be drawn here</b>
                            <span>{(versionView() as VersionDoc).reason ?? "the platform returned nothing to draw"}. You can still roll back to it.</span>
                          </div>
                        </Match>
                      </Switch>
                    </div>
                    <aside class="iris-gp-side iris-gp-versions" aria-label="Versions">
                      <Switch>
                        <Match when={!versions()}>
                          <div class="iris-ui-empty"><Spinner class="iris-ui-spin" /></div>
                        </Match>
                        <Match when={!versions()!.measured}>
                          <div class="iris-ui-empty"><Ic name="warning" />Couldn't read the versions — {versions()!.reason}.</div>
                        </Match>
                        <Match when={versions()!.versions.length === 0}>
                          <div class="iris-ui-empty">No saved versions yet.</div>
                        </Match>
                        <Match when={versions()}>
                          <For each={versions()!.versions}>
                            {(v) => {
                              const current = () => v.version === p().version
                              const viewing = () => (versionView() as VersionDoc | undefined)?.version === v.version || (versionView() as { loading?: number } | undefined)?.loading === v.version
                              return (
                                <div class="iris-gp-ver" aria-selected={viewing()} data-current={current() ? "" : undefined}>
                                  <button type="button" class="iris-gp-verbtn" onClick={() => showVersion(v.version)}>
                                    <span class="iris-gp-vertop">
                                      <b>v{v.version}</b>
                                      <Show when={current()}>
                                        <span class="iris-ui-chip" data-tone="good">current</span>
                                      </Show>
                                      <span class="iris-gp-when" title={exactTime(v.createdAt)}>{relativeTime(v.createdAt, Date.now())}</span>
                                    </span>
                                    <span class="iris-gp-versub">
                                      {[personName(v.byId) ? `by ${personName(v.byId)}` : undefined, v.summary].filter(Boolean).join(" · ")}
                                    </span>
                                  </button>
                                  <Show when={!current()}>
                                    <button type="button" class="iris-ui-icon" title={`Roll back to v${v.version}`} aria-label={`Roll back to v${v.version}`} disabled={!!busy()} onClick={() => ask({ kind: "rollback", version: v.version, when: relativeTime(v.createdAt, Date.now()) })}>
                                      <Icon name="arrow-undo-down" size="small" />
                                    </button>
                                  </Show>
                                </div>
                              )
                            }}
                          </For>
                          <Show when={versions()!.hasMore}>
                            <p class="iris-gp-muted">Older versions: <code>iris pages versions {p().slug}</code></p>
                          </Show>
                        </Match>
                      </Switch>
                    </aside>
                  </Match>

                  <Match when={tab() === "edit"}>
                    <div class="iris-gp-edit">
                      <Switch>
                        <Match when={!doc()}>
                          <div class="iris-ui-empty"><Spinner class="iris-ui-spin" /></div>
                        </Match>
                        <Match when={!doc()!.measured}>
                          <div class="iris-ui-empty"><Ic name="warning" />Couldn't load this page — {doc()!.reason}.</div>
                        </Match>
                        <Match when={doc()}>
                          <div class="iris-gp-editbar">
                            <span class="iris-gp-muted">
                              {doc()!.currentVersion != null ? `Saving checks it is still version ${doc()!.currentVersion}, so nobody's work is overwritten.` : "No version — a save here cannot detect a conflict."}
                            </span>
                            <span class="iris-ui-spacer" />
                            <button type="button" class="iris-ui-btn" data-primary disabled={draft() == null || !!busy()} onClick={() => void saveDoc()}>
                              <Show when={busy() === "save"} fallback={<Icon name="save" size="small" />}>
                                <Spinner class="iris-ui-spin" />
                              </Show>
                              {draft() == null ? "No changes" : "Save"}
                            </button>
                          </div>
                          <textarea class="iris-gp-editor" spellcheck={false} value={draft() ?? doc()!.json} onInput={(e) => setDraft(e.currentTarget.value)} aria-label="Page JSON" />
                        </Match>
                      </Switch>
                    </div>
                  </Match>

                  <Match when={tab() === "json"}>
                    <div class="iris-gp-edit">
                      <div class="iris-gp-editbar">
                        <span class="iris-gp-muted">The record as the platform returned it.</span>
                        <span class="iris-ui-spacer" />
                        <button type="button" class="iris-ui-btn" onClick={() => copy(JSON.stringify({ ...p(), ...(info() ?? {}) }, null, 2), "JSON")}>
                          <Icon name="copy" size="small" />
                          Copy
                        </button>
                      </div>
                      <pre class="iris-gp-json">{JSON.stringify({ ...p(), ...(info() ? { info: { ...info(), page: undefined } } : {}) }, null, 2)}</pre>
                    </div>
                  </Match>
                </Switch>
              </div>
            </div>
          )
        }}
      </Show>

      {/* ── the confirm: who will be able to read it, in plain words ── */}
      <Show when={confirm()}>
        {(c) => (
          <div class="iris-ui-scrim" onClick={(e) => e.target === e.currentTarget && !busy() && setConfirm(undefined)}>
            <div class="iris-ui-dialog" role="alertdialog" aria-modal="true" aria-labelledby="iris-gp-confirm-title" data-slot="gp-confirm" data-action={c().action.kind}>
              <div class="iris-ui-dialog-icon" data-tone={c().c.tone}>
                <Icon name={c().c.icon} />
              </div>
              <h3 id="iris-gp-confirm-title">{c().c.title}</h3>
              <For each={c().c.body}>{(line) => <p>{line}</p>}</For>
              <div class="iris-ui-dialog-actions">
                <button type="button" class="iris-ui-btn" disabled={!!busy()} onClick={() => setConfirm(undefined)} autofocus>
                  Cancel
                </button>
                <button type="button" class="iris-ui-btn" data-primary data-tone={c().c.tone} disabled={!!busy()} onClick={() => void perform(c().action, true)}>
                  <Show when={busy()}>
                    <Spinner class="iris-ui-spin" />
                  </Show>
                  {c().c.confirmLabel}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

const actionWord = (a: PageAction) => (a.kind === "publish" ? "Publishing" : a.kind === "unpublish" ? "Unpublishing" : a.kind === "visibility" ? "The change" : "The rollback")
function doneWord(a: PageAction, p: GenesisPage): string {
  if (a.kind === "publish") return `Published. ${visibilityOf(p) === "public" ? "Anyone with the link can read it now." : VISIBILITY[visibilityOf(p)].hint + "."}`
  if (a.kind === "visibility") return `${VISIBILITY[a.to].label}. ${VISIBILITY[a.to].hint}.`
  if (a.kind === "rollback") return `Rolled back to version ${a.version}${p.version != null ? ` — the page is now version ${p.version}` : ""}.`
  return "Done."
}

function BrandMark(props: { brand: BrandSummary; size?: "lg" }) {
  const [broken, setBroken] = createSignal(false)
  return (
    <span class="iris-gp-mark" data-size={props.size} aria-hidden="true">
      <Show when={props.brand.logoUrl && !broken()} fallback={<span>{props.brand.name.slice(0, 1).toUpperCase()}</span>}>
        <img src={props.brand.logoUrl} alt="" loading="lazy" onError={() => setBroken(true)} />
      </Show>
    </span>
  )
}

function Swatches(props: { brand: BrandSummary; max: number }) {
  return (
    <span class="iris-gp-swatches" aria-hidden="true">
      <For each={props.brand.swatches.slice(0, props.max)}>{(s) => <span style={{ background: s.value }} title={`${s.name} ${s.value}`} />}</For>
    </span>
  )
}

function VisChip(props: { page: GenesisPage }) {
  const v = () => visibilityOf(props.page)
  return (
    <Show
      when={props.page.requiresAuth}
      fallback={
        <span class="iris-ui-chip" title={VISIBILITY[v()].hint} data-vis={v()}>
          <Icon name={VISIBILITY[v()].icon} size="small" />
          {VISIBILITY[v()].label}
        </span>
      }
    >
      <span class="iris-ui-chip" title={`${VISIBILITY[v()].label} — visitors must sign in`} data-vis="members">
        <Icon name="shield" size="small" />
        Members only
      </span>
    </Show>
  )
}

function PageCard(props: {
  page: GenesisPage
  brand?: BrandMatch
  board?: string
  focused: boolean
  onFocus: () => void
  onOpen: () => void
  onCopy: () => void
  onExternal: () => void
}) {
  const p = () => props.page
  const status = () => statusOf(p())
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation()
    fn()
  }
  return (
    <div
      class="iris-gp-card"
      role="option"
      tabIndex={props.focused ? 0 : -1}
      aria-selected={props.focused}
      data-slot="gp-card"
      data-id={p().id}
      onClick={props.onOpen}
      onFocus={props.onFocus}
    >
      <div class="iris-gp-thumbwrap">
        <Thumb page={p()} brand={props.brand?.brand} />
        <div class="iris-gp-quick">
          <button type="button" class="iris-ui-icon" title="Preview" aria-label={`Preview ${p().title}`} tabIndex={-1} onClick={stop(props.onOpen)}>
            <Icon name="eye" size="small" />
          </button>
          <button type="button" class="iris-ui-icon" title="Copy link" aria-label="Copy link" tabIndex={-1} disabled={!p().url} onClick={stop(props.onCopy)}>
            <Icon name="link" size="small" />
          </button>
          <button type="button" class="iris-ui-icon" title="Open in browser" aria-label="Open in browser" tabIndex={-1} disabled={!p().url || p().status !== "published"} onClick={stop(props.onExternal)}>
            <Icon name="square-arrow-top-right" size="small" />
          </button>
        </div>
      </div>
      <div class="iris-gp-meta">
        <div class="iris-gp-name" title={p().title}>{p().title}</div>
        <div class="iris-gp-slug" title={p().url}>/{p().slug ?? p().id}</div>
        <div class="iris-gp-chips">
          <span class="iris-ui-chip" data-tone={status().tone}>{status().label}</span>
          <VisChip page={p()} />
          <span class="iris-gp-when" title={exactTime(p().updatedAt)}>{relativeTime(p().updatedAt, Date.now())}</span>
        </div>
        <Show when={props.brand}>
          {(b) => (
            <div class="iris-gp-brand" title={`${b().brand.name} — ${BRAND_BY[b().by]}`} data-by={b().by}>
              <BrandMark brand={b().brand} />
              <span class="iris-gp-brandname">{b().brand.name}</span>
              <Show when={isGuessed(b())}>
                <span class="iris-gp-guessed">guessed</span>
              </Show>
              <Swatches brand={b().brand} max={5} />
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}

/** The card's picture. See the header: images first, a live frame last, all only once in view. */
function Thumb(props: { page: GenesisPage; brand?: BrandSummary }) {
  let el: HTMLDivElement | undefined
  const [seen, setSeen] = createSignal(false)
  const [tried, setTried] = createSignal(0)
  const [width, setWidth] = createSignal(0)
  const sources = createMemo(() => thumbSources(props.page).filter((s) => s.kind === "frame" || !deadImages.has(s.url)))
  const source = () => sources()[tried()]
  const [frameSlot, setFrameSlot] = createSignal(false)
  onMount(() => {
    if (!el) return
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (setSeen(true), io.disconnect()), { rootMargin: "200px" })
    io.observe(el)
    const ro = new ResizeObserver(() => setWidth(el!.clientWidth))
    ro.observe(el)
    onCleanup(() => (io.disconnect(), ro.disconnect()))
  })
  createEffect(() => {
    if (!seen() || source()?.kind !== "frame" || frameSlot()) return
    if (liveFrames >= LIVE_FRAMES) return
    liveFrames++
    setFrameSlot(true)
  })
  onCleanup(() => frameSlot() && liveFrames--)
  return (
    <div class="iris-gp-thumb" ref={el} data-kind={seen() ? (source()?.kind ?? "none") : "waiting"}>
      <div class="iris-gp-ph" aria-hidden="true">
        <Show when={props.brand} fallback={<Svg d={PAGE_GLYPH} />}>
          {(b) => <BrandMark brand={b()} size="lg" />}
        </Show>
      </div>
      <Show when={seen() && source()}>
        {(s) => (
          <Switch>
            <Match when={s().kind === "image"}>
              <img
                src={s().url}
                alt=""
                loading="lazy"
                decoding="async"
                onError={() => {
                  deadImages.add(s().url)
                  setTried((t) => t + 1)
                }}
              />
            </Match>
            <Match when={s().kind === "frame" && frameSlot() && width() > 0}>
              <iframe
                src={s().url}
                title=""
                aria-hidden="true"
                tabIndex={-1}
                loading="lazy"
                sandbox="allow-scripts allow-same-origin"
                style={{ transform: `scale(${width() / 1280})` }}
              />
            </Match>
          </Switch>
        )}
      </Show>
    </div>
  )
}

/** A live page at a device's width, scaled into the room there is. */
function DeviceFrame(props: { src?: string; srcdoc?: string; title: string; device: DeviceId; reloadKey: number }) {
  let el: HTMLDivElement | undefined
  const [room, setRoom] = createSignal({ w: 0, h: 0 })
  const [loaded, setLoaded] = createSignal(false)
  onMount(() => {
    if (!el) return
    const ro = new ResizeObserver(() => setRoom({ w: el!.clientWidth, h: el!.clientHeight }))
    ro.observe(el)
    onCleanup(() => ro.disconnect())
  })
  const width = () => DEVICES.find((d) => d.id === props.device)!.width
  const scale = () => frameScale(width(), room().w - 24)
  createEffect(on([() => props.src, () => props.srcdoc, () => props.reloadKey], () => setLoaded(false)))
  return (
    <div class="iris-gp-room" ref={el} data-device={props.device}>
      <Show when={room().w > 0}>
        <Show when={`${props.reloadKey}|${props.src ?? ""}|${props.device}`} keyed>
          {(_) => (
            <div class="iris-gp-device" style={{ width: `${width() * scale()}px`, height: `${Math.max(200, room().h - 24)}px` }}>
              <Show when={!loaded()}>
                <div class="iris-gp-loading"><Spinner class="iris-ui-spin" /></div>
              </Show>
              <iframe
                class="iris-gp-frame"
                src={props.srcdoc ? undefined : props.src}
                srcdoc={props.srcdoc}
                title={props.title}
                // A version's document is drawn without the page's origin: its scripts run, but it
                // can reach nothing the panel can.
                sandbox={props.srcdoc ? "allow-scripts" : PAGE_SANDBOX}
                allow={props.srcdoc ? undefined : PAGE_ALLOW}
                onLoad={() => setLoaded(true)}
                style={{ width: `${width()}px`, height: `${Math.max(200, room().h - 24) / scale()}px`, transform: `scale(${scale()})` }}
              />
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}

function SideCard(props: {
  page: GenesisPage
  info?: PageInfo
  brand?: BrandMatch
  board?: string
  previewing: boolean
  onCopy: (text: string | undefined, what: string) => void
}) {
  const p = () => props.page
  const vis = () => visibilityOf(p())
  const owner = () => (p().ownerType === "bloq" ? props.info?.ownerName ?? props.board ?? (p().ownerId != null ? `board ${p().ownerId}` : undefined) : props.info?.ownerName ?? "your account")
  const cmd = () => viewCommand(p().slug)
  return (
    <aside class="iris-gp-side" aria-label="About this page" data-slot="gp-side">
      <Show when={props.brand}>
        {(b) => (
          <div class="iris-gp-sidebrand" title={BRAND_BY[b().by]}>
            <BrandMark brand={b().brand} size="lg" />
            <div class="iris-gp-grow">
              <div class="iris-gp-strong">{b().brand.name}</div>
              <div class="iris-gp-muted">{BRAND_BY_SHORT[b().by]}</div>
            </div>
            <Swatches brand={b().brand} max={6} />
          </div>
        )}
      </Show>
      <dl class="iris-gp-facts">
        <dt>Status</dt>
        <dd>
          <span class="iris-ui-chip" data-tone={statusOf(p()).tone}>{statusOf(p()).label}</span>
          <Show when={props.previewing}>
            <span class="iris-gp-muted"> · showing its draft preview</span>
          </Show>
        </dd>
        <dt>Access</dt>
        <dd>
          <VisChip page={p()} />
        </dd>
        <dd class="iris-gp-wide iris-gp-muted">
          {VISIBILITY[vis()].hint}
          {p().requiresAuth ? " — and they have to sign in first" : ""}.
        </dd>
        <Show when={p().version != null}>
          <dt>Version</dt>
          <dd>v{p().version}</dd>
        </Show>
        <dt>Updated</dt>
        <dd title={exactTime(p().updatedAt)}>
          {relativeTime(p().updatedAt, Date.now()) ?? "—"}
          <Show when={props.info?.updater}>{(u) => <span class="iris-gp-muted"> by {u().name}</span>}</Show>
        </dd>
        <Show when={p().publishedAt}>
          <dt>Published</dt>
          <dd title={exactTime(p().publishedAt)}>{relativeTime(p().publishedAt, Date.now())}</dd>
        </Show>
        <Show when={owner()}>
          <dt>Board</dt>
          <dd>{owner()}</dd>
        </Show>
        <Show when={props.info?.creator}>
          {(c) => (
            <>
              <dt>Made by</dt>
              <dd>{c().name}</dd>
            </>
          )}
        </Show>
      </dl>
      <Show when={p().url}>
        <button type="button" class="iris-gp-copy" title="Copy link" onClick={() => props.onCopy(p().url, "Link")}>
          <Icon name="link" size="small" />
          <span class="iris-gp-grow">{p().url}</span>
          <Icon name="copy" size="small" />
        </button>
      </Show>
      <Show when={cmd()}>
        <button type="button" class="iris-gp-copy iris-gp-cmd" title="Copy command" onClick={() => props.onCopy(cmd(), "Command")}>
          <Icon name="console" size="small" />
          <span class="iris-gp-grow">{cmd()}</span>
          <Icon name="copy" size="small" />
        </button>
      </Show>
      <Show when={props.info && !props.info.measured}>
        <p class="iris-gp-muted">Some details couldn't be read — {props.info!.reason}.</p>
      </Show>
    </aside>
  )
}
