import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { gb } from "./session/iris-hive-machines-model"
import { ago, diskOf, type HiveNodeRow } from "./session/iris-hive-scripts-model"
import {
  fleetCards,
  fleetHeadline,
  inboxKind,
  restartWords,
  type FleetCard,
  type InboxRow,
  type LocalDaemon,
} from "./dialog-hive-model"
import "./session/iris-hive-scripts.css"
import "./dialog-hive.css"

/**
 * The machines and inbox dialogs behind the titlebar pills (#189763).
 *
 * The basics in a dialog — is each computer up, what is wrong, the one press that fixes it —
 * and "Full controls" for everything else, which opens the side panel on Hive. A dialog is the
 * right weight for "is my Hive OK?"; the side panel is the right weight for working in it.
 */

type Fetch = <T>(path: string, init?: RequestInit) => Promise<T>

type HiveList = { measured: boolean; reason?: string; nodes: HiveNodeRow[] }
type LocalState = { measured: boolean; reason?: string; daemon: LocalDaemon }
type RestartState = { measured: boolean; reason?: string; before: number | null; after: number | null; repaired: boolean }

export function DialogHiveFleet(props: { fetchJson: Fetch; onFullControls: (computerId?: string) => void; onChanged?: () => void }) {
  const dialog = useDialog()
  const [tick, setTick] = createSignal(0)
  const [hive, { refetch: refetchHive }] = createResource(tick, () =>
    props.fetchJson<HiveList>("/iris/hive?perPage=200").catch(() => ({ measured: false, reason: "could not reach IRIS", nodes: [] })),
  )
  const [local, { refetch: refetchLocal }] = createResource(tick, () =>
    props.fetchJson<LocalState>("/iris/hive/local").catch(() => null),
  )
  const now = () => Date.now()
  const cards = createMemo(() => fleetCards(hive.latest?.nodes ?? [], local.latest?.daemon, now()))

  const [busy, setBusy] = createSignal<string | null>(null)
  const [said, setSaid] = createSignal<string | null>(null)

  const recheck = async () => {
    setBusy("recheck")
    setSaid(null)
    await Promise.all([refetchHive(), refetchLocal()])
    props.onChanged?.()
    setBusy(null)
    setSaid("Checked just now")
  }

  const restart = async () => {
    setBusy("restart")
    setSaid(null)
    try {
      const r = await props.fetchJson<RestartState>("/iris/hive/local/restart", { method: "POST" })
      setSaid(restartWords(r))
    } catch {
      setSaid("Did not restart — the app could not reach its engine")
    }
    // The hub learns about the restart from the next heartbeat (~30 s); this shows the local half now.
    await Promise.all([refetchHive(), refetchLocal()])
    props.onChanged?.()
    setBusy(null)
  }

  const details = (id?: string) => {
    dialog.close()
    props.onFullControls(id)
  }

  return (
    <Dialog title="Your machines" description={hive.latest ? fleetHeadline(cards()) : "Checking your computers…"} fit>
      <div class="hfd px-6 pb-5" data-component="hive-fleet-dialog">
        <Show when={hive.latest?.measured === false}>
          <p class="hfd-warn">Could not read your computers — {hive.latest?.reason ?? "unknown"}</p>
        </Show>
        <Show when={hive.latest?.measured && !cards().length}>
          <p class="hfd-faint">No computers are linked to this account yet. Run <code>iris hive start</code> on one to add it.</p>
        </Show>
        <ul class="hfd-cards">
          <For each={cards()}>{(c) => <FleetRow card={c} busy={busy()} onRestart={restart} onDetails={() => details(c.id)} />}</For>
        </ul>
        <div class="hfd-foot">
          <Button size="small" variant="secondary" disabled={!!busy()} onClick={() => void recheck()} data-action="hive-recheck">
            {busy() === "recheck" ? "Checking…" : "Re-check now"}
          </Button>
          <span class="hfd-said" role="status">
            {busy() === "restart" ? "Restarting… waiting for the new process" : (said() ?? "")}
          </span>
          <span class="hsc-spacer" />
          <Button size="small" variant="primary" onClick={() => details()} data-action="hive-full-controls">
            Full controls
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function FleetRow(props: { card: FleetCard; busy: string | null; onRestart: () => void; onDetails: () => void }) {
  const c = () => props.card
  const disk = () => diskOf(c())
  return (
    <li class="hfd-card" classList={{ "is-away": !c().online }} data-computer={c().name}>
      <div class="hfd-head">
        <span class="hfd-dot" classList={{ on: c().online }} aria-hidden="true" />
        <b class="hfd-name">{c().name}</b>
        <Show when={c().self}>
          <span class="hfd-tag">this computer</span>
        </Show>
        <Show when={c().regs > 1}>
          <span class="hfd-faint hsc-num" title="Registered more than once — same computer">
            ×{c().regs}
          </span>
        </Show>
        <span class="hsc-spacer" />
        <button type="button" class="hfd-link" onClick={props.onDetails}>
          Details →
        </button>
      </div>
      <div class="hfd-status" data-tone={c().status.tone}>
        {c().status.text}
        <Show when={c().online && c().lastHeartbeat}>
          <span class="hfd-faint"> · checked in {ago(c().lastHeartbeat, Date.now())}</span>
        </Show>
        <Show when={disk()}>
          <span class="hfd-faint hsc-num"> · {gb(disk()!.free)} free</span>
        </Show>
      </div>
      <Show when={c().notes.length}>
        <ul class="hfd-notes">
          <For each={c().notes}>
            {(n) => (
              <li data-level={n.level}>
                <div>
                  <span class="hfd-note">{n.text}</span>
                  <span class="hfd-fix">{n.fix}</span>
                </div>
                <Show when={n.action === "restart" && c().self}>
                  <Button size="small" variant="secondary" disabled={!!props.busy} onClick={props.onRestart} data-action="hive-restart">
                    {props.busy === "restart" ? "Restarting…" : "Restart daemon"}
                  </Button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={c().self && !c().notes.some((n) => n.action === "restart")}>
        <div class="hfd-quiet">
          <button type="button" class="hfd-link" disabled={!!props.busy} onClick={props.onRestart} data-action="hive-restart">
            {props.busy === "restart" ? "Restarting…" : "Restart daemon"}
          </button>
        </div>
      </Show>
    </li>
  )
}

// ── inbox ────────────────────────────────────────────────────────────────────────────────────

type InboxList = { measured: boolean; reason?: string; unread: number | null; unreadable: boolean; items: InboxRow[] }
type Opened = {
  measured: boolean
  reason?: string
  message: {
    index: number
    type: string
    from: string
    receivedAt?: string
    body: string | null
    url: string | null
    file: string | null
    size: number | null
    burned: boolean
  } | null
}

export function DialogHiveInbox(props: {
  fetchJson: Fetch
  onOpenInbox: () => void
  onChanged?: () => void
  openUrl?: (url: string) => void
  openPath?: (path: string) => void
}) {
  const dialog = useDialog()
  const [list, { refetch }] = createResource(() =>
    props.fetchJson<InboxList>("/iris/inbox?perPage=30").catch(() => null),
  )
  const [opened, setOpened] = createSignal<Opened["message"]>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal<number | null>(null)

  const open = async (row: InboxRow) => {
    setError(null)
    setLoading(row.index)
    try {
      const r = await props.fetchJson<Opened>(`/iris/inbox/${row.index}/open`, { method: "POST" })
      if (!r.message) setError(r.reason ?? "Could not open it")
      else setOpened(r.message)
    } catch {
      setError("The app could not reach its engine")
    }
    setLoading(null)
    // Opening marks it read (and a burn message is gone): the list and the pill both change.
    await refetch()
    props.onChanged?.()
  }

  const full = () => {
    dialog.close()
    props.onOpenInbox()
  }

  return (
    <Dialog
      title="Hive messages"
      description={
        list.latest?.unread
          ? `${list.latest.unread} unread · from your computers and the people you work with`
          : "From your computers and the people you work with"
      }
      fit
    >
      <div class="hfd px-6 pb-5" data-component="hive-inbox-dialog">
        <Show
          when={opened()}
          fallback={
            <>
              <Show when={list.latest?.unreadable}>
                <p class="hfd-warn">The inbox file could not be read.</p>
              </Show>
              <Show when={list.latest && !list.latest.unreadable && !list.latest.items.length}>
                <p class="hfd-faint">Nothing here yet. Messages sent to this computer through Hive appear here.</p>
              </Show>
              <Show when={error()}>
                <p class="hfd-warn">{error()}</p>
              </Show>
              <ul class="hfd-inbox">
                <For each={list.latest?.items ?? []}>
                  {(m) => (
                    <li>
                      <button type="button" classList={{ unread: !m.read }} onClick={() => void open(m)} data-inbox-index={m.index}>
                        <span class="hfd-dot" classList={{ on: !m.read }} aria-label={m.read ? "read" : "unread"} />
                        <span class="hfd-msg">
                          <span class="hfd-msg-top">
                            <b>{m.from}</b>
                            <span class="hfd-faint"> · {inboxKind(m.type)}</span>
                            <span class="hsc-spacer" />
                            <span class="hfd-faint hsc-num">{m.receivedAt ? ago(m.receivedAt, Date.now()) : ""}</span>
                          </span>
                          <span class="hfd-msg-label">{loading() === m.index ? "Opening…" : m.label}</span>
                        </span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </>
          }
        >
          {(m) => (
            <div class="hfd-open" data-inbox-open={m().index}>
              <button type="button" class="hfd-link" onClick={() => setOpened(null)}>
                ← All messages
              </button>
              <div class="hfd-msg-top">
                <b>{m().from}</b>
                <span class="hfd-faint"> · {inboxKind(m().type)}</span>
                <span class="hsc-spacer" />
                <span class="hfd-faint hsc-num">{m().receivedAt ? ago(m().receivedAt, Date.now()) : ""}</span>
              </div>
              <Show when={m().body !== null} fallback={<p class="hfd-faint">This one is a file that cannot be shown as text.</p>}>
                <pre class="hfd-body">{m().body}</pre>
              </Show>
              <div class="hfd-foot">
                <Show when={m().url && props.openUrl}>
                  <Button size="small" variant="secondary" onClick={() => props.openUrl!(m().url!)}>
                    Open link
                  </Button>
                </Show>
                <Show when={m().file && props.openPath}>
                  <Button size="small" variant="secondary" onClick={() => props.openPath!(m().file!)}>
                    Open file
                  </Button>
                </Show>
                <Show when={m().burned}>
                  <span class="hfd-said">Burn after reading — it is gone now.</span>
                </Show>
              </div>
            </div>
          )}
        </Show>
        <div class="hfd-foot">
          <span class="hsc-spacer" />
          <Button size="small" variant="primary" onClick={full} data-action="hive-open-inbox">
            Open inbox
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
