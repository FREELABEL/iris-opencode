import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import "./iris-panel-ui.css"
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
 * through the engine's /iris/site routes, drawn with the panel's shared pieces (iris-panel-ui.css).
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
  return (
    <button
      type="button"
      class="iris-ui-chip iris-gs-chip"
      data-slot="gp-site-chip"
      data-in={props.name ? "" : undefined}
      title={props.title ?? (props.name ? `In ${props.name} — change site` : "Not in a site — add it to one")}
      onClick={(e) => {
        e.stopPropagation()
        props.onClick(e)
      }}
    >
      <Svg d={SITE_GLYPH} />
      <span class="iris-gs-chipname">{props.name ?? "No site"}</span>
      <Icon name="chevron-down" size="small" />
    </button>
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
    return id == null ? undefined : { id, name: list().find((s) => s.id === id)?.name ?? `Site #${id}` }
  }
  const change = createMemo(() => siteChange(from(), to()))

  async function create() {
    const n = name().trim()
    if (!n || props.board == null) return
    setBusy(true)
    setError(undefined)
    try {
      const r = await send<SiteResult>(props.doFetch, `/iris/site`, "POST", { name: n, bloqId: props.board })
      if (!r.ok || !r.site) return setError(`The site wasn't made — ${r.reason ?? "the platform refused"}`)
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
      if (!r.ok) return setError(`${siteChangeLabel(c)} didn't happen — ${r.reason ?? "the platform refused"}`)
      props.onChanged(t?.id, r.site, t ? `In ${t.name}. ${siteChangeLine(c)}` : `Out of ${f!.name}. It keeps its own sidebar and sign-in now.`)
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
        <span class="iris-ui-chip" title="Visitors sign in once for the whole site">
          <Icon name="shield" size="small" />
          sign-in
        </span>
      </Show>
      <Show when={props.page.siteId != null && props.page.siteId === o.id}>
        <span class="iris-ui-chip">now</span>
      </Show>
    </button>
  )

  return (
    <div class="iris-ui-scrim" onClick={(e) => e.target === e.currentTarget && !busy() && props.onClose()}>
      <div class="iris-ui-dialog iris-gs-dialog" role="dialog" aria-modal="true" aria-labelledby="iris-gs-title" data-slot="gp-site-dialog">
        <div class="iris-ui-dialog-icon">
          <Svg d={SITE_GLYPH} />
        </div>
        <h3 id="iris-gs-title">Site for “{props.page.title}”</h3>
        <p class="iris-gs-intro">Pages in a site share its sidebar and sign-in rules, so people sign in once for all of them.</p>
        <Switch>
          <Match when={props.board == null}>
            <p class="iris-gs-sub">Open the page's board to see its sites.</p>
          </Match>
          <Match when={sites.loading && !sites.latest}>
            <div class="iris-ui-empty"><Spinner class="iris-ui-spin" /></div>
          </Match>
          <Match when={sites.latest && !sites.latest.measured}>
            <p class="iris-gs-sub" role="alert">Couldn't read this board's sites — {sites.latest!.reason}.</p>
          </Match>
          <Match when={sites.latest}>
            <div class="iris-gs-opts" role="radiogroup" aria-label="Site">
              <For each={list()}>
                {(s) => <Option id={s.id} label={s.name} sub={`/s/${s.slug} · ${s.pagesCount} page${s.pagesCount === 1 ? "" : "s"}${s.status === "published" ? "" : ` · ${s.status}`}`} site={s} />}
              </For>
              <Show when={props.page.siteId != null && !list().some((s) => s.id === props.page.siteId)}>
                <Option id={props.page.siteId} label={`Site #${props.page.siteId}`} sub="not one of this board's sites" />
              </Show>
              <Option id={undefined} label="No site" sub="Its own sidebar and sign-in list" />
            </div>
            <Show
              when={naming()}
              fallback={
                <button type="button" class="iris-ui-btn iris-gs-new" disabled={busy()} onClick={() => setNaming(true)}>
                  <Icon name="plus-small" size="small" />
                  New site
                </button>
              }
            >
              <form
                class="iris-gs-newform"
                onSubmit={(e) => {
                  e.preventDefault()
                  void create()
                }}
              >
                <input class="iris-gs-input" type="text" placeholder="Site name" aria-label="New site name" value={name()} onInput={(e) => setName(e.currentTarget.value)} autofocus />
                <button type="submit" class="iris-ui-btn" disabled={busy() || !name().trim()}>
                  Create
                </button>
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
        <div class="iris-ui-dialog-actions">
          <button type="button" class="iris-ui-btn" disabled={busy()} onClick={props.onClose}>
            Cancel
          </button>
          <button type="button" class="iris-ui-btn" data-primary disabled={busy() || change().kind === "same"} onClick={() => void apply()}>
            <Show when={busy()}>
              <Spinner class="iris-ui-spin" />
            </Show>
            {siteChangeLabel(change())}
          </button>
        </div>
      </div>
    </div>
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
}) {
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
    if (!r.ok) return setNote({ tone: "bad", text: `${text} didn't happen — ${r.reason ?? "the platform refused"}` })
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
      landed(await send<SiteResult>(props.doFetch, `/iris/site/${d.id}/reorder`, "POST", { pageIds: ids }), "The new order")
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
      if (landed(await send<SiteResult>(props.doFetch, `/iris/site/${d.id}/pages/${p.id}`, "DELETE"), "Removing it"))
        setNote({ tone: "good", text: `“${p.title}” is out of ${d.name}. It keeps its own sidebar and sign-in now.` })
      setRemoving(undefined)
    } catch (e) {
      setNote({ tone: "bad", text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(undefined)
    }
  }

  // ── adding pages ──
  const [adding, setAdding] = createSignal(false)
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
        else failed.push(`${candidates().find((p) => p.id === id)?.title ?? `page ${id}`}: ${r.reason ?? "refused"}`)
      } catch (e) {
        failed.push(`page ${id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (last) mutate({ measured: true, site: last })
    else void refetch()
    props.onChanged?.()
    const added = ids.length - failed.length
    setNote(
      failed.length
        ? { tone: "bad", text: `${added} of ${ids.length} added. Not added — ${failed.join("; ")}` }
        : { tone: "good", text: `${added} page${added === 1 ? "" : "s"} added to ${d.name}.` },
    )
    setChosen(new Set<number>())
    setAdding(false)
    setBusy(undefined)
  }

  return (
    <div class="iris-ui iris-gs-editor" data-slot="iris-site-pages">
      <Switch>
        <Match when={site.loading && !site.latest}>
          <div class="iris-ui-empty"><Spinner class="iris-ui-spin" /></div>
        </Match>
        <Match when={site.latest && !site.latest.measured}>
          <p class="text-12-regular text-text-weak py-2" role="alert">Couldn't read this site's pages — {site.latest!.reason}.</p>
        </Match>
        <Match when={detail()}>
          {(d) => (
            <>
              <div class="iris-gs-bar">
                <span class="iris-gs-sub">
                  {d().pages.length} page{d().pages.length === 1 ? "" : "s"}, in the order the sidebar lists them
                </span>
                <span class="iris-ui-spacer" />
                <button type="button" class="iris-ui-btn" data-slot="site-add-pages" aria-expanded={adding()} disabled={!!busy()} onClick={() => setAdding(!adding())}>
                  <Icon name="plus-small" size="small" />
                  Add pages
                </button>
              </div>

              <Show when={note()}>
                {(n) => (
                  <div class="iris-ui-callout iris-gs-note" data-tone={n().tone} role={n().tone === "bad" ? "alert" : "status"}>
                    <span class="iris-gs-grow">{n().text}</span>
                    <button type="button" class="iris-ui-icon" aria-label="Dismiss" onClick={() => setNote(undefined)}>
                      <Icon name="close-small" size="small" />
                    </button>
                  </div>
                )}
              </Show>

              <Show when={adding()}>
                <div class="iris-gs-picker" data-slot="site-add-picker">
                  <Switch>
                    <Match when={props.board == null}>
                      <p class="iris-gs-sub">This site is not on a board, so there are no board pages to add here. Add pages from Genesis › Pages instead.</p>
                    </Match>
                    <Match when={board.loading && !board.latest}>
                      <div class="iris-ui-empty"><Spinner class="iris-ui-spin" /></div>
                    </Match>
                    <Match when={board.latest && !board.latest.measured}>
                      <p class="iris-gs-sub" role="alert">Couldn't read the board's pages — {board.latest!.reason}.</p>
                    </Match>
                    <Match when={candidates().length === 0}>
                      <p class="iris-gs-sub">Every page on this board is already in a site. To move one, open it in Genesis › Pages.</p>
                    </Match>
                    <Match when={candidates().length > 0}>
                      <p class="iris-gs-sub">Pages on this board that are in no site:</p>
                      <div class="iris-gs-checks">
                        <For each={candidates()}>
                          {(p) => (
                            <label class="iris-gs-check">
                              <input type="checkbox" checked={chosen().has(p.id)} disabled={busy() === "add"} onChange={() => toggle(p.id)} />
                              <span class="iris-gs-grow">
                                <span class="iris-gs-optname">{p.title}</span>
                                <span class="iris-gs-sub">/{p.slug ?? p.id}</span>
                              </span>
                              <span class="iris-ui-chip">{p.status === "published" ? "Published" : "Draft"}</span>
                            </label>
                          )}
                        </For>
                      </div>
                      <Show when={board.latest?.hasMore}>
                        <p class="iris-gs-sub">Showing the first 100 of the board's pages.</p>
                      </Show>
                      <Show when={chosen().size > 0}>
                        <p class="iris-gs-line" data-slot="site-add-line">{siteChangeLine({ kind: "add", to: d().name }, chosen().size)}</p>
                      </Show>
                      <div class="iris-gs-bar">
                        <span class="iris-ui-spacer" />
                        <button type="button" class="iris-ui-btn" disabled={busy() === "add"} onClick={() => (setAdding(false), setChosen(new Set<number>()))}>
                          Cancel
                        </button>
                        <button type="button" class="iris-ui-btn" data-primary disabled={chosen().size === 0 || !!busy()} onClick={() => void addChosen()}>
                          <Show when={busy() === "add"}>
                            <Spinner class="iris-ui-spin" />
                          </Show>
                          {chosen().size ? `Add ${chosen().size} page${chosen().size === 1 ? "" : "s"}` : "Add pages"}
                        </button>
                      </div>
                    </Match>
                  </Switch>
                </div>
              </Show>

              {/* Taking a page out asks inline, with the one line of what changes: a scrim inside a
                detail this short would clip its own dialog. */}
              <Show when={removing()}>
                {(r) => (
                  <div class="iris-ui-callout iris-gs-confirm" data-tone="warn" role="alertdialog" aria-labelledby="iris-gs-remove-title" data-slot="site-remove-confirm">
                    <div class="iris-gs-grow">
                      <p class="iris-gs-optname" id="iris-gs-remove-title">Take “{r().title}” out of {d().name}?</p>
                      <p class="iris-gs-sub">{siteChangeLine({ kind: "remove", from: d().name })} The page itself is not changed.</p>
                    </div>
                    <button type="button" class="iris-ui-btn" disabled={!!busy()} onClick={() => setRemoving(undefined)}>
                      Cancel
                    </button>
                    <button type="button" class="iris-ui-btn" data-primary data-tone="warn" disabled={!!busy()} onClick={() => void remove()}>
                      <Show when={busy()}>
                        <Spinner class="iris-ui-spin" />
                      </Show>
                      Remove from site
                    </button>
                  </div>
                )}
              </Show>

              <Show when={d().pages.length > 0} fallback={<p class="iris-gs-sub iris-gs-pad">No pages in this site yet. Add some above.</p>}>
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
                          <span class="iris-ui-chip" title="The page /s/{slug} opens on">home</span>
                        </Show>
                        <span class="iris-ui-chip" data-tone={p.status === "published" ? "good" : "warn"}>{p.status === "published" ? "Published" : "Draft"}</span>
                        <button type="button" class="iris-ui-icon" title="Move up" aria-label={`Move ${p.title} up`} disabled={i() === 0 || !!busy()} onClick={() => void reorder(p.id, -1)}>
                          <Svg d={UP} />
                        </button>
                        <button type="button" class="iris-ui-icon" title="Move down" aria-label={`Move ${p.title} down`} disabled={i() === d().pages.length - 1 || !!busy()} onClick={() => void reorder(p.id, 1)}>
                          <Svg d={DOWN} />
                        </button>
                        <button type="button" class="iris-ui-icon" title="Remove from site" aria-label={`Remove ${p.title} from the site`} disabled={!!busy()} onClick={() => setRemoving({ id: p.id, title: p.title })}>
                          <Show when={busy() === `remove-${p.id}`} fallback={<Icon name="close-small" size="small" />}>
                            <Spinner class="iris-ui-spin" />
                          </Show>
                        </button>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>

              <Show when={(props.navItems?.length ?? 0) > 0}>
                <p class="iris-gs-sub iris-gs-pad">Navigation</p>
                <For each={props.navItems}>
                  {(n) => (
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

            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}
