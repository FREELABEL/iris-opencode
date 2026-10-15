import { Component, For, Show, createResource, createSignal } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

/**
 * Settings > Security (#189589): what protects this account's model traffic, and why.
 *
 * Constellation Gate gets the full panel — whether it is on and the reason, what it does when it
 * finds something, which checks run, the last 30 days, and every recent scan with a way to say
 * "that one was wrong". The health-data guard sits beside it, and the tab has room for the next
 * control without being redesigned.
 *
 * READ-ONLY ON PURPOSE. Whether Gate screens an account is decided on the server from a remote
 * rollout flag, by the same policy the model proxy runs. The panel renders that decision; a
 * toggle here would be a second source of truth that could disagree with what the proxy does.
 *
 * English copy, like the other IRIS-only surfaces: the locale files carry the upstream app's
 * strings and the parity test requires every key in all 61 of them.
 */

export interface GateEvent {
  id: number
  at: string | null
  segment: string
  action: string
  mode: string
  verdict: string | null
  score: number | null
  reasonCode: string | null
  detected: string[]
  sensitivity: string | null
  latencyMs: number | null
  cached: boolean
  errorCode: string | null
  reportedFalse: boolean
}

export interface SecurityState {
  measured: boolean
  reason?: string
  gate: {
    enabled: boolean
    reason: string
    explanation: string
    mode: string
    org: string | null
    sensitivity: string | null
    categories: string[]
    segments: string[]
    failOpen: boolean
    availableChecks: string[]
    sensitivities: string[]
    stats: {
      windowDays: number
      scanned: number
      clean: number
      flagged: number
      held: number
      errors: number
      reportedFalse: number
      reportedFalsePct: number | null
      p50LatencyMs: number | null
      billableTokens: number
    }
    recent: GateEvent[]
  }
  phiGuard: { active: boolean; mode: string; explanation: string }
}

type Tone = "on" | "off" | "warn" | "unknown"

/** The headline: on, off, or "we could not ask" — which is never shown as off. */
export function gateStatusView(s: SecurityState | undefined, loading: boolean): { label: string; tone: Tone; description: string } {
  if (!s) {
    return loading
      ? { label: "Checking…", tone: "unknown", description: "Asking IRIS how this account is protected." }
      : { label: "Unknown", tone: "unknown", description: "Couldn't reach IRIS to check. This is not the same as Gate being off." }
  }
  if (!s.measured) {
    return { label: "Unknown", tone: "unknown", description: `Couldn't reach IRIS to check (${s.reason ?? "no answer"}). This is not the same as Gate being off.` }
  }
  if (!s.gate.enabled) {
    return { label: "Off", tone: s.gate.reason === "phi_no_baa" ? "warn" : "off", description: s.gate.explanation }
  }
  return { label: s.gate.mode === "enforce" ? "On" : "On · watching", tone: "on", description: s.gate.explanation }
}

export function modeView(mode: string): { title: string; description: string } {
  return mode === "enforce"
    ? {
        title: "Holds what it flags",
        description:
          "A flagged tool result — a web page, an email, a file — is removed before the model reads it, and the turn says so. A flagged message of yours is stopped before it reaches any model.",
      }
    : {
        title: "Watching only",
        description: "Gate scans and records what it finds, and changes nothing in your conversations.",
      }
}

const CHECK_LABELS: Record<string, string> = {
  prompt_injection: "Prompt injection",
  credential: "Credentials",
  pii: "Personal data",
  phi: "Health data",
}

export function checkLabel(name: string): string {
  return CHECK_LABELS[name] ?? name.replace(/_/g, " ")
}

/** Every check Gate offers, and whether this account runs it. Health data says why it is off. */
export function checkChips(available: string[], enabled: string[]): { name: string; label: string; on: boolean; note?: string }[] {
  return available.map((name) => ({
    name,
    label: checkLabel(name),
    on: enabled.includes(name),
    ...(name === "phi" && !enabled.includes(name) ? { note: "needs a health-data agreement (BAA)" } : {}),
  }))
}

/** The 30-day numbers. An unmeasured rate is "—", never 0%. */
export function statTiles(st: SecurityState["gate"]["stats"]): { label: string; value: string; hint: string }[] {
  const judged = st.scanned - st.errors
  return [
    { label: "Scanned", value: st.scanned.toLocaleString("en-US"), hint: `pieces of text in ${st.windowDays} days` },
    {
      label: "Flagged",
      value: (st.flagged + st.held).toLocaleString("en-US"),
      hint: st.held > 0 ? `${st.held.toLocaleString("en-US")} held before the model read them` : "none held",
    },
    {
      label: "Reported wrong",
      value: st.reportedFalsePct === null ? "—" : `${st.reportedFalsePct}%`,
      hint: judged > 0 ? `${st.reportedFalse} of ${judged.toLocaleString("en-US")}` : "nothing scanned yet",
    },
    {
      label: "Median scan",
      value: st.p50LatencyMs === null ? "—" : `${(st.p50LatencyMs / 1000).toFixed(2)}s`,
      hint: st.errors > 0 ? `${st.errors} scan${st.errors === 1 ? "" : "s"} couldn't run and went through` : "per piece of text",
    },
  ]
}

const ACTION_LABELS: Record<string, string> = {
  clean: "Clean",
  flagged: "Flagged",
  held: "Held",
  error: "Not scanned",
}

/** One line of the audit list. Only a flag or a hold can be reported — a clean pass has nothing to dispute. */
export function eventView(e: GateEvent): { label: string; tone: Tone; source: string; detail: string; reportable: boolean } {
  const source = e.segment === "tool" ? "Tool result" : e.segment === "user" ? "Your message" : e.segment
  const parts: string[] = []
  if (e.action === "error") parts.push(`Gate didn't answer (${e.errorCode ?? "error"}); the call went through`)
  if (e.reasonCode) parts.push(checkLabel(e.reasonCode))
  if (e.score !== null && e.action !== "error") parts.push(`risk ${e.score.toFixed(2)}`)
  if (e.cached) parts.push("seen before")
  return {
    label: ACTION_LABELS[e.action] ?? e.action,
    tone: e.action === "clean" ? "on" : e.action === "error" ? "unknown" : "warn",
    source,
    detail: parts.join(" · "),
    reportable: (e.action === "flagged" || e.action === "held") && !e.reportedFalse,
  }
}

export function eventTime(at: string | null, now = new Date()): string {
  if (!at) return ""
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ""
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay
    ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

const Pill: Component<{ tone: Tone; children: string }> = (props) => (
  <span class="settings-v2-security-pill" data-tone={props.tone}>
    {props.children}
  </span>
)

export const SettingsSecurityV2: Component = () => {
  const platform = usePlatform()
  const server = useServer()
  const base = () => server.current?.http?.url?.replace(/\/$/, "")

  const [state, { refetch, mutate }] = createResource(base, async (b): Promise<SecurityState | undefined> => {
    try {
      const res = await (platform.fetch ?? globalThis.fetch)(`${b}/iris/security`)
      return res.ok ? ((await res.json()) as SecurityState) : undefined
    } catch {
      return undefined
    }
  })

  const [reporting, setReporting] = createSignal<number | null>(null)
  const [reportError, setReportError] = createSignal<string | null>(null)
  const report = async (e: GateEvent) => {
    setReportError(null)
    setReporting(e.id)
    try {
      const res = await (platform.fetch ?? globalThis.fetch)(`${base()}/iris/security/gate/events/${e.id}/report`, { method: "POST" })
      const body = res.ok ? ((await res.json()) as { measured: boolean; reason?: string }) : { measured: false, reason: `${res.status}` }
      if (!body.measured) throw new Error(body.reason ?? "refused")
      const s = state()
      if (s) {
        mutate({ ...s, gate: { ...s.gate, recent: s.gate.recent.map((r) => (r.id === e.id ? { ...r, reportedFalse: true } : r)) } })
      }
    } catch (err) {
      setReportError(`Couldn't send the report: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setReporting(null)
    }
  }

  const status = () => gateStatusView(state(), state.loading)
  const gate = () => state()?.gate
  const ready = () => state()?.measured === true

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">Security</h2>
      </div>
      <div class="settings-v2-tab-body settings-v2-security">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">Prompt-injection screening</h3>
          <SettingsListV2>
            <SettingsRowV2
              title="Constellation Gate"
              description={
                <>
                  {status().description}
                  <Show when={ready() && gate()?.enabled}>
                    <br />
                    Checks the new text in each turn — your messages and what tools bring back — before the model reads it.
                  </Show>
                </>
              }
            >
              <span data-action="gate-status" class="settings-v2-security-control">
                <Pill tone={status().tone}>{status().label}</Pill>
                <Show when={!state.loading && !ready()}>
                  <ButtonV2 size="normal" variant="neutral" onClick={() => void refetch()}>
                    Retry
                  </ButtonV2>
                </Show>
              </span>
            </SettingsRowV2>

            <Show when={ready() && gate()}>
              {(g) => (
                <>
                  <SettingsRowV2 title={modeView(g().mode).title} description={modeView(g().mode).description}>
                    <Pill tone={g().mode === "enforce" ? "on" : "off"}>{g().mode === "enforce" ? "Enforce" : "Shadow"}</Pill>
                  </SettingsRowV2>
                  <SettingsRowV2
                    title="Sensitivity"
                    description="How readily Gate flags something. Set by your workspace's rollout, tuned around a 1% false-positive rate."
                  >
                    <span class="settings-v2-security-segmented" data-action="gate-sensitivity">
                      <For each={g().sensitivities}>
                        {(level) => (
                          <span data-selected={level === g().sensitivity ? "" : undefined}>{level}</span>
                        )}
                      </For>
                    </span>
                  </SettingsRowV2>
                  <SettingsRowV2 title="Checks" description="What each scan looks for.">
                    <span class="settings-v2-security-chips" data-action="gate-checks">
                      <For each={checkChips(g().availableChecks, g().categories)}>
                        {(c) => (
                          <span data-on={c.on ? "" : undefined} title={c.note ?? (c.on ? "On" : "Off")}>
                            {c.label}
                            <Show when={c.note}>
                              <em> · {c.note}</em>
                            </Show>
                          </span>
                        )}
                      </For>
                    </span>
                  </SettingsRowV2>
                  <SettingsRowV2
                    title="If Gate is unavailable"
                    description={
                      g().failOpen
                        ? "Your work carries on unscreened, and the miss is recorded below. A Gate outage never stops a conversation."
                        : "Anything Gate could not check is held, the same as something it flagged."
                    }
                  >
                    <Pill tone="off">{g().failOpen ? "Carry on" : "Hold"}</Pill>
                  </SettingsRowV2>
                  <Show when={g().org}>
                    <SettingsRowV2
                      title="Organization"
                      description="Your workspace's Gate account. Each organization has its own key and audit log; the key never leaves IRIS's servers."
                    >
                      <span class="settings-v2-security-mono">{g().org}</span>
                    </SettingsRowV2>
                  </Show>
                </>
              )}
            </Show>
          </SettingsListV2>
        </div>

        <Show when={ready() && gate()?.enabled}>
          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">Last {gate()!.stats.windowDays} days</h3>
            <div class="settings-v2-security-stats" data-action="gate-stats">
              <For each={statTiles(gate()!.stats)}>
                {(t) => (
                  <div class="settings-v2-security-stat">
                    <span data-slot="label">{t.label}</span>
                    <span data-slot="value">{t.value}</span>
                    <span data-slot="hint">{t.hint}</span>
                  </div>
                )}
              </For>
            </div>
          </div>

          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">Recent scans</h3>
            <SettingsListV2>
              <Show
                when={gate()!.recent.length > 0}
                fallback={
                  <SettingsRowV2 title="Nothing scanned yet" description="Scans appear here after your next conversation.">
                    <span />
                  </SettingsRowV2>
                }
              >
                <For each={gate()!.recent}>
                  {(e) => {
                    const v = eventView(e)
                    return (
                      <SettingsRowV2
                        title={
                          <span class="settings-v2-security-event-title">
                            <Pill tone={v.tone}>{v.label}</Pill>
                            {v.source}
                            <span class="settings-v2-security-mono settings-v2-security-faint">{eventTime(e.at)}</span>
                          </span>
                        }
                        description={v.detail || "Nothing found."}
                      >
                        <Show
                          when={v.reportable}
                          fallback={
                            <Show when={e.reportedFalse}>
                              <span class="settings-v2-security-faint">Reported</span>
                            </Show>
                          }
                        >
                          <ButtonV2
                            size="normal"
                            variant="neutral"
                            disabled={reporting() !== null}
                            onClick={() => void report(e)}
                          >
                            {reporting() === e.id ? "Sending…" : "Report a mistake"}
                          </ButtonV2>
                        </Show>
                      </SettingsRowV2>
                    )
                  }}
                </For>
              </Show>
            </SettingsListV2>
            <Show when={reportError()}>
              <p class="settings-v2-security-error">{reportError()}</p>
            </Show>
          </div>
        </Show>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">Health data</h3>
          <SettingsListV2>
            <SettingsRowV2
              title="Health-data guard"
              description={
                ready()
                  ? state()!.phiGuard.explanation
                  : "Shown once IRIS answers. Model calls that touch health data stay on providers covered for it."
              }
            >
              <Show when={ready()} fallback={<Pill tone="unknown">Unknown</Pill>}>
                <Pill tone={state()!.phiGuard.active ? "on" : "off"}>{state()!.phiGuard.active ? "Active" : "Not needed"}</Pill>
              </Show>
            </SettingsRowV2>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
