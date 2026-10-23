import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch, untrack } from "solid-js"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import "./iris-hive-scripts.css"
import "./iris-hive-inbox.css"
import { renderMarkdown } from "./iris-item"
import {
  applyFilter,
  bodyAfterTitle,
  bodyNote,
  cardLabel,
  FILTERS,
  filterCounts,
  fullTime,
  groupByDay,
  inboxCli,
  inboxRowsOf,
  initials,
  kindLabel,
  matchesQuery,
  needsMe,
  parsePrefs,
  peersOf,
  rankInbox,
  replyCount,
  samePeer,
  sentMatches,
  sentNewestFirst,
  sentState,
  shortAge,
  subjectOf,
  threadOf,
  type Filter,
  type InboxMessage,
  type InboxRow,
  type Lens,
  type SentRow,
} from "./iris-hive-inbox-model"
import { bumpIrisInbox } from "./iris-nav"

/**
 * Hive › Inbox — v2 (#190917, "Make the Hive inbox a place people work").
 *
 * One inbox, two lenses. INBOX ranks what needs you; ACTIVITY shows the same items in time order.
 * The lens changes order and grouping only — never which items are in, the filter, the read
 * state, or where a click lands. A click opens the THREAD with that computer (everything it sent
 * here, everything this panel sent it), with the list collapsed to an avatar rail so context stays
 * on screen. Read is marked on open; done is a separate, explicit action.
 *
 * What it replaced (#189279): a newest-first list whose click showed one message. That could be
 * read, but not worked: no unread, no done, no reply, and no way to see a conversation.
 */
type IconName = IconProps["name"]
type ListPayload = { measured: boolean; reason?: string | null; unread: number | null; items: InboxRow[] }
type SentPayload = { measured: boolean; reason?: string | null; items: SentRow[] }
type MessagePayload = { measured: boolean; reason?: string | null; message: InboxMessage | null }
type StatePayload = { measured: boolean; reason?: string; read: boolean; done: boolean; card?: { item: string; ok: boolean; reason?: string } }
type SendPayload = { measured: boolean; ok: boolean; reason?: string; sent?: SentRow }
type Entry = { key: string; kind: "in"; row: InboxRow } | { key: string; kind: "out"; sent: SentRow }

const PREFS_KEY = "iris.hive-inbox.v2"
const keyOf = (r: InboxRow) => r.id ?? `i${r.index}`

function Ic(props: { name: IconName; class?: string }) {
  return (
    <span class={`hsc-ic ${props.class ?? ""}`} aria-hidden="true">
      <Icon name={props.name} size="small" />
    </span>
  )
}

function Avatar(props: { name: string; you?: boolean }) {
  return (
    <span class="hib-av" classList={{ "hib-av--you": props.you }} aria-hidden="true">
      {props.you ? "You" : initials(props.name)}
    </span>
  )
}

export function IrisHiveInbox(props: {
  doFetch: (path: string, init?: RequestInit) => Promise<Response>
  openExternal?: (url: string) => void
  now?: () => number
}) {
  const now = () => props.now?.() ?? Date.now()
  const getJson = async <T,>(path: string, init: RequestInit | undefined, fallback: T): Promise<T> => {
    try {
      const res = await props.doFetch(path, init)
      return (await res.json()) as T
    } catch (e) {
      return { ...fallback, reason: e instanceof Error ? e.message : String(e) }
    }
  }
  const post = <T,>(path: string, body: unknown, fallback: T) =>
    getJson<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, fallback)

  // ── data ────────────────────────────────────────────────────────────────
  const [list, { refetch }] = createResource(() =>
    getJson<ListPayload>("/iris/inbox?perPage=200", undefined, { measured: false, unread: null, items: [] }),
  )
  const [sentRes, { refetch: refetchSent }] = createResource(() =>
    getJson<SentPayload>("/iris/inbox-sent", undefined, { measured: false, items: [] }),
  )
  const reload = () => {
    void refetch()
    void refetchSent()
  }
  // New messages are a file the daemon appends to; 20s keeps the list honest without a watcher.
  const timer = setInterval(reload, 20_000)
  onCleanup(() => clearInterval(timer))

  const all = createMemo(() => list.latest?.items ?? [])
  const sent = createMemo(() => (sentRes.latest?.measured ? sentRes.latest.items : []))
  /** The manifest's count, or null when it could not be measured — rendered as a dash, never 0. */
  const unread = createMemo<number | null>(() => (list.latest?.measured ? (list.latest.unread ?? null) : null))

  // ── view state, remembered per viewer ───────────────────────────────────
  const saved = (() => {
    try {
      return parsePrefs(localStorage.getItem(PREFS_KEY))
    } catch {
      return parsePrefs(null)
    }
  })()
  const [lens, setLens] = createSignal<Lens>(saved.lens)
  const [filter, setFilter] = createSignal<Filter>(saved.filter)
  const [selected, setSelected] = createSignal<string | undefined>(saved.selected)
  const [query, setQuery] = createSignal("")
  const [peer, setPeer] = createSignal<string | undefined>()
  createEffect(() => {
    const v = JSON.stringify({ lens: lens(), filter: filter(), selected: selected() })
    try {
      localStorage.setItem(PREFS_KEY, v)
    } catch {}
  })

  const counts = createMemo(() => filterCounts(all(), sent()))
  /** What the list shows, in the order the current lens puts it. */
  const entries = createMemo<Entry[]>(() => {
    const q = query()
    if (filter() === "sent") return sentNewestFirst(sent().filter((s) => sentMatches(s, q))).map((s) => ({ key: `s:${s.id}`, kind: "out" as const, sent: s }))
    const rows = applyFilter(all(), filter()).filter((r) => matchesQuery(r, q))
    const ordered = lens() === "inbox" ? rankInbox(rows) : inboxRowsOf(rows)
    return ordered.map((row) => ({ key: keyOf(row), kind: "in" as const, row }))
  })
  const entryAt = (e: Entry) => (e.kind === "in" ? e.row.receivedAt : e.sent.sentAt)
  const groups = createMemo(() =>
    lens() === "activity" ? groupByDay(entries(), entryAt, now()) : [{ day: "", rows: entries() }],
  )
  const selectedEntry = createMemo(() => entries().find((e) => e.key === selected()))
  const peerOf = (e: Entry) => (e.kind === "in" ? e.row.from : e.sent.to)

  // ── bodies, loaded on demand ────────────────────────────────────────────
  const [bodies, setBodies] = createSignal<Record<string, InboxMessage | { error: string } | "loading">>({})
  const loadBody = async (r: InboxRow) => {
    const k = keyOf(r)
    // Untracked: this runs inside effects, and reading the cache there would make every write to
    // it re-run the effect that wrote it.
    const have = untrack(bodies)[k]
    if (have === "loading") return undefined
    if (have && !("error" in have)) return have
    setBodies((b) => ({ ...b, [k]: "loading" }))
    const q = r.id ? `?id=${encodeURIComponent(r.id)}` : ""
    const p = await getJson<MessagePayload>(`/iris/inbox/${r.index}${q}`, undefined, { measured: false, message: null })
    setBodies((b) => ({ ...b, [k]: p.message ?? { error: p.reason ?? "could not open this message" } }))
    return p.message
  }
  const bodyOf = (r: InboxRow) => {
    const b = bodies()[keyOf(r)]
    return b && b !== "loading" && !("error" in b) ? b : undefined
  }

  // ── the writes ──────────────────────────────────────────────────────────
  const [notice, setNotice] = createSignal<{ tone: "ok" | "warn"; text: string } | undefined>()
  const say = (tone: "ok" | "warn", text: string) => {
    setNotice({ tone, text })
    setTimeout(() => setNotice((n) => (n?.text === text ? undefined : n)), 5000)
  }

  /** Mark read — after the body is in hand, so a burn-after-read message is still readable. */
  // Each row is marked once per session: the list refetches after every write, and a thread that
  // re-renders must not POST the same read again while the first is in flight.
  const marking = new Set<string>()
  const markRead = async (r: InboxRow) => {
    if (r.read || marking.has(keyOf(r))) return
    marking.add(keyOf(r))
    await loadBody(r)
    const res = await post<{ measured: boolean; reason?: string }>(`/iris/inbox/${r.index}/read`, { id: r.id }, { measured: false })
    if (res.measured) bumpIrisInbox()
    else marking.delete(keyOf(r))
    void refetch()
  }
  const setState = async (r: InboxRow, change: { read?: boolean; done?: boolean }) => {
    const resolveCard = change.done === true && !!r.item && (r.type === "handoff" || r.type === "job")
    const res = await post<StatePayload>(`/iris/inbox/${r.index}/state`, { id: r.id, ...change, resolveCard }, { measured: false, read: r.read, done: !!r.done })
    if (!res.measured) say("warn", `Not changed — ${res.reason ?? "the inbox could not be updated"}`)
    else if (res.card && !res.card.ok) say("warn", `Marked done here, but card ${cardLabel(res.card.item)} was not closed — ${res.card.reason ?? "unknown reason"}`)
    else if (res.card?.ok) say("ok", `Done — card ${cardLabel(res.card.item)} closed too`)
    else if (change.done === true) say("ok", "Marked done")
    else if (change.done === false) say("ok", "Back in the inbox")
    else if (change.read === false) say("ok", "Marked unread")
    bumpIrisInbox()
    void refetch()
  }
  const toggleDone = (r: InboxRow) => void setState(r, { done: !r.done })
  const toggleRead = (r: InboxRow) => {
    if (!r.read) return void markRead(r)
    marking.delete(keyOf(r))
    void setState(r, { read: false })
  }

  const [sending, setSending] = createSignal(false)
  const send = async (to: string, text: string, replyTo?: string): Promise<boolean> => {
    if (!text.trim() || sending()) return false
    setSending(true)
    const res = await post<SendPayload>("/iris/inbox-send", { to, text, replyTo }, { measured: false, ok: false })
    setSending(false)
    if (!res.ok) {
      say("warn", `Not sent — ${res.reason ?? "the send failed"}`)
      return false
    }
    say("ok", `Sent to ${res.sent?.to ?? to} — accepted by IRIS`)
    void refetchSent()
    return true
  }

  // ── navigation ──────────────────────────────────────────────────────────
  const openThread = (e: Entry) => {
    setSelected(e.key)
    setPeer(peerOf(e))
  }
  const back = () => setPeer(undefined)
  const thread = createMemo(() => {
    const p = peer()
    return p ? threadOf(p, all(), sent()) : []
  })
  const rail = createMemo(() => peersOf(all(), sent()))
  /** A reply from the thread answers the newest message that came IN. */
  const lastIncomingId = createMemo(() => {
    for (const x of [...thread()].reverse()) if (x.dir === "in") return x.row.id
    return undefined
  })
  // Opening a thread loads its recent bodies, then marks what was unread as read.
  createEffect(() => {
    const t = thread()
    if (!peer()) return
    const incoming = t.filter((x): x is Extract<typeof x, { dir: "in" }> => x.dir === "in").slice(-15)
    void (async () => {
      for (const x of incoming) await loadBody(x.row)
      for (const x of incoming) if (!x.row.read) await markRead(x.row)
    })()
  })
  // The peek loads the selected message's body so it can show the text, not just a subject.
  createEffect(() => {
    const e = selectedEntry()
    if (e?.kind === "in" && !peer()) void loadBody(e.row)
  })

  let searchEl: HTMLInputElement | undefined
  let replyEl: HTMLTextAreaElement | undefined
  let rootEl: HTMLDivElement | undefined
  const move = (d: 1 | -1) => {
    const list = entries()
    if (!list.length) return
    const i = list.findIndex((e) => e.key === selected())
    const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + d))]
    setSelected(next.key)
    const esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(next.key) : next.key.replace(/["\\]/g, "\\$&")
    rootEl?.querySelector(`[data-key="${esc}"]`)?.scrollIntoView?.({ block: "nearest" })
  }
  const onKey = (ev: KeyboardEvent) => {
    const typing = (ev.target as HTMLElement | null)?.closest?.("input, textarea")
    if (ev.key === "Escape") {
      if (typing) (typing as HTMLElement).blur()
      else if (peer()) back()
      else return
      ev.preventDefault()
      return
    }
    if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
        ev.preventDefault()
        searchEl?.focus()
      }
      return
    }
    const e = selectedEntry()
    const row = e?.kind === "in" ? e.row : undefined
    const handled = (() => {
      switch (ev.key) {
        case "j":
        case "ArrowDown":
          if (!peer()) move(1)
          return true
        case "k":
        case "ArrowUp":
          if (!peer()) move(-1)
          return true
        case "Enter":
          if (e && !peer()) openThread(e)
          return !!e
        case "e":
          if (row) toggleDone(row)
          return !!row
        case "u":
          if (row) toggleRead(row)
          return !!row
        case "r":
          replyEl?.focus()
          return !!replyEl
        case "/":
          searchEl?.focus()
          return true
      }
      return false
    })()
    if (handled) ev.preventDefault()
  }

  // ── rendering helpers ───────────────────────────────────────────────────
  // Message text comes from OTHER machines and other people: sanitized, never trusted as markup.
  // The sanitizer is loaded lazily — its module pulls a web worker that unit tests cannot load —
  // and until it is here (or if it is unsupported) the body shows as plain text, never raw HTML.
  const [purify] = createResource(() =>
    import("@opencode-ai/session-ui/markdown-cache").then((m) => m.sanitizeMarkdown).catch(() => undefined),
  )
  const bodyHtml = (text: string): string | null => {
    const clean = purify.latest
    if (!clean) return null
    return clean(renderMarkdown(text)) || null
  }
  // A link inside a message opens in the browser, not inside the app's own window.
  const onBodyClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a")
    const href = a?.getAttribute("href")
    if (!a || !href) return
    e.preventDefault()
    if (/^https?:\/\//i.test(href)) props.openExternal?.(href)
  }
  const [copied, setCopied] = createSignal(false)
  const copyCli = async (m: InboxMessage) => {
    try {
      await navigator.clipboard.writeText(inboxCli(m))
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {}
  }

  const Kind = (p: { row: InboxRow }) => (
    <Show when={p.row.type !== "message" && p.row.type !== "text"}>
      <span class="hib-kind" data-kind={p.row.type}>
        {kindLabel(p.row.type)}
      </span>
    </Show>
  )

  const Composer = (p: { to: string; replyTo?: string; compact?: boolean }) => {
    const [text, setText] = createSignal("")
    const submit = async () => {
      if (await send(p.to, text(), p.replyTo)) setText("")
    }
    return (
      <form
        class="hib-compose"
        classList={{ "hib-compose--compact": p.compact }}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <textarea
          ref={(el) => (replyEl = el)}
          class="hib-compose-input"
          rows={p.compact ? 1 : 2}
          placeholder={`Reply to ${p.to}…`}
          aria-label={`Reply to ${p.to}`}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey || p.compact) && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <button type="submit" class="hib-send" disabled={!text().trim() || sending()} title="Send (⌘↩)">
          <Ic name="arrow-up" />
          <span class="hib-sr">Send</span>
        </button>
      </form>
    )
  }

  const Row = (p: { e: Entry }) => {
    const isSel = () => selected() === p.e.key
    return (
      <li data-key={p.e.key} classList={{ "hib-li--sel": isSel() }}>
        <Switch>
          <Match when={p.e.kind === "in" && p.e}>
            {(e) => {
              const r = () => (e() as Extract<Entry, { kind: "in" }>).row
              return (
                <button
                  type="button"
                  class="hib-row"
                  classList={{ "hib-row--new": !r().read, "hib-row--sel": isSel(), "hib-row--done": !!r().done }}
                  title={fullTime(r().receivedAt)}
                  aria-current={isSel() ? "true" : undefined}
                  onClick={() => openThread(p.e)}
                  onFocus={() => setSelected(p.e.key)}
                >
                  <i class="hib-dot" aria-label={r().read ? undefined : "Unread"} />
                  <Avatar name={r().from} />
                  <span class="hib-main">
                    <span class="hib-line">
                      <span class="hib-from">{r().from}</span>
                      <Kind row={r()} />
                      <Show when={needsMe(r())}>
                        <span class="hib-need">needs you</span>
                      </Show>
                      <span class="hsc-spacer" />
                      <span class="hsc-num hib-age">{shortAge(r().receivedAt, now())}</span>
                    </span>
                    <span class="hib-subj">{subjectOf(r())}</span>
                    <Show when={replyCount(r().id, sent()) > 0 || cardLabel(r().item)}>
                      <span class="hib-sub">
                        <Show when={cardLabel(r().item)}>
                          <span class="hsc-num">{cardLabel(r().item)}</span>
                          <Show when={r().status}>
                            <span data-status={r().status}> · {r().status}</span>
                          </Show>
                        </Show>
                        <Show when={replyCount(r().id, sent()) > 0}>
                          <span>
                            ↳ <span class="hsc-num">{replyCount(r().id, sent())}</span>{" "}
                            {replyCount(r().id, sent()) === 1 ? "reply" : "replies"}
                          </span>
                        </Show>
                      </span>
                    </Show>
                  </span>
                </button>
              )
            }}
          </Match>
          <Match when={p.e.kind === "out" && p.e}>
            {(e) => {
              const s = () => (e() as Extract<Entry, { kind: "out" }>).sent
              return (
                <button
                  type="button"
                  class="hib-row hib-row--out"
                  classList={{ "hib-row--sel": isSel() }}
                  title={fullTime(s().sentAt)}
                  onClick={() => openThread(p.e)}
                  onFocus={() => setSelected(p.e.key)}
                >
                  <i class="hib-dot" />
                  <Avatar name="You" you />
                  <span class="hib-main">
                    <span class="hib-line">
                      <span class="hib-from">
                        You <span class="hib-faint">→</span> {s().to}
                      </span>
                      <span class="hsc-spacer" />
                      <span class="hsc-num hib-age">{shortAge(s().sentAt, now())}</span>
                    </span>
                    <span class="hib-subj">{s().text.split("\n")[0]}</span>
                    <span class="hib-sub">{sentState(s())}</span>
                  </span>
                </button>
              )
            }}
          </Match>
        </Switch>
        <Show when={isSel() && p.e.kind === "in" && p.e}>{(e) => <Peek row={(e() as Extract<Entry, { kind: "in" }>).row} />}</Show>
      </li>
    )
  }

  /** The selected row's last exchange, a reply box, and the two actions — triage without leaving the list. */
  const Peek = (p: { row: InboxRow }) => {
    const lastOut = () => [...sent()].reverse().find((s) => samePeer(s.to, p.row.from))
    const text = () => {
      const m = bodyOf(p.row)
      return m?.body ? bodyAfterTitle(m.body, subjectOf(p.row)) : (p.row.preview ?? "")
    }
    return (
      <div class="hib-peek">
        <Show when={text() && text() !== subjectOf(p.row)}>
          <p class="hib-peek-text">{text()}</p>
        </Show>
        <Show when={lastOut()}>
          {(s) => (
            <p class="hib-peek-you">
              <b>you:</b> {s().text.split("\n")[0]}
            </p>
          )}
        </Show>
        <div class="hib-peek-acts">
          <button type="button" class="hib-chipbtn" onClick={() => openThread({ key: keyOf(p.row), kind: "in", row: p.row })}>
            Open thread →
          </button>
          <button type="button" class="hib-chipbtn" onClick={() => toggleDone(p.row)} title="Done (e)">
            {p.row.done ? "Not done" : p.row.item ? `Done · close ${cardLabel(p.row.item)}` : "Done"}
          </button>
          <button type="button" class="hib-chipbtn" onClick={() => toggleRead(p.row)} title="Toggle read (u)">
            {p.row.read ? "Mark unread" : "Mark read"}
          </button>
        </div>
        <Composer to={p.row.from} replyTo={p.row.id} compact />
      </div>
    )
  }

  // ── the view ────────────────────────────────────────────────────────────
  return (
    <div class="hsc-wrap">
      <div class="hib" ref={(el) => (rootEl = el)} tabIndex={-1} onKeyDown={onKey}>
        <header class="hib-top">
          <div class="hib-sum">
            <span class="hib-scope">this machine</span>
            <span>
              <b class="hsc-num" classList={{ "hib-hot": (unread() ?? 0) > 0 }}>
                {unread() === null ? "—" : unread()}
              </b>{" "}
              unread
            </span>
          </div>
          <div class="hib-seg" role="tablist" aria-label="Lens">
            <button type="button" role="tab" aria-selected={lens() === "inbox"} onClick={() => setLens("inbox")} title="Ranked for what needs you">
              Inbox
            </button>
            <button type="button" role="tab" aria-selected={lens() === "activity"} onClick={() => setLens("activity")} title="Everything, in time order">
              Activity
            </button>
          </div>
          <button type="button" class="hib-ib" title="Check for new messages" onClick={reload}>
            <Ic name="reset" />
          </button>
        </header>

        <Show when={notice()}>
          {(n) => (
            <p class="hib-notice" data-tone={n().tone} role="status">
              {n().text}
            </p>
          )}
        </Show>
        <Show when={list.latest && !list.latest.measured}>
          <p class="hsc-warn">Could not read the inbox{list.latest!.reason ? ` — ${list.latest!.reason}` : ""}</p>
        </Show>
        <Show when={list.latest?.measured && list.latest.reason}>
          <p class="hsc-warn">{list.latest!.reason}</p>
        </Show>

        <Show
          when={peer()}
          fallback={
            <section class="hib-list" aria-label="Hive inbox">
              <div class="hib-search">
                <Ic name="magnifying-glass" />
                <input
                  ref={(el) => (searchEl = el)}
                  type="search"
                  placeholder={lens() === "inbox" ? "Search sender, message, file" : "Search activity"}
                  aria-label="Search the inbox"
                  value={query()}
                  onInput={(e) => setQuery(e.currentTarget.value)}
                />
                <kbd class="hsc-num">⌘K</kbd>
              </div>
              <div class="hib-chips" role="tablist" aria-label="Filter">
                <For each={FILTERS}>
                  {(f) => (
                    <button type="button" role="tab" class="hib-chip" aria-selected={filter() === f.id} onClick={() => setFilter(f.id)}>
                      {f.label}
                      <span class="hsc-num">{counts()[f.id]}</span>
                    </button>
                  )}
                </For>
              </div>

              <Switch>
                <Match when={list.loading && !list.latest}>
                  <p class="hib-empty hib-faint">Reading the inbox…</p>
                </Match>
                <Match when={list.latest?.measured && all().length === 0 && sent().length === 0}>
                  <div class="hib-empty">
                    <div class="hib-empty-mark" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M3 13h5l1.5 2.5h5L16 13h5M5 5h14l2 8v6H3v-6l2-8Z" stroke-linejoin="round" />
                      </svg>
                    </div>
                    <b>Your Hive inbox is empty</b>
                    <p>
                      Messages land here when another of your computers, a person you share with, or an agent sends one
                      to this machine — a note, a link, a file, or a handed-off task. You can reply from here.
                    </p>
                    <p class="hib-faint">
                      To try it, from another computer: <code class="hsc-mono">iris hive inbox send "hello" --to &lt;this computer&gt;</code>
                    </p>
                  </div>
                </Match>
                <Match when={entries().length === 0}>
                  <p class="hib-empty hib-faint">
                    {query().trim()
                      ? `Nothing matches "${query().trim()}".`
                      : filter() === "needs"
                        ? "Nothing needs you. You are caught up."
                        : filter() === "sent"
                          ? "Nothing sent from this computer yet."
                          : filter() === "done"
                            ? "Nothing marked done yet."
                            : "Nothing here."}
                  </p>
                </Match>
                <Match when={entries().length > 0}>
                  <For each={groups()}>
                    {(g) => (
                      <>
                        <Show when={g.day}>
                          <h4 class="hib-day">{g.day}</h4>
                        </Show>
                        <ul class="hib-rows" role="list">
                          <For each={g.rows}>{(e) => <Row e={e} />}</For>
                        </ul>
                      </>
                    )}
                  </For>
                  <p class="hib-keys hib-faint">
                    <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>↩</kbd> open · <kbd>e</kbd> done · <kbd>u</kbd> unread · <kbd>r</kbd> reply
                  </p>
                </Match>
              </Switch>
            </section>
          }
        >
          {(p) => (
            <div class="hib-thread-wrap">
              <nav class="hib-rail" aria-label="Threads">
                <For each={rail()}>
                  {(x) => (
                    <button
                      type="button"
                      class="hib-rail-btn"
                      classList={{ "hib-rail-btn--on": samePeer(x.peer, p()) }}
                      title={x.peer}
                      aria-label={`${x.peer}${x.unread ? `, ${x.unread} unread` : ""}`}
                      onClick={() => setPeer(x.peer)}
                    >
                      <Avatar name={x.peer} />
                      <Show when={x.unread > 0}>
                        <i class="hib-rail-dot" />
                      </Show>
                    </button>
                  )}
                </For>
              </nav>
              <article class="hib-read" aria-live="polite">
                <header class="hib-thead">
                  <button type="button" class="hib-back" onClick={back} title="Back to the list (Esc)">
                    <Ic name="arrow-left" />
                    <span class="hib-sr">Inbox</span>
                  </button>
                  <Avatar name={p()} />
                  <div class="hib-thead-main">
                    <b class="hib-title">{p()}</b>
                    <span class="hib-faint">
                      <span class="hsc-num">{thread().length}</span> {thread().length === 1 ? "message" : "messages"} · this machine
                    </span>
                  </div>
                </header>

                <ol class="hib-msgs">
                  <For each={groupByDay(thread(), (x) => (x.at ? new Date(x.at).toISOString() : undefined), now())}>
                    {(g) => (
                      <>
                        <li class="hib-day hib-day--thread">{g.day}</li>
                        <For each={g.rows}>
                          {(x) => (
                            <Switch>
                              <Match when={x.dir === "in" && x}>
                                {(xi) => {
                                  const r = () => (xi() as Extract<typeof x, { dir: "in" }>).row
                                  const m = () => bodyOf(r())
                                  const err = () => {
                                    const b = bodies()[keyOf(r())]
                                    return b && b !== "loading" && "error" in b ? b.error : undefined
                                  }
                                  return (
                                    <li class="hib-msg" classList={{ "hib-msg--done": !!r().done, "hib-msg--sel": selected() === keyOf(r()) }} data-key={keyOf(r())}>
                                      <div class="hib-meta">
                                        <span class="hib-from">{r().from}</span>
                                        <Kind row={r()} />
                                        <span class="hsc-spacer" />
                                        <span class="hsc-num hib-faint" title={r().receivedAt}>
                                          {fullTime(r().receivedAt)}
                                        </span>
                                      </div>
                                      <Show when={m()} fallback={<p class="hib-subj">{err() ? `Could not open — ${err()}` : subjectOf(r())}</p>}>
                                        {(mm) => (
                                          <>
                                            <Show when={mm().burn}>
                                              <p class="hib-burn">Sent to be read once — it is deleted from this computer once opened.</p>
                                            </Show>
                                            <Show when={mm().url}>
                                              <button type="button" class="hib-link" onClick={() => props.openExternal?.(mm().url!)}>
                                                <Ic name="square-arrow-top-right" />
                                                <span>{mm().url}</span>
                                              </button>
                                            </Show>
                                            <Show when={mm().body}>
                                              <Show
                                                when={bodyHtml(mm().body!)}
                                                fallback={<div class="hib-body hib-body--plain">{mm().body}</div>}
                                              >
                                                {(html) => <div class="hib-body iris-markdown" onClick={onBodyClick} innerHTML={html()} />}
                                              </Show>
                                            </Show>
                                            <Show when={bodyNote(mm())}>
                                              <p class="hib-note">{bodyNote(mm())}</p>
                                            </Show>
                                            <Show when={mm().type === "file"}>
                                              <div class="hib-file">
                                                <span class="hib-file-ext hsc-mono">
                                                  {(mm().originalName ?? "file").split(".").pop()?.slice(0, 4).toUpperCase()}
                                                </span>
                                                <span class="hib-file-name">{mm().originalName ?? mm().file}</span>
                                                <Show when={mm().sizeBytes !== undefined}>
                                                  <span class="hsc-num hib-faint">{fmtBytes(mm().sizeBytes!)}</span>
                                                </Show>
                                              </div>
                                            </Show>
                                            <Show when={mm().result}>
                                              <pre class="hib-pre hsc-mono">{mm().result}</pre>
                                            </Show>
                                          </>
                                        )}
                                      </Show>
                                      <Show when={r().item}>
                                        <div class="hib-card">
                                          <span class="hib-card-tag">atlas</span>
                                          <span class="hsc-num">{cardLabel(r().item)}</span>
                                          <Show when={r().status}>
                                            <span class="hib-card-status" data-status={r().status}>
                                              {r().status}
                                            </span>
                                          </Show>
                                        </div>
                                      </Show>
                                      <div class="hib-acts">
                                        <button type="button" class="hib-chipbtn" onClick={() => toggleDone(r())}>
                                          {r().done ? "Not done" : r().item ? `Done · close ${cardLabel(r().item)}` : "Done"}
                                        </button>
                                        <button type="button" class="hib-chipbtn" onClick={() => toggleRead(r())}>
                                          {r().read ? "Mark unread" : "Mark read"}
                                        </button>
                                        <Show when={r().done}>
                                          <span class="hib-faint">done {shortAge(r().doneAt, now())}</span>
                                        </Show>
                                      </div>
                                      <Show when={m()}>
                                        {(mm) => (
                                          <details class="hib-dev">
                                            <summary>For developers</summary>
                                            <div class="hib-dev-row">
                                              <code class="hsc-mono">{inboxCli(mm())}</code>
                                              <button type="button" class="hib-ib" title="Copy CLI command" onClick={() => void copyCli(mm())}>
                                                <Ic name={copied() ? "check" : "copy"} />
                                              </button>
                                            </div>
                                          </details>
                                        )}
                                      </Show>
                                    </li>
                                  )
                                }}
                              </Match>
                              <Match when={x.dir === "out" && x}>
                                {(xo) => {
                                  const s = () => (xo() as Extract<typeof x, { dir: "out" }>).sent
                                  return (
                                    <li class="hib-msg hib-msg--out">
                                      <div class="hib-meta">
                                        <span class="hib-from">You</span>
                                        <span class="hsc-spacer" />
                                        <span class="hsc-num hib-faint">{fullTime(s().sentAt)}</span>
                                      </div>
                                      <div class="hib-body hib-body--plain">{s().text}</div>
                                      <span class="hib-state" title="The server accepted it. Whether their computer has it yet, IRIS cannot see.">
                                        {sentState(s())}
                                      </span>
                                    </li>
                                  )
                                }}
                              </Match>
                            </Switch>
                          )}
                        </For>
                      </>
                    )}
                  </For>
                </ol>

                <div class="hib-compose-dock">
                  <Composer to={p()} replyTo={lastIncomingId()} />
                  <p class="hib-faint hib-compose-note">
                    ⌘↩ sends · “accepted by IRIS” means the server has it — not that {p()} has read it.
                  </p>
                </div>
              </article>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
