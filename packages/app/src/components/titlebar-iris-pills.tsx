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
interface AuthState {
  signedIn: boolean
  source: string
  providerCanSee: boolean
  verdict: "ready" | "signed-out" | "unreachable-credential"
}

/**
 * What to SAY about a broken credential — and it is two different sentences, because it is two
 * different problems and one of them is not a login problem at all.
 *
 * The failure this exists for: a machine with a valid key in its auth store sent a message and
 * got "Unauthorized: Provide a Bearer token in the Authorization header" printed raw into the
 * transcript, with nothing offering a sign-in. Answering "are you signed in?" would have said
 * YES and explained nothing. Telling that person to log in again would have "fixed" nothing
 * and cost them ten minutes.
 */
export function authNotice(auth: AuthState | undefined): { text: string; hint: string } | null {
  if (!auth || auth.verdict === "ready") return null
  if (auth.verdict === "signed-out") {
    return { text: "Sign in", hint: "Not signed in — run: iris auth login" }
  }
  return {
    text: "Key unreachable",
    hint: `Signed in via ${auth.source}, but the AI provider reads IRIS_API_KEY from the environment and it is unset. Signing in again will not help.`,
  }
}

/**
 * How the fleet pill reads.
 *
 * THREE states, not two — and the third is the one I got wrong and a browser caught.
 * `fleetLabel` used to return "—" both while the first fetch was in flight and when it had
 * failed, so for the first second of every launch the pill claimed the fleet was unreachable.
 * It is the same mistake this whole change set is built to avoid, made one level down: a
 * not-yet-measured value rendered as a measured verdict. Two consecutive e2e runs disagreed —
 * "●3/4" then "●—" — which is exactly how an intermittent-looking bug announces a real one.
 */
export function fleetLabel(hive: HiveState | undefined, loading = false): string {
  if (loading && !hive) return "·"
  if (!hive || !hive.measured) return "—"
  return `${hive.nodes.filter((n) => n.online).length}/${hive.nodes.length}`
}

/** How the inbox pill reads. Null unread is not zero; zero is simply not shown. */
export function inboxLabel(inbox: InboxState | undefined, loading = false): string | null {
  // Nothing at all while loading: the inbox pill's resting state is already absent, so there is
  // no placeholder to get wrong. Only a resolved unreadable manifest earns a dash.
  if (loading || !inbox) return null
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
  const [auth] = createResource(key, async () => (await (await doFetch("/iris/auth")).json()) as AuthState)

  const notice = createMemo(() => authNotice(auth()))

  const unread = createMemo(() => inboxLabel(inbox(), inbox.loading))

  return (
    <Show when={mount()}>
      <Portal mount={mount()!}>
        <div data-slot="iris-pills" class="flex shrink-0 items-center gap-2 mr-3 text-[11px] tabular-nums text-v2-text-text-weak">
          <span data-slot="iris-fleet-pill" title={hive()?.measured === false ? `Fleet unreachable — ${hive()?.reason ?? "unknown"}` : "Hive machines online"}>
            <span class="mr-1" classList={{ "text-v2-icon-icon-accent": (hive()?.nodes?.some((n) => n.online) ?? false) }}>
              ●
            </span>
            {fleetLabel(hive(), hive.loading)}
          </span>
          {/* The credential warning outranks everything else here: a fleet count is useless
              information if the app cannot talk to its API at all. Shown as a word, not an
              icon, because the whole failure was that nothing said what was wrong. */}
          <Show when={notice()}>
            <span data-slot="iris-auth-pill" class="text-v2-text-text-danger" title={notice()!.hint}>
              ⚠ {notice()!.text}
            </span>
          </Show>
          {/* Absent when there is nothing waiting. A permanent "0" is furniture; a number that
              appears is a signal. */}
          <Show when={unread()}>
            <span data-slot="iris-inbox-pill" title="Unread Hive messages — iris hive inbox read">✉ {unread()}</span>
          </Show>
        </div>
      </Portal>
    </Show>
  )
}
