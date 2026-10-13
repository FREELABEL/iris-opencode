import { createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import "./iris-hive-scripts.css"
import "./iris-hive-inbox.css"
import { renderMarkdown } from "./iris-item"
import {
  bodyNote,
  fullTime,
  inboxCli,
  inboxRowsOf,
  kindLabel,
  shortAge,
  subjectOf,
  type InboxMessage,
  type InboxRow,
} from "./iris-hive-inbox-model"
import { bumpIrisInbox } from "./iris-nav"

/**
 * Hive › Inbox (#189279).
 *
 * What it replaced: a generic record list whose detail showed from / type / read / received /
 * "manifest position" and a code box saying `iris hive inbox read 1` — everything about the
 * message except the message. This reads like an inbox: newest first, unread marked, and opening
 * one shows its whole text. The CLI command is still there, in the developer drawer.
 */
type IconName = IconProps["name"]
type ListPayload = { measured: boolean; reason?: string | null; unread: number | null; items: InboxRow[] }
type MessagePayload = { measured: boolean; reason?: string | null; message: InboxMessage | null }
type Filter = "all" | "unread"

function Ic(props: { name: IconName; class?: string }) {
  return (
    <span class={`hsc-ic ${props.class ?? ""}`} aria-hidden="true">
      <Icon name={props.name} size="small" />
    </span>
  )
}

/** The sender's initial, as a small mark — a list of machine names scans faster with one. */
const initial = (from: string) => (from.trim()[0] ?? "?").toUpperCase()

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

  const [list, { refetch }] = createResource(() =>
    getJson<ListPayload>("/iris/inbox?perPage=200", undefined, { measured: false, unread: null, items: [] }),
  )
  // New messages are a file the daemon appends to; 20s keeps the list honest without a watcher.
  const timer = setInterval(() => void refetch(), 20_000)
  onCleanup(() => clearInterval(timer))

  const [filter, setFilter] = createSignal<Filter>("all")
  const rows = createMemo(() => {
    const all = inboxRowsOf(list.latest?.items)
    return filter() === "unread" ? all.filter((r) => !r.read) : all
  })
  const unread = createMemo(() => (list.latest?.items ?? []).filter((r) => !r.read).length)

  // The message on screen. Rows are keyed by (index, id): index alone can point at a different
  // message once anything ahead of it is burned or cleared.
  const [openKey, setOpenKey] = createSignal<{ index: number; id?: string } | undefined>()
  const [message] = createResource(openKey, async (k) => {
    const q = k.id ? `?id=${encodeURIComponent(k.id)}` : ""
    const r = await getJson<MessagePayload>(`/iris/inbox/${k.index}${q}`, undefined, { measured: false, message: null })
    // Mark read on open — what `iris hive inbox read` does. The body is already in hand, so a
    // burn-after-read message is still readable here after the sidecar deletes it.
    if (r.message && (!r.message.read || r.message.burn)) {
      void getJson(
        `/iris/inbox/${r.message.index}/read`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.message.id }) },
        { measured: false },
      ).then(() => {
        bumpIrisInbox()
        void refetch()
      })
    }
    return r
  })

  const open = (r: InboxRow) => setOpenKey({ index: r.index, id: r.id })
  const back = () => setOpenKey(undefined)

  const [copied, setCopied] = createSignal(false)
  const copyCli = async (m: InboxMessage) => {
    try {
      await navigator.clipboard.writeText(inboxCli(m))
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {}
  }

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

  return (
    <div class="hsc-wrap">
      <div class="hib">
        <Show
          when={openKey()}
          fallback={
            <section class="hib-list" aria-label="Hive inbox">
              <header class="hib-top">
                <div class="hib-sum">
                  <Show when={list.latest?.measured} fallback={<span>Inbox</span>}>
                    <span>
                      <b class="hsc-num">{unread()}</b> unread
                      <span class="hib-faint">
                        {" "}
                        · <span class="hsc-num">{list.latest!.items.length}</span> total
                      </span>
                    </span>
                  </Show>
                </div>
                <div class="hib-seg" role="tablist" aria-label="Show">
                  <button type="button" role="tab" aria-selected={filter() === "all"} onClick={() => setFilter("all")}>
                    All
                  </button>
                  <button type="button" role="tab" aria-selected={filter() === "unread"} onClick={() => setFilter("unread")}>
                    Unread
                  </button>
                </div>
                <button type="button" class="hib-ib" title="Check for new messages" onClick={() => void refetch()}>
                  <Ic name="reset" />
                </button>
              </header>

              <Show when={list.latest && !list.latest.measured}>
                <p class="hsc-warn">Could not read the inbox{list.latest!.reason ? ` — ${list.latest!.reason}` : ""}</p>
              </Show>
              <Show when={list.latest?.measured && list.latest.reason}>
                <p class="hsc-warn">{list.latest!.reason}</p>
              </Show>

              <Switch>
                <Match when={list.loading && !list.latest}>
                  <p class="hib-empty hib-faint">Reading the inbox…</p>
                </Match>
                <Match when={list.latest?.measured && list.latest.items.length === 0}>
                  <div class="hib-empty">
                    <div class="hib-empty-mark" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M3 13h5l1.5 2.5h5L16 13h5M5 5h14l2 8v6H3v-6l2-8Z" stroke-linejoin="round" />
                      </svg>
                    </div>
                    <b>Your Hive inbox is empty</b>
                    <p>
                      Messages land here when another of your computers, a person you share with, or an agent sends one
                      to this machine — a note, a link, a file, or a handed-off task.
                    </p>
                    <p class="hib-faint">
                      To try it, from another computer: <code class="hsc-mono">iris hive inbox send "hello" --to &lt;this computer&gt;</code>
                    </p>
                  </div>
                </Match>
                <Match when={list.latest?.measured && rows().length === 0}>
                  <p class="hib-empty hib-faint">Nothing unread. You are caught up.</p>
                </Match>
                <Match when={rows().length > 0}>
                  <ul class="hib-rows" role="list">
                    <For each={rows()}>
                      {(r) => (
                        <li>
                          <button
                            type="button"
                            class="hib-row"
                            classList={{ "hib-row--new": !r.read }}
                            title={fullTime(r.receivedAt)}
                            onClick={() => open(r)}
                          >
                            <i class="hib-dot" aria-label={r.read ? undefined : "Unread"} />
                            <span class="hib-av" aria-hidden="true">
                              {initial(r.from)}
                            </span>
                            <span class="hib-main">
                              <span class="hib-line">
                                <span class="hib-from">{r.from}</span>
                                <Show when={r.type !== "message" && r.type !== "text"}>
                                  <span class="hib-kind">{kindLabel(r.type)}</span>
                                </Show>
                                <span class="hsc-spacer" />
                                <span class="hsc-num hib-age">{shortAge(r.receivedAt, now())}</span>
                              </span>
                              <span class="hib-subj">{subjectOf(r)}</span>
                            </span>
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Match>
              </Switch>
            </section>
          }
        >
          <article class="hib-read" aria-live="polite">
            <button type="button" class="hib-back" onClick={back}>
              <Ic name="arrow-left" />
              Inbox
            </button>
            <Switch>
              <Match when={message.loading && !message.latest}>
                <p class="hib-faint">Opening…</p>
              </Match>
              <Match when={message.latest && !message.latest.message}>
                <p class="hsc-warn">Could not open this message{message.latest!.reason ? ` — ${message.latest!.reason}` : ""}</p>
              </Match>
              <Match when={message.latest?.message}>
                {(m) => (
                  <>
                    <header class="hib-head">
                      <h3 class="hib-title">{subjectOf(m())}</h3>
                      <div class="hib-meta">
                        <span class="hib-av" aria-hidden="true">
                          {initial(m().from)}
                        </span>
                        <span class="hib-from">{m().from}</span>
                        <span class="hib-kind">{kindLabel(m().type)}</span>
                        <span class="hsc-spacer" />
                        <span class="hsc-num hib-faint" title={m().receivedAt}>
                          {fullTime(m().receivedAt)}
                        </span>
                      </div>
                      <Show when={m().burn}>
                        <p class="hib-burn">Sent to be read once — it has been deleted from this computer now that you opened it.</p>
                      </Show>
                    </header>

                    <Show when={m().url}>
                      <button type="button" class="hib-link" onClick={() => props.openExternal?.(m().url!)}>
                        <Ic name="square-arrow-top-right" />
                        <span>{m().url}</span>
                      </button>
                    </Show>

                    <Show when={m().item || m().status}>
                      <dl class="hib-facts">
                        <Show when={m().item}>
                          <div>
                            <dt>Work item</dt>
                            <dd class="hsc-mono">{m().item}</dd>
                          </div>
                        </Show>
                        <Show when={m().status}>
                          <div>
                            <dt>Status</dt>
                            <dd data-status={m().status}>{m().status}</dd>
                          </div>
                        </Show>
                      </dl>
                    </Show>

                    <Show when={m().body}>
                      <Show
                        when={bodyHtml(m().body!)}
                        fallback={<div class="hib-body hib-body--plain">{m().body}</div>}
                      >
                        {(html) => <div class="hib-body iris-markdown" onClick={onBodyClick} innerHTML={html()} />}
                      </Show>
                    </Show>
                    <Show when={bodyNote(m())}>
                      <p class="hib-note">{bodyNote(m())}</p>
                    </Show>
                    <Show when={m().result}>
                      <h4 class="hib-h4">Result</h4>
                      <pre class="hib-pre hsc-mono">{m().result}</pre>
                    </Show>

                    <details class="hib-dev">
                      <summary>For developers</summary>
                      <div class="hib-dev-row">
                        <code class="hsc-mono">{inboxCli(m())}</code>
                        <button type="button" class="hib-ib" title="Copy CLI command" onClick={() => void copyCli(m())}>
                          <Ic name={copied() ? "check" : "copy"} />
                        </button>
                      </div>
                      <p class="hsc-mono">
                        position {m().index}
                        {m().id ? ` · id ${m().id}` : ""}
                        {m().file ? ` · ${m().file}` : ""}
                      </p>
                    </details>
                  </>
                )}
              </Match>
            </Switch>
          </article>
        </Show>
      </div>
    </div>
  )
}
