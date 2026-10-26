import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { useServerSync } from "@/context/server-sync"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { backgroundRows } from "./background-work-model"
import { bellCount, bellLabel, bellRows, replyPrompt, waitingOnYou, type BellRow, type BellThread } from "./notification-bell-model"
import { hivePillTarget } from "./session/iris-hive-inbox-model"
import { irisInboxVersion, openIrisPanel } from "./session/iris-nav"
import "./notification-bell.css"

/**
 * The bell in the message box's toolbar (#190993). Everything that wants the person's attention, in
 * one quiet place: people waiting on a reply (from their connected mail), work running in the
 * background, and unread Hive messages. "N people need a reply" sends a request that IRIS answers
 * with the question card — who to answer, then a drafted reply for each.
 *
 * Settings > Notifications > Bell turns it off.
 */
export function NotificationBell(props: { onAsk: (text: string) => void }) {
  const server = useServer()
  const platform = usePlatform()
  const serverSync = useServerSync()
  const navigate = useNavigate()
  const params = useParams<{ serverKey?: string; id?: string }>()
  const [open, setOpen] = createSignal(false)
  const [tick, setTick] = createSignal(0)

  const base = createMemo(() => server.current?.http?.url?.replace(/\/$/, ""))
  const get = async <T,>(path: string, fallback: T | undefined): Promise<T | undefined> => {
    try {
      return (await (await (platform.fetch ?? globalThis.fetch)(`${base()}${path}`)).json()) as T
    } catch {
      // A failed poll keeps the last reading; the next tick tries again.
      return fallback
    }
  }

  // Mail is a call to the provider, so it is read every 5 minutes and whenever the bell is opened.
  // The Hive inbox is a local read and follows the titlebar's 30s pace and its read signal.
  onMount(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000)
    onCleanup(() => clearInterval(timer))
  })
  const mailKey = createMemo(() => (base() ? [base()!, Math.floor(tick() / 10)] : undefined))
  const inboxKey = createMemo(() => (base() ? [base()!, tick() * 1000 + irisInboxVersion()] : undefined))
  type Mail = { measured?: boolean; account?: string; threads?: BellThread[] }
  type Inbox = { unread: number | null; from?: string }
  type Key = (string | number)[]
  const [mail, { refetch: refetchMail }] = createResource<Mail | undefined, Key>(mailKey, (_, info) =>
    get<Mail>("/iris/onboarding/mail", info.value),
  )
  const [inbox] = createResource<Inbox | undefined, Key>(inboxKey, (_, info) =>
    get<Inbox>("/iris/inbox?perPage=1", info.value),
  )
  createEffect(() => open() && refetchMail())

  const data = () => serverSync().session.data
  const work = createMemo(() =>
    backgroundRows({
      status: data().session_status,
      working: (id) => data().session_working(id),
      info: (id) => serverSync().session.get(id),
      current: params.id,
      untitled: "New chat",
    }),
  )

  const rows = createMemo(() =>
    bellRows({
      waiting: mail()?.measured ? waitingOnYou(mail()?.threads ?? [], mail()?.account) : [],
      work: work(),
      hiveUnread: inbox()?.unread ?? null,
      hiveFrom: inbox()?.from,
    }),
  )
  const working = createMemo(() => work().length > 0)

  // The bell swings once when the count goes UP — never on load, never on a loop.
  const [swing, setSwing] = createSignal(0)
  let last: number | undefined
  createEffect(() => {
    const n = bellCount(rows())
    if (last !== undefined && n > last) setSwing((s) => s + 1)
    last = n
  })

  const choose = (row: BellRow) => {
    setOpen(false)
    if (row.kind === "reply") return props.onAsk(replyPrompt(row.threads))
    if (row.kind === "hive") return openIrisPanel(hivePillTarget("inbox"))
    const session = serverSync().session.get(row.id)
    navigate(
      params.serverKey
        ? sessionHref(requireServerKey(params.serverKey), row.id)
        : legacySessionHref(session?.directory ?? "", row.id),
    )
  }

  return (
    <NotificationBellView
      rows={rows()}
      working={working()}
      swing={swing()}
      open={open()}
      onOpenChange={setOpen}
      onChoose={choose}
    />
  )
}

/** The bell and its list, from rows alone — what the preview renders and the container feeds. */
export function NotificationBellView(props: {
  rows: BellRow[]
  working: boolean
  /** How many times the count has risen; each rise plays the swing once. */
  swing: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onChoose: (row: BellRow) => void
}) {
  const rows = () => props.rows
  const label = createMemo(() => bellLabel(bellCount(props.rows)))
  const working = () => props.working
  const swing = () => props.swing
  const aria = () => {
    const n = label()
    return n ? `Notifications, ${n} need you` : working() ? "Notifications, work is running" : "Notifications"
  }

  return (
    <MenuV2 gutter={8} modal={false} placement="top-start" open={props.open} onOpenChange={props.onOpenChange}>
      <MenuV2.Trigger
        as="button"
        type="button"
        class="iris-bell"
        data-action="notification-bell"
        data-working={working() ? "" : undefined}
        aria-label={aria()}
        title={aria()}
      >
        {/* Keyed on the count of swings, so each rise remounts the glyph and plays the swing once. */}
        <Show when={swing()} keyed fallback={<BellGlyph />}>
          {(n) => <BellGlyph swing={n > 0} />}
        </Show>
        <Show when={label()}>{(n) => <span class="iris-bell__n">{n()}</span>}</Show>
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content class="iris-bell-panel" aria-label="Notifications">
          <Show when={rows().length > 0} fallback={<div class="iris-bell-panel__empty">You're all caught up</div>}>
            <For each={rows()}>
              {(row, i) => (
                <>
                  <Show when={i() > 0 && rows()[i() - 1].kind !== row.kind}>
                    <MenuV2.Separator />
                  </Show>
                  <MenuV2.Item class="iris-bell-panel__row" data-kind={row.kind} onSelect={() => props.onChoose(row)}>
                    <span class="iris-bell-panel__glyph" aria-hidden="true">
                      <Switch>
                        <Match when={row.kind === "reply"}>
                          <ReplyGlyph />
                        </Match>
                        <Match when={row.kind === "work"}>
                          <span class="iris-bell-panel__arc" />
                          <WorkGlyph />
                        </Match>
                        <Match when={row.kind === "hive"}>
                          <HiveGlyph />
                        </Match>
                      </Switch>
                    </span>
                    <span class="iris-bell-panel__text">
                      <span class="iris-bell-panel__title">{row.title}</span>
                      <Show when={row.sub}>
                        <span class="iris-bell-panel__sub">{row.sub}</span>
                      </Show>
                    </span>
                    <Show when={row.kind === "reply" ? row.faces : undefined}>
                      {(faces) => (
                        <span class="iris-bell-panel__faces" aria-hidden="true">
                          <For each={faces()}>{(f) => <span>{f}</span>}</For>
                        </span>
                      )}
                    </Show>
                  </MenuV2.Item>
                </>
              )}
            </For>
          </Show>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}

// Lucide geometry (ISC), inline like iris-product-icon.tsx.
function BellGlyph(props: { swing?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" class="iris-bell__glyph" data-swing={props.swing ? "" : undefined} aria-hidden="true">
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
    </svg>
  )
}
function ReplyGlyph() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
      <path d="M8 12h.01M12 12h.01M16 12h.01" />
    </svg>
  )
}
function WorkGlyph() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
    </svg>
  )
}
function HiveGlyph() {
  return (
    <svg viewBox="0 0 24 24">
      <rect x="16" y="16" width="6" height="6" rx="1" />
      <rect x="2" y="16" width="6" height="6" rx="1" />
      <rect x="9" y="2" width="6" height="6" rx="1" />
      <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3M12 12V8" />
    </svg>
  )
}
