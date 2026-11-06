import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import "./iris-panel-ui.css"
import "./iris-inbox.css"
import type { Fetch } from "./iris-leads"
import {
  applyQuery,
  approveDraft,
  CHANNEL_GROUPS,
  channelGroup,
  channelLabel,
  DRAFTS_KEY,
  FILTERS,
  groupByDay,
  initialOf,
  isUnread,
  markDraft,
  markSeen,
  markUnread,
  newComposer,
  NO_QUERY,
  parseDrafts,
  parseSeen,
  pruneSeen,
  queryCounts,
  readableBody,
  rememberDrafts,
  REPLY_LABEL,
  replyChannelFor,
  SEEN_KEY,
  sendBlock,
  sendConfirm,
  sendPayload,
  switchChannel,
  timeLabel,
  typeText,
  unreadCount,
  type ChannelGroup,
  type Composer,
  type Conversation,
  type ConversationsAnswer,
  type Draft,
  type InboxQuery,
  type LocalDraft,
  type ReplyChannel,
  type Seen,
  type ThreadAnswer,
} from "./iris-inbox-model"
import { setSurfaceCount } from "./iris-surface-store"

/**
 * INBOX (#192688): Elon's unified inbox and lead outreach, in the panel's own design (iris-panel-ui.css).
 *
 * Conversations with leads across every channel the platform logs (Instagram DMs, Gmail, contact
 * forms, SMS…), newest first in day groups; filters with counts (Unread on this computer, Needs reply,
 * Assigned to me) and channel chips; a conversation opens beside the list with the lead's card next to
 * it; reply or compose by email, SMS or Instagram DM; an AI draft is approved into the reply box and
 * the person still presses Send, which asks. Nothing is ever sent by the machine.
 */

const ROUTE = "/iris/comms"
const json = (doFetch: Fetch, path: string, body?: unknown) =>
  doFetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json())
    .catch((e: unknown) => ({ measured: false, reason: e instanceof Error ? e.message : String(e) }))

const store = {
  read: (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  write: (k: string, v: unknown) => {
    try {
      localStorage.setItem(k, JSON.stringify(v))
    } catch {}
  },
}

const Svg = (p: { d: string }) => (
  <svg class="iris-ui-svg" viewBox="0 0 24 24" aria-hidden="true">
    <path d={p.d} />
  </svg>
)
const ARROW_IN = "M7 7l10 10M17 9v8H9"
const ARROW_OUT = "M17 17 7 7M7 15V7h8"
const MAIL = "M4 6h16v12H4zM4 7l8 6 8-6"
const PHONE = "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"
const IG = "M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4zM16 11.4A4 4 0 1 1 12.6 8 4 4 0 0 1 16 11.4zM17.5 6.5h.01"
const FORM = "M9 3h6l1 2h3v16H5V5h3zM9 12h6M9 16h4"
const CHAT = "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"
const channelPath = (g: ChannelGroup) => (g === "email" ? MAIL : g === "instagram" ? IG : g === "form" ? FORM : g === "sms" || g === "whatsapp" ? PHONE : CHAT)

/** Elon's channel colours, as a wash and a text colour — never a stripe. */
const CHANNEL_TONE: Record<ChannelGroup, string> = { email: "info", instagram: "pink", sms: "good", imessage: "info", whatsapp: "good", form: "warn", other: "idle" }

export function ChannelChip(props: { channel: string }) {
  const g = () => channelGroup(props.channel)
  return (
    <span class="iris-ui-chip iris-inb-ch" data-tone={CHANNEL_TONE[g()]} title={props.channel}>
      <Svg d={channelPath(g())} />
      {channelLabel(props.channel)}
    </span>
  )
}

// ─── The tab ───────────────────────────────────────────────────────────────────

export function IrisInbox(props: { doFetch: Fetch; onOpenLead: (leadId: number) => void }) {
  const [st, setSt] = createStore({
    days: 14,
    query: { ...NO_QUERY } as InboxQuery,
    open: undefined as undefined | { key: string; leadId?: number; name: string },
    composing: false,
    refresh: 0,
  })
  const [seen, setSeenSig] = createSignal<Seen>(parseSeen(store.read(SEEN_KEY)))
  const setSeen = (s: Seen) => {
    setSeenSig(s)
    store.write(SEEN_KEY, s)
  }
  const [data, { refetch }] = createResource(
    () => ({ days: st.days, n: st.refresh }),
    async (k): Promise<ConversationsAnswer> => json(props.doFetch, `${ROUTE}?days=${k.days}${k.n ? "&refresh=1" : ""}`),
  )
  const list = createMemo(() => (data.latest?.measured ? data.latest.conversations : []))
  const shown = createMemo(() => applyQuery(list(), st.query, seen()))
  const counts = createMemo(() => queryCounts(list(), st.query, seen()))
  const now = () => Date.now()

  // The tab's badge: unread here. Unknown (not loaded, failed) leaves the badge as it was.
  createEffect(() => {
    const d = data.latest
    if (!d?.measured) return
    setSurfaceCount("inbox", unreadCount(d.conversations, seen()))
  })
  // Seen markers for conversations that left the window are dropped.
  createEffect(on(() => data.latest, (d) => d?.measured && setSeen(pruneSeen(seen(), d.conversations)), { defer: true }))

  const openConv = (c: Conversation) => {
    setSt("open", { key: c.key, leadId: c.leadId, name: c.name })
    setSt("composing", false)
    setSeen(markSeen(seen(), c))
  }
  const current = createMemo(() => list().find((c) => c.key === st.open?.key))
  const setQuery = (p: Partial<InboxQuery>) => setSt("query", { ...st.query, ...p })
  const refresh = () => setSt("refresh", st.refresh + 1)

  let searchEl: HTMLInputElement | undefined
  let root: HTMLDivElement | undefined
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (!t || e.metaKey || e.ctrlKey || e.altKey || !root) return
      if (!root.contains(t) && t !== document.body) return
      const typing = !!t.closest("input,textarea,select,[contenteditable]")
      if (typing) return
      if (e.key === "/") {
        searchEl?.focus()
        e.preventDefault()
      } else if (e.key === "Escape" && st.open) {
        setSt("open", undefined)
        e.preventDefault()
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const rows = shown()
        if (!rows.length) return
        const i = rows.findIndex((c) => c.key === st.open?.key)
        const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]
        openConv(next)
        root.querySelector<HTMLElement>(`[data-key="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: "nearest" })
        e.preventDefault()
      }
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  return (
    <div ref={root} class="iris-ui iris-inb" data-slot="iris-inbox" data-open={st.open ? "" : undefined}>
      <div class="iris-ui-bar">
        <label class="iris-ui-search">
          <Icon name="magnifying-glass" size="small" />
          <input
            ref={searchEl}
            type="search"
            placeholder="Search conversations"
            aria-label="Search conversations"
            value={st.query.search}
            onInput={(e) => setQuery({ search: e.currentTarget.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape" && st.query.search) {
                e.stopPropagation()
                setQuery({ search: "" })
              }
            }}
          />
          <kbd>/</kbd>
        </label>
        <div class="iris-ui-seg" role="group" aria-label="How far back">
          <For each={[7, 14, 30]}>
            {(d) => (
              <button type="button" aria-pressed={st.days === d} onClick={() => setSt("days", d)}>
                {d}d
              </button>
            )}
          </For>
        </div>
        <span class="iris-ui-spacer" />
        <button type="button" class="iris-ui-btn" data-slot="ib-compose" onClick={() => (setSt("open", undefined), setSt("composing", true))}>
          <Icon name="pencil-line" size="small" />
          New message
        </button>
        <button type="button" class="iris-ui-icon" title="Refresh" aria-label="Refresh" disabled={data.loading} onClick={refresh}>
          <Show when={data.loading} fallback={<Icon name="reset" size="small" />}>
            <Spinner class="iris-ui-spin" />
          </Show>
        </button>
      </div>

      <div class="iris-ui-tabs" role="tablist" aria-label="Show">
        <For each={FILTERS}>
          {(f) => (
            <button type="button" class="iris-ui-tab" role="tab" title={f.hint} aria-selected={st.query.filter === f.id} data-filter={f.id} onClick={() => setQuery({ filter: f.id })}>
              {f.label}
              <Show when={data.latest?.measured}>
                <span class="n">{counts().filters[f.id]}</span>
              </Show>
            </button>
          )}
        </For>
      </div>
      <div class="iris-inb-chips" role="group" aria-label="Channel">
        <button type="button" class="iris-inb-chipbtn" aria-pressed={!st.query.channel} onClick={() => setQuery({ channel: undefined })}>
          All channels
        </button>
        <For each={CHANNEL_GROUPS.filter((g) => (counts().channels[g.id] ?? 0) > 0 || st.query.channel === g.id)}>
          {(g) => (
            <button type="button" class="iris-inb-chipbtn" aria-pressed={st.query.channel === g.id} data-channel={g.id} onClick={() => setQuery({ channel: st.query.channel === g.id ? undefined : g.id })}>
              <Svg d={channelPath(g.id)} />
              {g.label}
              <span class="n">{counts().channels[g.id]}</span>
            </button>
          )}
        </For>
      </div>

      <div class="iris-inb-body">
        <div class="iris-inb-list" role="listbox" aria-label="Conversations">
          <Show
            when={data.latest?.measured}
            fallback={
              <Show
                when={!data.loading || data.latest}
                fallback={
                  <div class="iris-ui-empty">
                    <Spinner class="iris-ui-spin" />
                    Reading conversations…
                  </div>
                }
              >
                <div class="iris-ui-empty" role="alert">
                  <span>Couldn't read your conversations: {data.latest?.reason ?? "no answer"}</span>
                  <button type="button" class="iris-ui-btn" onClick={() => refetch()}>
                    Try again
                  </button>
                </div>
              </Show>
            }
          >
            <For
              each={groupByDay(shown(), (c) => c.lastAt, now())}
              fallback={
                <div class="iris-ui-empty" data-slot="ib-empty">
                  <Show when={list().length} fallback={<span>No messages from leads in the last {st.days} days.</span>}>
                    <span>
                      {st.query.filter === "unread"
                        ? "Nothing unread. You've opened every conversation they wrote in."
                        : st.query.filter === "needsReply"
                          ? "Nobody is waiting on a reply."
                          : st.query.filter === "assigned"
                            ? "No conversations with leads assigned to you."
                            : "No conversations match."}
                    </span>
                    <button type="button" class="iris-ui-btn" onClick={() => setSt("query", { ...NO_QUERY })}>
                      Show all
                    </button>
                  </Show>
                </div>
              }
            >
              {(g) => (
                <>
                  <div class="iris-inb-day">{g.label}</div>
                  <For each={g.items}>
                    {(c) => (
                      <button
                        type="button"
                        role="option"
                        class="iris-inb-row"
                        data-slot="ib-row"
                        data-key={c.key}
                        aria-selected={st.open?.key === c.key}
                        data-unread={isUnread(c, seen()) ? "" : undefined}
                        onClick={() => openConv(c)}
                      >
                        <span class="iris-inb-av" data-tone={CHANNEL_TONE[channelGroup(c.channel)]}>{initialOf(c.name)}</span>
                        <span class="iris-inb-main">
                          <span class="iris-inb-top">
                            <span class="iris-inb-name">{c.name}</span>
                            <Show when={isUnread(c, seen())}>
                              <span class="iris-inb-dot" title="Unread on this computer" />
                            </Show>
                            <span class="iris-inb-time" title={new Date(c.lastAt).toLocaleString()}>{timeLabel(c.lastAt, now())}</span>
                          </span>
                          <Show when={c.subject}>
                            <span class="iris-inb-subj">{c.subject}</span>
                          </Show>
                          <span class="iris-inb-prev">
                            <span class="iris-inb-dir" data-dir={c.lastDirection} title={c.lastDirection === "outbound" ? "You sent the last message" : "They sent the last message"}>
                              <Svg d={c.lastDirection === "outbound" ? ARROW_OUT : ARROW_IN} />
                            </span>
                            {c.lastDirection === "outbound" ? "You: " : ""}
                            {readableBody(c.preview)}
                          </span>
                          <span class="iris-inb-meta">
                            <ChannelChip channel={c.channel} />
                            <Show when={c.needsReply}>
                              <span class="iris-ui-chip" data-tone="warn">Needs reply</span>
                            </Show>
                            <Show when={c.assigned}>
                              <span class="iris-ui-chip" data-tone="info">Assigned to you</span>
                            </Show>
                            <Show when={c.status}>
                              <span class="iris-ui-chip">{c.status}</span>
                            </Show>
                          </span>
                        </span>
                      </button>
                    )}
                  </For>
                </>
              )}
            </For>
            <div class="iris-inb-foot">
              <span>
                {shown().length.toLocaleString()} of {list().length.toLocaleString()} conversations · last {st.days} days
                {(data.latest?.total ?? 0) > list().length ? ` · the ${list().length} newest of ${data.latest!.total}` : ""}
                {data.latest?.truncated ? " · older messages not read" : ""}
              </span>
              <span title="The platform keeps no read state; unread is what you have not opened here.">Unread is on this computer</span>
            </div>
          </Show>
        </div>

        <Show when={st.open || st.composing}>
          <div class="iris-inb-detail">
            <Show
              when={st.open?.leadId}
              keyed
              fallback={
                <Show when={st.composing} fallback={<NotALead conv={current()} onBack={() => setSt("open", undefined)} />}>
                  <NewMessage doFetch={props.doFetch} onCancel={() => setSt("composing", false)} onPick={(id, name) => (setSt("composing", false), setSt("open", { key: `lead:${id}`, leadId: id, name }))} />
                </Show>
              }
            >
              {(leadId) => (
                <ConversationDetail
                  doFetch={props.doFetch}
                  leadId={leadId}
                  name={st.open?.name ?? ""}
                  conv={current()}
                  onBack={() => setSt("open", undefined)}
                  onOpenLead={props.onOpenLead}
                  onSent={refresh}
                  onMarkUnread={() => current() && (setSeen(markUnread(seen(), current()!)), setSt("open", undefined))}
                />
              )}
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

function NotALead(props: { conv?: Conversation; onBack: () => void }) {
  return (
    <div class="iris-inb-thread">
      <div class="iris-inb-dhead">
        <button type="button" class="iris-ui-icon iris-inb-back" aria-label="Back to conversations" onClick={props.onBack}>
          <Icon name="chevron-left" size="small" />
        </button>
        <b>{props.conv?.name ?? "Conversation"}</b>
        <Show when={props.conv}>{(c) => <ChannelChip channel={c().channel} />}</Show>
      </div>
      <div class="iris-inb-msgs">
        <Show when={props.conv}>
          {(c) => (
            <div class="iris-inb-msg" data-dir="inbound">
              <Show when={c().subject}>
                <b class="iris-inb-msubj">{c().subject}</b>
              </Show>
              <p>{c().preview}</p>
            </div>
          )}
        </Show>
      </div>
      <div class="iris-ui-callout" data-tone="info">
        <span>Not a lead yet, so there is nowhere to send a reply from here. A contact form that creates a lead shows up as a conversation you can answer.</span>
      </div>
    </div>
  )
}

/** Compose: pick the lead, then write. Search is fl-api's own (the Leads tab's). */
function NewMessage(props: { doFetch: Fetch; onCancel: () => void; onPick: (leadId: number, name: string) => void }) {
  const [q, setQ] = createSignal("")
  const [applied, setApplied] = createSignal("")
  let t: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => t && clearTimeout(t))
  const [found] = createResource(applied, async (s) => {
    if (s.trim().length < 2) return [] as { id: number; name: string; email?: string; phone?: string; ig?: string }[]
    const r: any = await json(props.doFetch, "/iris/leads-api", { op: "list", query: { search: s, per_page: "12", page: "1" } })
    const rows = (r?.data?.data ?? []) as any[]
    return rows.map((l) => ({ id: Number(l.id), name: String(l.nickname || l.name || l.email || `Lead #${l.id}`), email: l.email ?? undefined, phone: l.phone ?? undefined, ig: l.contact_info?.instagram ?? undefined }))
  })
  return (
    <div class="iris-inb-thread" data-slot="ib-new">
      <div class="iris-inb-dhead">
        <button type="button" class="iris-ui-icon iris-inb-back" aria-label="Cancel" onClick={props.onCancel}>
          <Icon name="chevron-left" size="small" />
        </button>
        <b>New message</b>
      </div>
      <div class="iris-inb-pick">
        <label class="iris-ui-search iris-inb-pickq">
          <Icon name="magnifying-glass" size="small" />
          <input
            autofocus
            type="search"
            placeholder="Who to? Search leads by name, email or handle"
            aria-label="Search leads"
            value={q()}
            onInput={(e) => {
              setQ(e.currentTarget.value)
              if (t) clearTimeout(t)
              const v = e.currentTarget.value
              t = setTimeout(() => setApplied(v), 300)
            }}
          />
        </label>
        <Show when={found.loading}>
          <div class="iris-ui-empty">
            <Spinner class="iris-ui-spin" />
          </div>
        </Show>
        <For each={found() ?? []} fallback={<Show when={!found.loading && applied().trim().length >= 2}><div class="iris-ui-empty">No leads match "{applied()}".</div></Show>}>
          {(l) => (
            <button type="button" class="iris-inb-row" data-slot="ib-pick-row" onClick={() => props.onPick(l.id, l.name)}>
              <span class="iris-inb-av">{initialOf(l.name)}</span>
              <span class="iris-inb-main">
                <span class="iris-inb-name">{l.name}</span>
                <span class="iris-inb-meta">
                  <Show when={l.email}><span class="iris-ui-chip"><Svg d={MAIL} />{l.email}</span></Show>
                  <Show when={l.phone}><span class="iris-ui-chip"><Svg d={PHONE} />{l.phone}</span></Show>
                  <Show when={l.ig}><span class="iris-ui-chip"><Svg d={IG} />@{l.ig}</span></Show>
                </span>
              </span>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

// ─── One conversation ─────────────────────────────────────────────────────────

export function useThread(doFetch: Fetch, leadId: Accessor<number | undefined>) {
  return createResource(leadId, (id): Promise<ThreadAnswer> => json(doFetch, `${ROUTE}/thread/${id}`))
}

function ConversationDetail(props: {
  doFetch: Fetch
  leadId: number
  name: string
  conv?: Conversation
  onBack: () => void
  onOpenLead: (id: number) => void
  onSent: () => void
  onMarkUnread: () => void
}) {
  const [thread, { refetch }] = useThread(props.doFetch, () => props.leadId)
  const [cardOpen, setCardOpen] = createSignal(true)
  return (
    <div class="iris-inb-conv" data-card={cardOpen() ? "open" : "closed"}>
      <div class="iris-inb-thread">
        <div class="iris-inb-dhead">
          <button type="button" class="iris-ui-icon iris-inb-back" aria-label="Back to conversations" title="Back (Esc)" onClick={props.onBack}>
            <Icon name="chevron-left" size="small" />
          </button>
          <span class="iris-inb-av">{initialOf(thread.latest?.lead?.name ?? props.name)}</span>
          <b class="iris-inb-dname">{thread.latest?.lead?.name ?? props.name}</b>
          <For each={props.conv?.channels ?? []}>{(ch) => <ChannelChip channel={ch} />}</For>
          <span class="iris-ui-spacer" />
          <Show when={props.conv?.lastInboundAt}>
            <button type="button" class="iris-ui-btn" title="Show it as unread on this computer" onClick={props.onMarkUnread}>
              Mark unread
            </button>
          </Show>
          <button type="button" class="iris-ui-btn" data-slot="ib-open-lead" onClick={() => props.onOpenLead(props.leadId)}>
            Open in Leads
          </button>
          <button type="button" class="iris-ui-icon" aria-pressed={cardOpen()} title={cardOpen() ? "Hide the lead's card" : "Show the lead's card"} aria-label="Lead card" onClick={() => setCardOpen(!cardOpen())}>
            <Icon name="layout-right" size="small" />
          </button>
        </div>
        <ThreadBody doFetch={props.doFetch} leadId={props.leadId} name={thread.latest?.lead?.name ?? props.name} thread={thread.latest} loading={thread.loading} refetch={refetch} preferChannel={props.conv?.channel} bloqId={props.conv?.bloqId} onSent={props.onSent} />
      </div>
      <Show when={cardOpen()}>
        <aside class="iris-inb-card" aria-label="Lead">
          <LeadCardView thread={thread.latest} onOpenLead={() => props.onOpenLead(props.leadId)} />
        </aside>
      </Show>
    </div>
  )
}

/** The messages and the reply box. Also the Leads panel's Chat sub-tab. */
export function ThreadBody(props: {
  doFetch: Fetch
  leadId: number
  name: string
  thread?: ThreadAnswer
  loading: boolean
  refetch: () => void
  preferChannel?: string
  bloqId?: number
  onSent?: () => void
}) {
  let scroller: HTMLDivElement | undefined
  createEffect(on(() => props.thread?.messages.length, () => queueMicrotask(() => scroller && (scroller.scrollTop = scroller.scrollHeight))))
  const now = () => Date.now()
  return (
    <>
      <div class="iris-inb-msgs" ref={scroller} data-slot="ib-msgs">
        <Show when={props.thread} fallback={<div class="iris-ui-empty">{props.loading ? <Spinner class="iris-ui-spin" /> : "Couldn't read this conversation."}</div>}>
          {(t) => (
            <Show when={t().measured} fallback={<div class="iris-ui-empty" role="alert">Couldn't read this conversation: {t().reason}</div>}>
              <For each={groupByDay(t().messages, (m) => m.sentAt, now())} fallback={<div class="iris-ui-empty">No messages with {props.name} yet. Write the first one below.</div>}>
                {(g) => (
                  <>
                    <div class="iris-inb-day iris-inb-day-c">{g.label}</div>
                    <For each={g.items}>
                      {(m) => (
                        <div class="iris-inb-msg" data-dir={m.direction} data-slot="ib-msg">
                          <Show when={m.subject}>
                            <b class="iris-inb-msubj">{m.subject}</b>
                          </Show>
                          <p>{readableBody(m.body)}</p>
                          <span class="iris-inb-mmeta">
                            {channelLabel(m.channel)} · {m.direction === "outbound" ? "sent" : "received"} · <time title={new Date(m.sentAt).toLocaleString()}>{timeLabel(m.sentAt, now())}</time>
                          </span>
                        </div>
                      )}
                    </For>
                  </>
                )}
              </For>
            </Show>
          )}
        </Show>
      </div>
      <Show when={props.thread?.measured}>
        <Reply doFetch={props.doFetch} leadId={props.leadId} name={props.name} thread={props.thread!} preferChannel={props.preferChannel} bloqId={props.bloqId} onSent={() => (props.refetch(), props.onSent?.())} />
      </Show>
    </>
  )
}

// ─── Reply, AI draft, and the gate ────────────────────────────────────────────

function Reply(props: { doFetch: Fetch; leadId: number; name: string; thread: ThreadAnswer; preferChannel?: string; bloqId?: number; onSent: () => void }) {
  const available = () => (["email", "sms", "instagram"] as ReplyChannel[]).filter((ch) => !!props.thread.replyTo[ch === "sms" ? "sms" : ch])
  const startChannel = (): ReplyChannel => {
    const want = props.preferChannel ? replyChannelFor(props.preferChannel) : undefined
    return want && available().includes(want) ? want : (available()[0] ?? want ?? "email")
  }
  const [c, setC] = createSignal<Composer>(newComposer(startChannel(), props.thread))
  const [drafts, setDrafts] = createSignal<Draft[]>([])
  const [draftState, setDraftState] = createSignal<{ busy?: boolean; error?: string; fallback?: boolean }>({})
  const [confirming, setConfirming] = createSignal(false)
  const [sendState, setSendState] = createSignal<{ busy?: boolean; ok?: string; error?: string }>({})
  const block = () => sendBlock(c())
  const remember = (fn: (all: Record<string, LocalDraft[]>) => Record<string, LocalDraft[]>) => store.write(DRAFTS_KEY, fn(parseDrafts(store.read(DRAFTS_KEY))))

  async function draft() {
    setDraftState({ busy: true })
    const r: any = await json(props.doFetch, `${ROUTE}/draft`, { leadId: props.leadId, channel: c().channel })
    if (!r?.measured || !r.drafts?.length) return setDraftState({ error: r?.reason ?? "No draft came back" })
    setDrafts(r.drafts)
    setDraftState({ fallback: r.fallback })
    remember((all) => rememberDrafts(all, props.leadId, (r.drafts as Draft[]).map((d) => ({ at: new Date().toISOString(), channel: c().channel, text: d.text, subject: d.subject, tone: d.tone, state: "drafted" as const }))))
  }
  function approve(d: Draft) {
    setC(approveDraft(c(), d))
    setDrafts([])
    remember((all) => markDraft(all, props.leadId, d.text, "approved"))
  }
  async function send() {
    setSendState({ busy: true })
    const body = sendPayload(c(), props.leadId, props.bloqId)
    const r: any = await json(props.doFetch, `${ROUTE}/send`, body)
    setConfirming(false)
    if (!r?.ok) return setSendState({ error: r?.reason ?? "Not sent" })
    if (c().origin === "ai") remember((all) => markDraft(all, props.leadId, c().text, "sent"))
    setSendState({ ok: `Sent by ${REPLY_LABEL[c().channel]}. The platform accepted it; it shows in the thread once it is logged.` })
    setC(newComposer(c().channel, props.thread))
    props.onSent()
  }

  return (
    <div class="iris-inb-reply" data-slot="ib-reply">
      <Show when={drafts().length}>
        <div class="iris-inb-drafts" data-slot="ib-drafts">
          <div class="iris-inb-drafthead">
            <Icon name="sparkle" size="small" />
            <span>
              {drafts().length === 1 ? "An AI draft" : `${drafts().length} AI drafts`} for {props.name}. Approving puts it in the reply box; nothing is sent until you press Send.
            </span>
            <button type="button" class="iris-ui-icon" aria-label="Discard drafts" title="Discard" onClick={() => setDrafts([])}>
              <Icon name="close" size="small" />
            </button>
          </div>
          <Show when={draftState().fallback}>
            <div class="iris-ui-callout" data-tone="warn">The platform couldn't reach its model, so these are its stock lines.</div>
          </Show>
          <For each={drafts()}>
            {(d) => (
              <div class="iris-inb-draft" data-slot="ib-draft">
                <Show when={d.tone || d.subject}>
                  <span class="iris-inb-dtone">{d.subject ?? d.tone}</span>
                </Show>
                <p>{d.text}</p>
                <div class="iris-inb-dact">
                  <button type="button" class="iris-ui-btn" data-primary data-slot="ib-approve" onClick={() => approve(d)}>
                    <Icon name="check" size="small" />
                    Approve
                  </button>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      <div class="iris-inb-rbar">
        <div class="iris-ui-seg" role="group" aria-label="Reply by">
          <For each={["email", "sms", "instagram"] as ReplyChannel[]}>
            {(ch) => (
              <button
                type="button"
                aria-pressed={c().channel === ch}
                disabled={!available().includes(ch)}
                title={available().includes(ch) ? `Reply by ${REPLY_LABEL[ch]}` : `This lead has no ${ch === "email" ? "email address" : ch === "sms" ? "phone number" : "Instagram handle"}`}
                onClick={() => setC(switchChannel(c(), ch, props.thread))}
              >
                {REPLY_LABEL[ch]}
              </button>
            )}
          </For>
        </div>
        <span class="iris-inb-to">
          <Show when={c().to} fallback={<span class="weak">No address for this channel</span>}>
            to {c().channel === "instagram" ? `@${c().to}` : c().to}
          </Show>
        </span>
        <span class="iris-ui-spacer" />
        <Show when={c().origin === "ai"}>
          <span class="iris-ui-chip" data-tone="info" title="You approved an AI draft into the box. You can still edit it.">
            <Icon name="sparkle" size="small" />
            AI draft · approved
          </span>
        </Show>
      </div>
      <Show when={c().channel === "email"}>
        <input class="iris-inb-subjin" aria-label="Subject" placeholder="Subject" value={c().subject} onInput={(e) => setC({ ...c(), subject: e.currentTarget.value })} />
      </Show>
      <textarea
        class="iris-inb-text"
        aria-label={`Reply to ${props.name}`}
        placeholder={`Reply to ${props.name}…`}
        rows={3}
        value={c().text}
        onInput={(e) => setC(typeText(c(), e.currentTarget.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !block()) {
            e.preventDefault()
            setConfirming(true)
          }
        }}
      />
      <div class="iris-inb-ract">
        <button type="button" class="iris-ui-btn" data-slot="ib-draft-btn" disabled={draftState().busy} onClick={() => void draft()}>
          <Show when={draftState().busy} fallback={<Icon name="sparkle" size="small" />}>
            <Spinner class="iris-ui-spin" />
          </Show>
          {draftState().busy ? "Drafting…" : "Draft with AI"}
        </button>
        <Show when={draftState().error}>
          <span class="iris-inb-err" role="alert">{draftState().error}</span>
        </Show>
        <Show when={sendState().error}>
          <span class="iris-inb-err" role="alert">{sendState().error}</span>
        </Show>
        <Show when={sendState().ok}>
          <span class="iris-inb-ok" role="status">{sendState().ok}</span>
        </Show>
        <span class="iris-ui-spacer" />
        <span class="iris-inb-hint">{block() ?? (c().channel === "sms" ? `${c().text.length}/160` : "⌘↵")}</span>
        <button type="button" class="iris-ui-btn" data-primary data-slot="ib-send" disabled={!!block() || sendState().busy} title={block()} onClick={() => setConfirming(true)}>
          <Icon name="send" size="small" />
          Send
        </button>
      </div>

      <Show when={confirming()}>
        {(() => {
          const words = sendConfirm(c(), props.name)
          return (
            <div class="iris-ui-scrim" data-slot="ib-confirm" role="dialog" aria-modal="true" aria-label={words.title}>
              <div class="iris-ui-dialog">
                <span class="iris-ui-dialog-icon" data-tone="warn">
                  <Icon name="send" size="small" />
                </span>
                <h3>{words.title}</h3>
                <For each={words.lines}>{(l) => <p>{l}</p>}</For>
                <blockquote class="iris-inb-quote">
                  <Show when={c().channel === "email"}>
                    <b>{c().subject}</b>
                  </Show>
                  {c().text}
                </blockquote>
                <div class="iris-ui-dialog-actions">
                  <button type="button" class="iris-ui-btn" onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                  <button type="button" class="iris-ui-btn" data-primary data-slot="ib-confirm-send" disabled={sendState().busy} onClick={() => void send()}>
                    {sendState().busy ? "Sending…" : "Send"}
                  </button>
                </div>
              </div>
            </div>
          )
        })()}
      </Show>
    </div>
  )
}

// ─── The lead beside the thread ───────────────────────────────────────────────

export function LeadCardView(props: { thread?: ThreadAnswer; onOpenLead?: () => void }) {
  const lead = () => props.thread?.lead
  return (
    <Show when={lead()} fallback={<div class="iris-ui-empty">{props.thread ? (props.thread.reason ?? "No lead card") : <Spinner class="iris-ui-spin" />}</div>}>
      {(l) => (
        <div class="iris-inb-lead" data-slot="ib-lead-card">
          <div class="iris-inb-lhead">
            <span class="iris-inb-av iris-inb-av-lg">{initialOf(l().name)}</span>
            <div>
              <b>{l().name}</b>
              <Show when={l().company}>
                <span class="weak">{l().company}</span>
              </Show>
            </div>
          </div>
          <div class="iris-inb-lchips">
            <Show when={l().status}>
              <span class="iris-ui-chip">{l().status}</span>
            </Show>
            <Show when={l().hasReplied}>
              <span class="iris-ui-chip" data-tone="good">Replied</span>
            </Show>
            <Show when={l().score != null && l().score! > 0}>
              <span class="iris-ui-chip">Score {l().score}</span>
            </Show>
          </div>
          <dl class="iris-inb-dl">
            <Show when={l().email}><dt>Email</dt><dd>{l().email}</dd></Show>
            <Show when={l().phone}><dt>Phone</dt><dd>{l().phone}</dd></Show>
            <Show when={l().instagram}><dt>Instagram</dt><dd>@{l().instagram}</dd></Show>
            <Show when={l().website}><dt>Website</dt><dd>{l().website}</dd></Show>
            <Show when={l().city || l().country}><dt>Place</dt><dd>{[l().city, l().country].filter(Boolean).join(", ")}</dd></Show>
            <Show when={l().value}><dt>Value</dt><dd>${l().value!.toLocaleString()}</dd></Show>
            <Show when={l().source}><dt>Source</dt><dd>{l().source}</dd></Show>
          </dl>
          <SequenceView thread={props.thread!} compact />
          <Show when={props.thread?.outreachStats?.total ? props.thread.outreachStats : undefined}>
            {(s) => (
              <div class="iris-inb-stats">
                <span><b>{s().outbound}</b> sent</span>
                <span><b>{s().inbound}</b> received</span>
              </div>
            )}
          </Show>
          <Show when={props.onOpenLead}>
            <button type="button" class="iris-ui-btn iris-inb-lopen" onClick={() => props.onOpenLead?.()}>
              <Icon name="square-arrow-top-right" size="small" />
              Open in Leads
            </button>
          </Show>
        </div>
      )}
    </Show>
  )
}

/** Where the lead is in its outreach sequence: the step now, and how far along (LeadOutreachChecklist). */
export function SequenceView(props: { thread: ThreadAnswer; compact?: boolean }) {
  const p = () => props.thread.progress
  return (
    <div class="iris-inb-seq" data-slot="ib-sequence">
      <div class="iris-inb-sechead">
        Sequence
        <Show when={p()?.total ? p() : undefined}>{(x) => <span class="weak">{x().completed}/{x().total} · {x().percent}%</span>}</Show>
      </div>
      <Show when={props.thread.steps.length} fallback={<span class="weak">No outreach sequence on this lead.</span>}>
        <div class="iris-inb-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p()?.percent ?? 0}>
          <span style={{ width: `${p()?.percent ?? 0}%` }} />
        </div>
        <Show when={props.thread.currentStep} fallback={<span class="weak">Every step is done.</span>}>
          {(s) => (
            <div class="iris-inb-now">
              <span class="weak">Next step</span>
              <b>{s().title}</b>
              <Show when={s().dueDate}>
                <span class="weak">due {new Date(s().dueDate!).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
              </Show>
            </div>
          )}
        </Show>
        <Show when={!props.compact}>
          <ol class="iris-inb-steps">
            <For each={props.thread.steps}>
              {(s) => (
                <li data-done={s.done ? "" : undefined} data-current={props.thread.currentStep?.id === s.id ? "" : undefined}>
                  <span class="iris-inb-check">{s.done ? <Icon name="check-small" size="small" /> : null}</span>
                  <span>{s.title}</span>
                  <Show when={s.type}>
                    <span class="iris-ui-chip">{s.type}</span>
                  </Show>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </Show>
    </div>
  )
}

/**
 * AI responses for this lead: the platform's (outreach messages it marks generated_by_ai) and the
 * drafts made on this computer, each with Copy and Add to notes (Elon's LeadAIResponseHistory).
 */
export function AiHistoryView(props: { thread: ThreadAnswer; leadId: number; onAddNote?: (text: string) => Promise<boolean> }) {
  const [local, setLocal] = createSignal(parseDrafts(store.read(DRAFTS_KEY))[props.leadId] ?? [])
  const [note, setNote] = createSignal<string>()
  const rows = () => [
    ...local().map((d) => ({ key: `l:${d.at}:${d.text.slice(0, 20)}`, text: d.text, subject: d.subject, at: d.at, where: `Drafted here · ${REPLY_LABEL[d.channel]}`, state: d.state as string })),
    ...props.thread.aiHistory.map((m) => ({ key: `p:${m.id}`, text: m.text, subject: m.subject, at: m.at ?? "", where: `Platform · ${m.type?.replace(/_/g, " ") ?? "message"}${m.account ? ` · ${m.account}` : ""}`, state: m.status ?? "" })),
  ].sort((a, b) => b.at.localeCompare(a.at))
  onMount(() => setLocal(parseDrafts(store.read(DRAFTS_KEY))[props.leadId] ?? []))
  return (
    <div class="iris-inb-ai" data-slot="ib-ai-history">
      <div class="iris-inb-sechead">
        AI responses <span class="weak">{rows().length}</span>
      </div>
      <Show when={note()}>
        <div class="iris-ui-callout" data-tone="good" role="status">{note()}</div>
      </Show>
      <For each={rows()} fallback={<span class="weak">No AI responses for this lead yet. Draft one from the Chat tab.</span>}>
        {(r) => (
          <div class="iris-inb-airow">
            <div class="iris-inb-aimeta">
              <Icon name="sparkle" size="small" />
              <span>{r.where}</span>
              <Show when={r.state}>
                <span class="iris-ui-chip" data-tone={r.state === "sent" || r.state === "replied" ? "good" : r.state === "approved" ? "info" : undefined}>{r.state}</span>
              </Show>
              <span class="iris-ui-spacer" />
              <Show when={r.at}>
                <time class="weak">{timeLabel(r.at, Date.now())}</time>
              </Show>
            </div>
            <Show when={r.subject}>
              <b class="iris-inb-msubj">{r.subject}</b>
            </Show>
            <p>{r.text}</p>
            <div class="iris-inb-dact">
              <button type="button" class="iris-ui-btn" onClick={() => void navigator.clipboard?.writeText(r.text)}>
                <Icon name="copy" size="small" />
                Copy
              </button>
              <Show when={props.onAddNote}>
                <button type="button" class="iris-ui-btn" onClick={async () => setNote((await props.onAddNote!(r.text)) ? "Added to the lead's notes." : "Not added to notes.")}>
                  Add to notes
                </button>
              </Show>
            </div>
          </div>
        )}
      </For>
    </div>
  )
}

/**
 * The tab's unread badge while the Inbox is in the strip but not on screen: the same read the tab
 * makes, every couple of minutes, only while the window is visible. A failed read leaves it alone.
 */
export function watchInboxBadge(input: { doFetch: Fetch; shown: () => boolean; paneOpen: () => boolean }) {
  let inFlight = false
  const read = async () => {
    if (inFlight || !input.shown() || input.paneOpen() || document.visibilityState === "hidden") return
    inFlight = true
    const r: any = await json(input.doFetch, `${ROUTE}?days=14`)
    inFlight = false
    if (r?.measured) setSurfaceCount("inbox", unreadCount(r.conversations, parseSeen(store.read(SEEN_KEY))))
  }
  createEffect(() => input.shown() && void read())
  const timer = setInterval(() => void read(), 120_000)
  const onVisible = () => void read()
  document.addEventListener("visibilitychange", onVisible)
  onCleanup(() => {
    clearInterval(timer)
    document.removeEventListener("visibilitychange", onVisible)
  })
}
