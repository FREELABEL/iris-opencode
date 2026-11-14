import { createEffect, createMemo, createResource, For, on, onCleanup, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Spinner } from "@opencode-ai/ui/spinner"
import type { Fetch } from "./iris-leads"
import type { CampaignRow, Payload } from "./iris-outreach-model"
import {
  countText,
  countViews,
  draftUnsaved,
  FILTER_DEFS,
  filterToRow,
  memberCells,
  nextKey,
  rowsToFilters,
  type Draft,
  type FilterKey,
  type FilterRow,
  type MemberPage,
  type Preview,
  type Segment,
} from "./iris-audiences-model"

/**
 * OUTREACH › AUDIENCES (#193533 U2a, live per #193535 U2c).
 *
 * Left: the board's saved segments and New. Middle: the draft's filters as editable rows, each
 * with what is left after it (cumulative, in order), re-counted on every edit. Right: the members.
 *
 * THE DRAFT IS THE ENGINE'S, not this component's (packages/opencode/src/iris/segments.ts). The
 * agent's segment_* tools edit the same draft; this view adopts any draft with a higher `rev`, from
 * the `iris.outreach.segment.updated` event or the 5 s poll while the window is visible — the same
 * visibility rule as iris-outreach-badge.ts. A CLI edit of a saved segment reaches it through that
 * poll (the engine re-reads a clean draft's segment). Edits typed here are never overwritten while
 * they are still being sent.
 *
 * Nothing here sends a message. Find adds leads to the board; Target points a campaign's next run
 * at the segment, after a second click that says so.
 */
export const SEGMENT_EVENT = "iris.outreach.segment.updated"
const POLL_MS = 5000
const EDIT_DEBOUNCE_MS = 400

export type AudienceIntent = { mode: "find" | "post" | "site"; post?: string }

type State = {
  bloq: number | undefined
  draft: Draft | null
  rows: FilterRow[]
  /** Local edits not yet acknowledged by the engine: a poll must not replace them. */
  pending: number
  preview: Preview | null
  previewReason: string | undefined
  counting: boolean
  page: number
  members: MemberPage | null
  name: string
  note: { tone?: "warn" | "good"; text: string } | undefined
  busy: "" | "save" | "find" | "target"
  find: { open: boolean; mode: "post" | "site"; text: string }
  target: { open: boolean; campaign: number | undefined; confirm: boolean }
}

const json = <T,>(doFetch: Fetch, path: string, init?: { method: string; body: unknown }): Promise<Payload<T>> =>
  doFetch(path, init ? { method: init.method, headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) } : undefined)
    .then((r) => r.json())
    .catch((e: unknown) => ({ measured: false, reason: e instanceof Error ? e.message : String(e), data: undefined as T }))

export function IrisAudiences(props: {
  doFetch: Fetch
  /** The panel's board: where a new draft starts when the engine has none in focus. */
  bloqId?: number
  boards?: () => { id: number; name: string }[]
  listen?: (fn: (e: { details?: { type?: string; properties?: any } }) => void) => () => void
  intent?: AudienceIntent
  onIntentUsed?: () => void
}) {
  const [s, set] = createStore<State>({
    bloq: undefined,
    draft: null,
    rows: [],
    pending: 0,
    preview: null,
    previewReason: undefined,
    counting: false,
    page: 1,
    members: null,
    name: "",
    note: undefined,
    busy: "",
    find: { open: false, mode: "post", text: "" },
    target: { open: false, campaign: undefined, confirm: false },
  })
  let alive = true
  onCleanup(() => (alive = false))

  /** Take the engine's draft. `keepRows`: it answers our own edit, so the rows on screen (with any half-typed one) stay. */
  const adopt = (d: Draft, keepRows = false) => {
    set(
      produce((x) => {
        const rowsChanged = !keepRows && (!x.draft || x.draft.bloq !== d.bloq || JSON.stringify(x.draft.filters) !== JSON.stringify(d.filters))
        x.bloq = d.bloq
        x.draft = d
        if (rowsChanged) x.rows = d.filters.map(filterToRow)
        if (!keepRows) x.name = d.name
      }),
    )
  }

  /** Read the engine's draft; adopt it when it is newer than ours and we are not mid-edit. */
  const pull = async (bloq?: number) => {
    const r = await json<Draft | null>(props.doFetch, `/iris/outreach/segments/draft${bloq ? `?bloq=${bloq}` : ""}`)
    if (!alive || !r.measured || !r.data || s.pending) return r.data ?? null
    if (!s.draft || r.data.rev > s.draft.rev || r.data.bloq !== s.draft.bloq) adopt(r.data)
    return r.data
  }

  const change = async (body: Record<string, unknown>, keepRows = false) => {
    const r = await json<Draft>(props.doFetch, "/iris/outreach/segments/draft", { method: "PUT", body: { bloq: s.bloq, ...body } })
    if (!alive) return
    if (r.measured && r.data) adopt(r.data, keepRows)
    if (!r.measured) set("note", { tone: "warn", text: r.reason ?? "The change did not reach the engine." })
  }

  // Start: the draft in focus (the agent may already be building one), else this panel's board.
  void (async () => {
    const focused = await pull()
    if (focused || !alive) return
    const b = props.bloqId ?? props.boards?.()[0]?.id
    if (b) await pull(b)
    if (!s.draft && b) set("bloq", b)
  })()

  // The Today buttons hand over what the person asked for.
  createEffect(
    on(
      () => props.intent,
      (i) => {
        if (!i) return
        if (i.mode === "post" || i.mode === "site") set("find", { open: true, mode: i.mode, text: i.post ?? "" })
        props.onIntentUsed?.()
      },
    ),
  )

  // Live (#193535): the engine's event for changes made in this engine, the poll for the rest.
  const stop = props.listen?.((e) => {
    if (e.details?.type === SEGMENT_EVENT) void pull()
  })
  const timer = setInterval(() => {
    if (document.visibilityState !== "hidden") void pull()
  }, POLL_MS)
  const onVisible = () => document.visibilityState === "visible" && void pull()
  document.addEventListener("visibilitychange", onVisible)
  onCleanup(() => {
    stop?.()
    clearInterval(timer)
    document.removeEventListener("visibilitychange", onVisible)
  })

  // Edits: rows change at once on screen, reach the engine after a pause in typing.
  let editTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(editTimer))
  const edited = () => {
    set("pending", (n) => n + 1)
    clearTimeout(editTimer)
    editTimer = setTimeout(async () => {
      await change({ filters: rowsToFilters(s.rows) }, true)
      set("pending", 0)
    }, EDIT_DEBOUNCE_MS)
  }

  // Count: on every new draft revision (ours, the agent's, or the CLI's).
  const filtersKey = createMemo(() => (s.draft ? `${s.draft.bloq}|${JSON.stringify(s.draft.filters)}` : ""))
  let asked = 0
  createEffect(
    on(filtersKey, async (k) => {
      if (!k || !s.draft) return
      const ticket = ++asked
      set({ counting: true, page: 1 })
      const r = await json<Preview | null>(props.doFetch, "/iris/outreach/segments/preview", { method: "POST", body: { bloq: s.draft.bloq, filters: s.draft.filters } })
      if (!alive || ticket !== asked) return
      set({ counting: false, preview: r.measured ? r.data : null, previewReason: r.measured ? undefined : r.reason, members: r.data?.members ?? null })
    }),
  )

  // fl-api pages a SAVED segment's members; a preview returns the first 25 only.
  const pageable = () => !!s.draft?.segment_id && !draftUnsaved(s.draft)
  const turnPage = async (page: number) => {
    const id = s.draft?.segment_id
    if (!id || !pageable()) return
    set("page", page)
    const r = await json<MemberPage>(props.doFetch, `/iris/outreach/segments/${id}/members?page=${page}`)
    if (alive && r.measured && r.data) set("members", r.data)
  }

  const [segments, { refetch: refetchSegments }] = createResource(
    () => s.bloq,
    (b) => json<Segment[]>(props.doFetch, `/iris/outreach/segments?bloq=${b}`),
  )
  const [campaigns] = createResource(
    () => (s.target.open ? true : undefined),
    () => json<{ campaigns: CampaignRow[] }>(props.doFetch, "/iris/outreach/campaigns"),
  )
  const boardCampaigns = () => (campaigns.latest?.measured ? campaigns.latest.data.campaigns.filter((c) => c.bloq_id === s.bloq) : [])

  const counts = createMemo(() => countViews(s.draft?.filters ?? [], s.preview?.breakdown))
  const countOf = (key: FilterKey) => counts().find((c) => c.key === key)
  const unsaved = () => (s.draft ? draftUnsaved({ ...s.draft, name: s.name }) : false)

  const save = async () => {
    set({ busy: "save", note: undefined })
    const r = await json<Draft>(props.doFetch, "/iris/outreach/segments/draft/save", { method: "POST", body: { bloq: s.bloq, name: s.name } })
    if (!alive) return
    set("busy", "")
    if (!r.measured) return set("note", { tone: "warn", text: `Not saved: ${r.reason}` })
    adopt(r.data)
    set("note", { tone: "good", text: `Saved as segment #${r.data.segment_id}.` })
    void refetchSegments()
  }

  const find = async () => {
    const text = s.find.text.trim()
    if (!text || !s.bloq) return
    set({ busy: "find", note: undefined })
    const body = s.find.mode === "post" ? { bloq: s.bloq, post_url: text } : { bloq: s.bloq, urls: text.split(/[\s,]+/).filter(Boolean) }
    const r = await json<{ added: number | null; already: number | null; source: string }>(props.doFetch, "/iris/outreach/segments/find", { method: "POST", body })
    if (!alive) return
    set("busy", "")
    if (!r.measured) return set("note", { tone: "warn", text: `Nothing added: ${r.reason}` })
    set("note", { tone: "good", text: `Added ${r.data.added ?? "?"} lead(s) from ${r.data.source}${r.data.already ? ` · ${r.data.already} already on the board` : ""}. Nothing was sent.` })
    set("find", "open", false)
    if (s.find.mode === "post" && !s.rows.some((x) => x.key === "source_post")) {
      set("rows", (rows) => [{ key: "source_post", text }, ...rows])
      edited()
    }
  }

  const target = async () => {
    const id = s.target.campaign
    const seg = s.draft?.segment_id
    if (!id || !seg) return
    set({ busy: "target", note: undefined })
    const r = await json<{ campaign: number; segment_id: number | null }>(props.doFetch, `/iris/outreach/campaigns/${id}/segment`, { method: "POST", body: { segment_id: seg } })
    if (!alive) return
    set({ busy: "", target: { open: false, campaign: undefined, confirm: false } })
    set("note", r.measured ? { tone: "good", text: `Campaign #${id} now draws from segment #${seg} on its next run. Nothing was sent.` } : { tone: "warn", text: `Not changed: ${r.reason}` })
  }

  const setRow = (i: number, patch: Partial<FilterRow>) => {
    set("rows", i, (r) => ({ ...r, ...patch }))
    edited()
  }

  return (
    <div class="iris-or-aud" data-slot="or-audiences" data-bloq={s.bloq} data-rev={s.draft?.rev ?? 0}>
      {/* Left: saved segments */}
      <section class="iris-or-col" aria-label="Segments">
        <div class="iris-or-head">
          <span>Segments</span>
          <Show when={(props.boards?.() ?? []).length > 1} fallback={<span class="m">{s.bloq ? `board #${s.bloq}` : ""}</span>}>
            <select
              class="iris-or-select"
              aria-label="Board"
              value={s.bloq ?? ""}
              onChange={(e) => {
                const b = Number(e.currentTarget.value)
                set({ bloq: b, draft: null, rows: [], preview: null })
                void pull(b).then((d) => !d && set("bloq", b))
              }}
            >
              <Show when={s.bloq && !(props.boards?.() ?? []).some((b) => b.id === s.bloq)}>
                <option value={s.bloq}>#{s.bloq}</option>
              </Show>
              <For each={props.boards?.() ?? []}>{(b) => <option value={b.id}>{`${b.name} #${b.id}`}</option>}</For>
            </select>
          </Show>
        </div>
        <button type="button" class="iris-or-seg" data-slot="or-seg-new" aria-pressed={!!s.draft && !s.draft.segment_id} onClick={() => void change({ reset: true })}>
          <span class="t">New segment</span>
        </button>
        <Show when={segments.latest} fallback={<div class="iris-or-none">{s.bloq ? "Reading…" : "Pick a board."}</div>}>
          <Show when={segments.latest?.measured} fallback={<p class="iris-or-note" data-tone="warn">{segments.latest?.reason}</p>}>
            <Show when={segments.latest!.data.length} fallback={<div class="iris-or-none">No saved segments on this board yet.</div>}>
              <For each={segments.latest!.data}>
                {(seg) => (
                  <button type="button" class="iris-or-seg" data-segment-id={seg.id} aria-pressed={s.draft?.segment_id === seg.id} onClick={() => void change({ load: seg.id })}>
                    <span class="t">{seg.name || `Segment #${seg.id}`}</span>
                    <span class="num">{seg.member_count === null ? "—" : seg.member_count.toLocaleString("en-US")}</span>
                    <span class="s">{seg.filters.map((f) => filterToRow(f).text).join(" · ") || "no filters"}</span>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </Show>
      </section>

      {/* Middle: the filters */}
      <section class="iris-or-col" aria-label="Filters" data-slot="or-filters">
        <div class="iris-or-head">
          <span>
            {s.draft?.segment_id ? s.name || `Segment #${s.draft.segment_id}` : "New segment"}
            <Show when={unsaved()}>
              <span class="n">unsaved</span>
            </Show>
          </span>
          <Show when={s.counting}>
            <Spinner class="iris-ui-spin" />
          </Show>
          <Show when={s.draft?.by === "agent"}>
            <span class="m" data-slot="or-by-agent">edited by the agent</span>
          </Show>
        </div>
        <div class="iris-or-board" data-slot="or-board-row">
          <span class="m">Board {s.bloq ? `#${s.bloq}` : "—"}</span>
          <span class="num">{s.preview?.of === null || s.preview?.of === undefined ? "—" : `${s.preview.of.toLocaleString("en-US")} leads`}</span>
        </div>
        <For each={s.rows}>
          {(row, i) => {
            const c = () => countOf(row.key)
            return (
              <div class="iris-or-frow" data-slot="or-filter" data-key={row.key} data-pending={c()?.pending ? "" : undefined}>
                <select class="iris-or-select" aria-label="Filter" value={row.key} onChange={(e) => setRow(i(), { key: e.currentTarget.value as FilterKey })}>
                  <For each={FILTER_DEFS}>
                    {(d) => (
                      <option value={d.key} disabled={d.key !== row.key && s.rows.some((r) => r.key === d.key)}>
                        {d.label}
                      </option>
                    )}
                  </For>
                </select>
                <input
                  class="iris-or-input"
                  aria-label="Value"
                  value={row.text}
                  placeholder={FILTER_DEFS.find((d) => d.key === row.key)?.hint}
                  onInput={(e) => setRow(i(), { text: e.currentTarget.value })}
                />
                <span class="num iris-or-count" data-slot="or-count" data-unjudged={c()?.unjudged ? "" : undefined} title={c() ? countText(c()!) : "Not counted yet"}>
                  <Show when={c()} fallback={<span class="m">—</span>}>
                    {(cv) => (
                      <>
                        <span>{cv().count}</span>
                        <Show when={cv().detail}>
                          <span class="m"> {cv().detail.endsWith("unknown") ? `· ${cv().detail}` : cv().detail}</span>
                        </Show>
                      </>
                    )}
                  </Show>
                </span>
                <button
                  type="button"
                  class="iris-or-link iris-or-x"
                  aria-label={`Remove ${row.key}`}
                  onClick={() => {
                    set("rows", (rows) => rows.filter((_, j) => j !== i()))
                    edited()
                  }}
                >
                  ×
                </button>
              </div>
            )
          }}
        </For>
        <div class="iris-or-factions">
          <button
            type="button"
            class="iris-or-link"
            data-slot="or-add-filter"
            disabled={!s.bloq || !nextKey(s.rows)}
            onClick={() => set("rows", (rows) => [...rows, { key: nextKey(rows)!, text: "" }])}
          >
            + Add filter
          </button>
          <button type="button" class="iris-or-link" disabled={!s.bloq} onClick={() => set("find", "open", !s.find.open)}>
            Find more people…
          </button>
        </div>
        <Show when={s.find.open}>
          <div class="iris-or-find" data-slot="or-find">
            <span class="iris-or-filter" role="group" aria-label="Find from">
              <button type="button" class="iris-or-link" aria-pressed={s.find.mode === "post"} onClick={() => set("find", "mode", "post")}>
                A post's commenters
              </button>
              <button type="button" class="iris-or-link" aria-pressed={s.find.mode === "site"} onClick={() => set("find", "mode", "site")}>
                A list or site
              </button>
            </span>
            <input
              class="iris-or-input"
              aria-label={s.find.mode === "post" ? "Post URL" : "Page URLs"}
              placeholder={s.find.mode === "post" ? "https://www.instagram.com/p/…" : "https://example.com/team (several: separate with spaces)"}
              value={s.find.text}
              onInput={(e) => set("find", "text", e.currentTarget.value)}
            />
            <p class="m">Adds the people it finds to board #{s.bloq} as leads, on this computer. Sends nothing.</p>
            <button type="button" class="iris-ui-btn" disabled={!s.find.text.trim() || s.busy === "find"} onClick={() => void find()}>
              {s.busy === "find" ? "Finding…" : "Add as leads"}
            </button>
          </div>
        </Show>
        <Show when={s.previewReason}>
          <p class="iris-or-note" data-tone="warn" data-slot="or-preview-reason">
            Counts unavailable: {s.previewReason}
          </p>
        </Show>
        <div class="iris-or-save">
          <input class="iris-or-input" aria-label="Segment name" placeholder="Name this segment" value={s.name} onInput={(e) => set("name", e.currentTarget.value)} />
          <button type="button" class="iris-ui-btn" data-slot="or-save" disabled={!s.name.trim() || !s.draft?.filters.length || s.busy === "save" || !unsaved()} onClick={() => void save()}>
            {s.busy === "save" ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            class="iris-ui-btn"
            data-slot="or-target"
            disabled={!s.draft?.segment_id || unsaved()}
            title={!s.draft?.segment_id || unsaved() ? "Save the segment first" : "Point a campaign at this segment"}
            onClick={() => set("target", { open: !s.target.open, campaign: undefined, confirm: false })}
          >
            Target a campaign
          </button>
        </div>
        <Show when={s.target.open}>
          <div class="iris-or-find" data-slot="or-target-pick">
            <Show when={!campaigns.loading} fallback={<Spinner class="iris-ui-spin" />}>
              <Show when={boardCampaigns().length} fallback={<span class="m">{campaigns.latest?.measured ? `No campaign runs on board #${s.bloq}.` : campaigns.latest?.reason}</span>}>
                <select class="iris-or-select" aria-label="Campaign" value={s.target.campaign ?? ""} onChange={(e) => set("target", { campaign: Number(e.currentTarget.value), confirm: false })}>
                  <option value="">Pick a campaign</option>
                  <For each={boardCampaigns()}>{(c) => <option value={c.id}>{`${c.label}${c.active ? " (on)" : ""}`}</option>}</For>
                </select>
                <Show when={s.target.campaign}>
                  <Show
                    when={s.target.confirm}
                    fallback={
                      <button type="button" class="iris-ui-btn" onClick={() => set("target", "confirm", true)}>
                        Use this segment
                      </button>
                    }
                  >
                    <p class="m">Its next run draws its leads from this segment. Nothing is sent now.</p>
                    <button type="button" class="iris-ui-btn" disabled={s.busy === "target"} onClick={() => void target()}>
                      {s.busy === "target" ? "Changing…" : "Confirm"}
                    </button>
                  </Show>
                </Show>
              </Show>
            </Show>
          </div>
        </Show>
        <Show when={s.note}>{(n) => <p class="iris-or-note" data-tone={n().tone} data-slot="or-note">{n().text}</p>}</Show>
      </section>

      {/* Right: members */}
      <section class="iris-or-col" aria-label="Members" data-slot="or-members">
        <div class="iris-or-head">
          <span>
            Members <span class="n" data-slot="or-total">{s.preview?.total === null || s.preview?.total === undefined ? "" : s.preview.total.toLocaleString("en-US")}</span>
          </span>
        </div>
        <Show when={s.members?.data.length} fallback={<div class="iris-or-none">{s.counting ? "Counting…" : s.draft ? "No one matches yet." : "Add a filter to start."}</div>}>
          <div class="iris-or-table iris-or-members" role="table" aria-label="Members">
            <div class="iris-or-tr iris-or-th" role="row">
              <span>Handle</span>
              <span>Name</span>
              <span>Status</span>
              <span>Comment</span>
              <span>Niche</span>
              <span>Role</span>
              <span>City</span>
              <span class="r">Followers</span>
            </div>
            <For each={s.members!.data}>
              {(m) => {
                const c = memberCells(m)
                return (
                  <div class="iris-or-tr" role="row" data-lead-id={m.id}>
                    <span class="t ell">{c.handle}</span>
                    <span class="ell">{c.name}</span>
                    <span class="m ell">{c.status}</span>
                    <span class="m ell" title={c.comment}>{c.comment}</span>
                    <span class="m ell">{c.niche}</span>
                    <span class="m ell">{c.role}</span>
                    <span class="m ell">{c.city}</span>
                    <span class="r num">{c.followers}</span>
                  </div>
                )
              }}
            </For>
          </div>
          <div class="iris-or-pager">
            <Show
              when={pageable()}
              fallback={<span class="m">{`First ${s.members!.data.length} of ${s.members!.total.toLocaleString("en-US")}. Save the segment to page through all of them.`}</span>}
            >
              <button type="button" class="iris-or-link" disabled={s.page <= 1} onClick={() => void turnPage(s.page - 1)}>
                Previous
              </button>
              <span class="m">
                {s.page} / {s.members!.last_page}
              </span>
              <button type="button" class="iris-or-link" disabled={s.page >= s.members!.last_page} onClick={() => void turnPage(s.page + 1)}>
                Next
              </button>
            </Show>
          </div>
        </Show>
      </section>
    </div>
  )
}
