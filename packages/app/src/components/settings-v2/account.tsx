import { Component, Show, createResource } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

/**
 * Settings > Account (#187966 K1 + K2): who the app is acting as, their plan, and how much of the
 * week's allowance is left.
 *
 * The copy is English, like the rest of the IRIS-only surfaces (titlebar pills, Upgrade dialog):
 * the locale files carry the upstream app's strings, and parity requires every key in all 61.
 */

export interface AccountState {
  measured: boolean
  reason?: string
  signedIn: boolean
  tokenSource: string
  id: number | null
  name: string | null
  email: string | null
  plan: { measured: boolean; plan: string | null; paid: boolean | null; uncapped: boolean; upgradeUrl: string | null }
  allowance: {
    measured: boolean
    window: string
    capUsd: number | null
    uncapped: boolean
    spendUsd: number | null
    fraction: number | null
    resetsAt: string | null
    thresholds: number[]
    upgradeUrl: string | null
  }
}

export type MeterView =
  | { kind: "unknown"; text: string }
  | { kind: "uncapped"; text: string }
  | { kind: "meter"; percent: number; text: string; resets: string | null; marks: number[] }

const usd = (n: number) => `$${n.toFixed(2)}`

/**
 * One meter, read from the gate (ADR-01). "Could not ask" and "no limit" each get their own words.
 * Neither is ever drawn as an empty bar, which would tell someone they have used nothing.
 */
export function meterView(a: AccountState["allowance"] | undefined, now = new Date()): MeterView {
  if (!a?.measured) return { kind: "unknown", text: "Usage is unavailable right now. This is not zero." }
  if (a.uncapped || a.capUsd === null) return { kind: "uncapped", text: "No weekly limit on this account." }
  if (a.fraction === null || a.spendUsd === null)
    return { kind: "unknown", text: "Usage is unavailable right now. This is not zero." }
  const percent = Math.max(0, Math.min(100, Math.round(a.fraction * 100)))
  return {
    kind: "meter",
    percent,
    text: `${usd(a.spendUsd)} of ${usd(a.capUsd)} this ${a.window} (${percent}%)`,
    resets: resetsText(a.resetsAt, now),
    marks: a.thresholds.filter((t) => t > 0 && t < 1).map((t) => Math.round(t * 100)),
  }
}

function resetsText(iso: string | null, now: Date): string | null {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  const day = at.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })
  return at.getTime() <= now.getTime() ? "Resets now" : `Resets ${day}`
}

/** The server reports staff as plan null (fl-iris-api 4eda580d). An unmeasured plan is "Unknown", never "Free". */
export function planLabel(p: AccountState["plan"] | undefined): string {
  if (!p?.measured) return "Unknown"
  if (p.plan === null) return "Staff"
  return p.plan.charAt(0).toUpperCase() + p.plan.slice(1)
}

/** A Hive node key can sign the app in, but it belongs to a machine, not to a person. */
export function sourceNote(source: string): string | null {
  if (source.includes("node_api_key")) return "Signed in with this machine's Hive node key, not a personal sign-in."
  if (source.startsWith("none")) return null
  return `Credential from ${source}.`
}

export const SettingsAccountV2: Component = () => {
  const platform = usePlatform()
  const server = useServer()

  const [me, { refetch }] = createResource(
    () => server.current?.http?.url?.replace(/\/$/, ""),
    async (base): Promise<AccountState | undefined> => {
      try {
        const res = await (platform.fetch ?? globalThis.fetch)(`${base}/iris/me`)
        return res.ok ? ((await res.json()) as AccountState) : undefined
      } catch {
        return undefined
      }
    },
  )

  const meter = () => meterView(me()?.allowance)
  const upgradeUrl = () => {
    const p = me()?.plan
    return p?.measured && p.paid === false ? (p.upgradeUrl ?? me()?.allowance.upgradeUrl ?? null) : null
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">Account</h2>
      </div>
      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <SettingsListV2>
            <Show
              when={me()?.signedIn}
              fallback={
                <SettingsRowV2
                  title={me.loading ? "Checking…" : me()?.measured === false ? "Can't reach IRIS" : "Not signed in"}
                  description={
                    me()?.measured === false
                      ? `IRIS did not answer (${me()?.reason ?? "no response"}). You may still be signed in.`
                      : "Sign in to use IRIS models, Atlas and Hive."
                  }
                >
                  <ButtonV2 size="normal" variant="neutral" onClick={() => void refetch()}>
                    Retry
                  </ButtonV2>
                </SettingsRowV2>
              }
            >
              <SettingsRowV2
                title={me()?.name ?? me()?.email ?? `User ${me()?.id}`}
                description={
                  <>
                    <span data-action="account-email">{me()?.email ?? "No email on this account"}</span>
                    <Show when={sourceNote(me()?.tokenSource ?? "")}>
                      {(note) => (
                        <>
                          <br />
                          {note()}
                        </>
                      )}
                    </Show>
                  </>
                }
              >
                <span data-action="account-id" class="text-text-weak">
                  #{me()?.id}
                </span>
              </SettingsRowV2>
              <SettingsRowV2 title="Plan" description={upgradeUrl() ? "Upgrade for a higher weekly allowance." : ""}>
                <div class="flex items-center gap-2">
                  <span data-action="account-plan">{planLabel(me()?.plan)}</span>
                  <Show when={upgradeUrl()}>
                    {(url) => (
                      <ButtonV2 size="normal" variant="neutral" onClick={() => platform.openExternal(url())}>
                        Upgrade
                      </ButtonV2>
                    )}
                  </Show>
                </div>
              </SettingsRowV2>
            </Show>
          </SettingsListV2>
        </div>

        <Show when={me()?.signedIn}>
          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">This week's allowance</h3>
            <SettingsListV2>
              <div data-component="settings-v2-row" data-action="account-allowance">
                <div data-slot="settings-v2-row-copy" style={{ width: "100%" }}>
                  <div data-slot="settings-v2-row-title">{meter().text}</div>
                  <Show
                    when={meter().kind === "meter" ? (meter() as Extract<MeterView, { kind: "meter" }>) : undefined}
                  >
                    {(m) => (
                      <>
                        <div
                          role="meter"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={m().percent}
                          aria-label="Weekly allowance used"
                          style={{
                            position: "relative",
                            height: "8px",
                            "border-radius": "4px",
                            "margin-top": "8px",
                            background: "var(--border-base, rgba(127, 127, 127, 0.35))",
                          }}
                        >
                          <div
                            style={{
                              width: `${m().percent}%`,
                              height: "100%",
                              "border-radius": "4px",
                              background:
                                m().percent >= 90
                                  ? "var(--icon-critical-base, #d14343)"
                                  : "var(--icon-interactive-base, #3b82f6)",
                            }}
                          />
                          {m().marks.map((mark) => (
                            <div
                              title={`You are told once at ${mark}%`}
                              style={{
                                position: "absolute",
                                left: `${mark}%`,
                                top: "-3px",
                                width: "2px",
                                height: "14px",
                                background: "var(--text-weak, #888)",
                              }}
                            />
                          ))}
                        </div>
                        <div data-slot="settings-v2-row-description" style={{ "margin-top": "6px" }}>
                          {[m().resets, m().marks.length ? `You are told once at ${m().marks.join("%, ")}%.` : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </>
                    )}
                  </Show>
                </div>
              </div>
            </SettingsListV2>
          </div>
        </Show>
      </div>
    </>
  )
}
