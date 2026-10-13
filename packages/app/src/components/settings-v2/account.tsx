import { Component, For, Show, createResource, createSignal } from "solid-js"
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
  credential: "personal" | "machine" | "rejected" | "none"
  panelsDiffer: boolean
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
  | { kind: "meter"; percent: number; alert: boolean; text: string; resets: string | null; marks: number[] }

const usd = (n: number) => `$${n.toFixed(2)}`
const UNKNOWN: MeterView = { kind: "unknown", text: "Usage is unavailable right now. This is not zero." }
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/**
 * One meter, read from the gate (ADR-01). "Could not ask" and "no limit" each get their own words.
 * Neither is ever drawn as an empty bar, which would tell someone they have used nothing.
 *
 * Edge cases from the 2026-10-07 stress test (#188509): a cap of 0 or below is not an empty
 * allowance, it is unknown; the percent is FLOORED, so 89.5% does not read as 90% and turn red
 * before the server's 90% notice has fired; red follows the server's own threshold, not 90
 * hard-coded; over the cap says so instead of "100%".
 */
export function meterView(a: AccountState["allowance"] | undefined, now = new Date()): MeterView {
  if (!a?.measured) return UNKNOWN
  if (a.uncapped || a.capUsd === null) return { kind: "uncapped", text: "No weekly limit on this account." }
  if (!isNum(a.capUsd) || a.capUsd <= 0 || !isNum(a.fraction) || !isNum(a.spendUsd)) return UNKNOWN
  if (a.fraction < 0 || a.spendUsd < 0) return UNKNOWN

  const marks = [...new Set((a.thresholds ?? []).filter((t) => isNum(t) && t > 0 && t < 1))].sort((x, y) => x - y)
  const over = a.fraction >= 1
  const percent = Math.min(100, Math.floor(a.fraction * 100))
  const window = a.window || "week"
  return {
    kind: "meter",
    percent,
    alert: over || (marks.length > 0 && a.fraction >= marks[0]),
    text: over
      ? `${usd(a.spendUsd)} of ${usd(a.capUsd)} this ${window}, over the limit`
      : `${usd(a.spendUsd)} of ${usd(a.capUsd)} this ${window} (${percent}%)`,
    resets: resetsText(a.resetsAt, now),
    marks: marks.map((t) => Math.round(t * 100)),
  }
}

/** Date AND time, in the viewer's zone: 00:00 UTC is still Saturday evening in the US. */
function resetsText(iso: string | null, now: Date): string | null {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  if (at.getTime() <= now.getTime()) return "Resets now"
  const when = at.toLocaleString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
  return `Resets ${when}`
}

/**
 * The server reports staff as plan null (fl-iris-api 4eda580d). An unmeasured plan is "Unknown",
 * never "Free". Slugs are humanised ("pro_monthly" reads "Pro Monthly"); an empty or non-string
 * plan is "Unknown" rather than a blank label (#188509).
 */
export function planLabel(p: AccountState["plan"] | undefined): string {
  if (!p?.measured) return "Unknown"
  if (p.plan === null) return "Staff"
  if (typeof p.plan !== "string" || !p.plan.trim()) return "Unknown"
  return p.plan
    .trim()
    .toLowerCase()
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

/**
 * The headline when nobody is signed in as a person. Each cause gets its own words, because
 * each has a different fix: "can't reach IRIS" for a refused key sent people to check their
 * network (#188505), and a failed /iris/me read as "Not signed in" (#188507).
 */
export function accountStatus(
  state: AccountState | undefined,
  loading: boolean,
): { title: string; description: string; action: "retry" | "sign-in" } {
  if (loading) return { title: "Checking…", description: "", action: "retry" }
  if (!state) {
    return {
      title: "Couldn't load your account",
      description: "IRIS on this computer did not answer. Your sign-in is probably fine.",
      action: "retry",
    }
  }
  if (state.credential === "machine") {
    return {
      title: "Signed in as this computer's Hive node",
      description: "Chat and Atlas act as this machine, not as you. Sign in to use your own account.",
      action: "sign-in",
    }
  }
  if (state.credential === "rejected") {
    return {
      title: "Your sign-in was refused",
      description: `IRIS rejected the saved key (${state.reason ?? "401"}). It may have expired or been revoked. Sign in again.`,
      action: "sign-in",
    }
  }
  if (state.credential === "none") {
    return { title: "Not signed in", description: "Sign in to use IRIS models, Atlas and Hive.", action: "sign-in" }
  }
  return {
    title: "Can't reach IRIS",
    description: `IRIS did not answer (${state.reason ?? "no response"}). You may still be signed in.`,
    action: "retry",
  }
}

/** A Hive node key can sign the app in, but it belongs to a machine, not to a person. */
export function sourceNote(source: string): string | null {
  if (source.includes("node_api_key")) return "Signed in with this machine's Hive node key, not a personal sign-in."
  if (source.startsWith("none")) return null
  return `Credential from ${source}.`
}

/** One row of /iris/accounts (#189321). The engine never sends the key. */
export interface SavedAccount {
  ref: string
  id: number | null
  email: string | null
  name: string | null
  active: boolean
  separateData: boolean
}

/** A saved sign-in by the best name we have. One saved before anyone asked who it is still gets words. */
export function savedAccountLabel(a: Pick<SavedAccount, "id" | "email" | "name">): string {
  return a.name?.trim() || a.email?.trim() || (a.id !== null ? `Account #${a.id}` : "An account signed in earlier")
}

/** The accounts you could switch to: every saved one except the one in use. */
export function otherAccounts(list: SavedAccount[] | undefined): SavedAccount[] {
  return (list ?? []).filter((a) => !a.active)
}

/** What "Sign out" will do, which depends on whether there is another account to fall back to. */
export function signOutDescription(others: SavedAccount[]): string {
  if (others.length === 0) {
    return "Signs this computer out of IRIS, in the app and in the iris command. Hive keeps running on this machine."
  }
  return `Signs out of this account and switches to ${savedAccountLabel(others[0])}. Hive keeps running on this machine.`
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

  const [signOutStep, setSignOutStep] = createSignal<"idle" | "confirm" | "working" | "failed">("idle")
  const canSignOut = () => platform.platform === "desktop"
  const signOut = async () => {
    setSignOutStep("working")
    try {
      const base = server.current?.http?.url?.replace(/\/$/, "")
      const res = await (platform.fetch ?? globalThis.fetch)(`${base}/iris/sign-out`, { method: "POST" })
      if (!res.ok) throw new Error(String(res.status))
      // The engine still holds the old key in memory. Restarting re-runs the startup check,
      // which finds no key and opens the sign-in screen.
      await platform.restart()
    } catch {
      setSignOutStep("failed")
    }
  }

  const [saved, { refetch: refetchSaved }] = createResource(
    () => server.current?.http?.url?.replace(/\/$/, ""),
    async (base): Promise<SavedAccount[] | undefined> => {
      try {
        const res = await (platform.fetch ?? globalThis.fetch)(`${base}/iris/accounts`)
        return res.ok ? (((await res.json()) as { accounts: SavedAccount[] }).accounts ?? []) : undefined
      } catch {
        return undefined
      }
    },
  )
  const others = () => otherAccounts(saved())

  // One action at a time, named by the account it is for, so two clicks cannot race a restart.
  const [accountAction, setAccountAction] = createSignal<{ ref: string; kind: "switch" | "remove" } | null>(null)
  const [accountError, setAccountError] = createSignal<string | null>(null)
  // Outside the desktop nothing can restart the engine, and it reads its key once, at start. So a
  // switch there is saved, not finished — and the page says so rather than pretending.
  const [switchedTo, setSwitchedTo] = createSignal<string | null>(null)
  const accountPost = async (path: "switch" | "remove", ref: string) => {
    const base = server.current?.http?.url?.replace(/\/$/, "")
    const res = await (platform.fetch ?? globalThis.fetch)(`${base}/iris/accounts/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref }),
    })
    const body = res.ok ? ((await res.json()) as { ok: boolean; reason?: string }) : { ok: false, reason: `${res.status}` }
    if (!body.ok) throw new Error(body.reason ?? "refused")
  }
  const switchTo = async (a: SavedAccount) => {
    setAccountError(null)
    setAccountAction({ ref: a.ref, kind: "switch" })
    try {
      await accountPost("switch", a.ref)
      // The engine reads its key once, at start; the restart is what makes chat act as this account.
      if (canSignOut()) return await platform.restart()
      setSwitchedTo(savedAccountLabel(a))
      setAccountAction(null)
      await refetchSaved()
    } catch (e) {
      setAccountError(`Couldn't switch to ${savedAccountLabel(a)}: ${e instanceof Error ? e.message : String(e)}`)
      setAccountAction(null)
    }
  }
  const forget = async (a: SavedAccount) => {
    setAccountError(null)
    setAccountAction({ ref: a.ref, kind: "remove" })
    try {
      await accountPost("remove", a.ref)
      await refetchSaved()
    } catch (e) {
      setAccountError(`Couldn't remove ${savedAccountLabel(a)}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setAccountAction(null)
    }
  }

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
              fallback={(() => {
                const s = () => accountStatus(me(), me.loading)
                return (
                  <SettingsRowV2 title={s().title} description={s().description}>
                    <span data-action="account-status">
                      <Show
                        when={s().action === "sign-in" && platform.openSignIn}
                        fallback={
                          <ButtonV2 size="normal" variant="neutral" onClick={() => void refetch()}>
                            Retry
                          </ButtonV2>
                        }
                      >
                        <ButtonV2 size="normal" variant="neutral" onClick={() => platform.openSignIn?.()}>
                          Sign in
                        </ButtonV2>
                      </Show>
                    </span>
                  </SettingsRowV2>
                )
              })()}
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
                    <Show when={me()?.panelsDiffer}>
                      <br />
                      <span data-action="account-panels-differ">
                        Atlas and Hive panels are using a different saved sign-in from chat. Sign out and back in to
                        line them up.
                      </span>
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
              <Show when={canSignOut()}>
                <SettingsRowV2
                  title="Sign out"
                  description={
                    signOutStep() === "failed"
                      ? "Sign-out failed. Nothing was restarted. Try again."
                      : signOutDescription(others())
                  }
                >
                  <span data-action="account-sign-out">
                    <Show
                      when={signOutStep() === "confirm" || signOutStep() === "working"}
                      fallback={
                        <ButtonV2 size="normal" variant="neutral" onClick={() => setSignOutStep("confirm")}>
                          Sign out
                        </ButtonV2>
                      }
                    >
                      <div class="flex items-center gap-2">
                        <ButtonV2
                          size="normal"
                          variant="neutral"
                          disabled={signOutStep() === "working"}
                          onClick={() => setSignOutStep("idle")}
                        >
                          Cancel
                        </ButtonV2>
                        <ButtonV2
                          size="normal"
                          variant="neutral"
                          disabled={signOutStep() === "working"}
                          onClick={() => void signOut()}
                        >
                          {signOutStep() === "working" ? "Signing out…" : "Sign out and restart"}
                        </ButtonV2>
                      </div>
                    </Show>
                  </span>
                </SettingsRowV2>
              </Show>
            </Show>
          </SettingsListV2>
        </div>

        <Show when={me()?.signedIn}>
          <div class="settings-v2-section" data-action="account-saved">
            <h3 class="settings-v2-section-title">Other accounts on this computer</h3>
            <SettingsListV2>
              <For each={others()}>
                {(a) => (
                  <SettingsRowV2
                    title={savedAccountLabel(a)}
                    description={
                      a.email && a.email !== savedAccountLabel(a)
                        ? a.email
                        : canSignOut()
                          ? "Switching restarts IRIS. Each account keeps its own chats."
                          : "Switching changes the saved sign-in; restart the IRIS server to finish."
                    }
                  >
                    <div class="flex items-center gap-2" data-action="account-saved-row">
                      <ButtonV2
                        size="normal"
                        variant="neutral"
                        disabled={accountAction() !== null}
                        onClick={() => void forget(a)}
                      >
                        {accountAction()?.ref === a.ref && accountAction()?.kind === "remove" ? "Removing…" : "Remove"}
                      </ButtonV2>
                      <ButtonV2
                        size="normal"
                        variant="neutral"
                        disabled={accountAction() !== null}
                        onClick={() => void switchTo(a)}
                      >
                        {accountAction()?.ref === a.ref && accountAction()?.kind === "switch"
                          ? "Switching…"
                          : canSignOut()
                            ? "Switch and restart"
                            : "Switch"}
                      </ButtonV2>
                    </div>
                  </SettingsRowV2>
                )}
              </For>
              <Show when={switchedTo()}>
                {(name) => (
                  <SettingsRowV2
                    title={`Switched to ${name()}`}
                    description="Saved for the app and the iris command. Restart the IRIS server to finish: chat keeps using the account it started with until then."
                  >
                    <span data-action="account-switched" />
                  </SettingsRowV2>
                )}
              </Show>
              <SettingsRowV2
                title="Add another account"
                description={
                  accountError() ??
                  (!platform.openSignIn
                    ? "Run iris auth login in a terminal as the other account, then reopen Settings. The account you are in now is kept."
                    : others().length === 0
                      ? "Sign in as a second account without signing out of this one. Each account keeps its own chats."
                      : "Sign in as another account. The ones above stay signed in.")
                }
              >
                <Show when={platform.openSignIn}>
                  <span data-action="account-add">
                    <ButtonV2 size="normal" variant="neutral" onClick={() => platform.openSignIn?.()}>
                      Add account
                    </ButtonV2>
                  </span>
                </Show>
              </SettingsRowV2>
            </SettingsListV2>
          </div>
        </Show>

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
                              background: m().alert
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
