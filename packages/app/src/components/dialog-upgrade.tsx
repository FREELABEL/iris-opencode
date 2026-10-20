import { createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { usePlatform } from "@/context/platform"
import { planSummary, type SummaryInput } from "./plan-summary"
import { IRIS_COLORS, PlanMark } from "./plan-mark"

const GRADIENT = `linear-gradient(90deg, ${IRIS_COLORS.fuchsia}, ${IRIS_COLORS.blue}, ${IRIS_COLORS.cyan})`
const BUTTON_GRADIENT = `linear-gradient(90deg, ${IRIS_COLORS.violet}, #2563eb)`

export interface PlanOffer {
  slug: string
  title: string
  subtitle: string | null
  price: number
  period: string
  features: string[]
  trialDays: number | null
  popular: boolean
}

interface PlansState {
  measured: boolean
  plans: PlanOffer[]
}

/** "$1,299/mo". Whole dollars: every IRIS plan is priced in them, and cents would only be noise. */
export function formatPrice(price: number, period: string): string {
  const unit = period === "year" ? "/yr" : period === "month" ? "/mo" : `/${period}`
  return `$${Math.round(price).toLocaleString("en-US")}${unit}`
}

/** GET by default; checkout passes a POST. The sidecar answers both as JSON. */
export type FetchJson = <T>(path: string, init?: RequestInit) => Promise<T>

export type CheckoutAnswer = { ok: boolean; url?: string; reason?: string }

/**
 * Ask the sidecar for Stripe's URL for one plan (#190190). Every failure comes back as a sentence
 * the dialog can show — a network error included — because the bug this replaced was a button
 * that did nothing: the customer clicked it again and again and never learned why.
 */
export async function requestCheckout(
  fetchJson: FetchJson,
  slug: string,
): Promise<{ url: string } | { error: string }> {
  try {
    const r = await fetchJson<CheckoutAnswer>("/iris/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    })
    if (r?.ok && r.url) return { url: r.url }
    return { error: r?.reason || "Checkout didn't open. Try again." }
  } catch (e) {
    return { error: `Checkout didn't open: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** The plan button's words. The weekly allowance is the trial, so a plan is chosen, not trialled. */
export function planButtonLabel(plan: Pick<PlanOffer, "slug" | "title">, opening: string | null): string {
  return opening === plan.slug ? "Opening checkout…" : `Choose ${plan.title}`
}

/**
 * The plans on sale, as cards — shared by the Upgrade dialog and Settings > Account. Prices come
 * from the sidecar (/iris/plans), which reads the same package list the web pricing page does, so
 * the two never quote different numbers. Choosing a plan asks the sidecar for a Stripe Checkout
 * session on this account and opens Stripe itself — no web app, no second sign-in (#190190).
 *
 * If the list cannot be read, it says so — it never renders an empty grid that looks like there
 * is nothing to buy.
 */
export function PlanCards(props: {
  fetchJson: FetchJson
  /** Called after Stripe opens in the browser (the dialog closes itself here). */
  onChosen?: () => void
  /**
   * The account, when the caller already has it (Settings). Without it the cards ask /iris/me
   * themselves, so the dialog can say which plan you are on and what is left (#189988).
   */
  me?: () => SummaryInput | undefined
  /** "rows" for a narrow panel (Settings): one full-width row per plan instead of squeezed columns. */
  layout?: "columns" | "rows"
}) {
  const rows = () => props.layout === "rows"
  const platform = usePlatform()
  const [plans] = createResource(() =>
    props.fetchJson<PlansState>("/iris/plans").catch((): PlansState => ({ measured: false, plans: [] })),
  )
  const [fetched] = createResource(
    () => (props.me ? false : true),
    () => props.fetchJson<SummaryInput>("/iris/me").catch(() => undefined),
  )
  const summary = () => planSummary(props.me ? props.me() : fetched())

  const [opening, setOpening] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const choose = async (slug: string) => {
    if (opening()) return
    setError(null)
    setOpening(slug)
    const r = await requestCheckout(props.fetchJson, slug)
    setOpening(null)
    if ("error" in r) {
      setError(r.error)
      return
    }
    platform.openExternal(r.url)
    props.onChosen?.()
  }

  return (
    <div data-slot="iris-upgrade" class="flex flex-col gap-4">
      <Show when={summary().plan || summary().allowance || summary().trial}>
        <div
          data-slot="iris-plan-summary"
          data-over={summary().over ? "true" : undefined}
          class="flex flex-col gap-2 rounded-lg border px-4 py-3 text-[13px]"
          classList={{
            "border-v2-border-border-base": !summary().over,
            "border-v2-state-fg-warning bg-v2-state-bg-warning": summary().over,
          }}
        >
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Show when={summary().plan}>
              <span>
                <span class="text-v2-text-text-weak">Current plan </span>
                <b class="text-v2-text-text-strong" data-slot="iris-plan-summary-plan">
                  {summary().plan}
                </b>
              </span>
            </Show>
            <Show when={summary().allowance}>
              <span
                class="tabular-nums"
                classList={{
                  "text-v2-state-fg-warning font-medium": summary().over,
                  "text-v2-text-text-base": !summary().over,
                }}
                data-slot="iris-plan-summary-allowance"
              >
                {summary().allowance}
              </span>
            </Show>
            <Show when={summary().trial}>
              <span class="text-v2-icon-icon-accent font-medium" data-slot="iris-plan-summary-trial">
                {summary().trial}
              </span>
            </Show>
            <Show when={summary().percent !== null}>
              <span class="ml-auto font-mono text-[12px] tabular-nums text-v2-text-text-weak">
                {summary().percent}%
              </span>
            </Show>
          </div>
          <Show when={summary().percent !== null}>
            <div
              role="meter"
              aria-label="Allowance used this week"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={summary().percent ?? 0}
              data-slot="iris-plan-summary-meter"
              class="h-1.5 w-full overflow-hidden rounded-full bg-v2-border-border-base"
            >
              <div
                class="h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${summary().percent}%`,
                  "background-image":
                    (summary().percent ?? 0) >= 90
                      ? "linear-gradient(90deg, #f59e0b, #facc15)"
                      : `linear-gradient(90deg, ${IRIS_COLORS.fuchsia}, ${IRIS_COLORS.blue}, ${IRIS_COLORS.cyan})`,
                }}
              />
            </div>
          </Show>
        </div>
      </Show>
      <Show when={!plans.loading} fallback={<div class="text-v2-text-text-weak py-8 text-center">Loading plans…</div>}>
        <Show
          when={plans()?.measured && plans()!.plans.length > 0}
          fallback={
            <div class="text-v2-text-text-weak py-6 text-center">Couldn't load plans. Close this and try again.</div>
          }
        >
          <div
            class="grid gap-3"
            style={{ "grid-template-columns": rows() ? "1fr" : "repeat(auto-fit, minmax(220px, 1fr))" }}
          >
            <For each={plans()!.plans}>
              {(p) => {
                const button = (
                  <button
                    type="button"
                    data-slot="iris-upgrade-choose"
                    class="h-10 rounded-lg px-4 text-[14px] font-semibold transition-opacity hover:opacity-90 disabled:opacity-60"
                    classList={{
                      "text-white": !!p.popular,
                      "border border-v2-border-border-base text-v2-text-text-strong hover:bg-v2-background-bg-base":
                        !p.popular,
                    }}
                    style={p.popular ? { background: BUTTON_GRADIENT } : undefined}
                    disabled={opening() !== null}
                    onClick={() => void choose(p.slug)}
                  >
                    {planButtonLabel(p, opening())}
                  </button>
                )
                const features = (
                  <ul class="text-v2-text-text-base flex flex-1 flex-col gap-2 text-[12.5px]">
                    <For each={p.features}>
                      {(f, i) => (
                        <li class="flex gap-2">
                          <span
                            aria-hidden="true"
                            class="mt-[5px] inline-block h-2 w-2 shrink-0 rounded-full"
                            style={{ background: [IRIS_COLORS.fuchsia, IRIS_COLORS.blue, IRIS_COLORS.cyan][i() % 3] }}
                          />
                          {f}
                        </li>
                      )}
                    </For>
                  </ul>
                )
                return (
                  <div
                    data-slot="iris-upgrade-plan"
                    data-layout={rows() ? "rows" : "columns"}
                    class="rounded-xl border p-5"
                    classList={{ "flex flex-col gap-3": !rows(), "grid gap-x-8 gap-y-3": rows() }}
                    style={{
                      "grid-template-columns": rows() ? "minmax(200px, 240px) 1fr" : undefined,
                      "border-color": p.popular
                        ? IRIS_COLORS.blue
                        : "var(--v2-border-border-base, rgba(127,127,127,.25))",
                      "box-shadow": p.popular ? `0 0 0 1px ${IRIS_COLORS.blue}33` : undefined,
                    }}
                  >
                    <div class="flex flex-col gap-3">
                      <div class="flex items-center gap-2.5">
                        <PlanMark slug={p.slug} size={32} />
                        <span class="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-v2-text-text-strong">
                          {p.title}
                        </span>
                        <Show when={p.popular}>
                          <span
                            class="whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-white"
                            style={{ background: BUTTON_GRADIENT }}
                          >
                            Most popular
                          </span>
                        </Show>
                      </div>
                      <div
                        class="text-[36px] font-black leading-none tracking-tight tabular-nums"
                        style={{
                          // background-IMAGE, not the shorthand: the shorthand resets background-clip,
                          // which paints the gradient as a solid bar behind the text.
                          "background-image": GRADIENT,
                          "-webkit-background-clip": "text",
                          "background-clip": "text",
                          "-webkit-text-fill-color": "transparent",
                          color: "transparent",
                          width: "fit-content",
                        }}
                      >
                        {formatPrice(p.price, p.period)}
                      </div>
                      <Show when={p.subtitle}>
                        <div class="text-v2-text-text-weak text-[12px]">{p.subtitle}</div>
                      </Show>
                      <Show when={rows()}>{button}</Show>
                    </div>
                    {features}
                    <Show when={!rows()}>{button}</Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </Show>
      <Show when={error()}>
        <div
          data-slot="iris-upgrade-error"
          role="alert"
          class="rounded-lg border border-v2-border-border-base px-4 py-3 text-[13px] text-v2-text-text-danger"
        >
          {error()}
        </div>
      </Show>
      <div class="text-[12px] text-v2-text-text-weak">Secure checkout by Stripe · Cancel anytime</div>
    </div>
  )
}

/** The plans, inside the app — not a bounce to a browser tab for someone who only wanted to look. */
export function DialogUpgrade(props: { fetchJson: FetchJson }) {
  const dialog = useDialog()
  return (
    <Dialog
      title="Upgrade IRIS"
      description="Pick a plan to pay securely with Stripe."
      size="x-large"
    >
      <div class="px-6 pb-5">
        <PlanCards fetchJson={props.fetchJson} onChosen={() => dialog.close()} />
      </div>
    </Dialog>
  )
}
