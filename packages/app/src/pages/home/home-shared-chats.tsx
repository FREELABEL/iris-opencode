import { createSignal, For, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogJoinTeam } from "@/components/session/dialog-join-team"
import { openSharedRoom, sharedFetch, sharedRooms } from "@/components/session/iris-shared-store"
import { ago, firstName, homeSharedRows, initials, type HomeScope } from "@/components/session/iris-shared-rooms-model"

/**
 * Home, shared with your team (#194307): the chats your teammates share sit next to the ones on
 * this computer. One filter — All · This computer · Shared — and a way to join a team from an
 * invite link. Opening a shared chat opens it as its own tab, like any chat (#194463).
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

export function HomeSharedChats(props: { scope: Accessor<HomeScope> }) {
  const dialog = useDialog()
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(tick))
  const rows = () => homeSharedRows(sharedRooms())

  return (
    <Show
      when={rows().length > 0}
      fallback={
        <Show when={props.scope() === "shared"}>
          <div data-component="home-shared-empty" class="flex flex-col items-start gap-2 px-3 pt-6 pb-16">
            <p class="text-v2-text-text-base [font-weight:530]">Nothing shared with you yet</p>
            <p class="max-w-[46ch] text-[13px] leading-5 text-v2-text-text-muted">
              When a teammate shares a chat with a project you are in, it shows up here — live, as they work. Got an
              invite link? Join their team.
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
        </Show>
      }
    >
      <div data-component="home-shared-chats" class="flex flex-col pt-3 pr-3" classList={{ "pb-16": props.scope() === "shared", "mb-3": props.scope() !== "shared" }}>
        <div class="flex h-7 items-center pl-3 text-v2-text-text-muted [font-weight:440]">Shared with your team</div>
        <div class="flex min-w-0 flex-col gap-px pt-4">
          <For each={rows()}>
            {(room) => {
              const live = () => !!room.updatedAt && now() - new Date(room.updatedAt).getTime() < ACTIVE_MS
              return (
                <button
                  type="button"
                  data-component="home-shared-row"
                  class={`
                    flex h-10 min-w-0 w-full items-center gap-2 rounded-[6px] py-3 pl-3 pr-3 text-left
                    text-v2-text-text-muted [font-weight:530] transition-[background-color] duration-[120ms]
                    hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none
                  `}
                  onClick={() => openSharedRoom(room.id)}
                >
                  <span class="relative grid size-6 shrink-0 place-items-center rounded-full bg-v2-overlay-simple-overlay-hover font-mono text-[9.5px] leading-none tracking-[-0.02em] text-v2-text-text-base">
                    {initials(room.ownerName ?? room.name)}
                    <Show when={live()}>
                      <span
                        aria-label="active now"
                        class="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-v2-state-fg-success ring-2 ring-v2-background-bg-base"
                      />
                    </Show>
                  </span>
                  <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-base">{room.name}</span>
                  <span class="min-w-0 shrink overflow-hidden text-ellipsis whitespace-nowrap text-[13px] [font-weight:440]">
                    {room.project?.name ?? ""}
                    <Show when={room.ownerName && !room.you.isOwner}> · {firstName(room.ownerName)}'s</Show>
                  </span>
                  <span class="ml-auto shrink-0 font-mono text-[12px] tabular-nums [font-weight:440]">
                    {live() ? "live" : ago(room.updatedAt ?? "", new Date(now()))}
                  </span>
                </button>
              )
            }}
          </For>
        </div>
      </div>
    </Show>
  )
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
