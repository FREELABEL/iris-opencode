import { IconButton } from "@opencode-ai/ui/icon-button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { DialogUpgrade, formatPrice, requestCheckout } from "@/components/dialog-upgrade"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { glowDurations, useSettings } from "@/context/settings"
import { allowanceDockState, outCardState } from "./allowance-dock-state"
import { allowanceRefusal, setAllowanceDockShown } from "./allowance-events"
import { BackgroundWorkMenu } from "@/components/background-work-menu"
import { trackPromptedOnce, trackUpgrade } from "@/utils/upgrade-funnel"
import { irisPlan, refreshIrisPlan, watchIrisPlan } from "@/utils/iris-plan-store"
import { UsageRings } from "@/components/usage/usage-rings"
import { RING_COLOR, packLabel, type Offer } from "@/components/usage/usage-model"
import { loadPacks, type TopupPack } from "@/components/usage/usage-actions"
import { TopupPicker } from "@/components/usage/topup-picker"
import { announceAsk } from "@/components/usage/usage-asks"
import { CTA_GRADIENT } from "@/components/usage/usage-popover"
import { rearmResetReminder, reminderAt, scheduleResetReminder } from "@/components/usage/usage-reminder"

/**
 * The allowance bar above the composer (#190087, Alex 2026-10-20: "just like the tasks bar").
 * Only from 90% of the allowance. Collapsed it is one line — where you stand, and Upgrade; open it
 * shows the meter, the reset and the plans. Out of allowance it wears the GOLD glow the composer
 * already uses for "IRIS is paused on you", because that is what it means. /iris/plan peeks: asking
 * never spends the weekly notice.
 */
export function SessionAllowanceDock(props: {
  /** The chat is mid-turn. At 100% the out card waits for the turn to finish (#194530). */
  busy?: () => boolean
} = {}) {
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const settings = useSettings()
  const base = createMemo(() => server.current?.http?.url?.replace(/\/$/, ""))
  const doFetch = (path: string, init?: RequestInit) => (platform.fetch ?? globalThis.fetch)(`${base()}${path}`, init)
  // The one shared /iris/plan read (epic #194525): the title bar, this tab and the ring agree.
  // A signal, never a resource, so remounting this dock (every approval card swaps the composer out)
  // can never suspend the chat (#191772). Until the first answer there is simply no bar.
  if (base()) watchIrisPlan(doFetch)
  const fetchJson = async <T,>(path: string, init?: RequestInit) => (await (await doFetch(path, init)).json()) as T
  const state = createMemo(() => allowanceDockState(irisPlan()))
  const [open, setOpen] = createSignal(false)
  createEffect(() => setAllowanceDockShown(!!state()))
  onCleanup(() => setAllowanceDockShown(false))
  // A FOLDER TAB tucked behind the composer, like the todos bar (Alex, 2026-10-20: "it works as a
  // family rather than a competing object"). The floating card was the alternative.
  // Inset by the composer's 12px corner radius: at full width the tab's straight sides, and the
  // gold ring round them, showed in the wedges beside the composer's rounded top corners (#191777).
  const tab = () => true
  // The API refused a message: open the tab with the upgrade, and re-read the allowance now
  // rather than at the next poll (#190087).
  createEffect(
    on(
      () => allowanceRefusal()?.count,
      (count) => {
        if (!count) return
        void refreshIrisPlan()
        setOpen(true)
        trackPromptedOnce(doFetch, "refused")
      },
      { defer: true },
    ),
  )
  const upgrade = (event?: MouseEvent) => {
    event?.stopPropagation()
    dialog.show(() => <DialogUpgrade source="dock" usage={irisPlan()} fetchJson={fetchJson} />)
  }

  // THE OUT CARD (#194530). At 100% the tab's content becomes three choices — but never mid-turn:
  // the work in flight finishes first, then the card opens. A refusal means the turn already
  // stopped, so it opens straight away (above).
  const [offers, setOffers] = createSignal<Offer[]>([])
  const [packs, setPacks] = createSignal<TopupPack[]>([])
  const card = createMemo(() => outCardState(irisPlan(), offers()))
  const out = () => state()?.tone === "out"
  createEffect(
    on(out, (isOut) => {
      if (!isOut) return
      void fetchJson<{ measured?: boolean; plans?: Offer[] }>("/iris/plans")
        .then((r) => setOffers(r?.measured && Array.isArray(r.plans) ? r.plans : []))
        .catch(() => undefined)
      void loadPacks(fetchJson).then((r) => "packs" in r && setPacks(r.packs))
    }),
  )
  createEffect(
    on(
      () => out() && !(props.busy?.() ?? false),
      (ready) => {
        if (ready) setOpen(true)
      },
    ),
  )
  createEffect(() => {
    if (out() && open() && card()) announceAsk(doFetch, "out-card", irisPlan(), offers())
  })
  const [picking, setPicking] = createSignal(false)
  const [checkoutError, setCheckoutError] = createSignal<string | null>(null)
  const [checkingOut, setCheckingOut] = createSignal(false)
  const choosePlan = async (slug: string) => {
    if (checkingOut()) return
    setCheckoutError(null)
    setCheckingOut(true)
    trackUpgrade(fetchJson, "upgrade.checkout_started", slug)
    const r = await requestCheckout(fetchJson, slug)
    setCheckingOut(false)
    if ("error" in r) return setCheckoutError(r.error)
    platform.openExternal(r.url)
  }
  // Remind me: a system notification at the reset. Re-armed if the app restarted before it.
  const notify = (title: string, description?: string) => platform.notify(title, description)
  const [reminded, setReminded] = createSignal<string | null>(typeof window === "undefined" ? null : reminderAt())
  onMount(() => setReminded(rearmResetReminder(notify)))
  const canRemind = () => typeof platform.notify === "function"

  return (
    <Show when={state()}>
      {(s) => (
        <div
          class="iris-glow relative z-0"
          classList={{ "mb-3": !tab(), "-mb-[18px] mx-3": tab() }}
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
            <Show when={!(s().tone === "out" && open() && card())} fallback={outCardView()}>
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
                class="h-7 shrink-0 rounded-md bg-surface-brand-base px-3 text-[12px] font-semibold text-text-on-brand-base transition-colors hover:bg-surface-brand-hover"
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
                    class="h-full rounded-full bg-v2-state-fg-warning"
                    style={{ width: `${s().percent}%` }}
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
            </Show>
          </div>
        </div>
      )}
    </Show>
  )

  function outCardView() {
    const c = card()!
    const option = "flex min-w-0 flex-1 flex-col gap-2 rounded-xl border border-v2-border-border-base bg-v2-background-bg-base p-4"
    const secondary =
      "mt-auto h-9 rounded-lg border border-v2-border-border-base px-3 text-[13px] text-v2-text-text-base hover:bg-v2-background-bg-layer-02 disabled:opacity-60"
    return (
      <div data-slot="session-allowance-out" class="flex flex-col gap-3 px-4 pb-3 pt-3.5">
        <div class="flex items-start gap-3">
          <UsageRings size={22} week={1} context={null} color={RING_COLOR.out} class="mt-0.5 shrink-0" />
          <div class="min-w-0 flex-1">
            <div data-slot="session-allowance-out-heading" class="text-[14.5px] font-semibold text-v2-text-text-base">
              {c.heading}
            </div>
            <div class="text-[12.5px] text-v2-text-text-muted">{c.line}</div>
          </div>
          <IconButton
            icon="chevron-down"
            variant="ghost"
            size="small"
            aria-label="Collapse"
            onClick={() => setOpen(false)}
          />
        </div>
        <div class="flex flex-col gap-2 sm:flex-row">
          <Show when={packs().length > 0}>
            <div data-slot="session-allowance-out-topup" class={option}>
              <div class="text-[13.5px] font-semibold">Keep going now</div>
              <div class="text-[12px] text-v2-text-text-muted">
                Add {packLabel(packs()[0]).split(" · ")[0]}. One-time; they never expire, and are only used after your weekly allowance.
              </div>
              <Show
                when={picking()}
                fallback={
                  <button type="button" data-action="session-allowance-topup" class={secondary} onClick={() => setPicking(true)}>
                    + Top up · ${+packs()[0].priceUsd.toFixed(2)}
                  </button>
                }
              >
                <TopupPicker fetchJson={fetchJson} packs={packs()} source="out-card" onOpened={() => setPicking(false)} />
              </Show>
            </div>
          </Show>
          <Show when={c.upgrade}>
            <div
              data-slot="session-allowance-out-plan"
              class={option}
              classList={{ "ring-1 ring-v2-icon-icon-accent": !!c.plan }}
            >
              <Show
                when={c.plan}
                fallback={
                  <>
                    <div class="text-[13.5px] font-semibold">More every week</div>
                    <div class="text-[12px] text-v2-text-text-muted">5x or 20x the compute, every week.</div>
                    <button
                      type="button"
                      data-action="session-allowance-upgrade"
                      class="mt-auto h-9 rounded-lg px-3 text-[13px] font-semibold text-white"
                      style={{ background: CTA_GRADIENT }}
                      onClick={upgrade}
                    >
                      See plans
                    </button>
                  </>
                }
              >
                {(p) => (
                  <>
                    <div class="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-v2-icon-icon-accent">
                      Best for how you work
                    </div>
                    <div class="text-[13.5px] font-semibold">{p().title}</div>
                    <div data-slot="session-allowance-out-fit" class="text-[12px] text-v2-text-text-muted">
                      {p().detail}
                    </div>
                    <button
                      type="button"
                      data-action="session-allowance-upgrade"
                      class="mt-auto h-9 rounded-lg px-3 text-[13px] font-semibold text-white disabled:opacity-60"
                      style={{ background: CTA_GRADIENT }}
                      disabled={checkingOut()}
                      onClick={() => void choosePlan(p().slug)}
                    >
                      {checkingOut() ? "Opening checkout…" : `Upgrade · ${formatPrice(p().price, p().period)}`}
                    </button>
                  </>
                )}
              </Show>
            </div>
          </Show>
          <Show when={c.wait}>
            {(w) => (
              <div data-slot="session-allowance-out-wait" class={option}>
                <div class="text-[13.5px] font-semibold">{w().title}</div>
                <div class="text-[12px] text-v2-text-text-muted">{w().detail}</div>
                <Show when={canRemind()}>
                  <button
                    type="button"
                    data-action="session-allowance-remind"
                    class={secondary}
                    disabled={reminded() === w().at}
                    onClick={() => {
                      if (scheduleResetReminder(w().at, notify)) setReminded(w().at)
                    }}
                  >
                    {reminded() === w().at ? "We'll remind you" : "Remind me"}
                  </button>
                </Show>
              </div>
            )}
          </Show>
        </div>
        <Show when={checkoutError()}>
          <div role="alert" class="text-[12px] text-v2-state-fg-danger">
            {checkoutError()}
          </div>
        </Show>
      </div>
    )
  }
}
