import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import "./iris-reachr-review.css"
import {
  bucketOf,
  canApprove,
  canEdit,
  canHold,
  canRelease,
  cleanForBulk,
  failureLine,
  FILTERS,
  matchesFilter,
  nextId,
  paceLine,
  stateWord,
  tally,
  toLocalInput,
  whenLine,
  type ReviewBatch,
  type ReviewFilter,
  type ReviewMessage,
} from "./iris-reachr-review-model"

/**
 * Reachr Review (#191990, epic #191985): the human gate between drafting and sending.
 *
 * APPROVING NEVER SENDS, and this panel has no send button. A message leaves only because a person
 * scheduled its batch, and fl-api re-checks it right before it goes. The server enforces all of that;
 * the buttons here only reflect it, so every refusal is shown in the server's own words.
 */
type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type Payload<T> = { measured: boolean; reason?: string; data: T }

const FILTER_WORD: Record<ReviewFilter, string> = { all: "All", review: "In review", approved: "Approved", held: "Held", sent: "Sent", problem: "Problems" }
// A batch that is going out is worth watching. One that isn't shouldn't poll.
const LIVE_POLL_MS = 15_000

export function IrisReachrReview(props: { doFetch: Fetch }) {
  const [batchId, setBatchId] = createSignal<number>()
  const [filter, setFilter] = createSignal<ReviewFilter>("all")
  const [selected, setSelected] = createSignal<number>()
  const [editing, setEditing] = createSignal<{ subject: string; body: string }>()
  const [scheduling, setScheduling] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [note, setNote] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const read = async <T,>(path: string): Promise<Payload<T>> => (await props.doFetch(path)).json()

  const [batches, { refetch: refetchBatches }] = createResource(() => read<ReviewBatch[]>("/iris/reachr/batches"))
  const [batch, { refetch: refetchBatch }] = createResource(batchId, (id) => read<ReviewBatch>(`/iris/reachr/batches/${id}`))

  createEffect(() => {
    const first = batches()?.data?.[0]
    if (first && batchId() === undefined) setBatchId(first.id)
  })

  const messages = createMemo<ReviewMessage[]>(() => batch()?.data?.messages ?? [])
  const counts = createMemo(() => tally(messages()))
  const clean = createMemo(() => cleanForBulk(messages()))
  const visible = createMemo(() => messages().filter((m) => matchesFilter(m, filter())))
  const current = createMemo(() => messages().find((m) => m.id === selected()) ?? visible()[0])

  // Keyboard moves and the stacked layout can leave the selected row out of view.
  let list: HTMLDivElement | undefined
  createEffect(() => {
    const id = current()?.id
    if (id !== undefined) list?.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" })
  })

  const live = () => batch()?.data?.status === "scheduled"
  const timer = setInterval(() => {
    if (live() && !busy() && !editing()) void refetchBatch()
  }, LIVE_POLL_MS)
  onCleanup(() => clearInterval(timer))

  /** Run one decision. The result is whatever the server says; nothing here assumes it worked. */
  async function act(action: string, ids: { batchId?: number; messageId?: number }, body?: unknown, done?: string): Promise<boolean> {
    setBusy(true)
    setError(undefined)
    setNote(undefined)
    try {
      const res = await props.doFetch("/iris/reachr/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...ids, body }),
      })
      const r = (await res.json().catch(() => null)) as Payload<unknown> | null
      if (!res.ok || !r?.measured) {
        setError(r?.reason ?? `HTTP ${res.status}`)
        return false
      }
      if (done) setNote(done)
      await Promise.all([refetchBatch(), refetchBatches()])
      return true
    } catch (e: any) {
      setError(e?.message ?? String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const advance = () => setSelected(nextId(visible(), current()?.id, 1))

  async function approve(m: ReviewMessage) {
    if (!canApprove(m)) return
    advance()
    await act("approve", { batchId: batchId() }, { ids: [m.id] }, "Approved. Nothing has been sent.")
  }
  async function hold(m: ReviewMessage) {
    if (!canHold(m)) return
    const reason = window.prompt("Why hold this one?", "") ?? undefined
    if (reason === undefined) return
    advance()
    await act("hold", { messageId: m.id }, { reason: reason || undefined })
  }
  async function saveEdit(m: ReviewMessage) {
    const draft = editing()
    if (!draft) return
    const wasDecided = ["approved", "scheduled"].includes(m.status)
    const ok = await act("edit", { messageId: m.id }, draft, wasDecided ? "Saved. It needs approving again, because the words changed." : "Saved.")
    if (ok) setEditing(undefined)
  }

  const [startAt, setStartAt] = createSignal("")
  const [paceMin, setPaceMin] = createSignal(3)
  const [paceMax, setPaceMax] = createSignal(5)
  function openSchedule() {
    const b = batch()?.data
    setStartAt(toLocalInput(b?.starts_at ? new Date(b.starts_at) : new Date(Date.now() + 3_600_000)))
    setPaceMin(Math.round((b?.pace_min_seconds ?? 180) / 60))
    setPaceMax(Math.round((b?.pace_max_seconds ?? 300) / 60))
    setScheduling(true)
  }
  async function confirmSchedule() {
    const at = new Date(startAt())
    if (Number.isNaN(at.getTime())) return setError("Pick a send time")
    if (paceMin() > paceMax()) return setError("The shortest gap can't be longer than the longest")
    const ok = await act(
      "schedule",
      { batchId: batchId() },
      { at: at.toISOString(), pace_min_seconds: paceMin() * 60, pace_max_seconds: paceMax() * 60 },
      "Scheduled. Each message is re-checked right before it goes.",
    )
    if (ok) setScheduling(false)
  }
  async function runAudit() {
    setBusy(true)
    try {
      const res = await props.doFetch("/iris/reachr/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "audit", batchId: batchId() }),
      })
      const r = (await res.json()) as Payload<{ ok: boolean; messages: { id: number; problems: string[] }[] }>
      if (!r.measured) return setError(r.reason)
      const bad = r.data.messages.filter((m) => m.problems.length)
      setNote(r.data.ok ? "Audit passed: every message has an approval, one send, a ledger entry and the approved text." : `Audit: ${bad.map((m) => `#${m.id} ${m.problems.join(", ")}`).join(" · ")}`)
    } finally {
      setBusy(false)
    }
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (!t || e.metaKey || e.ctrlKey || e.altKey || t.closest("input,textarea,select,[contenteditable]")) return
      if (!t.closest(".iris-rr") && t !== document.body) return
      const m = current()
      if (e.key === "j") setSelected(nextId(visible(), m?.id, 1))
      else if (e.key === "k") setSelected(nextId(visible(), m?.id, -1))
      else if (e.key === "a" && m) void approve(m)
      else if (e.key === "h" && m) void hold(m)
      else if (e.key === "e" && m && canEdit(m)) setEditing({ subject: m.subject ?? "", body: m.body ?? "" })
      else return
      e.preventDefault()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  return (
    <div class="iris-rr" data-slot="iris-reachr-review">
      <Show
        when={(batches()?.data ?? []).length > 0}
        fallback={
          <div class="iris-rr-empty">
            <Show when={batches() && !batches()!.measured} fallback={batches.loading ? "Loading…" : "No batches yet. Agents and the CLI add them: iris reachr drafts create"}>
              Couldn't read batches: {batches()!.reason}
            </Show>
          </div>
        }
      >
        <div class="iris-rr-head">
          <select
            aria-label="Batch"
            value={batchId()}
            onChange={(e) => {
              setSelected(undefined)
              setEditing(undefined)
              setScheduling(false)
              setBatchId(Number(e.currentTarget.value))
            }}
          >
            <For each={batches()!.data}>{(b) => <option value={b.id}>{b.name}</option>}</For>
          </select>
          <Show when={batch()?.data}>
            {(b) => (
              <span class="iris-rr-meta">
                <Show when={b().status === "scheduled"} fallback={b().status === "draft" ? "Not scheduled" : stateWord(b().status)}>
                  From {whenLine(b().starts_at)} · {paceLine(b().pace_min_seconds, b().pace_max_seconds)}
                </Show>
              </span>
            )}
          </Show>
          <span class="iris-rr-spacer" />
          <Show when={clean().length > 0}>
            <button
              class="iris-rr-btn"
              disabled={busy()}
              title="Flagged messages stay in review until you open them"
              onClick={() => act("approve", { batchId: batchId() }, { ids: clean().map((m) => m.id) }, "Approved. Nothing has been sent.")}
            >
              Approve {clean().length} unflagged
            </button>
          </Show>
          <Show when={batch()?.data?.status === "scheduled"}>
            <button class="iris-rr-btn" disabled={busy()} onClick={() => act("stop", { batchId: batchId() }, {}, "Stopped. Nothing else goes until you schedule it again.")}>
              Stop
            </button>
          </Show>
          <Show when={counts().sent > 0}>
            <button class="iris-rr-btn" disabled={busy()} onClick={runAudit}>Audit</button>
          </Show>
          <button class="iris-rr-btn" data-primary disabled={busy() || counts().approved === 0} onClick={openSchedule}>
            Schedule {counts().approved}
          </button>
        </div>

        <Show when={batch()?.data?.status === "stopped"}>
          <div class="iris-rr-banner" role="alert">Batch stopped: {batch()!.data.stopped_reason ?? "no reason recorded"}. Check it, then schedule it again.</div>
        </Show>
        <Show when={error()}>
          <div class="iris-rr-banner" role="alert">{error()}</div>
        </Show>
        <Show when={note()}>
          <div class="iris-rr-note" role="status">{note()}</div>
        </Show>

        <Show when={scheduling()}>
          <div class="iris-rr-schedule">
            <label>First send <input type="datetime-local" value={startAt()} onInput={(e) => setStartAt(e.currentTarget.value)} /></label>
            <label>Gap <input type="number" min="1" value={paceMin()} onInput={(e) => setPaceMin(Number(e.currentTarget.value))} /> to <input type="number" min="1" value={paceMax()} onInput={(e) => setPaceMax(Number(e.currentTarget.value))} /> min</label>
            <span class="iris-rr-spacer" />
            <button class="iris-rr-btn" onClick={() => setScheduling(false)}>Cancel</button>
            <button class="iris-rr-btn" data-primary disabled={busy()} onClick={confirmSchedule}>Schedule {counts().approved} messages</button>
          </div>
        </Show>

        <div class="iris-rr-filters" role="toolbar" aria-label="Filter messages">
          <For each={FILTERS}>
            {(f) => (
              <button class="iris-rr-filter" aria-pressed={filter() === f} onClick={() => { setFilter(f); setSelected(undefined) }}>
                {FILTER_WORD[f]}<span>{counts()[f]}</span>
              </button>
            )}
          </For>
        </div>

        <div class="iris-rr-body">
          <div class="iris-rr-list" ref={list} role="listbox" aria-label="Messages">
            <For each={visible()} fallback={<div class="iris-rr-empty">Nothing here</div>}>
              {(m) => (
                <button class="iris-rr-row" role="option" data-id={m.id} aria-selected={current()?.id === m.id} onClick={() => { setEditing(undefined); setSelected(m.id) }}>
                  <div class="iris-rr-row-top">
                    <span class="iris-rr-row-name">{m.lead_name ?? m.to_name ?? m.to_email}</span>
                    <Show when={m.warning}><span class="iris-rr-flag" title={m.warning!}>⚠</span></Show>
                    <span class="iris-rr-state" data-bucket={bucketOf(m.status)}>{stateWord(m.status)}</span>
                  </div>
                  <div class="iris-rr-row-sub">{m.scheduled_for && m.status === "scheduled" ? `${whenLine(m.scheduled_for)} · ` : ""}{m.subject}</div>
                </button>
              )}
            </For>
          </div>

          <div class="iris-rr-detail">
            <Show when={current()} fallback={<div class="iris-rr-empty">Pick a message</div>}>
              {(m) => (
                <>
                  <Show when={m().status === "failed" && m().send_error}><div class="iris-rr-callout" data-kind="bad">{failureLine(m())}</div></Show>
                  <Show when={m().status === "pre_check"}><div class="iris-rr-callout" data-kind="bad">This stopped mid-send and may have gone out. Check the mailbox before doing anything.</div></Show>
                  <Show when={m().warning}><div class="iris-rr-callout" data-kind="warn">{m().warning}</div></Show>
                  <Show when={m().hold_reason}><div class="iris-rr-callout" data-kind="warn">Held: {m().hold_reason}</div></Show>
                  <dl class="iris-rr-fields">
                    <dt>To</dt><dd>{m().to_name ? `${m().to_name} · ` : ""}{m().to_email}</dd>
                    <Show when={m().scheduled_for}><dt>Sends</dt><dd>{whenLine(m().scheduled_for)}</dd></Show>
                    <Show when={m().sent_at}><dt>Sent</dt><dd>{whenLine(m().sent_at)}</dd></Show>
                    <dt>Lead</dt><dd>#{m().lead_id}{m().group ? ` · ${m().group}` : ""}</dd>
                  </dl>
                  <Show
                    when={editing()}
                    fallback={
                      <>
                        <div class="iris-rr-subject">{m().subject}</div>
                        <div class="iris-rr-text">{m().body}</div>
                        <div class="iris-rr-actions">
                          <Show when={canApprove(m())}><button class="iris-rr-btn" data-primary disabled={busy()} onClick={() => approve(m())}>Approve<kbd>A</kbd></button></Show>
                          <Show when={canHold(m())}><button class="iris-rr-btn" disabled={busy()} onClick={() => hold(m())}>Hold<kbd>H</kbd></button></Show>
                          <Show when={canRelease(m())}><button class="iris-rr-btn" disabled={busy()} onClick={() => act("release", { messageId: m().id }, {}, "Back in review. It needs approving again.")}>Back to review</button></Show>
                          <Show when={canEdit(m())}><button class="iris-rr-btn" disabled={busy()} onClick={() => setEditing({ subject: m().subject ?? "", body: m().body ?? "" })}>Edit<kbd>E</kbd></button></Show>
                        </div>
                      </>
                    }
                  >
                    {(draft) => (
                      <>
                        <input class="iris-rr-edit" aria-label="Subject" value={draft().subject} onInput={(e) => setEditing({ ...draft(), subject: e.currentTarget.value })} />
                        <textarea class="iris-rr-edit iris-rr-edit-body" aria-label="Message" value={draft().body} onInput={(e) => setEditing({ ...draft(), body: e.currentTarget.value })} />
                        <Show when={["approved", "scheduled"].includes(m().status)}>
                          <div class="iris-rr-callout" data-kind="warn" style={{ "margin-top": "8px" }}>Changing the words removes its approval and its send time.</div>
                        </Show>
                        <div class="iris-rr-actions">
                          <button class="iris-rr-btn" data-primary disabled={busy()} onClick={() => saveEdit(m())}>Save</button>
                          <button class="iris-rr-btn" onClick={() => setEditing(undefined)}>Cancel</button>
                        </div>
                      </>
                    )}
                  </Show>
                </>
              )}
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}
