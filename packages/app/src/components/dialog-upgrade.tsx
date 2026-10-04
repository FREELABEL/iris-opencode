import { createResource, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { usePlatform } from "@/context/platform"

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

/** Checkout lives on the web pricing page; `source` tells it the click came from here. */
export function checkoutUrl(base: string, slug?: string): string {
  const u = new URL(base)
  u.searchParams.set("source", "desktop-upgrade")
  if (slug) u.searchParams.set("package", slug)
  return u.toString()
}

/**
 * The plans, inside the app — not a bounce to a browser tab for someone who only wanted to see
 * what upgrading gets them. Prices come from the sidecar (/iris/plans), which reads the same
 * package list the web pricing page does, so the two never quote different numbers. Checkout
 * itself stays on the web: Stripe, the trial and the account all live there.
 *
 * If the list cannot be read, the dialog says so and still offers the pricing page — it never
 * renders an empty grid that looks like there is nothing to buy.
 */
export function DialogUpgrade(props: { fetchJson: <T>(path: string) => Promise<T>; pricingUrl: string }) {
  const dialog = useDialog()
  const platform = usePlatform()
  const [plans] = createResource(() =>
    props.fetchJson<PlansState>("/iris/plans").catch((): PlansState => ({ measured: false, plans: [] })),
  )

  const open = (slug?: string) => {
    platform.openExternal(checkoutUrl(props.pricingUrl, slug))
    dialog.close()
  }

  return (
    <Dialog
      title="Upgrade IRIS"
      description="Every plan includes all twelve products and every model. Pick a plan to finish on the web."
      size="x-large"
    >
      <div data-slot="iris-upgrade" class="flex flex-col gap-4 px-6 pb-5">
        <Show when={!plans.loading} fallback={<div class="text-v2-text-text-weak py-8 text-center">Loading plans…</div>}>
          <Show
            when={plans()?.measured && plans()!.plans.length > 0}
            fallback={
              <div class="text-v2-text-text-weak py-6 text-center">
                Couldn't load plans here. The pricing page has them all.
              </div>
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
                      <For each={p.features}>{(f) => <li class="flex gap-1.5"><span aria-hidden="true">✓</span>{f}</li>}</For>
                    </ul>
                    <Button variant={p.popular ? "primary" : "secondary"} size="large" onClick={() => open(p.slug)}>
                      {p.trialDays ? `Start ${p.trialDays}-day trial` : `Choose ${p.title}`}
                    </Button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
        <div class="flex items-center justify-between gap-2 text-[12px]">
          <span class="text-v2-text-text-weak">Secure checkout by Stripe · Cancel anytime</span>
          <Button variant="ghost" size="small" onClick={() => open()}>
            Compare all plans
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
