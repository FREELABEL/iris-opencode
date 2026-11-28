import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Notice } from "@opencode-ai/ui/notice"
import { SkeletonRows } from "@opencode-ai/ui/skeleton"
import { Spinner } from "@opencode-ai/ui/spinner"
import { StatusBadge } from "@opencode-ai/ui/status-badge"
import { useLanguage } from "@/context/language"
import { PaneDialog, PaneDialogActions, statusTone } from "./iris-pane-dialog"
import "./iris-pane-layout.css"
import "./iris-genesis-sites.css"
import {
  addablePages,
  movePage,
  siteChange,
  siteChangeLabel,
  siteChangeLine,
  siteNameOf,
  type SiteSummary,
  type SitesPayload,
} from "./iris-genesis-sites-model"

/**
 * GENESIS › SITES, the controls (#192672): put a page in a site and see which site it is in.
 * Ported from Elon's BloqPagesSection (attach = POST /sites/{site}/pages/{page}, detach = DELETE),
 * through the engine's /iris/site routes, drawn with the ui library (Button, Dialog, StatusBadge, Notice).
 *
 * Two pieces: SiteDialog — one page, choose its site (or none), with the one plain line of what
 * changes — and SitePagesEditor — one site, its pages in order, add / remove / reorder.
 */
type Fetch = (path: string, init?: RequestInit) => Promise<Response>

export type SiteDetail = {
  id: number
  name: string
  slug: string
  status: string
  requiresAuth: boolean
  homePageId?: number
  pages: { id: number; title: string; slug?: string; status: string; sortOrder: number; updatedAt?: string }[]
}
type SiteResult = { ok: boolean; reason?: string; site?: SiteDetail }

export const SITE_GLYPH = "M9.5 3h5v4h-5zM3.5 17h5v4h-5zM15.5 17h5v4h-5zM12 7v5M6 17v-5h12v5"
const UP = "M6 15l6-6 6 6"
const DOWN = "M6 9l6 6 6-6"

export const Svg = (p: { d: string }) => (
  <svg class="iris-ui-svg" viewBox="0 0 24 24" aria-hidden="true">
    <path d={p.d} />
  </svg>
)

async function json<T>(doFetch: Fetch, path: string, init?: RequestInit): Promise<T> {
  const res = await doFetch(path, init)
  const body = (await res.json().catch(() => null)) as T | null
  if (!body) throw new Error(`IRIS answered HTTP ${res.status}`)
  return body
}
const send = <T,>(doFetch: Fetch, path: string, method: string, body?: unknown) =>
  json<T>(doFetch, path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })

/** A board's sites, as the Sites pane lists them. Not signed in / unreadable comes back unmeasured. */
export async function loadBoardSites(doFetch: Fetch, board: number): Promise<SitesPayload> {
  try {
    const r = await json<SitesPayload>(doFetch, `/iris/sites/${board}?perPage=200`)
    return { measured: !!r.measured, reason: r.reason, sites: r.sites ?? [] }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), sites: [] }
  }
}

export function SiteChip(props: { name?: string; onClick: (e: MouseEvent) => void; title?: string }) {
  const language = useLanguage()
  return (
    <Button
      variant="ghost"
      size="small"
      class="iris-gs-chip"
      data-slot="gp-site-chip"
      data-in={props.name ? "" : undefined}
      title={
        props.title ??
        (props.name ? language.t("iris.sites.chip.in", { name: props.name }) : language.t("iris.sites.chip.none"))
      }
      onClick={(e: MouseEvent) => {
        e.stopPropagation()
        props.onClick(e)
      }}
    >
      <Svg d={SITE_GLYPH} />
      <span class="iris-gs-chipname">{props.name ?? language.t("iris.sites.noSite")}</span>
      <Icon name="chevron-down" size="small" />
    </Button>
  )
}

/**
 * One page: which site is it in, and change that. The list is the sites of the board that owns the
 * page (else the open board); a new site can be made here without leaving the page.
 */
export function SiteDialog(props: {
  page: { id: number; title: string; siteId?: number }
  board?: number
  doFetch: Fetch
  onClose: () => void
  /** The page's new site (undefined = none), the site read back, and what to tell the person. */
  onChanged: (siteId: number | undefined, site: SiteDetail | undefined, note: string) => void
}) {
  const language = useLanguage()
  const [sites, { refetch }] = createResource(
    () => props.board,
    (b) => loadBoardSites(props.doFetch, b),
  )
  const list = () => sites()?.sites ?? []
  const [pick, setPick] = createSignal<number | undefined>(props.page.siteId)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [naming, setNaming] = createSignal(false)
  const [name, setName] = createSignal("")

  const from = () => (props.page.siteId == null ? undefined : { id: props.page.siteId, name: siteNameOf(props.page, list())! })
  const to = () => {
    const id = pick()
    return id == null ? undefined : { id, name: list().find((s) => s.id === id)?.name ?? language.t("iris.sites.numbered", { id }) }
  }
  const change = createMemo(() => siteChange(from(), to()))

  async function create() {
    const n = name().trim()
    if (!n || props.board == null) return
    setBusy(true)
    setError(undefined)
    try {
      const r = await send<SiteResult>(props.doFetch, `/iris/site`, "POST", { name: n, bloqId: props.board })
      if (!r.ok || !r.site) return setError(language.t("iris.sites.error.notMade", { reason: r.reason ?? language.t("iris.sites.refused") }))
      await refetch()
      setPick(r.site.id)
      setNaming(false)
      setName("")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    const c = change()
    if (c.kind === "same") return props.onClose()
    setBusy(true)
    setError(undefined)
    try {
      const f = from()
      const t = to()
      const r = t
        ? await send<SiteResult>(props.doFetch, `/iris/site/${t.id}/pages/${props.page.id}`, "POST", f ? { fromSiteId: f.id } : {})
        : await send<SiteResult>(props.doFetch, `/iris/site/${f!.id}/pages/${props.page.id}`, "DELETE")
      if (!r.ok) return setError(language.t("iris.sites.error.didntHappen", { what: siteChangeLabel(c), reason: r.reason ?? language.t("iris.sites.refused") }))
      props.onChanged(
        t?.id,
        r.site,
        t
          ? language.t("iris.sites.note.in", { name: t.name, line: siteChangeLine(c) ?? "" })
          : language.t("iris.sites.note.out", { name: f!.name }),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const Option = (o: { id?: number; label: string; sub?: string; site?: SiteSummary }) => (
    <button type="button" role="radio" class="iris-gs-opt" aria-checked={pick() === o.id} disabled={busy()} onClick={() => setPick(o.id)}>
      <span class="iris-gs-radio" aria-hidden="true" />
      <span class="iris-gs-grow">
        <span class="iris-gs-optname">{o.label}</span>
        <Show when={o.sub}>
          <span class="iris-gs-sub">{o.sub}</span>
        </Show>
      </span>
      <Show when={o.site?.requiresAuth}>
        <StatusBadge size="small" title={language.t("iris.sites.signIn.title")} mark={<Icon name="shield" size="small" />}>
          {language.t("iris.sites.signIn")}
        </StatusBadge>
      </Show>
      <Show when={props.page.siteId != null && props.page.siteId === o.id}>
        <StatusBadge size="small">{language.t("iris.sites.now")}</StatusBadge>
      </Show>
    </button>
  )

  return (
    <PaneDialog
      when={true}
      onClose={props.onClose}
      title={() => language.t("iris.sites.dialog.title", { title: props.page.title })}
      class="iris-gs-dialog"
      id="gp-site-dialog"
    >
      {() => (
        <>
        <p class="iris-gs-intro">{language.t("iris.sites.dialog.intro")}</p>
        <Switch>
          <Match when={props.board == null}>
            <p class="iris-gs-sub">{language.t("iris.sites.dialog.noBoard")}</p>
          </Match>
          <Match when={sites.loading && !sites.latest}>
            <SkeletonRows rows={3} label={language.t("iris.sites.loading")} />
          </Match>
          <Match when={sites.latest && !sites.latest.measured}>
            <p class="iris-gs-sub" role="alert">{language.t("iris.sites.error.unreadBoard", { reason: sites.latest!.reason ?? "" })}</p>
          </Match>
          <Match when={sites.latest}>
            <div class="iris-gs-opts" role="radiogroup" aria-label={language.t("iris.sites.site")}>
              <For each={list()}>
                {(s) => (
                  <Option
                    id={s.id}
                    label={s.name}
                    sub={`/s/${s.slug} · ${language.plural("iris.sites.pageCount", s.pagesCount)}${s.status === "published" ? "" : ` · ${s.status}`}`}
                    site={s}
                  />
                )}
              </For>
              <Show when={props.page.siteId != null && !list().some((s) => s.id === props.page.siteId)}>
                <Option id={props.page.siteId} label={language.t("iris.sites.numbered", { id: props.page.siteId! })} sub={language.t("iris.sites.notThisBoard")} />
              </Show>
              <Option id={undefined} label={language.t("iris.sites.noSite")} sub={language.t("iris.sites.noSite.sub")} />
            </div>
            <Show
              when={naming()}
              fallback={
                <Button size="small" icon="plus-small" class="iris-gs-new" disabled={busy()} onClick={() => setNaming(true)}>
                  {language.t("iris.sites.new")}
                </Button>
              }
            >
              <form
                class="iris-gs-newform"
                onSubmit={(e) => {
                  e.preventDefault()
                  void create()
                }}
              >
                <input
                  class="iris-gs-input"
                  type="text"
                  placeholder={language.t("iris.sites.new.placeholder")}
                  aria-label={language.t("iris.sites.new.label")}
                  value={name()}
                  onInput={(e) => setName(e.currentTarget.value)}
                  autofocus
                />
                <Button type="submit" size="small" disabled={busy() || !name().trim()}>
                  {language.t("iris.sites.new.create")}
                </Button>
              </form>
            </Show>
          </Match>
        </Switch>
        <Show when={siteChangeLine(change())}>
          {(line) => (
            <p class="iris-gs-line" data-slot="gp-site-line">
              {line()}
            </p>
          )}
        </Show>
        <Show when={error()}>
          <p class="iris-gs-error" role="alert">{error()}</p>
        </Show>
        <PaneDialogActions>
          <Button size="small" disabled={busy()} onClick={props.onClose}>
            {language.t("common.cancel")}
          </Button>
          <Button size="small" variant="primary" disabled={busy() || change().kind === "same"} onClick={() => void apply()}>
            <Show when={busy()}>
              <Spinner class="iris-ui-spin" />
            </Show>
            {siteChangeLabel(change())}
          </Button>
        </PaneDialogActions>
        </>
      )}
    </PaneDialog>
  )
}

type BoardPage = { id: number; title: string; slug?: string; status: string; siteId?: number }

/**
 * One site's pages, in the order its sidebar lists them: move up or down, take one out, and add
 * pages from the board that are in no site yet (several at once).
 */
export function SitePagesEditor(props: {
  siteId: number
  board?: number
  doFetch: Fetch
  navItems?: { label: string; url: string }[]
  openExternal?: (url: string) => void
  onChanged?: () => void
  /** Open with the add-pages chooser already showing (a detail's "Add page", #194582). */
  startAdding?: boolean
}) {
  const language = useLanguage()
  const [site, { mutate, refetch }] = createResource(
    () => props.siteId,
    async (id) => {
      try {
        return await json<{ measured: boolean; reason?: string; site?: SiteDetail }>(props.doFetch, `/iris/site/${id}`)
      } catch (e) {
        return { measured: false, reason: e instanceof Error ? e.message : String(e) }
      }
    },
  )
  const detail = () => site.latest?.site
  const [busy, setBusy] = createSignal<string>()
  const [note, setNote] = createSignal<{ tone: "good" | "bad"; text: string }>()
  const [removing, setRemoving] = createSignal<{ id: number; title: string }>()

  const landed = (r: SiteResult, text: string) => {
    if (!r.ok) return setNote({ tone: "bad", text: language.t("iris.sites.error.didntHappen", { what: text, reason: r.reason ?? language.t("iris.sites.refused") }) })
    if (r.site) mutate({ measured: true, site: r.site })
    else void refetch()
    props.onChanged?.()
    return true
  }

  async function reorder(id: number, delta: -1 | 1) {
    const d = detail()
    if (!d || busy()) return
    const ids = movePage(d.pages.map((p) => p.id), id, delta)
    setBusy(`move-${id}`)
    setNote(undefined)
    try {
      landed(await send<SiteResult>(props.doFetch, `/iris/site/${d.id}/reorder`, "POST", { pageIds: ids }), language.t("iris.sites.newOrder"))
    } catch (e) {
      setNote({ tone: "bad", text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(undefined)
    }
  }

  async function remove() {
    const d = detail()
    const p = removing()
    if (!d || !p) return
    setBusy(`remove-${p.id}`)
    try {
      if (landed(await send<SiteResult>(props.doFetch, `/iris/site/${d.id}/pages/${p.id}`, "DELETE"), language.t("iris.sites.removingIt")))
        setNote({ tone: "good", text: language.t("iris.sites.note.removed", { title: p.title, name: d.name }) })
      setRemoving(undefined)
    } catch (e) {
      setNote({ tone: "bad", text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(undefined)
    }
  }

  // ── adding pages ──
  const [adding, setAdding] = createSignal(!!props.startAdding)
  const [chosen, setChosen] = createSignal<Set<number>>(new Set())
  const [board] = createResource(
    () => (adding() && props.board != null ? props.board : undefined),
    async (b) => {
      try {
        return await json<{ measured: boolean; reason?: string; pages: BoardPage[]; hasMore?: boolean }>(
          props.doFetch,
          `/iris/pages/${b}?scope=project&filter=all&page=1&perPage=100`,
        )
      } catch (e) {
        return { measured: false, reason: e instanceof Error ? e.message : String(e), pages: [] as BoardPage[] }
      }
    },
  )
  const candidates = () => addablePages(board.latest?.pages ?? [])
  const toggle = (id: number) =>
    setChosen((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  async function addChosen() {
    const d = detail()
    const ids = [...chosen()]
    if (!d || ids.length === 0) return
    setBusy("add")
    setNote(undefined)
    const failed: string[] = []
    let last: SiteDetail | undefined
    for (const id of ids) {
      try {
        const r = await send<SiteResult>(props.doFetch, `/iris/site/${d.id}/pages/${id}`, "POST", {})
        if (r.ok) last = r.site ?? last
        else failed.push(`${candidates().find((p) => p.id === id)?.title ?? language.t("iris.sites.pageN", { id })}: ${r.reason ?? language.t("iris.sites.refusedShort")}`)
      } catch (e) {
        failed.push(`${language.t("iris.sites.pageN", { id })}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (last) mutate({ measured: true, site: last })
    else void refetch()
    props.onChanged?.()
    const added = ids.length - failed.length
    setNote(
      failed.length
        ? { tone: "bad", text: language.t("iris.sites.note.partial", { added, total: ids.length, failed: failed.join("; ") }) }
        : { tone: "good", text: language.plural("iris.sites.note.added", added, { name: d.name }) },
    )
    setChosen(new Set<number>())
    setAdding(false)
    setBusy(undefined)
  }

  return (
    <div class="iris-ui iris-gs-editor" data-slot="iris-site-pages">
      <Switch>
        <Match when={site.loading && !site.latest}>
          <SkeletonRows rows={4} label={language.t("iris.sites.loading")} />
        </Match>
        <Match when={site.latest && !site.latest.measured}>
          <p class="text-13-regular text-text-weak py-2" role="alert">{language.t("iris.sites.error.unreadSite", { reason: site.latest!.reason ?? "" })}</p>
        </Match>
        <Match when={detail()}>
          {(d) => (
            <>
              <div class="iris-gs-bar">
                <span class="iris-gs-sub">{language.plural("iris.sites.inOrder", d().pages.length)}</span>
                <span class="iris-ui-spacer" />
                <Button size="small" icon="plus-small" data-slot="site-add-pages" aria-expanded={adding()} disabled={!!busy()} onClick={() => setAdding(!adding())}>
                  {language.t("iris.sites.addPages")}
                </Button>
              </div>

              <Show when={note()}>
                {(n) => (
                  <Notice
                    class="iris-gs-note"
                    tone={statusTone(n().tone)}
                    role={n().tone === "bad" ? "alert" : "status"}
                    action={<IconButton icon="close-small" variant="ghost" size="small" aria-label={language.t("iris.sites.dismiss")} onClick={() => setNote(undefined)} />}
                  >
                    {n().text}
                  </Notice>
                )}
              </Show>

              <Show when={adding()}>
                <div class="iris-gs-picker" data-slot="site-add-picker">
                  <Switch>
                    <Match when={props.board == null}>
                      <p class="iris-gs-sub">{language.t("iris.sites.add.noBoard")}</p>
                    </Match>
                    <Match when={board.loading && !board.latest}>
                      <SkeletonRows rows={3} label={language.t("iris.sites.loading")} />
                    </Match>
                    <Match when={board.latest && !board.latest.measured}>
                      <p class="iris-gs-sub" role="alert">{language.t("iris.sites.error.unreadBoardPages", { reason: board.latest!.reason ?? "" })}</p>
                    </Match>
                    <Match when={candidates().length === 0}>
                      <p class="iris-gs-sub">{language.t("iris.sites.add.allInSites")}</p>
                    </Match>
                    <Match when={candidates().length > 0}>
                      <p class="iris-gs-sub">{language.t("iris.sites.add.candidates")}</p>
                      <div class="iris-gs-checks">
                        <For each={candidates()}>
                          {(p) => (
                            <label class="iris-gs-check">
                              <input type="checkbox" checked={chosen().has(p.id)} disabled={busy() === "add"} onChange={() => toggle(p.id)} />
                              <span class="iris-gs-grow">
                                <span class="iris-gs-optname">{p.title}</span>
                                <span class="iris-gs-sub">/{p.slug ?? p.id}</span>
                              </span>
                              <StatusBadge size="small">{p.status === "published" ? language.t("iris.sites.published") : language.t("iris.sites.draft")}</StatusBadge>
                            </label>
                          )}
                        </For>
                      </div>
                      <Show when={board.latest?.hasMore}>
                        <p class="iris-gs-sub">{language.t("iris.sites.add.first100")}</p>
                      </Show>
                      <Show when={chosen().size > 0}>
                        <p class="iris-gs-line" data-slot="site-add-line">{siteChangeLine({ kind: "add", to: d().name }, chosen().size)}</p>
                      </Show>
                      <div class="iris-gs-bar">
                        <span class="iris-ui-spacer" />
                        <Button size="small" disabled={busy() === "add"} onClick={() => (setAdding(false), setChosen(new Set<number>()))}>
                          {language.t("common.cancel")}
                        </Button>
                        <Button size="small" variant="primary" disabled={chosen().size === 0 || !!busy()} onClick={() => void addChosen()}>
                          <Show when={busy() === "add"}>
                            <Spinner class="iris-ui-spin" />
                          </Show>
                          {chosen().size ? language.plural("iris.sites.addN", chosen().size) : language.t("iris.sites.addPages")}
                        </Button>
                      </div>
                    </Match>
                  </Switch>
                </div>
              </Show>

              {/* Taking a page out asks inline, with the one line of what changes: a scrim inside a
                detail this short would clip its own dialog. */}
              <Show when={removing()}>
                {(r) => (
                  <Notice
                    class="iris-gs-confirm"
                    tone="warning"
                    role="alertdialog"
                    aria-labelledby="iris-gs-remove-title"
                    data-slot="site-remove-confirm"
                    action={
                      <>
                        <Button size="small" disabled={!!busy()} onClick={() => setRemoving(undefined)}>
                          {language.t("common.cancel")}
                        </Button>
                        <Button size="small" variant="primary" disabled={!!busy()} onClick={() => void remove()}>
                          <Show when={busy()}>
                            <Spinner class="iris-ui-spin" />
                          </Show>
                          {language.t("iris.sites.remove")}
                        </Button>
                      </>
                    }
                  >
                    <p class="iris-gs-optname" id="iris-gs-remove-title">{language.t("iris.sites.remove.title", { title: r().title, name: d().name })}</p>
                    <p class="iris-gs-sub">{language.t("iris.sites.remove.body", { line: siteChangeLine({ kind: "remove", from: d().name }) ?? "" })}</p>
                  </Notice>
                )}
              </Show>

              <Show when={d().pages.length > 0} fallback={<p class="iris-gs-sub iris-gs-pad">{language.t("iris.sites.empty")}</p>}>
                <ol class="iris-gs-order">
                  <For each={d().pages}>
                    {(p, i) => (
                      <li class="iris-gs-row" data-slot="site-page-row" data-id={p.id}>
                        <span class="iris-gs-n">{i() + 1}</span>
                        <span class="iris-gs-grow">
                          <span class="iris-gs-optname">{p.title}</span>
                          <span class="iris-gs-sub">/{p.slug ?? p.id}</span>
                        </span>
                        <Show when={d().homePageId === p.id}>
                          <StatusBadge size="small" title={language.t("iris.sites.home.title")}>{language.t("iris.sites.home")}</StatusBadge>
                        </Show>
                        <StatusBadge size="small" tone={p.status === "published" ? "success" : "warning"}>
                          {p.status === "published" ? language.t("iris.sites.published") : language.t("iris.sites.draft")}
                        </StatusBadge>
                        <Button variant="ghost" size="small" class="iris-gs-move" title={language.t("iris.sites.moveUp")} aria-label={language.t("iris.sites.moveUp.label", { title: p.title })} disabled={i() === 0 || !!busy()} onClick={() => void reorder(p.id, -1)}>
                          <Svg d={UP} />
                        </Button>
                        <Button variant="ghost" size="small" class="iris-gs-move" title={language.t("iris.sites.moveDown")} aria-label={language.t("iris.sites.moveDown.label", { title: p.title })} disabled={i() === d().pages.length - 1 || !!busy()} onClick={() => void reorder(p.id, 1)}>
                          <Svg d={DOWN} />
                        </Button>
                        <Show
                          when={busy() === `remove-${p.id}`}
                          fallback={
                            <IconButton icon="close-small" variant="ghost" size="small" title={language.t("iris.sites.remove")} aria-label={language.t("iris.sites.remove.label", { title: p.title })} disabled={!!busy()} onClick={() => setRemoving({ id: p.id, title: p.title })} />
                          }
                        >
                          <Spinner class="iris-ui-spin" />
                        </Show>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>

              <Show when={(props.navItems?.length ?? 0) > 0}>
                <p class="iris-gs-sub iris-gs-pad">{language.t("iris.sites.navigation")}</p>
                <For each={props.navItems}>
                  {(n) => (
                    <a
                      href={`https://heyiris.io${n.url}`}
                      target="_blank"
                      rel="noreferrer"
                      class="flex items-baseline gap-2 px-2 py-1.5 border-b border-border-weaker-base last:border-0 hover:bg-background-element"
                    >
                      <span class="text-13-regular text-text-base min-w-0 flex-1">{n.label}</span>
                      <span class="shrink-0 font-mono text-11-regular text-text-weaker">{n.url}</span>
                    </a>
                  )}
                </For>
              </Show>

            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}
