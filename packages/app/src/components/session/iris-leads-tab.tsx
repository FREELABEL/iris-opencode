import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import "./iris-leads.css"
import "./iris-leads-tab.css"
import { LeadDetail, leadsCall, type Fetch } from "./iris-leads"
import { displayName, humanDate, initials, moneyLine, noteCount, readList, type LeadRow } from "./iris-leads-model"
import {
  activeFilterCount,
  bandOf,
  bandQuery,
  BANDS,
  healthScore,
  healthWord,
  listQuery,
  mergePages,
  NO_FILTERS,
  showingLine,
  sqlTime,
  stagesOf,
  toneOf,
  type Band,
  type LeadsFilters,
} from "./iris-leads-tab-model"
import { inReviewCount, type ReviewBatch } from "./iris-reachr-review-model"
import { setSurfaceCount, surfaceCount } from "./iris-surface-store"

/**
 * THE LEADS TAB (#192544, epic #192479): Elon's BloqLeadsTab, in the panel's own design language.
 *
 * The same layout people already work leads in — a header bar (search, filters, bulk actions,
 * refresh), a collapsible stats column (KPIs, urgency, stages), the leads table with Load more, and
 * the lead's panel sliding in from the right — against the routes the panel already has. Elon's
 * styling is not carried over: type, spacing and colour are the IRIS panel's, dark and light.
 *
 * Outreach lives here too (#192544): the Reachr approval queue is this tab's "Needs approval" view
 * (session-iris-tab SUBVIEWS), and this view says how many wait and takes you there.
 */
const STATUSES = ["Prospected", "New", "Contacted", "Qualified", "Proposal", "Negotiation", "Won", "Lost", "On Hold", "Inactive"]
const SORTS: { id: LeadsFilters["sort"]; label: string }[] = [
  { id: "updated_at", label: "Last updated" },
  { id: "created_at", label: "Added" },
  { id: "nickname", label: "Name" },
  { id: "price_bid", label: "Value" },
]
const STATS_KEY = "iris.leads.statsCollapsed"

const Icon = (p: { d: string; title?: string }) => (
  <svg class="iris-lt-ico" viewBox="0 0 24 24" aria-hidden={p.title ? undefined : "true"} role={p.title ? "img" : undefined}>
    <Show when={p.title}><title>{p.title}</title></Show>
    <path d={p.d} />
  </svg>
)
const MAIL = "M4 6h16v12H4zM4 7l8 6 8-6"
const PHONE = "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"
const AT = "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z"
const REFRESH = "M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"
const FILTER = "M3 5h18M6 12h12M10 19h4"
const COLUMNS = "M3 4h18v16H3zM9 4v16"
const CLOSE = "M18 6 6 18M6 6l12 12"

export function IrisLeadsTab(props: { doFetch: Fetch; bloqId?: number; onNeedsApproval: () => void }) {
  const call = leadsCall(props.doFetch)
  const [filters, setFilters] = createSignal<LeadsFilters>({ ...NO_FILTERS })
  const patch = (p: Partial<LeadsFilters>) => setFilters({ ...filters(), ...p })
  const [filtersOpen, setFiltersOpen] = createSignal(false)
  const [statsCollapsed, setStatsCollapsed] = createSignal((() => {
    try {
      return localStorage.getItem(STATS_KEY) === "1"
    } catch {
      return false
    }
  })())
  const toggleStats = () => {
    setStatsCollapsed(!statsCollapsed())
    try {
      localStorage.setItem(STATS_KEY, statsCollapsed() ? "1" : "0")
    } catch {}
  }

  // ── Search: typed vs asked for, so a keystroke is not a request ──
  const [input, setInput] = createSignal("")
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => timer && clearTimeout(timer))
  const onSearch = (v: string) => {
    setInput(v)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => patch({ search: v }), 300)
  }
  let searchEl: HTMLInputElement | undefined

  // ── Stats: what the column on the left shows, read together ──
  const review = () => surfaceCount("leads")
  const [total, setTotal] = createSignal<number>()
  const [newWeek, setNewWeek] = createSignal<number>()
  const [replied, setReplied] = createSignal<number>()
  const [bands, setBands] = createSignal<Partial<Record<Band, number>>>({})
  const [meta, setMeta] = createSignal<any>()
  const [statsLoading, setStatsLoading] = createSignal(false)
  let statsRead = 0
  async function readStats() {
    const mine = ++statsRead
    setStatsLoading(true)
    const now = Date.now()
    const bloqId = props.bloqId
    const count = (extra: Record<string, string>) =>
      call({ op: "list", query: { ...listQuery({ ...NO_FILTERS, bloqId, page: 1, perPage: 1, now }), ...extra } }).then((r) => (r.measured ? readList(r.data).total : undefined))
    const [batches, all, week, rep, m, ...band] = await Promise.all([
      props
        .doFetch("/iris/reachr/batches")
        .then((r) => r.json() as Promise<{ measured?: boolean; data?: ReviewBatch[] }>)
        .catch(() => null),
      count({}),
      count({ created_after: sqlTime(now - 7 * 86_400_000) }),
      count({ has_replied: "1" }),
      // fl-api's filter metadata answers per board; account-wide it fails, so it is asked only with one.
      bloqId !== undefined ? call({ op: "meta", query: { bloq_id: String(bloqId) } }) : Promise.resolve(null),
      ...BANDS.map((b) => count(bandQuery(b.id, now))),
    ])
    if (mine !== statsRead) return
    setStatsLoading(false)
    // The strip's badge reads the same number (#192483). A failed read leaves the last one alone.
    if (batches?.measured) setSurfaceCount("leads", inReviewCount(batches.data))
    setTotal(all)
    setNewWeek(week)
    setReplied(rep)
    setMeta(m?.measured ? m.data : undefined)
    setBands(Object.fromEntries(BANDS.map((b, i) => [b.id, band[i]])) as Partial<Record<Band, number>>)
  }
  createEffect(on(() => props.bloqId, () => void readStats()))
  const stages = () => stagesOf(meta())
  const health = () => healthScore(bands(), total())

  // ── The table ──
  const [rows, setRows] = createSignal<LeadRow[]>([])
  const [page, setPage] = createSignal(1)
  const [lastPage, setLastPage] = createSignal(1)
  const [listTotal, setListTotal] = createSignal<number>()
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()
  // A later answer always wins: a slow first search must not overwrite the newer one.
  let latest = 0
  async function load(p: number) {
    const mine = ++latest
    setLoading(true)
    setError(undefined)
    const f = filters()
    const now = Date.now()
    // A stage spelled more than one way is read once per spelling and merged (fl-api matches exactly).
    const spellings = f.stage ? f.stage.statuses : [undefined]
    const answers = await Promise.all(spellings.map((status) => call({ op: "list", query: listQuery({ ...f, bloqId: props.bloqId, page: p, status, now }) })))
    if (mine !== latest) return
    setLoading(false)
    const failed = answers.find((r) => !r.measured)
    if (failed) return setError(failed.reason ?? "Couldn't read leads")
    const found = mergePages(answers.map((r) => readList(r.data)), f.sort, f.order)
    setRows(p === 1 ? found.rows : [...rows(), ...found.rows])
    setListTotal(found.total)
    setLastPage(found.lastPage)
    setPage(p)
  }
  createEffect(on([filters, () => props.bloqId], () => {
    setChecked(new Set<number>())
    void load(1)
  }))
  const refresh = () => {
    void readStats()
    void load(1)
  }

  // ── Selection: one lead open in the side panel; any number checked for bulk actions ──
  const [open, setOpen] = createSignal<LeadRow>()
  const [checked, setChecked] = createSignal(new Set<number>())
  const toggleCheck = (id: number) => {
    const next = new Set(checked())
    next.has(id) ? next.delete(id) : next.add(id)
    setChecked(next)
  }
  const allChecked = () => rows().length > 0 && rows().every((r) => checked().has(r.id))
  const toggleAll = () => setChecked(allChecked() ? new Set<number>() : new Set(rows().map((r) => r.id)))
  const [bulkNote, setBulkNote] = createSignal<string>()
  async function bulkStatus(status: string) {
    const ids = [...checked()]
    if (!status || !ids.length) return
    if (!window.confirm(`Set ${ids.length} ${ids.length === 1 ? "lead" : "leads"} to ${status}?`)) return
    let ok = 0
    for (const id of ids) if ((await call({ op: "update", leadId: id, body: { status } })).measured) ok++
    setBulkNote(ok === ids.length ? `${ok} set to ${status}` : `${ok} of ${ids.length} set to ${status}; the rest were refused`)
    setChecked(new Set<number>())
    refresh()
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (!t || e.metaKey || e.ctrlKey || e.altKey) return
      const typing = !!t.closest("input,textarea,select,[contenteditable]")
      if (!t.closest(".iris-lt") && t !== document.body) return
      if (e.key === "Escape" && open() && !typing) {
        setOpen(undefined)
        e.preventDefault()
      } else if (e.key === "/" && !typing) {
        searchEl?.focus()
        e.preventDefault()
      }
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  const kpis = () => [
    { id: "total", label: "Total leads", value: total()?.toLocaleString() },
    { id: "new", label: "New (7d)", value: newWeek()?.toLocaleString() },
    { id: "review", label: "In review", value: review()?.toLocaleString(), hot: (review() ?? 0) > 0, onClick: props.onNeedsApproval },
    { id: "health", label: "Health", value: health() === undefined ? undefined : `${health()}%`, sub: health() === undefined ? undefined : healthWord(health()!) },
  ]

  return (
    <div class="iris-lt" data-slot="iris-leads-tab" data-stats={statsCollapsed() ? "closed" : "open"}>
      {/* ── The header bar, on one line ── */}
      <div class="iris-lt-bar">
        <div class="iris-lt-search">
          <input
            ref={searchEl}
            type="search"
            placeholder="Search leads…"
            aria-label="Search leads"
            value={input()}
            onInput={(e) => onSearch(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && input()) {
                e.stopPropagation()
                onSearch("")
              }
            }}
          />
          <kbd>/</kbd>
        </div>
        <Show when={checked().size > 0}>
          <select class="iris-lt-btn" aria-label="Bulk actions" value="" onChange={(e) => void bulkStatus(e.currentTarget.value)}>
            <option value="">{checked().size} selected · Set status…</option>
            <For each={STATUSES}>{(s) => <option value={s}>{s}</option>}</For>
          </select>
        </Show>
        <button type="button" class="iris-lt-btn" aria-pressed={filtersOpen()} onClick={() => setFiltersOpen(!filtersOpen())}>
          <Icon d={FILTER} />
          Filters
          <Show when={activeFilterCount(filters()) > 0}>
            <span class="iris-lt-n">{activeFilterCount(filters())}</span>
          </Show>
        </button>
        <button type="button" class="iris-lt-btn iris-lt-iconbtn" title="Refresh" aria-label="Refresh" data-busy={loading() || statsLoading() ? "" : undefined} onClick={refresh}>
          <Icon d={REFRESH} />
        </button>
        <button type="button" class="iris-lt-btn iris-lt-iconbtn" title={statsCollapsed() ? "Show stats" : "Hide stats"} aria-label={statsCollapsed() ? "Show stats" : "Hide stats"} aria-pressed={!statsCollapsed()} onClick={toggleStats}>
          <Icon d={COLUMNS} />
        </button>
      </div>

      <div class="iris-lt-body">
        {/* ── The stats column ── */}
        <Show when={!statsCollapsed()}>
          <aside class="iris-lt-stats" aria-label="Lead stats">
            <div class="iris-lt-kpis">
              <For each={kpis()}>
                {(k) => (
                  <button type="button" class="iris-lt-kpi" data-hot={k.hot ? "" : undefined} disabled={!k.onClick} onClick={() => k.onClick?.()}>
                    <span class="lbl">{k.label}</span>
                    <b>{k.value ?? "—"}</b>
                    <Show when={k.sub}><span class="sub">{k.sub}</span></Show>
                  </button>
                )}
              </For>
            </div>

            <Show when={(review() ?? 0) > 0}>
              <button type="button" class="iris-lt-approval" data-slot="iris-lt-needs-approval" onClick={props.onNeedsApproval}>
                <b>{review()} waiting for approval</b>
                <span>Reachr drafted them. Approving never sends.</span>
              </button>
            </Show>

            <div class="iris-lt-grp">Lead urgency</div>
            <For each={BANDS}>
              {(b) => (
                <button
                  type="button"
                  class="iris-lt-row"
                  data-band={b.id}
                  title={b.hint}
                  data-on={filters().band === b.id ? "" : undefined}
                  onClick={() => patch({ band: filters().band === b.id ? undefined : b.id })}
                >
                  <span class="dot" />
                  <span class="nm">{b.label}</span>
                  <span class="ct">{bands()[b.id]?.toLocaleString() ?? "—"}</span>
                </button>
              )}
            </For>

            <Show when={stages()?.length}>
              <div class="iris-lt-grp">Stages</div>
              <For each={stages()}>
                {(s) => (
                  <button
                    type="button"
                    class="iris-lt-row"
                    data-on={filters().stage?.status === s.status ? "" : undefined}
                    title={s.statuses.length > 1 ? `Spelled ${s.statuses.map((x) => `"${x}"`).join(", ")}` : undefined}
                    onClick={() => patch({ stage: filters().stage?.status === s.status ? undefined : { status: s.status, statuses: s.statuses } })}
                  >
                    <span class="dot" data-tone={toneOf(s.status)} />
                    <span class="nm">{s.status}</span>
                    <span class="ct">{s.count.toLocaleString()}</span>
                  </button>
                )}
              </For>
            </Show>
          </aside>
        </Show>

        {/* ── The table ── */}
        <div class="iris-lt-main">
          <Show when={filtersOpen()}>
            <div class="iris-lt-filters" role="group" aria-label="Filters">
              <label>
                <span>Stage</span>
                <select
                  value={filters().stage?.status ?? ""}
                  onChange={(e) => {
                    const v = e.currentTarget.value
                    const s = stages()?.find((x) => x.status === v)
                    patch({ stage: v ? (s ? { status: s.status, statuses: s.statuses } : { status: v, statuses: [v] }) : undefined })
                  }}
                >
                  <option value="">All stages</option>
                  <For each={stages() ?? STATUSES.map((s) => ({ status: s }))}>{(s) => <option value={s.status}>{s.status}</option>}</For>
                </select>
              </label>
              <label>
                <span>Sort by</span>
                <select value={filters().sort} onChange={(e) => patch({ sort: e.currentTarget.value as LeadsFilters["sort"] })}>
                  <For each={SORTS}>{(s) => <option value={s.id}>{s.label}</option>}</For>
                </select>
              </label>
              <label>
                <span>Direction</span>
                <select value={filters().order} onChange={(e) => patch({ order: e.currentTarget.value as LeadsFilters["order"] })}>
                  <option value="desc">{filters().sort === "nickname" ? "Z → A" : "Newest / highest first"}</option>
                  <option value="asc">{filters().sort === "nickname" ? "A → Z" : "Oldest / lowest first"}</option>
                </select>
              </label>
              <label class="iris-lt-check">
                <input type="checkbox" checked={filters().replied} onChange={(e) => patch({ replied: e.currentTarget.checked })} />
                <span>Replied only{replied() !== undefined ? ` (${replied()!.toLocaleString()})` : ""}</span>
              </label>
              <Show when={activeFilterCount(filters()) > 0}>
                <button type="button" class="iris-lt-link" onClick={() => setFilters({ ...NO_FILTERS, search: filters().search })}>Clear</button>
              </Show>
            </div>
          </Show>
          <Show when={bulkNote()}>
            <div class="iris-lt-note" role="status">{bulkNote()}</div>
          </Show>
          <Show when={error()}>
            <div class="iris-lt-err" role="alert">{error()}</div>
          </Show>

          <div class="iris-lt-scroll">
            <table class="iris-lt-table">
              <thead>
                <tr>
                  <th class="cb">
                    <input type="checkbox" aria-label="Select all shown" checked={allChecked()} ref={(el) => createEffect(() => (el.indeterminate = checked().size > 0 && !allChecked()))} onChange={toggleAll} />
                  </th>
                  <th>Name</th>
                  <th class="when">Last updated</th>
                  <th class="st">Status</th>
                  <th class="val">Value</th>
                </tr>
              </thead>
              <tbody>
                <For
                  each={rows()}
                  fallback={
                    <tr>
                      <td colSpan={5} class="iris-lt-empty">
                        {loading() ? "Loading…" : activeFilterCount(filters()) || filters().search ? "No leads match these filters" : "No leads on this board yet"}
                      </td>
                    </tr>
                  }
                >
                  {(l) => {
                    const band = bandOf(l.updated_at, Date.now())
                    const ig = (l as any).contact_info?.instagram as string | undefined
                    return (
                      <tr data-slot="iris-lead-row" aria-current={open()?.id === l.id || undefined} onClick={() => setOpen(l)}>
                        <td class="cb" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" aria-label={`Select ${displayName(l)}`} checked={checked().has(l.id)} onChange={() => toggleCheck(l.id)} />
                        </td>
                        <td class="name">
                          <div class="who">
                            <span class="iris-lt-av">{initials(l)}</span>
                            <span class="nm">{displayName(l)}</span>
                          </div>
                          <div class="meta">
                            <Show when={l.email}><Icon d={MAIL} title={l.email!} /></Show>
                            <Show when={l.phone}><Icon d={PHONE} title={l.phone!} /></Show>
                            <Show when={ig}><Icon d={AT} title={`@${ig}`} /></Show>
                            <Show when={l.has_replied}><span class="tag" data-tone="good">Replied</span></Show>
                            <Show when={l.has_user_account}><span class="tag">User</span></Show>
                            <For each={(l.tags ?? []).slice(0, 2)}>{(t) => <span class="tag">{t.name}</span>}</For>
                            <Show when={(l.tags ?? []).length > 2}><span class="more">+{(l.tags ?? []).length - 2}</span></Show>
                          </div>
                        </td>
                        <td class="when">
                          <div>{humanDate(l.updated_at)}</div>
                          <Show when={band}>{(b) => <span class="band" data-band={b()}>{BANDS.find((x) => x.id === b())!.label}</span>}</Show>
                        </td>
                        <td class="st">
                          <Show when={l.status} fallback={<span class="none">—</span>}>
                            <span class="pill" data-tone={toneOf(l.status)}>{l.status}</span>
                          </Show>
                          <div class="meta">
                            <Show when={(l.outreach_total_count ?? 0) > 0}>
                              <span title="Outreach steps done">{l.outreach_completed_count ?? 0}/{l.outreach_total_count}</span>
                            </Show>
                            <Show when={noteCount(l) > 0}><span title="Notes">{noteCount(l)} notes</span></Show>
                            <Show when={(l.tasks_count ?? 0) > 0}><span title="Tasks">{l.tasks_count} tasks</span></Show>
                          </div>
                        </td>
                        <td class="val">{moneyLine(l.price_bid) || <span class="none">—</span>}</td>
                      </tr>
                    )
                  }}
                </For>
              </tbody>
            </table>
            <div class="iris-lt-pager">
              <span>{showingLine(rows().length, listTotal())}</span>
              <Show when={page() < lastPage()}>
                <button type="button" class="iris-lt-btn" disabled={loading()} onClick={() => load(page() + 1)}>
                  {loading() ? "Loading…" : `Load more +${Math.min(50, (listTotal() ?? 0) - rows().length)}`}
                </button>
              </Show>
            </div>
          </div>

          {/* ── The lead's panel, sliding in over the table (LeadSidePanel) ── */}
          <Show when={open()} keyed>
            {(lead) => (
              <section class="iris-lt-side" aria-label={displayName(lead)}>
                <button type="button" class="iris-lt-close" title="Close (Esc)" aria-label="Close" onClick={() => setOpen(undefined)}>
                  <Icon d={CLOSE} />
                </button>
                <div class="iris-ld" data-slot="iris-leads">
                  <LeadDetail call={call} row={lead} onBack={() => setOpen(undefined)} onSaved={refresh} hideBack />
                </div>
              </section>
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}
