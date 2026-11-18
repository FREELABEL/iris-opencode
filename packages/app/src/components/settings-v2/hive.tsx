import { Component, Show, createResource, createSignal } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { remoteAccessView, type RemoteAccessState } from "./hive-remote-access"
import "./settings-v2.css"

/**
 * Settings → Hive (epic #192964 W2): one switch, "Allow access to this computer".
 *
 * ON is `iris hive connect`, the same path signing in takes, so the machine joins your Hive and
 * its sessions can be followed and answered from your other machines and your phone. It is ON by
 * default, matching the CLI. OFF: this computer's daemon tells the Hive it is offline and refuses
 * messages and answers from other machines; its own scheduled work keeps running.
 *
 * The panel shows what the engine reports after the write (the daemon's /health), never the
 * value it asked for. English copy, like the other IRIS-only surfaces.
 */
export const SettingsHiveV2: Component = () => {
  const platform = usePlatform()
  const server = useServer()
  const base = () => server.current?.http?.url?.replace(/\/$/, "")
  const call = (path: string, init?: RequestInit) => (platform.fetch ?? globalThis.fetch)(`${base()}${path}`, init)

  const [state, { refetch, mutate }] = createResource(base, async (): Promise<RemoteAccessState | undefined> => {
    try {
      const res = await call("/iris/hive/remote-access")
      return res.ok ? ((await res.json()) as RemoteAccessState) : undefined
    } catch {
      return undefined
    }
  })

  const [switching, setSwitching] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const set = async (allow: boolean) => {
    setError(null)
    setSwitching(true)
    // Show the flip at once; ON can take a while (it waits for the machine to come online).
    const was = state()
    if (was) mutate({ ...was, allow })
    try {
      const res = await call("/iris/hive/remote-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allow }),
      })
      const next = res.ok ? ((await res.json()) as RemoteAccessState) : undefined
      if (!next?.measured) throw new Error(next?.reason ?? `${res.status}`)
      mutate(next)
    } catch (err) {
      setError(`Couldn't change it: ${err instanceof Error ? err.message : String(err)}`)
      void refetch()
    } finally {
      setSwitching(false)
    }
  }

  const view = () => remoteAccessView(state(), state.loading)

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">Hive</h2>
      </div>
      <div class="settings-v2-tab-body settings-v2-security">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">This computer</h3>
          <SettingsListV2>
            <SettingsRowV2
              title="Allow access to this computer"
              description={
                <>
                  {view().description}
                  <Show when={switching() && state()?.allow}>
                    <br />
                    Connecting this computer to your Hive…
                  </Show>
                </>
              }
            >
              <span class="settings-v2-security-control" data-action="hive-remote-access">
                <span class="settings-v2-security-pill" data-tone={view().tone}>
                  {view().label}
                </span>
                <Show when={!state.loading && !state()?.measured}>
                  <ButtonV2 size="normal" variant="neutral" onClick={() => void refetch()}>
                    Retry
                  </ButtonV2>
                </Show>
                <Switch
                  checked={state()?.allow ?? true}
                  disabled={!state()?.measured || switching()}
                  onChange={(checked: boolean) => void set(checked)}
                />
              </span>
            </SettingsRowV2>
            <Show when={error()}>
              <p class="settings-v2-security-error">{error()}</p>
            </Show>
            <Show when={state()?.nodeId}>
              {(id) => (
                <SettingsRowV2 title="Hive node" description="How your other machines know this one.">
                  <span class="settings-v2-security-mono" title={id()}>
                    {id().slice(0, 8)}…
                  </span>
                </SettingsRowV2>
              )}
            </Show>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
