import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js"
import "./iris-leads.css"
import { IrisPager } from "./iris-pager"
import { envelopeOf, pageSummary } from "./use-paged-surface"
import {
  agoLine,
  displayName,
  humanDate,
  initials,
  isDone,
  listQuery,
  moneyLine,
  noteCount,
  peopleNotes,
  readList,
  statusColor,
  systemNotes,
  urgencyOf,
  type LeadNote,
  type LeadRow,
  type LeadTask,
} from "./iris-leads-model"

/**
 * Desktop Leads (#190553, epic #190552): the experience people already know from ELON's
 * BloqLeadsTab and LeadSidePanel, against the same fl-api endpoints. Search, status and sort happen
 * on the server, so a lead past the first page can be found and the total is real.
 */
type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type Answer = { measured: boolean; reason?: string; data: any }
type Op = { op: string; leadId?: number; taskId?: number; query?: Record<string, string>; body?: unknown }

const STATUSES = ["Prospected", "New", "Contacted", "Qualified", "Proposal", "Negotiation", "Won", "Lost", "On Hold", "Inactive"]
const SORTS = [
  { id: "updated_at", label: "Last updated" },
  { id: "created_at", label: "Newest" },
  { id: "nickname", label: "Name" },
]
const PER_PAGE = 50
const TABS = ["Details", "Notes", "Tasks", "Outreach", "Pulse"] as const
type Tab = (typeof TABS)[number]

export function IrisLeads(props: { doFetch: Fetch; bloqId?: number }) {
  const call = async (op: Op): Promise<Answer> => {
    const res = await props.doFetch("/iris/leads-api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op) })
    return (await res.json().catch(() => ({ measured: false, reason: `HTTP ${res.status}`, data: null }))) as Answer
  }
  const [open, setOpen] = createSignal<LeadRow>()
  return (
    <div class="iris-ld" data-slot="iris-leads">
      <Show when={open()} fallback={<LeadList call={call} bloqId={props.bloqId} onOpen={setOpen} />}>
        {(lead) => <LeadDetail call={call} row={lead()} onBack={() => setOpen(undefined)} />}
      </Show>
    </div>
  )
}

function StatusPill(props: { status?: string | null }) {
  return (
    <Show when={props.status}>
      <span class="iris-ld-pill" style={{ "--pill": statusColor(props.status) }}>{props.status}</span>
    </Show>
  )
}

function LeadList(props: { call: (o: Op) => Promise<Answer>; bloqId?: number; onOpen: (l: LeadRow) => void }) {
  const [input, setInput] = createSignal("")
  const [search, setSearch] = createSignal("")
  const [status, setStatus] = createSignal("")
  const [sort, setSort] = createSignal("updated_at")
  const [rows, setRows] = createSignal<LeadRow[]>([])
  const [page, setPage] = createSignal(1)
  const [total, setTotal] = createSignal(0)
  const [lastPage, setLastPage] = createSignal(1)
  let list: HTMLDivElement | undefined
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()

  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => timer && clearTimeout(timer))
  const onSearch = (v: string) => {
    setInput(v)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => setSearch(v), 300)
  }

  // A later answer always wins: a slow first search must not overwrite the newer one.
  let latest = 0
  async function load(p: number) {
    const mine = ++latest
    setLoading(true)
    setError(undefined)
    const r = await props.call({
      op: "list",
      query: listQuery({ bloqId: props.bloqId, search: search(), status: status(), sort: sort(), order: sort() === "nickname" ? "asc" : "desc", page: p }),
    }).catch((e) => ({ measured: false, reason: String(e?.message ?? e), data: null }) as Answer)
    if (mine !== latest) return
    setLoading(false)
    if (!r.measured) return setError(r.reason ?? "Couldn't read leads")
    const found = readList(r.data)
    setRows(found.rows)
    setTotal(found.total)
    setLastPage(found.lastPage)
    setPage(p)
    if (list) list.scrollTop = 0
  }
  createEffect(on([search, status, sort, () => props.bloqId], () => void load(1)))

  return (
    <>
      <div class="iris-ld-bar">
        <input type="search" placeholder="Search name, email, company…" aria-label="Search leads" value={input()} onInput={(e) => onSearch(e.currentTarget.value)} />
        <select aria-label="Status" value={status()} onChange={(e) => setStatus(e.currentTarget.value)}>
          <option value="">All statuses</option>
          <For each={STATUSES}>{(s) => <option value={s}>{s}</option>}</For>
        </select>
        <select aria-label="Sort" value={sort()} onChange={(e) => setSort(e.currentTarget.value)}>
          <For each={SORTS}>{(s) => <option value={s.id}>{s.label}</option>}</For>
        </select>
      </div>
      <Show when={error()}><div class="iris-ld-error" role="alert">{error()}</div></Show>
      <div class="iris-ld-list" ref={list}>
        <For each={rows()} fallback={<div class="iris-ld-empty">{loading() ? "Loading…" : "No leads match"}</div>}>
          {(l) => {
            const urgency = urgencyOf(l.updated_at)
            return (
              <button type="button" class="iris-ld-row" data-slot="iris-lead-row" onClick={() => props.onOpen(l)}>
                <span class="iris-ld-avatar">{initials(l)}</span>
                <span style={{ "min-width": 0 }}>
                  <div class="iris-ld-name">{displayName(l)}</div>
                  <div class="iris-ld-sub">{[l.email, l.phone].filter(Boolean).join(" · ") || l.company || "No contact details"}</div>
                  <div class="iris-ld-chips">
                    <Show when={l.has_replied}><span class="iris-ld-chip">Replied</span></Show>
                    <Show when={l.has_user_account}><span class="iris-ld-chip">User</span></Show>
                    <Show when={(l.outreach_total_count ?? 0) > 0}><span class="iris-ld-chip">Outreach {l.outreach_completed_count ?? 0}/{l.outreach_total_count}</span></Show>
                    <Show when={noteCount(l) > 0}><span class="iris-ld-chip">{noteCount(l)} notes</span></Show>
                    <Show when={(l.tasks_count ?? 0) > 0}><span class="iris-ld-chip">{l.tasks_count} tasks</span></Show>
                    <For each={(l.tags ?? []).slice(0, 3)}>{(t) => <span class="iris-ld-chip">{t.name}</span>}</For>
                  </div>
                </span>
                <span class="iris-ld-right">
                  <StatusPill status={l.status} />
                  <Show when={urgency}>{(u) => <span class="iris-ld-pill" style={{ "--pill": u().color }}>{u().label}</span>}</Show>
                  <span class="iris-ld-when">{agoLine(l.updated_at)}</span>
                  <Show when={moneyLine(l.price_bid)}><span class="iris-ld-when">{moneyLine(l.price_bid)}</span></Show>
                </span>
              </button>
            )
          }}
        </For>
      </div>
      <IrisPager
        class="px-3 py-2"
        summary={error() ? null : pageSummary({ shown: (page() - 1) * PER_PAGE + rows().length, env: envelopeOf({ page: page(), perPage: PER_PAGE, total: total(), lastPage: lastPage() }), noun: "leads" })}
        loading={loading()}
        hasMore={page() < lastPage()}
        hasPrevious={page() > 1}
        onPrevious={() => load(page() - 1)}
        onNext={() => load(page() + 1)}
      />
    </>
  )
}

function LeadDetail(props: { call: (o: Op) => Promise<Answer>; row: LeadRow; onBack: () => void }) {
  const id = props.row.id
  const [tab, setTab] = createSignal<Tab>("Details")
  const [error, setError] = createSignal<string>()
  const [lead, { refetch }] = createResource(async () => {
    const r = await props.call({ op: "get", leadId: id })
    if (!r.measured) setError(r.reason)
    return (r.data?.data ?? r.data ?? props.row) as LeadRow
  })
  const current = () => lead() ?? props.row
  const notes = createMemo<LeadNote[]>(() => current().notes ?? [])

  /** Save, then read back: what's on screen is what the server kept. */
  async function save(op: Op): Promise<boolean> {
    setError(undefined)
    const r = await props.call(op)
    if (!r.measured) {
      setError(r.reason ?? "Not saved")
      return false
    }
    await refetch()
    return true
  }

  const statuses = () => {
    const s = current().status
    return s && !STATUSES.includes(s) ? [s, ...STATUSES] : STATUSES
  }

  return (
    <>
      <div class="iris-ld-head">
        <button type="button" class="iris-ld-back" onClick={props.onBack}>← Leads</button>
        <div class="iris-ld-title">
          <span class="iris-ld-avatar">{initials(current())}</span>
          <h3>{displayName(current())}</h3>
          <StatusPill status={current().status} />
          <select aria-label="Change status" value={current().status ?? ""} onChange={(e) => save({ op: "update", leadId: id, body: { status: e.currentTarget.value } })}>
            <For each={statuses()}>{(s) => <option value={s}>{s}</option>}</For>
          </select>
        </div>
      </div>
      <div class="iris-ld-tabs" role="tablist">
        <For each={TABS}>
          {(t) => (
            <button type="button" role="tab" class="iris-ld-tab" aria-selected={tab() === t} onClick={() => setTab(t)}>
              {t}
              <Show when={t === "Notes" && peopleNotes(notes()).length > 0}><span>{peopleNotes(notes()).length}</span></Show>
            </button>
          )}
        </For>
      </div>
      <Show when={error()}><div class="iris-ld-error" role="alert">{error()}</div></Show>
      <div class="iris-ld-body">
        <Show when={tab() === "Details"}><DetailsTab lead={current()} onSave={(body) => save({ op: "update", leadId: id, body })} /></Show>
        <Show when={tab() === "Notes"}><NotesTab notes={notes()} onAdd={(message) => save({ op: "addNote", leadId: id, body: { message, content: message } })} /></Show>
        <Show when={tab() === "Tasks"}><TasksTab call={props.call} leadId={id} setError={setError} /></Show>
        <Show when={tab() === "Outreach"}><OutreachTab call={props.call} lead={current()} /></Show>
        <Show when={tab() === "Pulse"}><PulseTab call={props.call} leadId={id} /></Show>
      </div>
    </>
  )
}

const EDITABLE: { key: keyof LeadRow; label: string }[] = [
  { key: "nickname", label: "Name" },
  { key: "company", label: "Company" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "website", label: "Website" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "price_bid", label: "Value" },
]

function DetailsTab(props: { lead: LeadRow; onSave: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [edits, setEdits] = createSignal<Record<string, string>>({})
  const [busy, setBusy] = createSignal(false)
  const dirty = () => Object.keys(edits()).length > 0
  return (
    <>
      <dl class="iris-ld-fields">
        <For each={EDITABLE}>
          {(f) => (
            <>
              <dt>{f.label}</dt>
              <dd>
                <input class="iris-ld-input" aria-label={f.label} value={edits()[f.key] ?? String(props.lead[f.key] ?? "")} onInput={(e) => setEdits({ ...edits(), [f.key]: e.currentTarget.value })} />
              </dd>
            </>
          )}
        </For>
        <Show when={props.lead.source}><dt>Source</dt><dd>{props.lead.source}</dd></Show>
        <Show when={(props.lead.tags ?? []).length > 0}>
          <dt>Tags</dt>
          <dd class="iris-ld-chips" style={{ "margin-top": 0 }}><For each={props.lead.tags}>{(t) => <span class="iris-ld-chip">{t.name}</span>}</For></dd>
        </Show>
        <dt>Added</dt><dd>{humanDate(props.lead.created_at)}</dd>
        <dt>Updated</dt><dd>{humanDate(props.lead.updated_at)}</dd>
      </dl>
      <Show when={dirty()}>
        <div style={{ display: "flex", gap: "6px", "margin-top": "12px" }}>
          <button type="button" class="iris-ld-btn" data-primary disabled={busy()} onClick={async () => { setBusy(true); if (await props.onSave(edits())) setEdits({}); setBusy(false) }}>Save</button>
          <button type="button" class="iris-ld-btn" onClick={() => setEdits({})}>Cancel</button>
        </div>
      </Show>
    </>
  )
}

function NotesTab(props: { notes: LeadNote[]; onAdd: (text: string) => Promise<boolean> }) {
  const [text, setText] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const newest = (a: LeadNote, b: LeadNote) => b.created_at.localeCompare(a.created_at)
  return (
    <>
      <div class="iris-ld-compose">
        <textarea aria-label="Add a follow-up note" placeholder="Add a follow-up note…" value={text()} onInput={(e) => setText(e.currentTarget.value)} />
        <button type="button" class="iris-ld-btn" data-primary disabled={busy() || !text().trim()} onClick={async () => { setBusy(true); if (await props.onAdd(text().trim())) setText(""); setBusy(false) }}>Add</button>
      </div>
      <For each={[...peopleNotes(props.notes)].sort(newest)} fallback={<div class="iris-ld-empty">No notes yet</div>}>
        {(n) => <div class="iris-ld-note"><time>{humanDate(n.created_at)} · {agoLine(n.created_at)}</time>{n.content}</div>}
      </For>
      <Show when={systemNotes(props.notes).length > 0}>
        <span class="iris-ld-sectionhead">Activity</span>
        <For each={[...systemNotes(props.notes)].sort(newest)}>
          {(n) => <div class="iris-ld-note" style={{ color: "var(--text-weak)", "font-size": "12px" }}><time>{humanDate(n.created_at)}</time>{n.content}</div>}
        </For>
      </Show>
    </>
  )
}

function TasksTab(props: { call: (o: Op) => Promise<Answer>; leadId: number; setError: (e?: string) => void }) {
  const [tasks, { refetch }] = createResource(async () => {
    const r = await props.call({ op: "tasks", leadId: props.leadId })
    if (!r.measured) props.setError(r.reason)
    const d = r.data?.data ?? r.data
    return (Array.isArray(d) ? d : (d?.data ?? [])) as LeadTask[]
  })
  const [title, setTitle] = createSignal("")
  async function run(op: Op) {
    const r = await props.call(op)
    if (!r.measured) return props.setError(r.reason ?? "Not saved")
    await refetch()
  }
  return (
    <>
      <div class="iris-ld-compose">
        <input class="iris-ld-input" aria-label="New task" placeholder="Add a task…" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
        <button type="button" class="iris-ld-btn" data-primary disabled={!title().trim()} onClick={async () => { await run({ op: "addTask", leadId: props.leadId, body: { title: title().trim() } }); setTitle("") }}>Add</button>
      </div>
      <For each={tasks() ?? []} fallback={<div class="iris-ld-empty">{tasks.loading ? "Loading…" : "No tasks"}</div>}>
        {(t) => (
          <label class="iris-ld-task" data-done={isDone(t)}>
            <input type="checkbox" checked={isDone(t)} onChange={(e) => run({ op: "saveTask", leadId: props.leadId, taskId: t.id, body: { status: e.currentTarget.checked ? "completed" : "pending" } })} />
            <span>{t.title ?? t.description}</span>
            <Show when={t.due_date}><time class="iris-ld-when">{humanDate(t.due_date)}</time></Show>
          </label>
        )}
      </For>
    </>
  )
}

function OutreachTab(props: { call: (o: Op) => Promise<Answer>; lead: LeadRow }) {
  const listOf = (r: Answer) => {
    const d = r.data?.data ?? r.data
    return (Array.isArray(d) ? d : (d?.messages ?? d?.steps ?? d?.data ?? [])) as any[]
  }
  const [steps] = createResource(() => props.call({ op: "steps", leadId: props.lead.id }).then(listOf))
  const [messages] = createResource(() => props.call({ op: "messages", leadId: props.lead.id }).then(listOf))
  return (
    <>
      <span class="iris-ld-sectionhead" style={{ "margin-top": 0 }}>Steps</span>
      <For each={steps() ?? []} fallback={<div class="iris-ld-when">{steps.loading ? "Loading…" : "No outreach steps"}</div>}>
        {(s) => (
          <label class="iris-ld-task" data-done={!!s.completed_at || !!s.is_completed}>
            <input type="checkbox" disabled checked={!!s.completed_at || !!s.is_completed} />
            <span>{s.title ?? s.type ?? `Step ${s.step_number ?? ""}`}</span>
            <Show when={s.due_date}><time class="iris-ld-when">{humanDate(s.due_date)}</time></Show>
          </label>
        )}
      </For>
      <span class="iris-ld-sectionhead">Messages</span>
      <For each={messages() ?? []} fallback={<div class="iris-ld-when">{messages.loading ? "Loading…" : "No messages logged"}</div>}>
        {(m) => (
          <div class="iris-ld-message">
            <strong>{m.subject ?? m.type ?? "Message"}</strong> <span class="iris-ld-when">{m.status} · {humanDate(m.sent_at ?? m.created_at)}</span>
            <p>{String(m.message ?? m.body ?? "").replace(/<[^>]+>/g, "").slice(0, 600)}</p>
          </div>
        )}
      </For>
    </>
  )
}

function PulseTab(props: { call: (o: Op) => Promise<Answer>; leadId: number }) {
  const [pulse] = createResource(() => props.call({ op: "readiness", leadId: props.leadId }))
  const data = () => pulse()?.data?.data ?? pulse()?.data
  const score = () => data()?.score ?? data()?.readiness_score ?? data()?.overall_score
  return (
    <Show when={!pulse.loading} fallback={<div class="iris-ld-empty">Loading…</div>}>
      <Show when={pulse()?.measured && score() != null} fallback={<div class="iris-ld-empty">{pulse()?.reason ?? "No readiness score yet"}</div>}>
        <div class="iris-ld-score">{score()}</div>
        <div class="iris-ld-when">Readiness</div>
      </Show>
    </Show>
  )
}
