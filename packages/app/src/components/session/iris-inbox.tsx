import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { EmptyState } from "@opencode-ai/ui/empty-state"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Notice } from "@opencode-ai/ui/notice"
import { RadioGroup } from "@opencode-ai/ui/radio-group"
import { SkeletonRows } from "@opencode-ai/ui/skeleton"
import { Spinner } from "@opencode-ai/ui/spinner"
import { StatusBadge, type StatusTone } from "@opencode-ai/ui/status-badge"
import { Tabs } from "@opencode-ai/ui/tabs"
import { useLanguage } from "@/context/language"
import { PaneDialog, PaneDialogActions } from "./iris-pane-dialog"
import "./iris-pane-layout.css"
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
  type InboxFilter,
  type InboxQuery,
  type LocalDraft,
  type ReplyChannel,
  type Seen,
  type ThreadAnswer,
} from "./iris-inbox-model"
import { setSurfaceCount } from "./iris-surface-store"

/**
 * INBOX (#192688): Elon's unified inbox and lead outreach, drawn with the ui library (Button, Tabs,
 * RadioGroup, StatusBadge, Notice, EmptyState, PaneDialog) on the panes' shared layout (#194375 W5).
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

/** Elon's channel colours, as the library's tones (a wash and a text colour) — never a stripe. */
const CHANNEL_TONE: Record<ChannelGroup, StatusTone> = { email: "info", instagram: "accent", sms: "success", imessage: "info", whatsapp: "success", form: "warning", other: "neutral" }

export function ChannelChip(props: { channel: string }) {
  const g = () => channelGroup(props.channel)
  return (
    <StatusBadge size="small" class="iris-inb-ch" tone={CHANNEL_TONE[g()]} title={props.channel} mark={<Svg d={channelPath(g())} />}>
      {channelLabel(props.channel)}
    </StatusBadge>
  )
}

const EMPTY_KEY = {
  unread: "iris.inbox.empty.unread",
  needsReply: "iris.inbox.empty.needsReply",
  assigned: "iris.inbox.empty.assigned",
  all: "iris.inbox.empty.match",
} as const
const NO_ADDRESS_KEY = { email: "iris.inbox.noAddress.email", sms: "iris.inbox.noAddress.sms", instagram: "iris.inbox.noAddress.instagram" } as const

// ─── The tab ───────────────────────────────────────────────────────────────────

export function IrisInbox(props: { doFetch: Fetch; onOpenLead: (leadId: number) => void }) {
  const language = useLanguage()
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
            placeholder={language.t("iris.inbox.search")}
            aria-label={language.t("iris.inbox.search")}
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
        <RadioGroup
          size="small"
          class="iris-inb-days"
          aria-label={language.t("iris.inbox.howFarBack")}
          options={[7, 14, 30]}
          current={st.days}
          value={(d) => String(d)}
          label={(d) => language.t("iris.inbox.days", { days: d })}
          onSelect={(d) => d !== undefined && setSt("days", d)}
        />
        <span class="iris-ui-spacer" />
        <Button size="small" icon="pencil-line" data-slot="ib-compose" onClick={() => (setSt("open", undefined), setSt("composing", true))}>
          {language.t("iris.inbox.newMessage")}
        </Button>
        <Button variant="ghost" size="small" class="iris-inb-iconbtn" title={language.t("iris.inbox.refresh")} aria-label={language.t("iris.inbox.refresh")} disabled={data.loading} onClick={refresh}>
          <Show when={data.loading} fallback={<Icon name="reset" size="small" />}>
            <Spinner class="iris-ui-spin" />
          </Show>
        </Button>
      </div>

      <Tabs variant="pill" size="small" class="iris-inb-tabs" value={st.query.filter} onChange={(v: string) => setQuery({ filter: v as InboxFilter })}>
        <Tabs.List aria-label={language.t("iris.inbox.show")}>
          <For each={FILTERS}>
            {(f) => (
              <Tabs.Trigger value={f.id} title={f.hint} data-filter={f.id}>
                {f.label}
                <Show when={data.latest?.measured}>
                  <span class="n">{counts().filters[f.id]}</span>
                </Show>
              </Tabs.Trigger>
            )}
          </For>
        </Tabs.List>
      </Tabs>
      <div class="iris-inb-chips" role="group" aria-label={language.t("iris.inbox.channel")}>
        <Button variant="ghost" size="small" class="iris-inb-chipbtn" aria-pressed={!st.query.channel} onClick={() => setQuery({ channel: undefined })}>
          {language.t("iris.inbox.allChannels")}
        </Button>
        <For each={CHANNEL_GROUPS.filter((g) => (counts().channels[g.id] ?? 0) > 0 || st.query.channel === g.id)}>
          {(g) => (
            <Button variant="ghost" size="small" class="iris-inb-chipbtn" aria-pressed={st.query.channel === g.id} data-channel={g.id} onClick={() => setQuery({ channel: st.query.channel === g.id ? undefined : g.id })}>
              <Svg d={channelPath(g.id)} />
              {g.label}
              <span class="n">{counts().channels[g.id]}</span>
            </Button>
          )}
        </For>
      </div>

      <div class="iris-inb-body">
        <div class="iris-inb-list" role="listbox" aria-label={language.t("iris.inbox.conversations")}>
          <Show
            when={data.latest?.measured}
            fallback={
              <Show when={!data.loading || data.latest} fallback={<SkeletonRows rows={6} label={language.t("iris.inbox.reading")} />}>
                <EmptyState
                  size="small"
                  role="alert"
                  title={language.t("iris.inbox.error.list", { reason: data.latest?.reason ?? language.t("iris.inbox.noAnswer") })}
                  action={
                    <Button size="small" onClick={() => refetch()}>
                      {language.t("iris.inbox.tryAgain")}
                    </Button>
                  }
                />
              </Show>
            }
          >
            <For
              each={groupByDay(shown(), (c) => c.lastAt, now())}
              fallback={
                <Show
                  when={list().length}
                  fallback={<EmptyState size="small" data-slot="ib-empty" title={language.t("iris.inbox.empty.window", { days: st.days })} />}
                >
                  <EmptyState
                    size="small"
                    data-slot="ib-empty"
                    title={language.t(EMPTY_KEY[st.query.filter])}
                    action={
                      <Button size="small" onClick={() => setSt("query", { ...NO_QUERY })}>
                        {language.t("iris.inbox.showAll")}
                      </Button>
                    }
                  />
                </Show>
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
                              <span class="iris-inb-dot" title={language.t("iris.inbox.unreadHere")} />
                            </Show>
                            <span class="iris-inb-time" title={new Date(c.lastAt).toLocaleString()}>{timeLabel(c.lastAt, now())}</span>
                          </span>
                          <Show when={c.subject}>
                            <span class="iris-inb-subj">{c.subject}</span>
                          </Show>
                          <span class="iris-inb-prev">
                            <span class="iris-inb-dir" data-dir={c.lastDirection} title={c.lastDirection === "outbound" ? language.t("iris.inbox.dir.out") : language.t("iris.inbox.dir.in")}>
                              <Svg d={c.lastDirection === "outbound" ? ARROW_OUT : ARROW_IN} />
                            </span>
                            {c.lastDirection === "outbound" ? language.t("iris.inbox.you") : ""}
                            {readableBody(c.preview)}
                          </span>
                          <span class="iris-inb-meta">
                            <ChannelChip channel={c.channel} />
                            <Show when={c.needsReply}>
                              <StatusBadge size="small" tone="warning">{language.t("iris.inbox.needsReply")}</StatusBadge>
                            </Show>
                            <Show when={c.assigned}>
                              <StatusBadge size="small" tone="info">{language.t("iris.inbox.assignedToYou")}</StatusBadge>
                            </Show>
                            <Show when={c.status}>
                              <StatusBadge size="small">{c.status}</StatusBadge>
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
                {language.t("iris.inbox.foot.count", { shown: shown().length.toLocaleString(), total: list().length.toLocaleString(), days: st.days })}
                {(data.latest?.total ?? 0) > list().length ? language.t("iris.inbox.foot.newest", { count: list().length, total: data.latest!.total }) : ""}
                {data.latest?.truncated ? language.t("iris.inbox.foot.truncated") : ""}
              </span>
              <span title={language.t("iris.inbox.foot.unread.title")}>{language.t("iris.inbox.foot.unread")}</span>
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
  const language = useLanguage()
  return (
    <div class="iris-inb-thread">
      <div class="iris-inb-dhead">
        <IconButton icon="chevron-left" variant="ghost" size="small" class="iris-inb-back" aria-label={language.t("iris.inbox.back")} onClick={props.onBack} />
        <b>{props.conv?.name ?? language.t("iris.inbox.conversation")}</b>
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
      <Notice class="iris-inb-notice" tone="info">
        {language.t("iris.inbox.notLead")}
      </Notice>
    </div>
  )
}

/** Compose: pick the lead, then write. Search is fl-api's own (the Leads tab's). */
function NewMessage(props: { doFetch: Fetch; onCancel: () => void; onPick: (leadId: number, name: string) => void }) {
  const language = useLanguage()
  const [q, setQ] = createSignal("")
  const [applied, setApplied] = createSignal("")
  let t: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => t && clearTimeout(t))
  const [found] = createResource(applied, async (s) => {
    if (s.trim().length < 2) return [] as { id: number; name: string; email?: string; phone?: string; ig?: string }[]
    const r: any = await json(props.doFetch, "/iris/leads-api", { op: "list", query: { search: s, per_page: "12", page: "1" } })
    const rows = (r?.data?.data ?? []) as any[]
    return rows.map((l) => ({ id: Number(l.id), name: String(l.nickname || l.name || l.email || language.t("iris.inbox.leadN", { id: l.id })), email: l.email ?? undefined, phone: l.phone ?? undefined, ig: l.contact_info?.instagram ?? undefined }))
  })
  return (
    <div class="iris-inb-thread" data-slot="ib-new">
      <div class="iris-inb-dhead">
        <IconButton icon="chevron-left" variant="ghost" size="small" class="iris-inb-back" aria-label={language.t("common.cancel")} onClick={props.onCancel} />
        <b>{language.t("iris.inbox.newMessage")}</b>
      </div>
      <div class="iris-inb-pick">
        <label class="iris-ui-search iris-inb-pickq">
          <Icon name="magnifying-glass" size="small" />
          <input
            autofocus
            type="search"
            placeholder={language.t("iris.inbox.pick.placeholder")}
            aria-label={language.t("iris.inbox.pick.label")}
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
          <div class="iris-ui-center">
            <Spinner class="iris-ui-spin" />
          </div>
        </Show>
        <For
          each={found() ?? []}
          fallback={
            <Show when={!found.loading && applied().trim().length >= 2}>
              <EmptyState size="small" title={language.t("iris.inbox.pick.none", { query: applied() })} />
            </Show>
          }
        >
          {(l) => (
            <button type="button" class="iris-inb-row" data-slot="ib-pick-row" onClick={() => props.onPick(l.id, l.name)}>
              <span class="iris-inb-av">{initialOf(l.name)}</span>
              <span class="iris-inb-main">
                <span class="iris-inb-name">{l.name}</span>
                <span class="iris-inb-meta">
                  <Show when={l.email}><StatusBadge size="small" mark={<Svg d={MAIL} />}>{l.email}</StatusBadge></Show>
                  <Show when={l.phone}><StatusBadge size="small" mark={<Svg d={PHONE} />}>{l.phone}</StatusBadge></Show>
                  <Show when={l.ig}><StatusBadge size="small" mark={<Svg d={IG} />}>@{l.ig}</StatusBadge></Show>
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

/** One conversation beside the lead's card. Also Outreach › Today's reply view (#193487). */
export function ConversationDetail(props: {
  doFetch: Fetch
  leadId: number
  name: string
  conv?: Conversation
  onBack: () => void
  onOpenLead: (id: number) => void
  onSent: () => void
  onMarkUnread: () => void
}) {
  const language = useLanguage()
  const [thread, { refetch }] = useThread(props.doFetch, () => props.leadId)
  const [cardOpen, setCardOpen] = createSignal(true)
  return (
    <div class="iris-inb-conv" data-card={cardOpen() ? "open" : "closed"}>
      <div class="iris-inb-thread">
        <div class="iris-inb-dhead">
          <IconButton
            icon="chevron-left"
            variant="ghost"
            size="small"
            class="iris-inb-back"
            aria-label={language.t("iris.inbox.back")}
            title={language.t("iris.inbox.back.title")}
            onClick={props.onBack}
          />
          <span class="iris-inb-av">{initialOf(thread.latest?.lead?.name ?? props.name)}</span>
          <b class="iris-inb-dname">{thread.latest?.lead?.name ?? props.name}</b>
          <For each={props.conv?.channels ?? []}>{(ch) => <ChannelChip channel={ch} />}</For>
          <span class="iris-ui-spacer" />
          <Show when={props.conv?.lastInboundAt}>
            <Button size="small" title={language.t("iris.inbox.markUnread.title")} onClick={props.onMarkUnread}>
              {language.t("iris.inbox.markUnread")}
            </Button>
          </Show>
          <Button size="small" data-slot="ib-open-lead" onClick={() => props.onOpenLead(props.leadId)}>
            {language.t("iris.inbox.openInLeads")}
          </Button>
          <IconButton
            icon="layout-right"
            variant="ghost"
            size="small"
            class="iris-inb-cardtoggle"
            aria-pressed={cardOpen()}
            title={cardOpen() ? language.t("iris.inbox.card.hide") : language.t("iris.inbox.card.show")}
            aria-label={language.t("iris.inbox.card.label")}
            onClick={() => setCardOpen(!cardOpen())}
          />
        </div>
        <ThreadBody doFetch={props.doFetch} leadId={props.leadId} name={thread.latest?.lead?.name ?? props.name} thread={thread.latest} loading={thread.loading} refetch={refetch} preferChannel={props.conv?.channel} bloqId={props.conv?.bloqId} onSent={props.onSent} />
      </div>
      <Show when={cardOpen()}>
        <aside class="iris-inb-card" aria-label={language.t("iris.inbox.lead")}>
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
  const language = useLanguage()
  let scroller: HTMLDivElement | undefined
  createEffect(on(() => props.thread?.messages.length, () => queueMicrotask(() => scroller && (scroller.scrollTop = scroller.scrollHeight))))
  const now = () => Date.now()
  return (
    <>
      <div class="iris-inb-msgs" ref={scroller} data-slot="ib-msgs">
        <Show
          when={props.thread}
          fallback={
            <Show when={props.loading} fallback={<EmptyState size="small" title={language.t("iris.inbox.thread.unread")} />}>
              <div class="iris-ui-center">
                <Spinner class="iris-ui-spin" />
              </div>
            </Show>
          }
        >
          {(t) => (
            <Show when={t().measured} fallback={<EmptyState size="small" role="alert" title={language.t("iris.inbox.thread.error", { reason: t().reason ?? "" })} />}>
              <For
                each={groupByDay(t().messages, (m) => m.sentAt, now())}
                fallback={<EmptyState size="small" title={language.t("iris.inbox.thread.empty", { name: props.name })} />}
              >
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
                            {channelLabel(m.channel)} · {m.direction === "outbound" ? language.t("iris.inbox.msg.sent") : language.t("iris.inbox.msg.received")} · <time title={new Date(m.sentAt).toLocaleString()}>{timeLabel(m.sentAt, now())}</time>
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
  const language = useLanguage()
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
    if (!r?.measured || !r.drafts?.length) return setDraftState({ error: r?.reason ?? language.t("iris.inbox.draft.none") })
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
    if (!r?.ok) return setSendState({ error: r?.reason ?? language.t("iris.inbox.send.not") })
    if (c().origin === "ai") remember((all) => markDraft(all, props.leadId, c().text, "sent"))
    setSendState({ ok: language.t("iris.inbox.send.ok", { channel: REPLY_LABEL[c().channel] }) })
    setC(newComposer(c().channel, props.thread))
    props.onSent()
  }

  return (
    <div class="iris-inb-reply" data-slot="ib-reply">
      <Show when={drafts().length}>
        <div class="iris-inb-drafts" data-slot="ib-drafts">
          <div class="iris-inb-drafthead">
            <Icon name="sparkle" size="small" />
            <span>{language.plural("iris.inbox.drafts.head", drafts().length, { name: props.name })}</span>
            <IconButton
              icon="close"
              variant="ghost"
              size="small"
              aria-label={language.t("iris.inbox.drafts.discard")}
              title={language.t("iris.inbox.drafts.discard.title")}
              onClick={() => setDrafts([])}
            />
          </div>
          <Show when={draftState().fallback}>
            <Notice tone="warning">{language.t("iris.inbox.drafts.fallback")}</Notice>
          </Show>
          <For each={drafts()}>
            {(d) => (
              <div class="iris-inb-draft" data-slot="ib-draft">
                <Show when={d.tone || d.subject}>
                  <span class="iris-inb-dtone">{d.subject ?? d.tone}</span>
                </Show>
                <p>{d.text}</p>
                <div class="iris-inb-dact">
                  <Button size="small" variant="primary" icon="check" data-slot="ib-approve" onClick={() => approve(d)}>
                    {language.t("iris.inbox.approve")}
                  </Button>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      <div class="iris-inb-rbar">
        {/* Not a RadioGroup: a channel the lead has no address for is disabled, with the reason as its title. */}
        <div class="iris-inb-replyby" role="group" aria-label={language.t("iris.inbox.replyBy")}>
          <For each={["email", "sms", "instagram"] as ReplyChannel[]}>
            {(ch) => (
              <Button
                variant="ghost"
                size="small"
                class="iris-inb-chipbtn"
                aria-pressed={c().channel === ch}
                disabled={!available().includes(ch)}
                title={available().includes(ch) ? language.t("iris.inbox.replyBy.title", { channel: REPLY_LABEL[ch] }) : language.t(NO_ADDRESS_KEY[ch])}
                onClick={() => setC(switchChannel(c(), ch, props.thread))}
              >
                {REPLY_LABEL[ch]}
              </Button>
            )}
          </For>
        </div>
        <span class="iris-inb-to">
          <Show when={c().to} fallback={<span class="weak">{language.t("iris.inbox.noAddress")}</span>}>
            {language.t("iris.inbox.to", { address: c().channel === "instagram" ? `@${c().to}` : (c().to ?? "") })}
          </Show>
        </span>
        <span class="iris-ui-spacer" />
        <Show when={c().origin === "ai"}>
          <StatusBadge size="small" tone="info" title={language.t("iris.inbox.aiChip.title")} mark={<Icon name="sparkle" size="small" />}>
            {language.t("iris.inbox.aiChip")}
          </StatusBadge>
        </Show>
      </div>
      <Show when={c().channel === "email"}>
        <input
          class="iris-inb-subjin"
          aria-label={language.t("iris.inbox.subject")}
          placeholder={language.t("iris.inbox.subject")}
          value={c().subject}
          onInput={(e) => setC({ ...c(), subject: e.currentTarget.value })}
        />
      </Show>
      <textarea
        class="iris-inb-text"
        aria-label={language.t("iris.inbox.replyTo", { name: props.name })}
        placeholder={language.t("iris.inbox.replyTo.placeholder", { name: props.name })}
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
        <Button size="small" data-slot="ib-draft-btn" disabled={draftState().busy} onClick={() => void draft()}>
          <Show when={draftState().busy} fallback={<Icon name="sparkle" size="small" />}>
            <Spinner class="iris-ui-spin" />
          </Show>
          {draftState().busy ? language.t("iris.inbox.drafting") : language.t("iris.inbox.draftWithAi")}
        </Button>
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
        <Button size="small" variant="primary" icon="send" data-slot="ib-send" disabled={!!block() || sendState().busy} title={block()} onClick={() => setConfirming(true)}>
          {language.t("iris.inbox.send")}
        </Button>
      </div>

      {/* The gate: the ui Dialog (focus trapped, Escape and the overlay cancel). Nothing goes out without this yes. */}
      {/* What is being confirmed is held (PaneDialog keeps the last value), so the message does not
        blank out as the dialog closes after the send clears the box. */}
      <PaneDialog
        when={confirming() ? { composer: c(), words: sendConfirm(c(), props.name) } : undefined}
        onClose={() => setConfirming(false)}
        title={(x) => x.words.title}
        id="ib-confirm"
      >
        {(x) => (
          <div class="iris-inb-confirm" data-slot="ib-confirm">
            <For each={x().words.lines}>{(l) => <p>{l}</p>}</For>
            <blockquote class="iris-inb-quote">
              <Show when={x().composer.channel === "email"}>
                <b>{x().composer.subject}</b>
              </Show>
              {x().composer.text}
            </blockquote>
            <PaneDialogActions>
              <Button size="small" onClick={() => setConfirming(false)}>
                {language.t("common.cancel")}
              </Button>
              <Button size="small" variant="primary" data-slot="ib-confirm-send" disabled={sendState().busy} onClick={() => void send()}>
                <Show when={sendState().busy}>
                  <Spinner class="iris-ui-spin" />
                </Show>
                {sendState().busy ? language.t("iris.inbox.sending") : language.t("iris.inbox.send")}
              </Button>
            </PaneDialogActions>
          </div>
        )}
      </PaneDialog>
    </div>
  )
}

// ─── The lead beside the thread ───────────────────────────────────────────────

export function LeadCardView(props: { thread?: ThreadAnswer; onOpenLead?: () => void }) {
  const language = useLanguage()
  const lead = () => props.thread?.lead
  return (
    <Show
      when={lead()}
      fallback={
        <Show
          when={props.thread}
          fallback={
            <div class="iris-ui-center">
              <Spinner class="iris-ui-spin" />
            </div>
          }
        >
          <EmptyState size="small" title={props.thread?.reason ?? language.t("iris.inbox.noLeadCard")} />
        </Show>
      }
    >
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
              <StatusBadge size="small">{l().status}</StatusBadge>
            </Show>
            <Show when={l().hasReplied}>
              <StatusBadge size="small" tone="success">{language.t("iris.inbox.replied")}</StatusBadge>
            </Show>
            <Show when={l().score != null && l().score! > 0}>
              <StatusBadge size="small">{language.t("iris.inbox.score", { score: l().score! })}</StatusBadge>
            </Show>
          </div>
          <dl class="iris-inb-dl">
            <Show when={l().email}><dt>{language.t("iris.inbox.field.email")}</dt><dd>{l().email}</dd></Show>
            <Show when={l().phone}><dt>{language.t("iris.inbox.field.phone")}</dt><dd>{l().phone}</dd></Show>
            <Show when={l().instagram}><dt>{language.t("iris.inbox.field.instagram")}</dt><dd>@{l().instagram}</dd></Show>
            <Show when={l().website}><dt>{language.t("iris.inbox.field.website")}</dt><dd>{l().website}</dd></Show>
            <Show when={l().city || l().country}><dt>{language.t("iris.inbox.field.place")}</dt><dd>{[l().city, l().country].filter(Boolean).join(", ")}</dd></Show>
            <Show when={l().value}><dt>{language.t("iris.inbox.field.value")}</dt><dd>${l().value!.toLocaleString()}</dd></Show>
            <Show when={l().source}><dt>{language.t("iris.inbox.field.source")}</dt><dd>{l().source}</dd></Show>
          </dl>
          <SequenceView thread={props.thread!} compact />
          <Show when={props.thread?.outreachStats?.total ? props.thread.outreachStats : undefined}>
            {(s) => (
              <div class="iris-inb-stats">
                <span><b>{s().outbound}</b> {language.t("iris.inbox.stats.sent")}</span>
                <span><b>{s().inbound}</b> {language.t("iris.inbox.stats.received")}</span>
              </div>
            )}
          </Show>
          <Show when={props.onOpenLead}>
            <Button size="small" icon="square-arrow-top-right" class="iris-inb-lopen" onClick={() => props.onOpenLead?.()}>
              {language.t("iris.inbox.openInLeads")}
            </Button>
          </Show>
        </div>
      )}
    </Show>
  )
}

/** Where the lead is in its outreach sequence: the step now, and how far along (LeadOutreachChecklist). */
export function SequenceView(props: { thread: ThreadAnswer; compact?: boolean }) {
  const language = useLanguage()
  const p = () => props.thread.progress
  return (
    <div class="iris-inb-seq" data-slot="ib-sequence">
      <div class="iris-inb-sechead">
        {language.t("iris.inbox.sequence")}
        <Show when={p()?.total ? p() : undefined}>{(x) => <span class="weak">{x().completed}/{x().total} · {x().percent}%</span>}</Show>
      </div>
      <Show when={props.thread.steps.length} fallback={<span class="weak">{language.t("iris.inbox.sequence.none")}</span>}>
        <div class="iris-inb-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p()?.percent ?? 0}>
          <span style={{ width: `${p()?.percent ?? 0}%` }} />
        </div>
        <Show when={props.thread.currentStep} fallback={<span class="weak">{language.t("iris.inbox.sequence.done")}</span>}>
          {(s) => (
            <div class="iris-inb-now">
              <span class="weak">{language.t("iris.inbox.sequence.next")}</span>
              <b>{s().title}</b>
              <Show when={s().dueDate}>
                <span class="weak">
                  {language.t("iris.inbox.sequence.due", { date: new Date(s().dueDate!).toLocaleDateString(undefined, { month: "short", day: "numeric" }) })}
                </span>
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
                    <StatusBadge size="small">{s.type}</StatusBadge>
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
  const language = useLanguage()
  const [local, setLocal] = createSignal(parseDrafts(store.read(DRAFTS_KEY))[props.leadId] ?? [])
  const [note, setNote] = createSignal<string>()
  const rows = () => [
    ...local().map((d) => ({ key: `l:${d.at}:${d.text.slice(0, 20)}`, text: d.text, subject: d.subject, at: d.at, where: language.t("iris.inbox.ai.here", { channel: REPLY_LABEL[d.channel] }), state: d.state as string })),
    ...props.thread.aiHistory.map((m) => ({
      key: `p:${m.id}`,
      text: m.text,
      subject: m.subject,
      at: m.at ?? "",
      where: `${language.t("iris.inbox.ai.platform", { type: m.type?.replace(/_/g, " ") ?? language.t("iris.inbox.ai.message") })}${m.account ? ` · ${m.account}` : ""}`,
      state: m.status ?? "",
    })),
  ].sort((a, b) => b.at.localeCompare(a.at))
  onMount(() => setLocal(parseDrafts(store.read(DRAFTS_KEY))[props.leadId] ?? []))
  const stateTone = (s: string): StatusTone => (s === "sent" || s === "replied" ? "success" : s === "approved" ? "info" : "neutral")
  return (
    <div class="iris-inb-ai" data-slot="ib-ai-history">
      <div class="iris-inb-sechead">
        {language.t("iris.inbox.ai.title")} <span class="weak">{rows().length}</span>
      </div>
      <Show when={note()}>
        <Notice tone="success" role="status">{note()}</Notice>
      </Show>
      <For each={rows()} fallback={<span class="weak">{language.t("iris.inbox.ai.none")}</span>}>
        {(r) => (
          <div class="iris-inb-airow">
            <div class="iris-inb-aimeta">
              <Icon name="sparkle" size="small" />
              <span>{r.where}</span>
              <Show when={r.state}>
                <StatusBadge size="small" tone={stateTone(r.state)}>{r.state}</StatusBadge>
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
              <Button size="small" icon="copy" onClick={() => void navigator.clipboard?.writeText(r.text)}>
                {language.t("iris.inbox.copy")}
              </Button>
              <Show when={props.onAddNote}>
                <Button
                  size="small"
                  onClick={async () => setNote((await props.onAddNote!(r.text)) ? language.t("iris.inbox.ai.added") : language.t("iris.inbox.ai.notAdded"))}
                >
                  {language.t("iris.inbox.addToNotes")}
                </Button>
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
