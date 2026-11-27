import { createSignal, For, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogJoinTeam } from "@/components/session/dialog-join-team"
import { openSharedRoom, sharedFetch, sharedMe, sharedRooms } from "@/components/session/iris-shared-store"
import { ago, initials, liveRooms, previewLine, roomFaces, roomWhen, type HomeScope, type SharedRoom } from "@/components/session/iris-shared-rooms-model"

/**
 * Home, shared with your team (#194307): the chats your teammates share sit next to the ones on
 * this computer. One filter — All · This computer · Shared — and a way to join a team from an
 * invite link. Shared rooms sit in Home's one list, mixed in by time (#194490); opening one opens its tab (#194463).
 */
const SCOPE_KEY = "iris.home.scope"
const ACTIVE_MS = 10 * 60_000

export function readHomeScope(): HomeScope {
  try {
    const v = localStorage.getItem(SCOPE_KEY)
    return v === "local" || v === "shared" ? v : "all"
  } catch {
    return "all"
  }
}

// One filter for all of Home (#194464): the left column sets it, the list follows it.
const [scopeSig, setScopeSig] = createSignal<HomeScope>(readHomeScope())
export const homeScope = scopeSig
export function setHomeScope(next: HomeScope) {
  setScopeSig(next)
  try {
    localStorage.setItem(SCOPE_KEY, next)
  } catch {}
}
export function createHomeScope() {
  return [homeScope, setHomeScope] as const
}

export function joinTeam(dialog: ReturnType<typeof useDialog>) {
  const f = sharedFetch()
  if (!f) return
  dialog.show(() => <DialogJoinTeam doFetch={f} />)
}

/** A shared room's row (#194490): faces, name, the latest line with whose it is, time, unread or working. */
export function HomeSharedRow(props: { room: SharedRoom; now: number }) {
  const faces = () => roomFaces(props.room, 2, sharedMe())
  const a = () => props.room.activity
  const when = () => {
    const at = roomWhen(props.room)
    return at && props.now - Date.parse(at) < 60_000 ? "now" : ago(at, new Date(props.now))
  }
  return (
    <button
      type="button"
      data-component="home-shared-row"
      class={`
        group/session flex h-10 min-w-0 w-full items-center gap-2 rounded-[6px] py-3 pl-3 pr-3 text-left
        text-v2-text-text-muted [font-weight:530] transition-[background-color] duration-[120ms]
        hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none
      `}
      onClick={() => openSharedRoom(props.room.id, props.room.name)}
    >
      <span class="relative flex h-5 w-7 shrink-0 items-center">
        <For each={faces().names}>
          {(name, i) => (
            <span
              class="absolute grid size-5 place-items-center rounded-full font-mono text-[8.5px] leading-none text-v2-text-text-base ring-2 ring-v2-background-bg-base"
              style={{ left: `${i() * 9}px`, "z-index": String(5 - i()), background: `hsl(${hueOf(name)} 55% 86%)` }}
            >
              {initials(name)}
            </span>
          )}
        </For>
      </span>
      <span class="min-w-0 max-w-[45%] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-base">{props.room.name}</span>
      <span class="shrink-0 text-v2-text-text-faint" title="Shared with your team">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-label="shared">
          <circle cx="6" cy="5.5" r="2.25" />
          <path d="M2 13c.4-2.2 2-3.5 4-3.5s3.6 1.3 4 3.5" />
          <circle cx="11.25" cy="6" r="1.75" />
          <path d="M11 9.6c1.5.1 2.6 1.2 3 3" />
        </svg>
      </span>
      <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] [font-weight:440]">
        {previewLine(props.room, sharedMe())}
      </span>
      <span class="shrink-0 font-mono text-[12px] tabular-nums [font-weight:440]">{when()}</span>
      <span class="flex w-5 shrink-0 justify-end">
        <Show
          when={a()?.unread}
          fallback={
            <Show when={a()?.working}>
              <span class="size-2 rounded-full bg-v2-state-fg-success animate-pulse" aria-label="an agent is working" title="An agent is working" />
            </Show>
          }
        >
          <span
            class="min-w-[18px] rounded-full bg-v2-state-fg-success px-1 text-center font-mono text-[11px] leading-[18px] tabular-nums"
            style={{ color: "var(--v2-background-bg-base, #fff)" }}
            aria-label={`${a()!.unread} new`}
          >
            {a()!.unread > 9 ? "9+" : a()!.unread}
          </span>
        </Show>
      </span>
    </button>
  )
}

/** The Shared filter with nothing shared yet: what it is, and how to get in. */
export function HomeSharedEmpty() {
  const dialog = useDialog()
  return (
    <div data-component="home-shared-empty" class="flex flex-col items-start gap-2 px-3 pt-6 pb-16">
      <p class="text-v2-text-text-base [font-weight:530]">Nothing shared with you yet</p>
      <p class="max-w-[46ch] text-[13px] leading-5 text-v2-text-text-muted">
        When a teammate shares a chat with a project you are in, it shows up here — live, as they work. Got an invite link? Join their team.
      </p>
      <Show when={sharedFetch()}>
        <button
          type="button"
          class="mt-1 h-8 rounded-md bg-v2-overlay-simple-overlay-hover px-3 text-[13px] text-v2-text-text-base [font-weight:530]"
          onClick={() => joinTeam(dialog)}
        >
          Join a team…
        </button>
      </Show>
    </div>
  )
}

function hueOf(name: string): number {
  let h = 0
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

/**
 * Home's left column, above Projects (#194464): which chats the list shows, with counts, and joining
 * a team. A filter belongs beside the list it filters, like a mail app's folders — not above it,
 * where it wrapped in a narrow window.
 */
export function HomeChatScopeNav(props: { localCount?: number }) {
  const dialog = useDialog()
  const item = (id: HomeScope, label: string, count?: number, icon?: JSX.Element) => (
    <button
      type="button"
      data-action={`home-scope-${id}`}
      aria-pressed={homeScope() === id}
      data-selected={homeScope() === id ? "" : undefined}
      class={`
        flex h-7 min-w-0 w-full shrink-0 cursor-default items-center gap-2 rounded-[6px] bg-transparent px-1.5 text-left
        text-v2-text-text-muted [font-weight:440] transition-[background-color,color] duration-[120ms]
        hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base
        data-[selected]:bg-v2-background-bg-layer-03 data-[selected]:text-v2-text-text-base
      `}
      onClick={() => setHomeScope(id)}
    >
      <span class="flex size-4 shrink-0 items-center justify-center text-v2-icon-icon-muted">{icon}</span>
      <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
      <Show when={count}>
        <span class="shrink-0 font-mono text-[12px] tabular-nums opacity-70">{count}</span>
      </Show>
    </button>
  )
  const live = () => sharedRooms().filter((r) => r.updatedAt && Date.now() - new Date(r.updatedAt).getTime() < ACTIVE_MS).length
  return (
    <nav data-component="home-chat-scope" aria-label="Show chats" class="flex min-w-0 shrink-0 flex-col gap-1 pr-3">
      <div class="flex h-7 items-center pl-1.5 text-v2-text-text-muted [font-weight:530]">Chats</div>
      {item(
        "all",
        "All chats",
        undefined,
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h7" stroke-linecap="round" /></svg>,
      )}
      {item(
        "local",
        "This computer",
        props.localCount,
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.2" /><path d="M5.5 13.5h5" stroke-linecap="round" /></svg>,
      )}
      {item(
        "shared",
        "Shared with you",
        sharedRooms().length || undefined,
        <span class="relative inline-flex">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true">
            <circle cx="6" cy="5.5" r="2.25" />
            <path d="M2 13c.4-2.2 2-3.5 4-3.5s3.6 1.3 4 3.5" />
            <circle cx="11.25" cy="6" r="1.75" />
            <path d="M11 9.6c1.5.1 2.6 1.2 3 3" />
          </svg>
          <Show when={live() > 0}>
            <span class="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-v2-state-fg-success" aria-label={`${live()} active now`} />
          </Show>
        </span>,
      )}
      <Show when={sharedFetch()}>
        <button
          type="button"
          data-action="home-join-team"
          class="flex h-7 min-w-0 w-full items-center gap-2 rounded-[6px] px-1.5 text-left text-v2-text-text-faint [font-weight:440] hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base"
          onClick={() => joinTeam(dialog)}
        >
          <span class="flex size-4 shrink-0 items-center justify-center text-[14px] leading-none">+</span>
          <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">Join a team…</span>
        </button>
      </Show>
    </nav>
  )
}

/**
 * "Live with your team" (#194490 — option C's cards over option B's list): the rooms where
 * something is happening right now, as cards, above Home's one list. Nothing live, no strip.
 */
export function HomeLiveRooms(props: { now: number }) {
  const live = () => liveRooms(sharedRooms(), sharedMe(), new Date(props.now))
  return (
    <Show when={live().length}>
      <section data-component="home-live-rooms" aria-label="Live with your team" class="relative z-[6] mb-6 flex flex-col gap-2 pt-3 pr-3">
        <div class="flex h-7 items-center justify-between pl-3">
          <span class="text-v2-text-text-muted [font-weight:440]">Live with your team</span>
          <Show when={sharedRooms().length > live().length}>
            <button type="button" class="text-[13px] text-v2-text-text-muted hover:text-v2-text-text-base" onClick={() => setHomeScope("shared")}>
              See all
            </button>
          </Show>
        </div>
        <div class="grid gap-2 pl-1.5" style={{ "grid-template-columns": "repeat(auto-fill, minmax(220px, 1fr))" }}>
          <For each={live()}>{(room) => <HomeLiveCard room={room} now={props.now} />}</For>
        </div>
      </section>
    </Show>
  )
}

function HomeLiveCard(props: { room: SharedRoom; now: number }) {
  const a = () => props.room.activity
  const others = () => (a()?.present ?? []).filter((p) => p.userId !== sharedMe())
  const faces = () => roomFaces(props.room, 3, sharedMe())
  const status = () => {
    if (a()?.working) return { tone: "live", text: "Agent working" }
    if (a()?.unread) return { tone: "new", text: `${a()!.unread} new` }
    if (others().length) return { tone: "here", text: `${others().length} here` }
    return { tone: "quiet", text: ago(roomWhen(props.room), new Date(props.now)) }
  }
  return (
    <button
      type="button"
      data-component="home-live-card"
      class={`
        group flex min-h-[118px] min-w-0 flex-col gap-2 rounded-[10px] border border-v2-border-border-base bg-v2-background-bg-base p-3 text-left
        transition-[background-color,border-color,box-shadow] duration-[120ms]
        hover:border-v2-border-border-muted hover:bg-v2-background-bg-layer-01 focus-visible:outline-none
        focus-visible:[box-shadow:0_0_0_2px_var(--v2-border-border-muted)]
      `}
      onClick={() => openSharedRoom(props.room.id, props.room.name)}
    >
      <div class="flex min-w-0 items-center gap-2">
        <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-base [font-weight:530]">{props.room.name}</span>
        <span
          class="flex shrink-0 items-center gap-1 text-[12px] [font-weight:530]"
          classList={{
            "text-v2-state-fg-success": status().tone === "live" || status().tone === "new" || status().tone === "here",
            "text-v2-text-text-faint font-mono": status().tone === "quiet",
          }}
        >
          <Show when={status().tone === "live"}>
            <span class="size-1.5 rounded-full bg-v2-state-fg-success animate-pulse" aria-hidden="true" />
          </Show>
          {status().text}
        </span>
      </div>
      <div class="flex min-w-0 items-center gap-2">
        <span class="relative flex h-6 shrink-0 items-center" style={{ width: `${18 + faces().names.length * 12}px` }}>
          <For each={faces().names}>
            {(name, i) => (
              <span
                class="absolute grid size-6 place-items-center rounded-full font-mono text-[9px] leading-none text-v2-text-text-base ring-2 ring-v2-background-bg-base"
                style={{ left: `${i() * 12}px`, "z-index": String(5 - i()), background: `hsl(${hueOf(name)} 55% 86%)` }}
              >
                {initials(name)}
              </span>
            )}
          </For>
        </span>
        <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-v2-text-text-muted">
          {props.room.project?.name ?? (props.room.you.isOwner ? "Your room" : `${props.room.ownerName ?? "Someone"}'s room`)}
        </span>
      </div>
      <p class="line-clamp-2 min-w-0 text-[13px] leading-[18px] text-v2-text-text-muted [font-weight:440]">{previewLine(props.room, sharedMe())}</p>
    </button>
  )
}
