import {
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  type ResourceFetcherInfo,
} from "solid-js"
import { Portal } from "solid-js/web"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
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
  nodes: { online: boolean; name: string }[]
}
interface InboxState {
  unread: number | null
  unreadable: boolean
  from?: string
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

/** How the fleet pill reads.
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

/**
 * The dot's colour, as a state machine — not a bare boolean around one accent class.
 *
 * THREE visuals, matching fleetLabel's three facts: green when we measured and something is
 * up, danger when measured:false (the fleet said so, with a reason), and the muted default
 * while loading or before a measurement. A not-yet-fetched fleet must not wear green: that is
 * the not-yet-measured-as-verdict bug this file already caught once (see above).
 */
export function fleetDotClass(hive: HiveState | undefined, loading = false): string {
  if (loading && !hive) return "text-v2-text-text-weak"
  if (!hive || !hive.measured) return "text-v2-text-text-danger"
  return hive.nodes.some((n) => n.online) ? "text-v2-state-fg-success" : "text-v2-text-text-weak"
}

/** How the inbox pill reads. Null unread is not zero; zero is simply not shown. */
export function inboxLabel(inbox: InboxState | undefined, loading = false): string | null {
  // Nothing at all while loading: the inbox pill's resting state is already absent, so there is
  // no placeholder to get wrong. Only a resolved unreadable manifest earns a dash.
  if (loading || !inbox) return null
  if (inbox.unreadable || inbox.unread === null) return "—"
  return inbox.unread > 0 ? String(inbox.unread) : null
}

interface PlanState {
  measured: boolean
  plan: string | null
  upgradeUrl: string | null
}

/** Where "Upgrade" goes when the server names no URL. Same page the limit dialog sends people to. */
export const TITLEBAR_UPGRADE_URL = "https://web.heyiris.io/pricing?source=desktop-titlebar"

/**
 * What the plan slot shows, decided from the server's answer and nothing else.
 *
 * Unmeasured shows NOTHING, never "Upgrade": a sidecar that cannot reach the API must not tell a
 * paying customer to buy what they already have. Staff (plan null) see nothing either.
 */
export function planBadge(
  state: PlanState | undefined,
): { kind: "upgrade" | "label"; text: string; url: string } | null {
  if (!state?.measured) return null
  const url = state.upgradeUrl || TITLEBAR_UPGRADE_URL
  switch (state.plan) {
    case "free":
    case "starter":
      return { kind: "upgrade", text: "Upgrade", url }
    case "pro":
      return { kind: "label", text: "Pro", url }
    case "business":
      return { kind: "label", text: "Business", url }
    default:
      return null
  }
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

  // These poll every 30s from OUTSIDE the session's error boundary, so a rejected fetch (sidecar
  // restarting, Windows resuming from sleep) used to throw straight to app.tsx and replace the whole
  // window with the error page. A failed poll keeps the last reading; the next tick tries again.
  type Key = readonly [string, number]
  const poll =
    <T,>(path: string) =>
    async (_: Key, info: ResourceFetcherInfo<T | undefined>): Promise<T | undefined> => {
      try {
        return (await (await doFetch(path)).json()) as T
      } catch {
        return info.value
      }
    }

  const [hive] = createResource<HiveState | undefined, Key>(key, poll<HiveState>("/iris/hive"))
  const [inbox] = createResource<InboxState | undefined, Key>(key, poll<InboxState>("/iris/inbox"))
  const [auth] = createResource<AuthState | undefined, Key>(key, poll<AuthState>("/iris/auth"))

  // The plan changes when someone buys, not every 30s: ask every 10 minutes (20 ticks). /iris/plan
  // peeks — it never consumes the weekly allowance notice, unlike /iris/allowance.
  const planKey = createMemo(() => {
    const b = base()
    return b ? ([b, Math.floor(tick() / 20)] as const) : undefined
  })
  const [plan] = createResource<PlanState | undefined, Key>(planKey, poll<PlanState>("/iris/plan"))
  const badge = createMemo(() => planBadge(plan()))

  const notice = createMemo(() => authNotice(auth()))

  const unread = createMemo(() => inboxLabel(inbox(), inbox.loading))

  /**
   * Fleet hover panel, not a tooltip.
   *
   * A one-line tooltip left the per-machine state invisible (which machine is down?) — the
   * whole point of a fleet count. The panel opens on hover (and toggle/click for keyboard),
   * lists the SAME nodes the pill already fetched, and dismisses on mouse-leave; it does not
   * flicker across the 30s refetch because the resource's latest is kept through reloads.
   * Hover-only disclosure on a focusable pill: focus/click are equivalent entrances.
   */
  const [fleetOpen, setFleetOpen] = createSignal(false)

  return (
    <Show when={mount()}>
      <Portal mount={mount()!}>
        <div
          data-slot="iris-pills"
          class="flex shrink-0 items-center gap-2 mr-3 text-[11px] tabular-nums text-v2-text-text-weak"
        >
          {/* Real tooltips, not the `title` attribute. A native tooltip takes about a second to
              appear, cannot be styled, and is the reason these pills read as decoration: there
              was no way to find out what "3/4" counted without asking someone. */}
          <div data-slot="iris-fleet-wrap" class="relative">
            <span
              data-slot="iris-fleet-pill"
              class="cursor-pointer"
              tabIndex={0}
              role="button"
              onMouseEnter={() => setFleetOpen(true)}
              onMouseLeave={() => setFleetOpen(false)}
              onFocus={() => setFleetOpen(true)}
              onBlur={() => setFleetOpen(false)}
              onClick={() => setFleetOpen((v) => !v)}
            >
              <span
                class="mr-1"
                data-slot="iris-fleet-dot"
                classList={{ [fleetDotClass(hive(), hive.loading)]: true, "animate-pulse": hive()?.measured === false }}
              >
                ●
              </span>
              {fleetLabel(hive(), hive.loading)}
            </span>
            <Show when={fleetOpen()}>
              <div
                data-slot="iris-fleet-panel"
                class="absolute right-0 top-full z-50 mt-1 min-w-56 rounded-lg border border-v2-border-border-base bg-v2-background-bg-deep p-2 shadow-lg"
              >
                <Switch fallback={<div class="px-2 py-1 text-v2-text-text-weak">Hive machines online</div>}>
                  <Match when={hive()?.measured === false}>
                    <div class="px-2 py-1 text-v2-state-fg-danger">
                      Fleet unreachable — {hive()?.reason ?? "unknown"}
                    </div>
                  </Match>
                  <Match when={hive.loading && !hive.latest}>
                    <div class="px-2 py-1 text-v2-text-text-weak">Checking the fleet…</div>
                  </Match>
                  <Match when={hive()?.measured}>
                    <Show
                      when={(hive()!.nodes?.length ?? 0) > 0}
                      fallback={<div class="px-2 py-1 text-v2-text-text-weak">No machines linked</div>}
                    >
                      <ul class="flex flex-col">
                        <For each={hive()!.nodes}>
                          {(n) => (
                            <li
                              data-slot="iris-fleet-node"
                              class="flex items-center justify-between gap-3 rounded px-2 py-1 text-v2-text-text-base"
                            >
                              <span class="truncate min-w-0">{n.name}</span>
                              <span
                                class="shrink-0 tabular-nums"
                                classList={{
                                  "text-v2-state-fg-success": n.online,
                                  "text-v2-text-text-weak": !n.online,
                                }}
                              >
                                {n.online ? "●" : "—"}
                              </span>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </Match>
                </Switch>
              </div>
            </Show>
          </div>

          <Show when={badge()}>
            {(b) => (
              <TooltipV2
                placement="bottom"
                value={
                  <>
                    {b().kind === "upgrade"
                      ? "See IRIS plans: IRIS Pro, Genesis Designer and higher limits"
                      : `You're on IRIS ${b().text}. See plans and billing`}
                  </>
                }
              >
                <button
                  type="button"
                  data-slot="iris-plan-pill"
                  class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 transition-colors"
                  classList={{
                    "bg-v2-icon-icon-accent/20 text-v2-icon-icon-accent hover:bg-v2-icon-icon-accent/30":
                      b().kind === "upgrade",
                    "text-v2-text-text-weak hover:text-v2-text-text-base": b().kind === "label",
                  }}
                  onClick={() => platform.openExternal(b().url)}
                >
                  {b().text}
                </button>
              </TooltipV2>
            )}
          </Show>

          <Show when={notice()}>
            <TooltipV2 placement="bottom" value={<>{notice()!.hint}</>}>
              <span data-slot="iris-auth-pill" class="text-v2-text-text-danger cursor-default">
                ⚠ {notice()!.text}
              </span>
            </TooltipV2>
          </Show>

          <Show when={unread()}>
            <TooltipV2
              placement="bottom"
              value={
                <>
                  {unread()} unread Hive {unread() === "1" ? "message" : "messages"}
                  {inbox()?.from ? ` · latest from ${inbox()!.from}` : ""} · read them with: iris hive inbox read
                </>
              }
            >
              <span data-slot="iris-inbox-pill" class="cursor-default">
                ✉ {unread()}
              </span>
            </TooltipV2>
          </Show>
        </div>
      </Portal>
    </Show>
  )
}
