import { For, Show, createResource, onCleanup } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { todayOf, type AgentsPayload, type HivePayload, type InboxPayload } from "./home-today-model"

/** The operator numbers above projects and sessions (#192222). Refreshes every minute. */
export function HomeToday(props: { class?: string }) {
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const get = async <T,>(path: string, fallback: T): Promise<T> => {
    try {
      const res = await (platform.fetch ?? globalThis.fetch)(`${serverSDK().url.replace(/\/$/, "")}${path}`, {
        headers: { Accept: "application/json" },
      })
      if (!res.ok) return { ...fallback, reason: `engine ${res.status}` }
      return (await res.json()) as T
    } catch (e) {
      return { ...fallback, reason: e instanceof Error ? e.message : String(e) }
    }
  }
  const [tiles, { refetch }] = createResource(async () => {
    const [hive, agents, inbox] = await Promise.all([
      get<HivePayload>("/iris/hive?perPage=200", { measured: false, nodes: [] }),
      get<AgentsPayload>("/iris/agents-mine", { measured: false, agents: [] }),
      get<InboxPayload>("/iris/inbox?perPage=1", { measured: false, unread: null }),
    ])
    return todayOf(hive, agents, inbox)
  })
  const timer = setInterval(() => void refetch(), 60_000)
  onCleanup(() => clearInterval(timer))

  return (
    <Show when={tiles()?.some((t) => t.measured)}>
      <section aria-label="Today" class={`grid grid-cols-1 gap-2 sm:grid-cols-3 ${props.class ?? ""}`}>
        <For each={tiles()}>
          {(t) => (
            <div class="rounded-[10px] border border-v2-border-border-base px-3 py-2.5" title={t.detail} data-measured={t.measured ? "1" : "0"}>
              <div class="text-12-regular text-v2-text-text-muted">{t.label}</div>
              <div class="text-14-medium text-v2-text-text-base tabular-nums">{t.value}</div>
              <div class="truncate text-12-regular text-v2-text-text-muted">{t.detail}</div>
            </div>
          )}
        </For>
      </section>
    </Show>
  )
}
