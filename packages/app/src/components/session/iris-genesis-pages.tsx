import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { EmptyState } from "@opencode-ai/ui/empty-state"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Notice } from "@opencode-ai/ui/notice"
import { RadioGroup } from "@opencode-ai/ui/radio-group"
import { SkeletonRows } from "@opencode-ai/ui/skeleton"
import { Spinner } from "@opencode-ai/ui/spinner"
import { StatusBadge } from "@opencode-ai/ui/status-badge"
import { Tabs } from "@opencode-ai/ui/tabs"
import { useLanguage } from "@/context/language"
import { PaneDialog, PaneDialogActions, statusTone } from "./iris-pane-dialog"
import "./iris-pane-layout.css"
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
import {
  boardForPage,
  filterBySite,
  groupBySite,
  groupCount,
  readGroup,
  SITE_GROUP_KEY,
  siteNameOf,
  type SiteFilter,
} from "./iris-genesis-sites-model"
import { loadBoardSites, SITE_GLYPH, SiteChip, SiteDialog } from "./iris-genesis-sites"

/**
 * GENESIS › PAGES (#192632). The account's pages as cards that show the page itself, a detail that
 * opens on the live preview, and the page's own controls — publish, who can read it, versions, pin —
 * each gated the way `iris pages` gates it. Drawn with the ui library (Button, Tabs, DropdownMenu,
 * StatusBadge, Notice, EmptyState, PaneDialog) on iris-pane-layout.css (#194375 W5).
 *
 * THUMBNAILS, cheapest first: the platform's own screenshot (`thumbnail_url`), then og:image, both
 * plain lazy <img>; a scaled, non-interactive live frame only when neither loads, only for a page
 * anyone can open, only once its card is in view, and never more than LIVE_FRAMES at a time. Which
 * source failed is remembered for the session, so scrolling back never re-tries a dead image.
 */
type Fetch = (path: string, init?: RequestInit) => Promise<Response>
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
const DEVICE_KEY = { desktop: "iris.pages.device.desktop", tablet: "iris.pages.device.tablet", phone: "iris.pages.device.phone" } as const
const PAGE_GLYPH = "M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5"

export function IrisGenesisPages(props: {
  doFetch: Fetch
  bloqId?: number
  bloqName?: string
  boards?: { id: number | string; name: string }[]
  openExternal: (url: string) => void
}) {
  const language = useLanguage()
  const json = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const res = await props.doFetch(path, init)
    const body = (await res.json().catch(() => null)) as T | null
    if (!body) throw new Error(language.t("iris.pages.error.http", { status: res.status }))
    return body
  }
  const post = <T,>(path: string, body: unknown) =>
    json<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

  const [st, setSt] = createStore({
    view: readView((() => { try { return localStorage.getItem(PAGES_VIEW_KEY) } catch { return null } })()),
    scope: (props.bloqId != null ? "project" : "all") as "project" | "all",
    filter: "all" as PagesFilter,
    brand: undefined as number | undefined,
    // Which site (#192672): every page, pages in no site, or one site's. Grouping draws pages under
    // their site, Elon's layout; it is on unless the person turned it off.
    site: "any" as SiteFilter,
    grouped: readGroup((() => { try { return localStorage.getItem(SITE_GROUP_KEY) } catch { return null } })()),
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
  const setGrouped = (on: boolean) => {
    setSt({ grouped: on, page: 1 })
    try { localStorage.setItem(SITE_GROUP_KEY, on ? "1" : "0") } catch {}
  }
  // Grouped, a page of results is 100 rather than 24: a site's pages split across pager pages read
  // as a site with fewer pages than it has. Each group header still says when that is so.
  const perPage = () => (st.grouped || st.site !== "any" ? 100 : PER_PAGE)

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
    const qs = new URLSearchParams({ scope, filter: st.filter, page: String(st.page), perPage: String(perPage()) })
    if (q) qs.set("q", q)
    try {
      const r = await json<PagesPayload>(`/iris/pages/${board ?? 0}?${qs}`)
      if (mine !== latest) return
      if (!r.measured) setError(r.reason ?? language.t("iris.pages.error.unread"))
      setData(r)
    } catch (e) {
      if (mine !== latest) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (mine === latest) setLoading(false)
    }
  }
  createEffect(on([() => props.bloqId, () => st.scope, () => st.filter, () => st.brand, () => st.q, () => st.page, perPage], () => void load()))
  const rows = createMemo(() => {
    const all = data()?.pages ?? []
    const bf = brandFilter()
    const branded = !bf || bf.bloqId != null ? all : all.filter((p) => brandOf(p)?.brand.id === bf.id)
    return filterBySite(branded, st.site)
  })

  // ── sites (#192672): which site each page is in, and putting it in one ──
  const [boardSites, { refetch: refetchSites }] = createResource(
    () => props.bloqId,
    (b) => loadBoardSites(props.doFetch, b),
  )
  const sites = () => boardSites.latest?.sites ?? []
  const siteName = (p: GenesisPage) => siteNameOf(p, sites())
  const siteFilterLabel = () =>
    st.site === "any"
      ? language.t("iris.pages.site.any")
      : st.site === "none"
        ? language.t("iris.pages.site.none")
        : (sites().find((x) => x.id === st.site)?.name ?? language.t("iris.pages.site.numbered", { id: st.site }))
  const groups = createMemo(() => groupBySite(rows(), sites()))
  const [collapsed, setCollapsed] = createStore<Record<string, boolean>>({})
  /** The cards in the order they are drawn — what the arrow keys walk. */
  const ordered = createMemo(() => (st.grouped ? groups().flatMap((g) => (collapsed[g.key] ? [] : g.pages)) : rows()))
  const [sitePage, setSitePage] = createSignal<GenesisPage>()
  function siteChanged(page: GenesisPage, siteId: number | undefined, text: string) {
    const patch = (x: GenesisPage) => (x.id === page.id ? { ...x, siteId } : x)
    setData((d) => (d ? { ...d, pages: d.pages.map(patch) } : d))
    setOpen((o) => (o ? patch(o) : o))
    setInfo((i) => (i?.page ? { ...i, page: patch(i.page) } : i))
    setSitePage(undefined)
    setNote({ tone: "good", text })
    void refetchSites()
  }
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
  createEffect(on(ordered, () => setFocus(-1)))
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
      if (!url) return setFrame({ state: "refused", title: language.t("iris.pages.frame.nothing"), detail: language.t("iris.pages.frame.nothing.detail") })
      setFrame({ state: "checking" })
      const q = new URLSearchParams({ url, origin: location.origin })
      void json<{ state?: string; reason?: string; status?: number }>(`/iris/frame-check?${q}`)
        .then((a) => {
          if (previewUrl() !== url) return
          const host = (() => { try { return new URL(url).host } catch { return url } })()
          const appAllowed = /tauri:\/\/localhost|localhost|127\.0\.0\.1/.test(a.reason ?? "")
          if (a.state === "unreachable") return setFrame({ state: "refused", title: language.t("iris.pages.frame.unreachable", { host }), detail: a.reason ?? language.t("iris.pages.frame.noConnection") })
          if (a.state === "refused" && !appAllowed) return setFrame({ state: "refused", title: language.t("iris.pages.frame.refused"), detail: a.reason ?? language.t("iris.pages.frame.refused.detail") })
          if (typeof a.status === "number" && a.status >= 400)
            return setFrame({
              state: "refused",
              title: a.status === 404 ? language.t("iris.pages.frame.notLive") : language.t("iris.pages.frame.status", { host, status: a.status }),
              detail: a.status === 404 ? language.t("iris.pages.frame.notLive.detail") : url,
            })
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
    if (me().id === id) return language.t("iris.pages.you")
    const i = info()
    if (i?.creator?.id === id) return i.creator.name
    if (i?.updater?.id === id) return i.updater.name
    return language.t("iris.pages.userN", { id })
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
      if (!r.ok) return setNote({ tone: "bad", text: language.t("iris.pages.note.notSaved", { reason: r.reason ?? language.t("iris.pages.refusedShort") }) })
      setDoc({ ...d, json: text, currentVersion: r.version ?? d.currentVersion })
      setDraft(undefined)
      setNote({ tone: "good", text: r.version != null ? language.t("iris.pages.note.savedAs", { version: r.version }) : language.t("iris.pages.note.saved") })
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
      if (!r.ok) return setNote({ tone: "bad", text: language.t("iris.pages.note.didntHappen", { what: actionWord(language.t, action), reason: r.reason ?? language.t("iris.pages.refused") }) })
      const next = { ...p, ...(r.page ?? {}) }
      setOpen(next)
      setInfo((i) => (i ? { ...i, page: next } : i))
      setData((d) => (d ? { ...d, pages: d.pages.map((x) => (x.id === next.id ? { ...x, ...next } : x)) } : d))
      setNote({ tone: "good", text: narrowedNote(p, action) ?? doneWord(language.t, action, next) })
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
    if (!k) return setNote({ tone: "bad", text: language.t("iris.pages.pin.signIn") })
    setBusy("pin")
    const r = await checkPin(props.doFetch, p.slug)
    setBusy(undefined)
    if (!r.ok) return setNote({ tone: "bad", text: language.t("iris.pages.pin.notPinned", { reason: r.reason }) })
    try {
      localStorage.setItem(k, serializePins(addPin(parsePins(localStorage.getItem(k)), r.pin)))
    } catch {}
    setPinned(true)
    setNote({ tone: "good", text: language.t("iris.pages.pin.pinned", { label: r.pin.label }) })
  }

  const copy = async (text: string | undefined, what: string) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setNote({ tone: "info", text: language.t("iris.pages.copied", { what }) })
    } catch {
      setNote({ tone: "bad", text: language.t("iris.pages.noClipboard") })
    }
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (!t || e.metaKey || e.ctrlKey || e.altKey) return
      if (!t.closest(".iris-gp") && t !== document.body) return
      const typing = !!t.closest("input,textarea,select,[contenteditable]")
      if (e.key === "Escape") {
        // The confirm, the site dialog and the menus are the ui Dialog / DropdownMenu, portalled
        // outside the pane: they take their own Escape. These guards keep one Escape from also
        // closing the page under them.
        if (confirm() || sitePage()) return
        if (open() && !typing) return (closePage(), e.preventDefault())
        return
      }
      if (open() || typing || sitePage() || confirm()) return
      if (e.key === "/") {
        searchEl?.focus()
        e.preventDefault()
      } else if (e.key.startsWith("Arrow")) {
        const n = moveFocus(focus(), e.key, ordered().length, cols())
        if (n >= 0) focusCard(n)
        e.preventDefault()
      } else if (e.key === "Enter" && !t.closest("button") && focus() >= 0 && ordered()[focus()]) {
        openPage(ordered()[focus()])
        e.preventDefault()
      }
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  const empty = (): JSX.Element => {
    const bf = brandFilter()
    if (st.q)
      return st.filter !== "all"
        ? language.t("iris.pages.empty.queryIn", { q: st.q, filter: FILTERS.find((f) => f.id === st.filter)!.label })
        : language.t("iris.pages.empty.query", { q: st.q })
    if (bf) return language.t("iris.pages.empty.brand", { name: bf.name })
    if (st.site === "none") return language.t("iris.pages.empty.allInSites")
    if (st.site !== "any") return language.t("iris.pages.empty.site", { name: siteFilterLabel() })
    if (st.filter === "draft") return language.t("iris.pages.empty.drafts")
    if (st.filter === "published") return language.t("iris.pages.empty.published")
    if (st.filter === "private") return language.t("iris.pages.empty.private")
    if (st.scope === "project")
      return (
        <>
          {language.t("iris.pages.empty.project", { board: props.bloqName ?? language.t("iris.pages.empty.thisBoard") })}
          <code>iris pages create</code>.
        </>
      )
    return language.t("iris.pages.empty.account")
  }

  const card = (p: GenesisPage) => {
    const i = () => ordered().indexOf(p)
    return (
      <PageCard
        page={p}
        brand={brandOf(p)}
        board={p.ownerType === "bloq" ? boardName(p.ownerId) : undefined}
        site={siteName(p)}
        focused={focus() === i()}
        onFocus={() => setFocus(i())}
        onOpen={() => openPage(p)}
        onCopy={() => copy(p.url, language.t("iris.pages.what.link"))}
        onExternal={() => p.url && props.openExternal(p.url)}
        onSite={() => setSitePage(p)}
      />
    )
  }

  const noteBanner = () => (
    <Show when={note()}>
      {(n) => (
        <Notice
          class="iris-gp-banner"
          tone={statusTone(n().tone)}
          role={n().tone === "bad" ? "alert" : "status"}
          icon={<Icon name={n().tone === "bad" ? "warning" : n().tone === "good" ? "circle-check" : "check-small"} size="small" />}
          action={<IconButton icon="close-small" variant="ghost" size="small" aria-label={language.t("common.dismiss")} onClick={() => setNote(undefined)} />}
        >
          {n().text}
        </Notice>
      )}
    </Show>
  )
  const scopes = ["all", "project"] as const

  return (
    <div class="iris-ui iris-gp" data-slot="iris-genesis-pages" data-view={st.view} data-open={open() ? "" : undefined}>
      <Show when={!open()}>
        {/* ── toolbar ── */}
        <div class="iris-ui-bar">
          <label class="iris-ui-search">
            <Icon name="magnifying-glass" size="small" />
            <input
              ref={searchEl}
              type="search"
              placeholder={language.t("iris.pages.search")}
              aria-label={language.t("iris.pages.search")}
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
            <RadioGroup
              size="small"
              class="iris-gp-scope"
              aria-label={language.t("iris.pages.scope.label")}
              options={[...scopes]}
              current={st.scope}
              label={(v) => (v === "all" ? language.t("iris.pages.scope.all") : language.t("iris.pages.scope.project"))}
              onSelect={(v) => v && ((scopeChosen = true), setSt({ scope: v, page: 1 }))}
            />
          </Show>
          <span class="iris-ui-spacer" />
          <div class="iris-gp-seg" role="group" aria-label={language.t("iris.pages.layout")}>
            <Button variant="ghost" size="small" class="iris-gp-iconbtn" aria-pressed={st.view === "grid"} title={language.t("iris.pages.layout.cards")} aria-label={language.t("iris.pages.layout.cards")} onClick={() => setView("grid")}>
              <Svg d={GRID} />
            </Button>
            <Button variant="ghost" size="small" class="iris-gp-iconbtn" aria-pressed={st.view === "list"} title={language.t("iris.pages.layout.list")} aria-label={language.t("iris.pages.layout.list")} onClick={() => setView("list")}>
              <Svg d={LIST} />
            </Button>
          </div>
          <Button
            variant="ghost"
            size="small"
            class="iris-gp-iconbtn"
            data-slot="gp-group-by-site"
            aria-pressed={st.grouped}
            title={st.grouped ? language.t("iris.pages.group.on") : language.t("iris.pages.group")}
            aria-label={language.t("iris.pages.group")}
            onClick={() => setGrouped(!st.grouped)}
          >
            <Svg d={SITE_GLYPH} />
          </Button>
          <Button variant="ghost" size="small" class="iris-gp-iconbtn" title={language.t("iris.pages.refresh")} aria-label={language.t("iris.pages.refresh")} disabled={loading()} onClick={() => void load()}>
            <Show when={loading()} fallback={<Icon name="reset" size="small" />}>
              <Spinner class="iris-ui-spin" />
            </Show>
          </Button>
        </div>

        {/* ── filter row with counts, and the site and brand filters ── */}
        <div class="iris-gp-filters">
          <Tabs variant="pill" size="small" value={st.filter} onChange={(v: string) => setSt({ filter: v as PagesFilter, page: 1 })}>
            <Tabs.List aria-label={language.t("iris.pages.filter.label")}>
              <For each={FILTERS}>
                {(f) => (
                  <Tabs.Trigger value={f.id} title={f.hint}>
                    {f.label}
                    <Show when={counts()[f.id] != null}>
                      <span class="n">{counts()[f.id]!.toLocaleString("en-US")}</span>
                    </Show>
                  </Tabs.Trigger>
                )}
              </For>
            </Tabs.List>
          </Tabs>
          <span class="iris-ui-spacer" />
          <DropdownMenu gutter={4} placement="bottom-end">
            <DropdownMenu.Trigger as={Button} variant="ghost" size="small" class="iris-gp-pick" data-testid="gp-site-filter" data-on={st.site !== "any" ? "" : undefined}>
              <Svg d={SITE_GLYPH} />
              {siteFilterLabel()}
              <Icon name="chevron-down" size="small" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="iris-gp-menu" aria-label={language.t("iris.pages.site.label")}>
                <DropdownMenu.RadioGroup
                  value={String(st.site)}
                  onChange={(raw) => { const v = String(raw); setSt({ site: v === "any" || v === "none" ? v : Number(v), page: 1 }) }}
                >
                  <DropdownMenu.RadioItem value="any">
                    <DropdownMenu.ItemLabel>{language.t("iris.pages.site.any")}</DropdownMenu.ItemLabel>
                    <DropdownMenu.ItemIndicator><Icon name="check-small" size="small" /></DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                  <DropdownMenu.RadioItem value="none">
                    <span class="iris-gp-grow">
                      <DropdownMenu.ItemLabel>{language.t("iris.pages.site.none")}</DropdownMenu.ItemLabel>
                      <DropdownMenu.ItemDescription>{language.t("iris.pages.site.none.sub")}</DropdownMenu.ItemDescription>
                    </span>
                    <DropdownMenu.ItemIndicator><Icon name="check-small" size="small" /></DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                  <For each={sites()}>
                    {(x) => (
                      <DropdownMenu.RadioItem value={String(x.id)}>
                        <span class="iris-gp-grow">
                          <DropdownMenu.ItemLabel>{x.name}</DropdownMenu.ItemLabel>
                          <DropdownMenu.ItemDescription>
                            /s/{x.slug} · {language.plural("iris.pages.pageCount", x.pagesCount)}
                          </DropdownMenu.ItemDescription>
                        </span>
                        <DropdownMenu.ItemIndicator><Icon name="check-small" size="small" /></DropdownMenu.ItemIndicator>
                      </DropdownMenu.RadioItem>
                    )}
                  </For>
                </DropdownMenu.RadioGroup>
                <Show when={props.bloqId == null}>
                  <p class="iris-gp-menunote">{language.t("iris.pages.site.openProject")}</p>
                </Show>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
          <DropdownMenu gutter={4} placement="bottom-end">
            <DropdownMenu.Trigger as={Button} variant="ghost" size="small" class="iris-gp-pick" data-testid="gp-brand-filter" data-on={st.brand != null ? "" : undefined} disabled={brands().length === 0}>
              <Show when={brandFilter()} fallback={<>{language.t("iris.pages.brand.any")}</>}>
                {(b) => (
                  <>
                    <BrandMark brand={b()} />
                    {b().name}
                  </>
                )}
              </Show>
              <Icon name="chevron-down" size="small" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="iris-gp-menu" aria-label={language.t("iris.pages.brand.label")}>
                <DropdownMenu.RadioGroup value={st.brand == null ? "" : String(st.brand)} onChange={(raw) => { const v = String(raw ?? ""); setSt({ brand: v ? Number(v) : undefined, page: 1 }) }}>
                  <DropdownMenu.RadioItem value="">
                    <DropdownMenu.ItemLabel>{language.t("iris.pages.brand.any")}</DropdownMenu.ItemLabel>
                    <DropdownMenu.ItemIndicator><Icon name="check-small" size="small" /></DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                  <For each={brands()}>
                    {(b) => (
                      <DropdownMenu.RadioItem value={String(b.id)}>
                        <BrandMark brand={b} />
                        <DropdownMenu.ItemLabel>{b.name}</DropdownMenu.ItemLabel>
                        <Swatches brand={b} max={4} />
                        <DropdownMenu.ItemIndicator><Icon name="check-small" size="small" /></DropdownMenu.ItemIndicator>
                      </DropdownMenu.RadioItem>
                    )}
                  </For>
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </div>

        {noteBanner()}

        <Show when={error() && data()?.pages?.length}>
          <Notice class="iris-gp-banner" tone="critical" role="alert" icon={<Icon name="warning" size="small" />}>
            {language.t("iris.pages.error.refresh", { error: error() ?? "" })}
          </Notice>
        </Show>

        {/* ── the cards ── */}
        <div class="iris-gp-scroll">
          <Switch>
            <Match when={error() && !data()?.pages?.length}>
              <EmptyState
                size="small"
                role="alert"
                icon={<Icon name="warning" size="small" />}
                title={language.t("iris.pages.error.read", { error: error() ?? "" })}
                action={
                  <Button size="small" onClick={() => void load()}>
                    {language.t("iris.pages.tryAgain")}
                  </Button>
                }
              />
            </Match>
            <Match when={!data() && loading()}>
              <SkeletonRows class="iris-gp-skeleton" rows={6} label={language.t("iris.pages.loading")} />
            </Match>
            <Match when={data() && rows().length === 0}>
              <EmptyState size="small" icon={<Svg d={PAGE_GLYPH} />} title={empty()} />
            </Match>
            <Match when={rows().length > 0 && !st.grouped}>
              <div class="iris-gp-cards" ref={listEl} role="listbox" aria-label={language.t("iris.pages.list")} data-busy={loading() ? "" : undefined}>
                <For each={rows()}>{(p) => card(p)}</For>
              </div>
            </Match>
            {/* GROUPED BY SITE (#192672) — Elon's layout: a header per site, its pages under it,
              then the pages in no site. A header says when the site holds more than are here. */}
            <Match when={rows().length > 0 && st.grouped}>
              <div class="iris-gs-groups" ref={listEl} data-slot="gp-site-groups" data-busy={loading() ? "" : undefined}>
                <For each={groups()}>
                  {(g) => (
                    <section class="iris-gs-group" data-slot="gp-site-group" data-key={g.key}>
                      {/* A disclosure row (the whole header is the hit area), not a ui Button: it
                          lays out a name, badges, a slug and a count across the row. */}
                      <button type="button" class="iris-gs-head" aria-expanded={!collapsed[g.key]} onClick={() => setCollapsed(g.key, !collapsed[g.key])}>
                        <span class="iris-gs-caret"><Icon name="chevron-down" size="small" /></span>
                        <Show when={g.kind === "site"} fallback={<span class="iris-gs-hname">{language.t("iris.pages.group.none")}</span>}>
                          <Svg d={SITE_GLYPH} />
                          <span class="iris-gs-hname">{g.kind === "site" ? g.site.name : ""}</span>
                          <Show when={g.kind === "site" && g.known ? g.site : undefined}>
                            {(x) => (
                              <>
                                <StatusBadge size="small" tone={x().status === "published" ? "success" : "warning"}>
                                  {x().status === "published" ? language.t("iris.pages.published") : x().status}
                                </StatusBadge>
                                <Show when={x().requiresAuth}>
                                  <StatusBadge size="small" title={language.t("iris.pages.signIn.site")} mark={<Icon name="shield" size="small" />}>
                                    {language.t("iris.pages.signIn")}
                                  </StatusBadge>
                                </Show>
                                <span class="iris-gs-hslug">/s/{x().slug}</span>
                              </>
                            )}
                          </Show>
                        </Show>
                        <span class="iris-gs-hcount">
                          {g.kind === "none"
                            ? language.plural("iris.pages.group.noneCount", g.pages.length)
                            : groupCount(g.pages.length, g.known ? g.site.pagesCount : undefined)}
                        </span>
                      </button>
                      <Show when={!collapsed[g.key]}>
                        <div
                          class="iris-gp-cards"
                          role="listbox"
                          aria-label={g.kind === "site" ? language.t("iris.pages.list.inSite", { name: g.site.name }) : language.t("iris.pages.list.noSite")}
                        >
                          <For each={g.pages}>{(p) => card(p)}</For>
                        </div>
                      </Show>
                    </section>
                  )}
                </For>
              </div>
            </Match>
          </Switch>
        </div>

        <Show when={data()?.measured}>
          <div class="iris-gp-pager">
            <span class="iris-gp-range">
              {rangeLine({ page: st.page, perPage: perPage(), shown: data()!.pages.length, total: data()!.total, totalIsExact: data()!.totalIsExact })}
              <Show when={brandFilter() && brandFilter()!.bloqId == null && rows().length !== data()!.pages.length}>
                {language.t("iris.pages.range.brand", { count: rows().length, name: brandFilter()!.name })}
              </Show>
              <Show when={st.site !== "any" && !(brandFilter() && brandFilter()!.bloqId == null)}>
                {st.site === "none"
                  ? language.t("iris.pages.range.noSite", { count: rows().length })
                  : language.t("iris.pages.range.site", { count: rows().length, name: siteFilterLabel() })}
              </Show>
            </span>
            <span class="iris-ui-spacer" />
            <IconButton icon="chevron-left" variant="ghost" size="small" title={language.t("iris.pages.prev")} aria-label={language.t("iris.pages.prev")} disabled={st.page <= 1 || loading()} onClick={() => setSt("page", st.page - 1)} />
            <IconButton icon="chevron-right" variant="ghost" size="small" title={language.t("iris.pages.next")} aria-label={language.t("iris.pages.next")} disabled={!data()!.hasMore || loading()} onClick={() => setSt("page", st.page + 1)} />
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
          const views: [Tab, string][] = [
            ["preview", language.t("iris.pages.tab.preview")],
            ["versions", language.t("iris.pages.tab.versions")],
            ["edit", language.t("iris.pages.tab.edit")],
            ["json", language.t("iris.pages.tab.json")],
          ]
          return (
            <div class="iris-gp-detail">
              <div class="iris-ui-bar iris-gp-dhead">
                <IconButton icon="arrow-left" variant="ghost" size="small" title={language.t("iris.pages.back.title")} aria-label={language.t("iris.pages.back")} onClick={closePage} />
                <div class="iris-gp-dtitle">
                  <h3 title={p().title}>{p().title}</h3>
                  <Show when={p().slug}>
                    <span class="iris-gp-slug">/{p().slug}</span>
                  </Show>
                </div>
                <StatusBadge size="small" tone={statusTone(status().tone)}>{status().label}</StatusBadge>
                <SiteChip name={siteName(p()) ? language.t("iris.pages.site.named", { name: siteName(p())! }) : undefined} onClick={() => setSitePage(p())} />
                <span class="iris-ui-spacer" />
                <Show
                  when={p().status === "published"}
                  fallback={
                    <Button size="small" variant="primary" icon={busy() === "publish" ? undefined : "cloud-upload"} disabled={!!busy()} onClick={() => ask({ kind: "publish" })}>
                      <Show when={busy() === "publish"}>
                        <Spinner class="iris-ui-spin" />
                      </Show>
                      {language.t("iris.pages.publish")}
                    </Button>
                  }
                >
                  <Button size="small" icon={busy() === "unpublish" ? undefined : "arrow-down-to-line"} disabled={!!busy()} title={language.t("iris.pages.unpublish.title")} onClick={() => ask({ kind: "unpublish" })}>
                    <Show when={busy() === "unpublish"}>
                      <Spinner class="iris-ui-spin" />
                    </Show>
                    {language.t("iris.pages.unpublish")}
                  </Button>
                </Show>
                <DropdownMenu gutter={4} placement="bottom-end">
                  <DropdownMenu.Trigger as={Button} size="small" class="iris-gp-pick" data-testid="gp-visibility" disabled={!!busy()} title={VISIBILITY[vis()].hint}>
                    <Show when={busy() === "visibility"} fallback={<Icon name={VISIBILITY[vis()].icon} size="small" />}>
                      <Spinner class="iris-ui-spin" />
                    </Show>
                    {VISIBILITY[vis()].label}
                    <Icon name="chevron-down" size="small" />
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content class="iris-gp-menu iris-gp-vismenu" aria-label={language.t("iris.pages.visibility.label")}>
                      <DropdownMenu.RadioGroup value={vis()} onChange={(raw) => { const m = String(raw); if (m !== vis()) ask({ kind: "visibility", to: m as Visibility }) }}>
                        <For each={["public", "unlisted", "private"] as Visibility[]}>
                          {(m) => (
                            <DropdownMenu.RadioItem value={m}>
                              <Icon name={VISIBILITY[m].icon} size="small" />
                              <span class="iris-gp-grow">
                                <DropdownMenu.ItemLabel>{VISIBILITY[m].label}</DropdownMenu.ItemLabel>
                                <DropdownMenu.ItemDescription>{VISIBILITY[m].hint}</DropdownMenu.ItemDescription>
                              </span>
                              <DropdownMenu.ItemIndicator><Icon name="check-small" size="small" /></DropdownMenu.ItemIndicator>
                            </DropdownMenu.RadioItem>
                          )}
                        </For>
                      </DropdownMenu.RadioGroup>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
                <Button
                  variant="ghost"
                  size="small"
                  class="iris-gp-iconbtn"
                  aria-pressed={pinned()}
                  disabled={!p().slug || busy() === "pin"}
                  title={pinned() ? language.t("iris.pages.pinned") : language.t("iris.pages.pin")}
                  aria-label={pinned() ? language.t("iris.pages.pinned") : language.t("iris.pages.pin")}
                  onClick={() => void pin()}
                >
                  <Show when={busy() === "pin"} fallback={<Icon name="pin" size="small" />}>
                    <Spinner class="iris-ui-spin" />
                  </Show>
                </Button>
                <IconButton icon="link" variant="ghost" size="small" disabled={!p().url} title={language.t("iris.pages.copyLink")} aria-label={language.t("iris.pages.copyLink")} onClick={() => copy(p().url, language.t("iris.pages.what.link"))} />
                <IconButton
                  icon="square-arrow-top-right"
                  variant="ghost"
                  size="small"
                  disabled={!previewUrl()}
                  title={language.t("iris.pages.openBrowser")}
                  aria-label={language.t("iris.pages.openBrowser")}
                  onClick={() => previewUrl() && props.openExternal(previewUrl()!)}
                />
              </div>

              <div class="iris-gp-tabrow">
                <Tabs variant="pill" size="small" value={tab()} onChange={(v: string) => setTab(v as Tab)}>
                  <Tabs.List aria-label={language.t("iris.pages.tab.label")}>
                    <For each={views}>
                      {([id, label]) => (
                        <Tabs.Trigger value={id}>
                          {label}
                          <Show when={id === "versions" && versions()?.measured && versions()!.total != null}>
                            <span class="n">{versions()!.total}</span>
                          </Show>
                        </Tabs.Trigger>
                      )}
                    </For>
                  </Tabs.List>
                </Tabs>
                <span class="iris-ui-spacer" />
                <Show when={tab() === "preview" || tab() === "versions"}>
                  <div class="iris-gp-seg" role="group" aria-label={language.t("iris.pages.device.label")}>
                    <For each={DEVICES}>
                      {(d) => (
                        <Button
                          variant="ghost"
                          size="small"
                          class="iris-gp-iconbtn"
                          aria-pressed={device() === d.id}
                          title={`${language.t(DEVICE_KEY[d.id])} · ${d.width}px`}
                          aria-label={language.t(DEVICE_KEY[d.id])}
                          onClick={() => setDevice(d.id)}
                        >
                          <Svg d={DEVICE_PATH[d.id]} />
                        </Button>
                      )}
                    </For>
                  </div>
                  <IconButton icon="reset" variant="ghost" size="small" title={language.t("iris.pages.reload")} aria-label={language.t("iris.pages.reload")} onClick={() => setReloadKey((k) => k + 1)} />
                </Show>
              </div>

              {noteBanner()}

              <div class="iris-gp-dbody" data-tab={tab()}>
                <Switch>
                  <Match when={tab() === "preview"}>
                    <div class="iris-gp-stage">
                      <Switch>
                        <Match when={frame().state === "checking" || (!info() && p().status !== "published")}>
                          <div class="iris-ui-center"><Spinner class="iris-ui-spin" /></div>
                        </Match>
                        <Match when={frame().state === "refused"}>
                          <EmptyState
                            size="small"
                            icon={<Icon name="eye" size="small" />}
                            title={frame().title}
                            description={frame().detail}
                            action={
                              previewUrl() ? (
                                <Button size="small" icon="square-arrow-top-right" onClick={() => props.openExternal(previewUrl()!)}>
                                  {language.t("iris.pages.openBrowser")}
                                </Button>
                              ) : undefined
                            }
                          />
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
                          <EmptyState size="small" icon={<Icon name="clock" size="small" />} title={language.t("iris.pages.versions.choose")} />
                        </Match>
                        <Match when={"loading" in (versionView() as object) && versionView()}>
                          <div class="iris-ui-center"><Spinner class="iris-ui-spin" /></div>
                        </Match>
                        <Match when={(versionView() as VersionDoc).html}>
                          {(html) => (
                            <DeviceFrame
                              srcdoc={html()}
                              title={language.t("iris.pages.versions.frame", { version: (versionView() as VersionDoc).version })}
                              device={device()}
                              reloadKey={reloadKey()}
                            />
                          )}
                        </Match>
                        <Match when={versionView()}>
                          <EmptyState
                            size="small"
                            icon={<Icon name="eye" size="small" />}
                            title={language.t("iris.pages.versions.cantDraw", { version: (versionView() as VersionDoc).version })}
                            description={language.t("iris.pages.versions.cantDraw.detail", {
                              reason: (versionView() as VersionDoc).reason ?? language.t("iris.pages.versions.nothingToDraw"),
                            })}
                          />
                        </Match>
                      </Switch>
                    </div>
                    <aside class="iris-gp-side iris-gp-versions" aria-label={language.t("iris.pages.tab.versions")}>
                      <Switch>
                        <Match when={!versions()}>
                          <SkeletonRows rows={4} label={language.t("iris.pages.versions.loading")} />
                        </Match>
                        <Match when={!versions()!.measured}>
                          <EmptyState size="small" icon={<Icon name="warning" size="small" />} title={language.t("iris.pages.versions.unread", { reason: versions()!.reason ?? "" })} />
                        </Match>
                        <Match when={versions()!.versions.length === 0}>
                          <EmptyState size="small" title={language.t("iris.pages.versions.none")} />
                        </Match>
                        <Match when={versions()}>
                          <For each={versions()!.versions}>
                            {(v) => {
                              const current = () => v.version === p().version
                              const viewing = () => (versionView() as VersionDoc | undefined)?.version === v.version || (versionView() as { loading?: number } | undefined)?.loading === v.version
                              const by = () => personName(v.byId)
                              return (
                                <div class="iris-gp-ver" aria-selected={viewing()} data-current={current() ? "" : undefined}>
                                  {/* A two-line row button (version, badge, time / who, summary), not a ui Button. */}
                                  <button type="button" class="iris-gp-verbtn" onClick={() => showVersion(v.version)}>
                                    <span class="iris-gp-vertop">
                                      <b>v{v.version}</b>
                                      <Show when={current()}>
                                        <StatusBadge size="small" tone="success">{language.t("iris.pages.versions.current")}</StatusBadge>
                                      </Show>
                                      <span class="iris-gp-when" title={exactTime(v.createdAt)}>{relativeTime(v.createdAt, Date.now())}</span>
                                    </span>
                                    <span class="iris-gp-versub">
                                      {[by() ? language.t("iris.pages.by", { name: by()! }) : undefined, v.summary].filter(Boolean).join(" · ")}
                                    </span>
                                  </button>
                                  <Show when={!current()}>
                                    <IconButton
                                      icon="arrow-undo-down"
                                      variant="ghost"
                                      size="small"
                                      title={language.t("iris.pages.rollback", { version: v.version })}
                                      aria-label={language.t("iris.pages.rollback", { version: v.version })}
                                      disabled={!!busy()}
                                      onClick={() => ask({ kind: "rollback", version: v.version, when: relativeTime(v.createdAt, Date.now()) })}
                                    />
                                  </Show>
                                </div>
                              )
                            }}
                          </For>
                          <Show when={versions()!.hasMore}>
                            <p class="iris-gp-muted">{language.t("iris.pages.versions.older")}<code>iris pages versions {p().slug}</code></p>
                          </Show>
                        </Match>
                      </Switch>
                    </aside>
                  </Match>

                  <Match when={tab() === "edit"}>
                    <div class="iris-gp-edit">
                      <Switch>
                        <Match when={!doc()}>
                          <div class="iris-ui-center"><Spinner class="iris-ui-spin" /></div>
                        </Match>
                        <Match when={!doc()!.measured}>
                          <EmptyState size="small" icon={<Icon name="warning" size="small" />} title={language.t("iris.pages.edit.unread", { reason: doc()!.reason ?? "" })} />
                        </Match>
                        <Match when={doc()}>
                          <div class="iris-gp-editbar">
                            <span class="iris-gp-muted">
                              {doc()!.currentVersion != null
                                ? language.t("iris.pages.edit.checks", { version: doc()!.currentVersion! })
                                : language.t("iris.pages.edit.noVersion")}
                            </span>
                            <span class="iris-ui-spacer" />
                            <Button size="small" variant="primary" icon={busy() === "save" ? undefined : "save"} disabled={draft() == null || !!busy()} onClick={() => void saveDoc()}>
                              <Show when={busy() === "save"}>
                                <Spinner class="iris-ui-spin" />
                              </Show>
                              {draft() == null ? language.t("iris.pages.edit.noChanges") : language.t("common.save")}
                            </Button>
                          </div>
                          <textarea
                            class="iris-gp-editor"
                            spellcheck={false}
                            value={draft() ?? doc()!.json}
                            onInput={(e) => setDraft(e.currentTarget.value)}
                            aria-label={language.t("iris.pages.edit.label")}
                          />
                        </Match>
                      </Switch>
                    </div>
                  </Match>

                  <Match when={tab() === "json"}>
                    <div class="iris-gp-edit">
                      <div class="iris-gp-editbar">
                        <span class="iris-gp-muted">{language.t("iris.pages.json.intro")}</span>
                        <span class="iris-ui-spacer" />
                        <Button size="small" icon="copy" onClick={() => copy(JSON.stringify({ ...p(), ...(info() ?? {}) }, null, 2), language.t("iris.pages.what.json"))}>
                          {language.t("iris.pages.copy")}
                        </Button>
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
      <PaneDialog when={confirm()} onClose={() => setConfirm(undefined)} title={(c) => c.c.title} id="gp-confirm">
        {(c) => (
          <div class="iris-gp-confirm" data-slot="gp-confirm" data-action={c().action.kind} data-tone={c().c.tone}>
            <For each={c().c.body}>{(line) => <p>{line}</p>}</For>
            <PaneDialogActions>
              <Button size="small" disabled={!!busy()} onClick={() => setConfirm(undefined)}>
                {language.t("common.cancel")}
              </Button>
              <Button size="small" variant="primary" data-tone={c().c.tone} disabled={!!busy()} onClick={() => void perform(c().action, true)}>
                <Show when={busy()}>
                  <Spinner class="iris-ui-spin" />
                </Show>
                {c().c.confirmLabel}
              </Button>
            </PaneDialogActions>
          </div>
        )}
      </PaneDialog>

      {/* ── which site this page is in (#192672). SiteDialog draws its own PaneDialog. ── */}
      <Show when={sitePage()} keyed>
        {(sp) => (
          <SiteDialog
            page={sp}
            board={boardForPage(sp, props.bloqId)}
            doFetch={props.doFetch}
            onClose={() => setSitePage(undefined)}
            onChanged={(siteId, _site, text) => siteChanged(sp, siteId, text)}
          />
        )}
      </Show>
    </div>
  )
}

type Translate = ReturnType<typeof useLanguage>["t"]
const actionWord = (t: Translate, a: PageAction) =>
  a.kind === "publish"
    ? t("iris.pages.action.publishing")
    : a.kind === "unpublish"
      ? t("iris.pages.action.unpublishing")
      : a.kind === "visibility"
        ? t("iris.pages.action.change")
        : t("iris.pages.action.rollback")
function doneWord(t: Translate, a: PageAction, p: GenesisPage): string {
  if (a.kind === "publish")
    return visibilityOf(p) === "public" ? t("iris.pages.done.publishedPublic") : t("iris.pages.done.published", { hint: VISIBILITY[visibilityOf(p)].hint })
  if (a.kind === "visibility") return t("iris.pages.done.visibility", { label: VISIBILITY[a.to].label, hint: VISIBILITY[a.to].hint })
  if (a.kind === "rollback")
    return p.version != null
      ? t("iris.pages.done.rollbackNow", { version: a.version, now: p.version })
      : t("iris.pages.done.rollback", { version: a.version })
  return t("iris.pages.done")
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
  const language = useLanguage()
  const v = () => visibilityOf(props.page)
  return (
    <Show
      when={props.page.requiresAuth}
      fallback={
        <StatusBadge size="small" title={VISIBILITY[v()].hint} data-vis={v()} mark={<Icon name={VISIBILITY[v()].icon} size="small" />}>
          {VISIBILITY[v()].label}
        </StatusBadge>
      }
    >
      <StatusBadge
        size="small"
        title={language.t("iris.pages.members.title", { label: VISIBILITY[v()].label })}
        data-vis="members"
        mark={<Icon name="shield" size="small" />}
      >
        {language.t("iris.pages.members")}
      </StatusBadge>
    </Show>
  )
}

function PageCard(props: {
  page: GenesisPage
  brand?: BrandMatch
  board?: string
  site?: string
  focused: boolean
  onFocus: () => void
  onOpen: () => void
  onCopy: () => void
  onExternal: () => void
  onSite: () => void
}) {
  const language = useLanguage()
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
          <IconButton icon="eye" variant="ghost" size="small" title={language.t("iris.pages.preview")} aria-label={language.t("iris.pages.preview.label", { title: p().title })} tabIndex={-1} onClick={stop(props.onOpen)} />
          <IconButton icon="link" variant="ghost" size="small" title={language.t("iris.pages.copyLink")} aria-label={language.t("iris.pages.copyLink")} tabIndex={-1} disabled={!p().url} onClick={stop(props.onCopy)} />
          <IconButton
            icon="square-arrow-top-right"
            variant="ghost"
            size="small"
            title={language.t("iris.pages.openBrowser")}
            aria-label={language.t("iris.pages.openBrowser")}
            tabIndex={-1}
            disabled={!p().url || p().status !== "published"}
            onClick={stop(props.onExternal)}
          />
        </div>
      </div>
      <div class="iris-gp-meta">
        <div class="iris-gp-name" title={p().title}>{p().title}</div>
        <div class="iris-gp-slug" title={p().url}>/{p().slug ?? p().id}</div>
        <div class="iris-gp-chips">
          <StatusBadge size="small" tone={statusTone(status().tone)}>{status().label}</StatusBadge>
          <VisChip page={p()} />
          <SiteChip name={props.site} onClick={props.onSite} />
          <span class="iris-gp-when" title={exactTime(p().updatedAt)}>{relativeTime(p().updatedAt, Date.now())}</span>
        </div>
        <Show when={props.brand}>
          {(b) => (
            <div class="iris-gp-brand" title={`${b().brand.name} — ${BRAND_BY[b().by]}`} data-by={b().by}>
              <BrandMark brand={b().brand} />
              <span class="iris-gp-brandname">{b().brand.name}</span>
              <Show when={isGuessed(b())}>
                <span class="iris-gp-guessed">{language.t("iris.pages.guessed")}</span>
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
  const language = useLanguage()
  const p = () => props.page
  const vis = () => visibilityOf(p())
  const owner = () =>
    p().ownerType === "bloq"
      ? (props.info?.ownerName ?? props.board ?? (p().ownerId != null ? language.t("iris.pages.boardN", { id: p().ownerId! }) : undefined))
      : (props.info?.ownerName ?? language.t("iris.pages.yourAccount"))
  const cmd = () => viewCommand(p().slug)
  return (
    <aside class="iris-gp-side" aria-label={language.t("iris.pages.side.label")} data-slot="gp-side">
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
        <dt>{language.t("iris.pages.fact.status")}</dt>
        <dd>
          <StatusBadge size="small" tone={statusTone(statusOf(p()).tone)}>{statusOf(p()).label}</StatusBadge>
          <Show when={props.previewing}>
            <span class="iris-gp-muted">{language.t("iris.pages.fact.draftPreview")}</span>
          </Show>
        </dd>
        <dt>{language.t("iris.pages.fact.access")}</dt>
        <dd>
          <VisChip page={p()} />
        </dd>
        <dd class="iris-gp-wide iris-gp-muted">
          {VISIBILITY[vis()].hint}
          {p().requiresAuth ? language.t("iris.pages.fact.signInFirst") : ""}.
        </dd>
        <Show when={p().version != null}>
          <dt>{language.t("iris.pages.fact.version")}</dt>
          <dd>v{p().version}</dd>
        </Show>
        <dt>{language.t("iris.pages.fact.updated")}</dt>
        <dd title={exactTime(p().updatedAt)}>
          {relativeTime(p().updatedAt, Date.now()) ?? "—"}
          <Show when={props.info?.updater}>{(u) => <span class="iris-gp-muted">{language.t("iris.pages.fact.byName", { name: u().name })}</span>}</Show>
        </dd>
        <Show when={p().publishedAt}>
          <dt>{language.t("iris.pages.fact.published")}</dt>
          <dd title={exactTime(p().publishedAt)}>{relativeTime(p().publishedAt, Date.now())}</dd>
        </Show>
        <Show when={owner()}>
          <dt>{language.t("iris.pages.fact.board")}</dt>
          <dd>{owner()}</dd>
        </Show>
        <Show when={props.info?.creator}>
          {(c) => (
            <>
              <dt>{language.t("iris.pages.fact.madeBy")}</dt>
              <dd>{c().name}</dd>
            </>
          )}
        </Show>
      </dl>
      <Show when={p().url}>
        <button type="button" class="iris-gp-copy" title={language.t("iris.pages.copyLink")} onClick={() => props.onCopy(p().url, language.t("iris.pages.what.link"))}>
          <Icon name="link" size="small" />
          <span class="iris-gp-grow">{p().url}</span>
          <Icon name="copy" size="small" />
        </button>
      </Show>
      <Show when={cmd()}>
        <button type="button" class="iris-gp-copy iris-gp-cmd" title={language.t("iris.pages.copyCommand")} onClick={() => props.onCopy(cmd(), language.t("iris.pages.what.command"))}>
          <Icon name="console" size="small" />
          <span class="iris-gp-grow">{cmd()}</span>
          <Icon name="copy" size="small" />
        </button>
      </Show>
      <Show when={props.info && !props.info.measured}>
        <p class="iris-gp-muted">{language.t("iris.pages.side.partial", { reason: props.info!.reason ?? "" })}</p>
      </Show>
    </aside>
  )
}
