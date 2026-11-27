import { createSignal, For, onCleanup, Show, type Accessor } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogJoinTeam } from "@/components/session/dialog-join-team"
import { openSharedRoom, sharedFetch, sharedRooms } from "@/components/session/iris-shared-store"
import { ago, firstName, homeSharedRows, initials, type HomeScope } from "@/components/session/iris-shared-rooms-model"

/**
 * Home, shared with your team (#194307): the chats your teammates share sit next to the ones on
 * this computer. One filter — All · This computer · Shared — and a way to join a team from an
 * invite link. Opening a shared chat opens it live in the side panel.
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

export function createHomeScope() {
  const [scope, set] = createSignal<HomeScope>(readHomeScope())
  const setScope = (next: HomeScope) => {
    set(next)
    try {
      localStorage.setItem(SCOPE_KEY, next)
    } catch {}
  }
  return [scope, setScope] as const
}

function joinTeam(dialog: ReturnType<typeof useDialog>) {
  const f = sharedFetch()
  if (!f) return
  dialog.show(() => <DialogJoinTeam doFetch={f} />)
}

export function HomeScopeBar(props: { scope: Accessor<HomeScope>; onScope: (s: HomeScope) => void }) {
  const dialog = useDialog()
  const chip = (id: HomeScope, label: string, count?: number) => (
    <button
      type="button"
      data-action={`home-scope-${id}`}
      aria-pressed={props.scope() === id}
      class="h-7 shrink-0 whitespace-nowrap rounded-full px-3 text-[13px] [font-weight:530] transition-colors duration-[120ms]"
      classList={{
        "bg-v2-overlay-simple-overlay-hover text-v2-text-text-base": props.scope() === id,
        "text-v2-text-text-muted hover:text-v2-text-text-base": props.scope() !== id,
      }}
      onClick={() => props.onScope(id)}
    >
      {label}
      <Show when={count}>
        <span class="ml-1.5 font-mono tabular-nums opacity-70">{count}</span>
      </Show>
    </button>
  )
  return (
    <div data-component="home-scope" role="group" aria-label="Show chats" class="flex min-w-0 items-center gap-1 pl-1.5 pr-3 pt-3">
      {chip("all", "All")}
      {chip("local", "This computer")}
      {chip("shared", "Shared", sharedRooms().length || undefined)}
      <Show when={sharedFetch()}>
        <button
          type="button"
          data-action="home-join-team"
          class="ml-auto h-7 min-w-0 truncate whitespace-nowrap rounded-md px-2 text-[13px] text-v2-text-text-muted [font-weight:530] hover:text-v2-text-text-base"
          onClick={() => joinTeam(dialog)}
        >
          Join a team…
        </button>
      </Show>
    </div>
  )
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
