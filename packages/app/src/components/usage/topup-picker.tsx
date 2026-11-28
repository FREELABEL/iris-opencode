import { For, Show, createSignal } from "solid-js"
import { usePlatform } from "@/context/platform"
import type { FetchJson } from "@/components/dialog-upgrade"
import { trackUpgrade } from "@/utils/upgrade-funnel"
import { packLabel } from "./usage-model"
import { requestTopup, type TopupPack } from "./usage-actions"

/** A small pack picker: one row per pack; choosing one opens Stripe in the browser. */
export function TopupPicker(props: { fetchJson: FetchJson; packs: TopupPack[]; source: string; onOpened?: () => void }) {
  const platform = usePlatform()
  const [opening, setOpening] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const choose = async (key: string) => {
    if (opening()) return
    setError(null)
    setOpening(key)
    trackUpgrade(props.fetchJson, "usage.topup_started", `${props.source}:${key}`)
    const r = await requestTopup(props.fetchJson, key)
    setOpening(null)
    if ("error" in r) return setError(r.error)
    platform.openExternal(r.url)
    props.onOpened?.()
  }
  return (
    <div data-slot="usage-topup-picker" class="flex flex-col gap-1.5">
      <For each={props.packs}>
        {(p) => (
          <button
            type="button"
            data-slot="usage-topup-pack"
            data-pack={p.key}
            class="flex h-9 items-center justify-between rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 px-3 text-[13px] text-v2-text-text-base hover:bg-v2-background-bg-layer-03 disabled:opacity-60"
            disabled={opening() !== null}
            onClick={() => void choose(p.key)}
          >
            <span>{opening() === p.key ? "Opening checkout…" : packLabel(p)}</span>
            <span class="text-[12px] text-v2-text-text-muted">{p.label ?? "never expires"}</span>
          </button>
        )}
      </For>
      <Show when={error()}>
        <div role="alert" data-slot="usage-topup-error" class="text-[12px] text-v2-state-fg-danger">
          {error()}
        </div>
      </Show>
    </div>
  )
}
