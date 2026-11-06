import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import "./iris-leads.css"
import { AiHistoryView, SequenceView, ThreadBody, useThread } from "./iris-inbox"
import { channelLabel, readableBody } from "./iris-inbox-model"
import {
  agoLine,
  displayName,
  humanDate,
  initials,
  isDone,
  peopleNotes,
  statusColor,
  systemNotes,
  type LeadNote,
  type LeadRow,
  type LeadTask,
} from "./iris-leads-model"

/**
 * Desktop Leads (#190553, epic #190552): one lead, the way ELON's LeadSidePanel shows it, against the
 * same fl-api endpoints. It slides in over the Leads tab's table (#192544, iris-leads-tab.tsx).
 */
export type Fetch = (path: string, init?: RequestInit) => Promise<Response>
export type Answer = { measured: boolean; reason?: string; data: any }
export type Op = { op: string; leadId?: number; taskId?: number; query?: Record<string, string>; body?: unknown }

const STATUSES = ["Prospected", "New", "Contacted", "Qualified", "Proposal", "Negotiation", "Won", "Lost", "On Hold", "Inactive"]
// Chat (#192688): the conversation with this lead and a reply box, as in the Inbox. Outreach: where the
// lead is in its sequence, the outreach log and the AI responses (Elon's LeadOutreachTab / LeadChatTab).
const TABS = ["Details", "Notes", "Tasks", "Outreach", "Chat", "Pulse"] as const
type Tab = (typeof TABS)[number]

/** Every leads read and write goes through the engine's one leads route, as ELON's do through fl-api. */
export function leadsCall(doFetch: Fetch) {
  return async (op: Op): Promise<Answer> => {
    try {
      const res = await doFetch("/iris/leads-api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op) })
      return (await res.json().catch(() => ({ measured: false, reason: `HTTP ${res.status}`, data: null }))) as Answer
    } catch (e: any) {
      return { measured: false, reason: String(e?.message ?? e), data: null }
    }
  }
}

function StatusPill(props: { status?: string | null }) {
  return (
    <Show when={props.status}>
      <span class="iris-ld-pill" style={{ "--pill": statusColor(props.status) }}>{props.status}</span>
    </Show>
  )
}

export function LeadDetail(props: {
  call: (o: Op) => Promise<Answer>
  row: LeadRow
  onBack: () => void
  onSaved?: () => void
  hideBack?: boolean
  /** The engine fetch, for the conversation routes (#192688). Without it, Outreach and Chat show the leads route only. */
  doFetch?: Fetch
  initialTab?: Tab
}) {
  const id = props.row.id
  const [tab, setTab] = createSignal<Tab>(props.initialTab ?? "Details")
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
    props.onSaved?.()
    return true
  }

  const statuses = () => {
    const s = current().status
    return s && !STATUSES.includes(s) ? [s, ...STATUSES] : STATUSES
  }

  return (
    <>
      <div class="iris-ld-head">
        <Show when={!props.hideBack}>
          <button type="button" class="iris-ld-back" onClick={props.onBack}>← Leads</button>
        </Show>
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
        <Show when={tab() === "Outreach"}>
          <OutreachTab call={props.call} lead={current()} doFetch={props.doFetch} onAddNote={(message) => save({ op: "addNote", leadId: id, body: { message, content: message } })} />
        </Show>
        <Show when={tab() === "Chat"}>
          <Show when={props.doFetch} fallback={<div class="iris-ld-empty">The conversation needs the IRIS engine.</div>}>
            {(f) => <ChatTab doFetch={f()} leadId={id} name={displayName(current())} />}
          </Show>
        </Show>
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
  const [addingDetails, setAddingDetails] = createSignal(false)
  const dirty = () => Object.keys(edits()).length > 0
  // What is known leads; empty fields wait behind one "Add" line instead of a stack of blank inputs.
  const filled = (f: (typeof EDITABLE)[number]) => f.key in edits() || String(props.lead[f.key] ?? "").trim() !== ""
  const shown = () => EDITABLE.filter((f) => addingDetails() || filled(f))
  const empty = () => EDITABLE.filter((f) => !filled(f))
  return (
    <>
      <dl class="iris-ld-fields">
        <For each={shown()}>
          {(f) => (
            <>
              <dt>{f.label}</dt>
              <dd>
                <input class="iris-ld-input" aria-label={f.label} value={edits()[f.key] ?? String(props.lead[f.key] ?? "")} onInput={(e) => setEdits({ ...edits(), [f.key]: e.currentTarget.value })} />
              </dd>
            </>
          )}
        </For>
        <Show when={!addingDetails() && empty().length > 0}>
          <dt>Missing</dt>
          <dd>
            <button type="button" class="iris-ld-addmore" onClick={() => setAddingDetails(true)}>
              + Add {empty().map((f) => f.label.toLowerCase()).join(", ")}
            </button>
          </dd>
        </Show>
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

function OutreachTab(props: { call: (o: Op) => Promise<Answer>; lead: LeadRow; doFetch?: Fetch; onAddNote: (text: string) => Promise<boolean> }) {
  const [thread] = useThread(props.doFetch ?? (() => Promise.reject(new Error("no engine"))), () => (props.doFetch ? props.lead.id : undefined))
  // The outreach log: what was sent and what came back on the lead's outreach channels (fl-api
  // `/outreach/messages`; the old `/messages` was a 404, so this said "No messages logged" for everyone).
  const [messages] = createResource(() =>
    props.call({ op: "messages", leadId: props.lead.id }).then((r) => (r.measured ? ((r.data?.messages ?? []) as any[]) : undefined)),
  )
  return (
    <div class="iris-ui iris-inb iris-ld-outreach">
      <Show when={thread()} fallback={<div class="iris-ld-when">{props.doFetch ? "Loading…" : ""}</div>}>
        {(t) => (
          <>
            <SequenceView thread={t()} />
            <AiHistoryView thread={t()} leadId={props.lead.id} onAddNote={props.onAddNote} />
          </>
        )}
      </Show>
      <div class="iris-inb-sechead">
        Outreach log <span class="weak">{messages()?.length ?? ""}</span>
      </div>
      <For each={messages() ?? []} fallback={<div class="iris-ld-when">{messages.loading ? "Loading…" : messages() ? "No outreach messages logged" : "Couldn't read the outreach log"}</div>}>
        {(m) => (
          <div class="iris-ld-message">
            <strong>{m.subject ?? String(m.type ?? "message").replace(/_/g, " ")}</strong>{" "}
            <span class="iris-ld-when">
              {m.direction === "inbound" ? "received" : "sent"} · {m.status} · {humanDate(m.sent_at ?? m.created_at)}
              {m.generated_by_ai ? " · AI" : ""}
            </span>
            <p>{readableBody(String(m.message ?? m.body ?? "").replace(/<[^>]+>/g, "")).slice(0, 600)}</p>
          </div>
        )}
      </For>
    </div>
  )
}

/** Chat: the conversation itself, every channel, with the Inbox's reply box (drafts approve, Send asks). */
function ChatTab(props: { doFetch: Fetch; leadId: number; name: string }) {
  const [thread, { refetch }] = useThread(props.doFetch, () => props.leadId)
  const lastChannel = () => thread.latest?.messages.at(-1)?.channel
  return (
    <div class="iris-ui iris-inb iris-ld-chat" data-slot="iris-lead-chat">
      <Show when={lastChannel()}>
        <div class="iris-ld-when iris-ld-chatline">Last message on {channelLabel(lastChannel()!)}</div>
      </Show>
      <ThreadBody doFetch={props.doFetch} leadId={props.leadId} name={props.name} thread={thread.latest} loading={thread.loading} refetch={refetch} preferChannel={lastChannel()} />
    </div>
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
