import { createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { useTitlebarRightMount } from "./titlebar"

/**
 * Two pills in the titlebar: how many machines are up, and whether anything is waiting for you.
 *
 * WHY CHROME AND NOT A TAB. From the TUI sidebar's own source: "On 2026-09-11 four messages
 * that changed what a client's agent was building sat unread until someone said 'run iris hive
 * inbox read' out loud on a call." That was a visibility failure, and a tab you have to click
 * is the same failure with a mouse. These sit where you are already looking, cost ~88px, and
 * are `shrink-0` so the session tabs give way first — which is the right priority.
 *
 * WHY A DASH IS NOT A ZERO. `● —` means we could not measure. `● 0/4` would mean we measured
 * and the fleet is down. Those are different facts and only one of them should send someone to
 * go check a machine. The same rule the sidecar enforces in its wire format.
 */

interface HiveState {
  measured: boolean
  reason?: string
  nodes: { online: boolean }[]
}
interface InboxState {
  unread: number | null
  unreadable: boolean
}

/** How the fleet pill reads. Pure so the "never show zero for unmeasured" rule is testable. */
export function fleetLabel(hive: HiveState | undefined): string {
  if (!hive || !hive.measured) return "—"
  return `${hive.nodes.filter((n) => n.online).length}/${hive.nodes.length}`
}

/** How the inbox pill reads. Null unread is not zero; zero is simply not shown. */
export function inboxLabel(inbox: InboxState | undefined): string | null {
  if (!inbox) return null
  if (inbox.unreadable || inbox.unread === null) return "—"
  return inbox.unread > 0 ? String(inbox.unread) : null
}

export function TitlebarIrisPills() {
  const mount = useTitlebarRightMount()
  const server = useServer()
  const platform = usePlatform()

  const base = createMemo(() => server.current?.http?.url?.replace(/\/$/, ""))
  const [tick, setTick] = createSignal(0)

  // The fleet heartbeats about every 30s and the inbox is a local file, so a slower poll would
  // show the same numbers and a faster one would only cost requests.
  onMount(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000)
    onCleanup(() => clearInterval(timer))
  })

  const key = createMemo(() => {
    const b = base()
    return b ? ([b, tick()] as const) : undefined
  })

  const doFetch = (path: string) => (platform.fetch ?? globalThis.fetch)(`${base()}${path}`)

  const [hive] = createResource(key, async () => (await (await doFetch("/iris/hive")).json()) as HiveState)
  const [inbox] = createResource(key, async () => (await (await doFetch("/iris/inbox")).json()) as InboxState)

  const unread = createMemo(() => inboxLabel(inbox()))

  return (
    <Show when={mount()}>
      <Portal mount={mount()!}>
        <div class="flex shrink-0 items-center gap-2 mr-3 text-[11px] tabular-nums text-v2-text-text-weak">
          <span title={hive()?.measured === false ? `Fleet unreachable — ${hive()?.reason ?? "unknown"}` : "Hive machines online"}>
            <span class="mr-1" classList={{ "text-v2-icon-icon-accent": (hive()?.nodes?.some((n) => n.online) ?? false) }}>
              ●
            </span>
            {fleetLabel(hive())}
          </span>
          {/* Absent when there is nothing waiting. A permanent "0" is furniture; a number that
              appears is a signal. */}
          <Show when={unread()}>
            <span title="Unread Hive messages — iris hive inbox read">✉ {unread()}</span>
          </Show>
        </div>
      </Portal>
    </Show>
  )
}
