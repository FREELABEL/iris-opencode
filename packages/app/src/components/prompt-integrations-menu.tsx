import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { connectsBy } from "@/components/session/iris-catalog"
import { integrationHealth, providerMark } from "@/components/session/session-iris-tab"

type Row = {
  type?: string
  name: string
  category?: string
  mode?: string
  oauthRequired?: boolean
  logoUrl?: string
  status?: string
  connected?: boolean
  account?: string
}

type Payload = { measured?: boolean; reason?: string; integrations?: Row[]; catalog?: Row[] }

/**
 * The "+" under the new-session composer: every integration, in one menu.
 *
 * It replaced the git branch chip in that row. The panel's Integrations surface does not exist on
 * this screen (no session yet, no panel), so this reads the same two sidecar endpoints the panel
 * does — what you have, and what you could add — and connecting one runs the same round trip:
 * ask for the authorize URL, open it in a real browser. Nothing here claims a connection landed;
 * the list is fetched again when the menu next opens.
 */
export function PromptIntegrationsMenu() {
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const base = createMemo(() => serverSDK().url.replace(/\/$/, ""))
  const doFetch = (path: string, init?: RequestInit) => (platform.fetch ?? globalThis.fetch)(`${base()}${path}`, init)
  const read = async (path: string): Promise<Payload> => {
    try {
      const res = await doFetch(path, { headers: { Accept: "application/json" } })
      return ((await res.json()) as Payload) ?? {}
    } catch (e) {
      return { measured: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  // Fetched on first open, not on mount: the new-session screen should not pay for a menu nobody opened.
  const [opened, setOpened] = createSignal(0)
  // Integrations are account-scoped, so the board id in the path is a placeholder the sidecar ignores for scope=all.
  const [mine] = createResource(opened, (n) => (n ? read("/iris/integrations/0?scope=all&perPage=200") : undefined))
  const [catalog] = createResource(opened, (n) => (n ? read("/iris/catalog?perPage=200") : undefined))
  const connected = createMemo(() => mine.latest?.integrations ?? [])
  const available = createMemo(() => catalog.latest?.catalog ?? [])
  const loading = () => (mine.loading && !mine.latest) || (catalog.loading && !catalog.latest)
  // ABSENT IS NOT EMPTY: a sidecar that could not read the account says why instead of drawing "none".
  const problem = () => {
    if (loading()) return
    const m = mine.latest
    const c = catalog.latest
    if (m?.measured === false && !connected().length) return m.reason
    if (c?.measured === false && !available().length) return c.reason
  }

  const [connect, setConnect] = createSignal<{ type: string; message: string } | null>(null)
  async function startConnect(type: string) {
    setConnect({ type, message: "Opening sign-in…" })
    try {
      const raw = await doFetch(`/iris/integrations/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ type }),
      })
      const res = (await raw.json().catch(() => null)) as {
        measured?: boolean
        reason?: string
        url?: string
        hint?: string
      } | null
      if (!res?.measured) return setConnect({ type, message: res?.reason ?? "Could not start the connection" })
      if (res.hint) return setConnect({ type, message: res.hint })
      if (!res.url) return setConnect({ type, message: "The platform returned no authorize URL" })
      platform.openExternal(res.url)
      setConnect({ type, message: "Approve it in your browser, then reopen this menu." })
    } catch (e) {
      setConnect({ type, message: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <>
      <span class="hidden select-none opacity-50 sm:inline mx-1">/</span>
      <MenuV2 placement="bottom" gutter={4} onOpenChange={(open) => open && setOpened((n) => n + 1)}>
        <TooltipV2 placement="top" value={connect()?.message ?? "Integrations"}>
          <MenuV2.Trigger
            aria-label="Integrations"
            class="flex size-7 shrink-0 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none data-[expanded]:bg-v2-overlay-simple-overlay-pressed"
          >
            <IconV2 name="plus" />
          </MenuV2.Trigger>
        </TooltipV2>
        <MenuV2.Portal>
          <MenuV2.Content class="w-[260px] max-h-[min(420px,60vh)] overflow-y-auto">
            <Show
              when={!loading()}
              fallback={
                <MenuV2.Group>
                  <MenuV2.GroupLabel>Loading integrations…</MenuV2.GroupLabel>
                </MenuV2.Group>
              }
            >
              <Show when={problem()}>
                {(reason) => (
                  <MenuV2.Group>
                    <MenuV2.GroupLabel>{reason()}</MenuV2.GroupLabel>
                  </MenuV2.Group>
                )}
              </Show>
              <Show when={connected().length > 0}>
                <MenuV2.Group>
                  <MenuV2.GroupLabel>Connected · {connected().length}</MenuV2.GroupLabel>
                  <For each={connected()}>
                    {(i) => (
                      <MenuV2.Item closeOnSelect={false} badge={i.account || i.category}>
                        <Mark row={i} state={integrationHealth({ status: i.status ?? "", connected: !!i.connected })} />
                        <span class="min-w-0 flex-1 truncate">{i.name}</span>
                      </MenuV2.Item>
                    )}
                  </For>
                </MenuV2.Group>
              </Show>
              <Show when={available().length > 0}>
                <Show when={connected().length > 0}>
                  <MenuV2.Separator />
                </Show>
                <MenuV2.Group>
                  <MenuV2.GroupLabel>Add · {available().length}</MenuV2.GroupLabel>
                  <For each={available()}>
                    {(c) => (
                      <MenuV2.Item
                        onSelect={() => c.type && void startConnect(c.type)}
                        title={connectsBy(c.mode, !!c.oauthRequired)}
                      >
                        <Mark row={c} />
                        <span class="min-w-0 flex-1 truncate">{c.name}</span>
                      </MenuV2.Item>
                    )}
                  </For>
                </MenuV2.Group>
              </Show>
            </Show>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </>
  )
}

function Mark(props: { row: Row; state?: "live" | "error" | "off" }) {
  const [failed, setFailed] = createSignal(false)
  return (
    <span
      class="relative flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-[3px] bg-v2-overlay-simple-overlay-hover text-[9px] font-medium uppercase text-v2-text-text-muted"
      aria-hidden="true"
    >
      <Show when={props.row.logoUrl && !failed()} fallback={providerMark(props.row.type, props.row.name)}>
        <img
          src={props.row.logoUrl}
          alt=""
          class="size-full object-contain"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </Show>
      <Show when={props.state}>
        <span
          class="absolute bottom-0 right-0 size-1.5 rounded-full"
          classList={{
            "bg-green-500": props.state === "live",
            "bg-red-500": props.state === "error",
            "bg-v2-icon-icon-muted": props.state === "off",
          }}
        />
      </Show>
    </span>
  )
}
