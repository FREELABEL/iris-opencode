import { IconButton } from "@opencode-ai/ui/icon-button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from "solid-js"
import { DialogUpgrade } from "@/components/dialog-upgrade"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { glowDurations, useSettings } from "@/context/settings"
import { allowanceDockState, type AllowancePlan } from "./allowance-dock-state"
import { allowanceRefusal, setAllowanceDockShown } from "./allowance-events"
import { BackgroundWorkMenu } from "@/components/background-work-menu"
import { trackPromptedOnce } from "@/utils/upgrade-funnel"

/**
 * The allowance bar above the composer (#190087, Alex 2026-10-20: "just like the tasks bar").
 * Only from 90% of the allowance. Collapsed it is one line — where you stand, and Upgrade; open it
 * shows the meter, the reset and the plans. Out of allowance it wears the GOLD glow the composer
 * already uses for "IRIS is paused on you", because that is what it means. /iris/plan peeks: asking
 * never spends the weekly notice.
 */
export function SessionAllowanceDock() {
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const settings = useSettings()
  const base = createMemo(() => server.current?.http?.url?.replace(/\/$/, ""))
  const doFetch = (path: string, init?: RequestInit) => (platform.fetch ?? globalThis.fetch)(`${base()}${path}`, init)
  const [tick, setTick] = createSignal(0)
  onMount(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 60_000)
    onCleanup(() => clearInterval(timer))
  })
  const [plan] = createResource(
    () => (base() ? [base(), tick()] : undefined),
    async () => {
      try {
        return (await (await doFetch("/iris/plan")).json()) as AllowancePlan
      } catch {
        return undefined
      }
    },
  )
  // Never suspend (#191772). This dock remounts every time an approval or question card closes
  // (the composer is swapped out while IRIS waits on you), and reading a resource that has not
  // resolved yet — `plan()` or `plan.latest` alike — hands the whole chat to the nearest
  // <Suspense>, whose fallback is an empty column: the chat went black until /iris/plan answered.
  // Until the first answer there is simply no bar.
  const state = createMemo(() =>
    allowanceDockState(plan.state === "ready" || plan.state === "refreshing" ? plan.latest : undefined),
  )
  const [open, setOpen] = createSignal(false)
  createEffect(() => setAllowanceDockShown(!!state()))
  onCleanup(() => setAllowanceDockShown(false))
  // A FOLDER TAB tucked behind the composer, like the todos bar (Alex, 2026-10-20: "it works as a
  // family rather than a competing object"). The floating card was the alternative.
  const tab = () => true
  // The API refused a message: open the tab with the upgrade, and re-read the allowance now
  // rather than at the next poll (#190087).
  createEffect(
    on(
      () => allowanceRefusal()?.count,
      (count) => {
        if (!count) return
        setTick((t) => t + 1)
        setOpen(true)
        trackPromptedOnce(doFetch, "refused")
      },
      { defer: true },
    ),
  )
  const upgrade = (event?: MouseEvent) => {
    event?.stopPropagation()
    dialog.show(() => (
      <DialogUpgrade
        source="dock"
        fetchJson={async <T,>(path: string, init?: RequestInit) => (await (await doFetch(path, init)).json()) as T}
      />
    ))
  }

  return (
    <Show when={state()}>
      {(s) => (
        <div
          class="iris-glow relative z-0"
          classList={{ "mb-3": !tab(), "-mb-[18px]": tab() }}
          style={{
            "border-radius": tab() ? "12px 12px 0 0" : "12px",
            "--iris-glow-ring": `${(glowDurations[settings.glow.speed()] ?? glowDurations.normal)[0]}s`,
          }}
          data-thin=""
          data-tab={tab() ? "" : undefined}
          data-wait={s().tone === "out" && settings.glow.ring() ? "" : undefined}
          data-halo={s().tone === "out" && settings.glow.halo() ? "" : undefined}
          data-still={settings.glow.reduceMotion() ? "" : undefined}
        >
          <div
            data-component="session-allowance-dock"
            data-tone={s().tone}
            class="w-full overflow-hidden border-[0.5px] border-v2-border-border-base bg-v2-background-bg-layer-01"
            classList={{ "rounded-xl": !tab(), "rounded-t-xl border-b-0 pb-[18px]": tab() }}
          >
            <div
              data-action="session-allowance-toggle"
              class="flex h-[42px] items-center gap-2 pl-4 pr-2"
              role="button"
              tabIndex={0}
              aria-expanded={open()}
              onClick={() => setOpen((v) => !v)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return
                event.preventDefault()
                setOpen((v) => !v)
              }}
            >
              <span
                aria-hidden="true"
                class="inline-block h-2 w-2 shrink-0 rounded-full"
                classList={{
                  "bg-v2-state-fg-danger": s().tone === "out",
                  "bg-v2-state-fg-warning": s().tone !== "out",
                }}
              />
              <span class="min-w-0 flex-1 truncate font-[440] text-[13px] leading-5 tracking-[-0.04px] text-v2-text-text-muted">
                {s().title}
              </span>
              <Show when={settings.glow.background()}>
                <span class="flex min-w-0 shrink" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                  <BackgroundWorkMenu inline />
                </span>
              </Show>
              <button
                type="button"
                data-action="session-allowance-upgrade"
                class="h-7 shrink-0 rounded-md px-3 text-[12px] font-semibold text-white transition-opacity hover:opacity-90"
                style={{ background: "linear-gradient(90deg, #9333ea, #2563eb)" }}
                onClick={upgrade}
              >
                Upgrade
              </button>
              <IconButton
                icon="chevron-down"
                style={{ transform: `rotate(${open() ? 0 : 180}deg)`, transition: "transform 200ms" }}
                variant="ghost"
                size="small"
                aria-label={open() ? "Collapse" : "Expand"}
                onClick={(event: MouseEvent) => {
                  event.stopPropagation()
                  setOpen((v) => !v)
                }}
              />
            </div>
            <Show when={open()}>
              <div class="flex flex-col gap-2 px-4 pb-3">
                <div
                  class="h-1.5 w-full overflow-hidden rounded-full bg-v2-border-border-base"
                  role="meter"
                  aria-label="Allowance used this week"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={s().percent}
                >
                  <div
                    class="h-full rounded-full"
                    style={{ width: `${s().percent}%`, "background-image": "linear-gradient(90deg, #f59e0b, #facc15)" }}
                  />
                </div>
                <div class="flex flex-wrap items-center justify-between gap-2 text-[12px] text-v2-text-text-weak">
                  <span>
                    {s().tone === "out"
                      ? "Your chats and agents pause until the allowance resets — or upgrade to keep going now."
                      : "You'll pause when it runs out. Upgrade for 5x or 20x compute."}
                    {s().resets ? ` ${s().resets}.` : ""}
                  </span>
                  <span class="font-mono tabular-nums">Solo $29 · 5x · Pro $199 · 20x</span>
                </div>
              </div>
            </Show>
          </div>
        </div>
      )}
    </Show>
  )
}
