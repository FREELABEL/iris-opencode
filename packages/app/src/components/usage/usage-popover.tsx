import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Switch as SwitchV2 } from "@opencode-ai/ui/v2/switch-v2"
import type { FetchJson } from "@/components/dialog-upgrade"
import { IRIS_COLORS, PlanMark } from "@/components/plan-mark"
import { trackUpgrade } from "@/utils/upgrade-funnel"
import { announceAsk } from "./usage-asks"
import { refreshIrisPlan } from "@/utils/iris-plan-store"
import { TopupPicker } from "./topup-picker"
import {
  RING_COLOR,
  forecastLine,
  lastWeekTiles,
  ladder,
  levelLine,
  openChecklist,
  packLabel,
  resetLine,
  ringState,
  tokenCount,
  upgradeLabel,
  usageAsk,
  weekLine,
  type Offer,
  type UsagePlan,
} from "./usage-model"
import { UsageRings } from "./usage-rings"
import {
  autoTopupView,
  loadAutoTopup,
  loadInvite,
  loadPacks,
  saveAutoTopup,
  type AutoTopup,
  type Invite,
  type TopupPack,
} from "./usage-actions"

/** The plans gradient (heyiris.io primary CTA). No token exists for a gradient. */
export const CTA_GRADIENT = `linear-gradient(90deg, ${IRIS_COLORS.violet}, #2563eb)`

/** "Free", "IRIS Solo" — the mark next to the plan name. Free is the plain cyan ring. */
function PlanBadgeMark(props: { plan: UsagePlan; offers: Offer[] }) {
  const slug = createMemo(() => {
    const label = (props.plan.label ?? "").toLowerCase()
    return props.plan.paid === true ? props.offers.find((o) => label.includes(o.title.toLowerCase()))?.slug : undefined
  })
  return (
    <Show
      when={slug()}
      fallback={
        <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
          <circle cx="14" cy="14" r="10" fill="none" stroke={IRIS_COLORS.cyan} stroke-width="3.5" />
        </svg>
      }
    >
      {(s) => <PlanMark slug={s()} size={28} />}
    </Show>
  )
}

/**
 * What the ring opens (#194529). Your week and this chat in one place, what happens at this pace,
 * the ladder, and the two different asks — Upgrade (more every week) and Top up (more right now) —
 * never the same word for both. Paid: no Upgrade nag. Uncapped: tokens used, nothing asked.
 */
export function UsagePopoverBody(props: {
  plan: UsagePlan
  context: { usage: number | null } | undefined
  fetchJson: FetchJson
  onContextDetails?: () => void
  onUpgrade: () => void
  onPlans: () => void
  onClose?: () => void
  now?: Date
}) {
  const now = () => props.now ?? new Date()
  const ring = createMemo(() => ringState(props.plan))
  const ask = createMemo(() => usageAsk(props.plan))
  const [offers, setOffers] = createSignal<Offer[]>([])
  const [packs, setPacks] = createSignal<TopupPack[]>([])
  const [auto, setAuto] = createSignal<AutoTopup | null>(null)
  const [autoError, setAutoError] = createSignal<string | null>(null)
  const [invite, setInvite] = createSignal<Invite | null>(null)
  const [copied, setCopied] = createSignal(false)
  const [picking, setPicking] = createSignal(false)

  const low = () => (props.plan.fraction ?? 0) >= 0.9

  onMount(() => {
    trackUpgrade(props.fetchJson, "usage.ring_opened", ring()?.tone ?? "unknown")
    if (ask() === "none") return
    // The popover IS an ask to pay when it shows Upgrade (#191267 — it was never recorded).
    announceAsk(props.fetchJson, "ring", props.plan)
    void props.fetchJson<{ measured?: boolean; plans?: Offer[] }>("/iris/plans")
      .then((r) => setOffers(r?.measured && Array.isArray(r.plans) ? r.plans : []))
      .catch(() => undefined)
    void loadPacks(props.fetchJson).then((r) => "packs" in r && setPacks(r.packs))
    void loadAutoTopup(props.fetchJson).then((r) => "value" in r && setAuto(r.value))
    if (low()) void loadInvite(props.fetchJson).then((r) => "invite" in r && setInvite(r.invite))
  })

  const steps = createMemo(() => ladder(offers(), props.plan))
  const tiles = createMemo(() => lastWeekTiles(props.plan.lastWeek))
  const checklist = createMemo(() => openChecklist(props.plan.progress))
  const level = createMemo(() => levelLine(props.plan.progress))
  const forecast = createMemo(() => forecastLine(props.plan, now()))
  const reset = createMemo(() => resetLine(props.plan.resetsAt, now()))
  const contextPct = () => props.context?.usage ?? null

  const toggleAuto = async (enabled: boolean) => {
    const prev = auto()
    if (!prev) return
    setAutoError(null)
    setAuto({ ...prev, enabled })
    const pack = prev.pack ?? packs()[0]?.key ?? null
    const r = await saveAutoTopup(props.fetchJson, { enabled, pack })
    if ("error" in r) {
      setAuto(prev)
      setAutoError(r.error)
      return
    }
    setAuto(r.value)
  }

  const copyInvite = async () => {
    const inv = invite()
    if (!inv) return
    try {
      await navigator.clipboard.writeText(inv.url)
      setCopied(true)
      trackUpgrade(props.fetchJson, "usage.invite_sent", "copy")
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div data-component="usage-popover" data-tone={ring()?.tone} data-ask={ask()} class="flex w-[400px] max-w-[calc(100vw-40px)] flex-col gap-4 p-4 text-[13px] text-v2-text-text-base">
      {/* Plan and reset */}
      <div class="flex items-center gap-3">
        <PlanBadgeMark plan={props.plan} offers={offers()} />
        <div class="min-w-0 flex-1">
          <div data-slot="usage-plan-label" class="truncate text-[15px] font-semibold text-v2-text-text-base">
            {props.plan.uncapped ? (props.plan.label ?? "Staff") : `${props.plan.label ?? "Your"} plan`.replace(/ plan plan$/i, " plan")}
          </div>
          <Show when={reset()}>
            <div data-slot="usage-reset" class="text-[12px] text-v2-text-text-muted">
              {reset()}
            </div>
          </Show>
        </div>
      </div>

      {/* Two rings, big */}
      <div class="flex items-center gap-4">
        <div class="relative shrink-0">
          <UsageRings
            size={88}
            week={ring()?.week ?? null}
            context={contextPct()}
            color={ring() ? RING_COLOR[ring()!.tone] : RING_COLOR.calm}
          />
          <Show when={ring()?.percent !== null && ring()?.percent !== undefined}>
            <div class="absolute inset-0 flex flex-col items-center justify-center leading-none">
              <span data-slot="usage-percent" class="text-[18px] font-bold tabular-nums">
                {ring()!.percent}%
              </span>
              <span class="mt-0.5 text-[9px] text-v2-text-text-muted">of your week</span>
            </div>
          </Show>
        </div>
        <div class="flex min-w-0 flex-col gap-1">
          <Show when={weekLine(props.plan)}>
            {(line) => (
              <div data-slot="usage-week-line" class="text-[15px] font-semibold tabular-nums">
                {line()}
              </div>
            )}
          </Show>
          <Show when={contextPct() !== null}>
            <div data-slot="usage-context-line" class="text-v2-text-text-base">
              This chat is using {contextPct()}% of its context.
            </div>
          </Show>
          <div class="flex items-center gap-3 text-[11px] text-v2-text-text-muted">
            <Show when={ring()?.week !== null && ring() !== null}>
              <span class="inline-flex items-center gap-1">
                <span class="inline-block size-2 rounded-full" style={{ background: RING_COLOR[ring()!.tone] }} />
                Your week
              </span>
            </Show>
            <span class="inline-flex items-center gap-1">
              <span class="inline-block size-2 rounded-full bg-v2-text-text-base" />
              This chat
            </span>
          </div>
        </div>
      </div>

      <Show when={forecast()}>
        <div
          data-slot="usage-forecast"
          class="rounded-lg px-3 py-2 text-[12.5px]"
          classList={{
            "bg-v2-state-bg-warning text-v2-state-fg-warning": low(),
            "bg-v2-background-bg-layer-02 text-v2-text-text-base": !low(),
          }}
        >
          {forecast()}
        </div>
      </Show>

      <Show when={tiles().length > 0}>
        <div data-slot="usage-last-week" class="grid gap-2" style={{ "grid-template-columns": `repeat(${tiles().length}, 1fr)` }}>
          <For each={tiles()}>
            {(t) => (
              <div class="rounded-lg bg-v2-background-bg-layer-02 px-3 py-2">
                <div class="text-[16px] font-semibold tabular-nums">{t.value}</div>
                <div class="text-[11px] text-v2-text-text-muted">{t.label}</div>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={ask() !== "none" && steps().length > 1}>
        <ol data-slot="usage-ladder" class="flex items-start justify-between gap-1">
          <For each={steps()}>
            {(s) => (
              <li
                data-slot="usage-ladder-step"
                data-current={s.current ? "" : undefined}
                data-next={s.next ? "" : undefined}
                class="flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-center"
                classList={{
                  "bg-v2-background-bg-layer-02 ring-1 ring-v2-icon-icon-accent": s.next,
                  "text-v2-text-text-muted": !s.next && !s.current,
                }}
              >
                <span class="text-[12px] font-medium">{s.label}</span>
                <span class="text-[10.5px] tabular-nums text-v2-text-text-muted">
                  {s.weekly ? `${tokenCount(s.weekly)}/wk` : s.current ? "you" : "—"}
                </span>
              </li>
            )}
          </For>
        </ol>
      </Show>

      <Show when={ask() !== "none"}>
        <div class="flex flex-col gap-2">
          <Show when={ask() === "upgrade"}>
            <button
              type="button"
              data-action="usage-upgrade"
              class="h-10 rounded-lg px-4 text-[13.5px] font-semibold text-white hover:opacity-95"
              style={{ background: CTA_GRADIENT }}
              onClick={() => props.onUpgrade()}
            >
              {upgradeLabel(props.plan) ?? "See plans"}
            </button>
          </Show>
          <Show when={ask() === "plan"}>
            <button
              type="button"
              data-action="usage-your-plan"
              class="h-9 rounded-lg border border-v2-border-border-base px-4 text-[13px] text-v2-text-text-base hover:bg-v2-background-bg-layer-02"
              onClick={() => props.onPlans()}
            >
              Your plan
            </button>
          </Show>
          <Show when={packs().length > 0}>
            <Show
              when={picking()}
              fallback={
                <button
                  type="button"
                  data-action="usage-topup"
                  class="h-9 rounded-lg border border-v2-border-border-base px-4 text-[13px] text-v2-text-text-base hover:bg-v2-background-bg-layer-02"
                  onClick={() => setPicking(true)}
                >
                  + Top up <span class="text-v2-text-text-muted">· from {packLabel(packs()[0])} · never expire</span>
                </button>
              }
            >
              <TopupPicker
                fetchJson={props.fetchJson}
                packs={packs()}
                source="ring"
                onOpened={() => {
                  setPicking(false)
                  props.onClose?.()
                  void refreshIrisPlan()
                }}
              />
            </Show>
          </Show>
          <Show when={auto() && autoTopupView(auto())}>
            {(view) => (
              <div data-slot="usage-auto-topup" class="flex flex-col gap-1">
                <SwitchV2
                  checked={auto()!.enabled && view().usable}
                  disabled={!view().usable}
                  onChange={(v: boolean) => void toggleAuto(v)}
                  class="text-[12.5px] text-v2-text-text-base"
                >
                  Top up automatically when I run low
                </SwitchV2>
                <Show when={view().note}>
                  <div
                    data-slot="usage-auto-topup-note"
                    class="text-[11.5px]"
                    classList={{
                      "text-v2-state-fg-danger": !!auto()!.lastError && view().usable,
                      "text-v2-text-text-muted": !auto()!.lastError || !view().usable,
                    }}
                  >
                    {view().note}
                  </div>
                </Show>
              </div>
            )}
          </Show>
          <Show when={autoError()}>
            <div role="alert" class="text-[12px] text-v2-state-fg-danger">
              {autoError()}
            </div>
          </Show>
        </div>
      </Show>

      <Show when={ask() !== "none" && invite() && low()}>
        <div data-slot="usage-invite" class="flex items-center gap-2 rounded-lg bg-v2-background-bg-layer-02 px-3 py-2">
          <span class="min-w-0 flex-1 text-[12.5px]">
            Invite a friend
            {invite()!.rewardTokens ? ` — you both get +${tokenCount(invite()!.rewardTokens!)} tokens` : ""}
          </span>
          <button
            type="button"
            data-action="usage-invite-copy"
            class="h-7 shrink-0 rounded-md border border-v2-border-border-base px-2.5 text-[12px] hover:bg-v2-background-bg-layer-03"
            onClick={() => void copyInvite()}
          >
            {copied() ? "Link copied" : "Copy link"}
          </button>
        </div>
      </Show>

      <Show when={ask() !== "none" && (checklist().length > 0 || level())}>
        <div data-slot="usage-progress" class="flex flex-col gap-1.5">
          <Show when={level()}>
            <div data-slot="usage-level" class="text-[12px] text-v2-text-text-muted">
              {level()}
            </div>
          </Show>
          <For each={checklist()}>
            {(c) => (
              <div data-slot="usage-check" data-done={c.done ? "" : undefined} class="flex items-center gap-2 text-[12.5px]">
                <span
                  aria-hidden="true"
                  class="inline-flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px]"
                  classList={{
                    "border-v2-state-fg-success text-v2-state-fg-success": c.done,
                    "border-v2-border-border-strong": !c.done,
                  }}
                >
                  {c.done ? "✓" : ""}
                </span>
                <span class="min-w-0 flex-1" classList={{ "text-v2-text-text-muted line-through": c.done }}>
                  {c.label}
                </span>
                <Show when={c.rewardTokens}>
                  <span class="shrink-0 text-[11.5px] tabular-nums text-v2-state-fg-success">+{tokenCount(c.rewardTokens!)}</span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.onContextDetails}>
        <button
          type="button"
          data-action="usage-context-details"
          class="self-start text-[12px] text-v2-text-text-muted underline-offset-2 hover:text-v2-text-text-base hover:underline"
          onClick={() => props.onContextDetails?.()}
        >
          Context details
        </button>
      </Show>
    </div>
  )
}
