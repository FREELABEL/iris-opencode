import { createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { usePlatform } from "@/context/platform"
import { planSummary, type SummaryInput } from "./plan-summary"

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
export async function requestCheckout(fetchJson: FetchJson, slug: string): Promise<{ url: string } | { error: string }> {
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
}) {
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
          class="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-v2-border-border-base px-4 py-3 text-[13px]"
        >
          <Show when={summary().plan}>
            <span>
              <span class="text-v2-text-text-weak">Current plan </span>
              <b class="text-v2-text-text-strong" data-slot="iris-plan-summary-plan">
                {summary().plan}
              </b>
            </span>
          </Show>
          <Show when={summary().allowance}>
            <span class="tabular-nums text-v2-text-text-base" data-slot="iris-plan-summary-allowance">
              {summary().allowance}
            </span>
          </Show>
          <Show when={summary().trial}>
            <span class="text-v2-icon-icon-accent font-medium" data-slot="iris-plan-summary-trial">
              {summary().trial}
            </span>
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
          <div class="grid gap-3" style={{ "grid-template-columns": "repeat(auto-fit, minmax(200px, 1fr))" }}>
            <For each={plans()!.plans}>
              {(p) => (
                <div
                  data-slot="iris-upgrade-plan"
                  class="flex flex-col gap-3 rounded-lg border p-4"
                  classList={{
                    "border-v2-icon-icon-accent": p.popular,
                    "border-v2-border-border-base": !p.popular,
                  }}
                >
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-v2-text-text-strong text-[15px] font-semibold">{p.title}</span>
                    <Show when={p.popular}>
                      <span class="bg-v2-icon-icon-accent/20 text-v2-icon-icon-accent rounded-full px-2 py-0.5 text-[11px] font-medium">
                        Most popular
                      </span>
                    </Show>
                  </div>
                  <div class="text-v2-text-text-strong font-mono text-[22px] font-semibold tabular-nums">
                    {formatPrice(p.price, p.period)}
                  </div>
                  <Show when={p.subtitle}>
                    <div class="text-v2-text-text-weak text-[12px]">{p.subtitle}</div>
                  </Show>
                  <ul class="text-v2-text-text-base flex flex-1 flex-col gap-1.5 text-[12px]">
                    <For each={p.features}>
                      {(f) => (
                        <li class="flex gap-1.5">
                          <span aria-hidden="true">✓</span>
                          {f}
                        </li>
                      )}
                    </For>
                  </ul>
                  <Button
                    variant={p.popular ? "primary" : "secondary"}
                    size="large"
                    disabled={opening() !== null}
                    onClick={() => void choose(p.slug)}
                  >
                    {planButtonLabel(p, opening())}
                  </Button>
                </div>
              )}
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
      description="Every plan includes all twelve products and every model. Pick a plan to pay securely with Stripe."
      size="x-large"
    >
      <div class="px-6 pb-5">
        <PlanCards fetchJson={props.fetchJson} onChosen={() => dialog.close()} />
      </div>
    </Dialog>
  )
}
