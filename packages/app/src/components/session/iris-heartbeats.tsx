import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import "./iris-hive-scripts.css"
import "./iris-hive-machines.css"
import "./iris-heartbeats.css"
import { ago } from "./iris-hive-scripts-model"
import {
  beatSummary,
  cadenceOf,
  durationOf,
  lastBeatAt,
  lineOf,
  modeOf,
  previewOf,
  problemsOf,
  sortBeats,
  stateOf,
  stripOf,
  tokensOf,
  untilOf,
  type HeartbeatRow,
} from "./iris-heartbeats-model"

/**
 * Agents › Heartbeats (#189110): every agent that runs on its own schedule — is it beating, did
 * the last beat work, when is the next — with Run now and Pause on the one you pick.
 */
type IconName = IconProps["name"]
type Payload = { measured: boolean; reason?: string | null; heartbeats: HeartbeatRow[] }
type Action = { ok: boolean; reason?: string; status?: string }

const STATE_WORD = { late: "Late", failing: "Failing", running: "Beating", ok: "OK", paused: "Paused" } as const

function Ic(props: { name: IconName; title?: string }) {
  return (
    <span class="hsc-ic" title={props.title} aria-hidden={props.title ? undefined : "true"}>
      <Icon name={props.name} size="small" />
    </span>
  )
}

export function IrisHeartbeats(props: {
  doFetch: (path: string, init?: RequestInit) => Promise<Response>
  now?: () => number
}) {
  const now = () => props.now?.() ?? Date.now()
  const [data, { refetch }] = createResource(async (): Promise<Payload> => {
    try {
      const res = await props.doFetch("/iris/heartbeats")
      return (await res.json()) as Payload
    } catch (e) {
      return { measured: false, reason: e instanceof Error ? e.message : String(e), heartbeats: [] }
    }
  })
  const timer = setInterval(() => void refetch(), 60_000)
  onCleanup(() => clearInterval(timer))

  const [q, setQ] = createSignal("")
  const rows = createMemo(() => {
    const words = q().toLowerCase().split(/\s+/).filter(Boolean)
    const all = sortBeats(data.latest?.heartbeats ?? [], now())
    if (!words.length) return all
    return all.filter((r) => {
      const hay = `${r.agentName} ${r.bloqName ?? ""} ${r.mode ?? ""} ${cadenceOf(r.frequency)}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  })
  const summary = createMemo(() => beatSummary(data.latest?.heartbeats ?? [], now()))

  const [openId, setOpenId] = createSignal<number | undefined>()
  const open = createMemo(() => rows().find((r) => r.jobId === openId()) ?? rows()[0])

  // One action at a time per heartbeat; the answer is shown where the button was pressed.
  const [busy, setBusy] = createSignal<number | undefined>()
  const [note, setNote] = createSignal<{ jobId: number; ok: boolean; text: string } | undefined>()
  const act = async (r: HeartbeatRow, kind: "run" | "pause" | "resume") => {
    setBusy(r.jobId)
    setNote(undefined)
    try {
      const res =
        kind === "run"
          ? await props.doFetch(`/iris/heartbeats/${r.jobId}/run`, { method: "POST" })
          : await props.doFetch(`/iris/heartbeats/${r.jobId}/pause`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ paused: kind === "pause" }),
            })
      const a = (await res.json()) as Action
      setNote({
        jobId: r.jobId,
        ok: a.ok,
        text: a.ok
          ? kind === "run"
            ? "Sent. The beat shows up here when it finishes."
            : kind === "pause"
              ? "Paused. It will not beat until you resume it."
              : "Resumed."
          : `Did not work — ${a.reason ?? "unknown error"}`,
      })
      void refetch()
      if (a.ok && kind === "run") setTimeout(() => void refetch(), 20_000)
    } catch (e) {
      setNote({ jobId: r.jobId, ok: false, text: `Did not work — ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setBusy(undefined)
    }
  }

  const [copied, setCopied] = createSignal(false)
  const copyCli = async (r: HeartbeatRow) => {
    try {
      await navigator.clipboard.writeText(`iris monitor agent ${r.agentId}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {}
  }

  return (
    <div class="hsc-wrap">
      <div class="hmc hbt">
        <section class="hmc-main" aria-label="Agent heartbeats">
          <header class="hmc-top">
            <div class="hmc-sum">
              <span>
                <b class="hsc-num">{summary().beating}</b> of <b class="hsc-num">{summary().total}</b> beating
              </span>
              <Show when={summary().attention}>
                <span class="hmc-att">
                  <Ic name="warning" />
                  <b class="hsc-num">{summary().attention}</b> need{summary().attention === 1 ? "s" : ""} attention
                </span>
              </Show>
              <Show when={summary().paused}>
                <span class="hsc-muted">
                  <b class="hsc-num">{summary().paused}</b> paused
                </span>
              </Show>
            </div>
            <input
              class="hbt-find"
              type="search"
              placeholder="Find an agent or board"
              aria-label="Find a heartbeat"
              value={q()}
              onInput={(e) => setQ(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQ("")
                if (e.key === "Enter" && rows()[0]) setOpenId(rows()[0].jobId)
              }}
            />
          </header>

          <Show when={data.latest && !data.latest.measured}>
            <p class="hsc-warn">Could not read your heartbeats{data.latest!.reason ? ` — ${data.latest!.reason}` : ""}</p>
          </Show>
          <Show when={data.loading && !data.latest}>
            <p class="hsc-muted hbt-loading">Reading heartbeats…</p>
          </Show>
          <Show when={data.latest?.measured && (data.latest?.heartbeats.length ?? 0) === 0}>
            <p class="hsc-muted hmc-empty">
              No agent has a heartbeat yet. Give one a schedule with{" "}
              <code class="hsc-mono">iris agents update &lt;id&gt; --heartbeat-mode autonomous</code>.
            </p>
          </Show>
          <Show when={(data.latest?.heartbeats.length ?? 0) > 0 && rows().length === 0}>
            <p class="hsc-muted hmc-empty">Nothing matches “{q()}”.</p>
          </Show>

          <ul class="hbt-list" role="listbox" aria-label="Heartbeats">
            <For each={rows()}>
              {(r) => {
                const st = () => stateOf(r, now())
                return (
                  <li
                    class="hbt-row"
                    role="option"
                    tabindex="0"
                    data-state={st()}
                    aria-selected={open()?.jobId === r.jobId}
                    onClick={() => setOpenId(r.jobId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        setOpenId(r.jobId)
                      }
                    }}
                  >
                    <i class="hbt-dot" data-state={st()} aria-hidden="true" />
                    <div class="hbt-who">
                      <span class="hbt-name" title={r.agentName}>
                        {r.agentName}
                      </span>
                      <span class="hbt-line" data-state={st()}>
                        {lineOf(r, now())}
                      </span>
                    </div>
                    <span class="hbt-cad">{cadenceOf(r.frequency)}</span>
                    <span class="hbt-strip" title="Last beats, oldest to newest" aria-hidden="true">
                      <For each={stripOf(r)}>{(b) => <i data-b={b} />}</For>
                    </span>
                  </li>
                )
              }}
            </For>
          </ul>
        </section>

        <Show when={open()}>
          {(r) => {
            const st = () => stateOf(r(), now())
            const probs = () => problemsOf(r(), now())
            const paused = () => st() === "paused"
            const mine = () => note()?.jobId === r().jobId
            return (
              <aside class="hmc-detail" aria-label={r().agentName}>
                <h3 class="hmc-dname">
                  <i class="hbt-dot" data-state={st()} aria-hidden="true" />
                  <span title={r().agentName}>{r().agentName}</span>
                  <span class="hbt-badge" data-state={st()}>
                    {STATE_WORD[st()]}
                  </span>
                </h3>
                <p class="hmc-spec">
                  {[cadenceOf(r().frequency), modeOf(r().mode), r().bloqName].filter(Boolean).join(" · ")}
                </p>
                <div class="hmc-acts">
                  <button
                    type="button"
                    class="hmc-btn hmc-btn--go"
                    disabled={busy() === r().jobId || st() === "running"}
                    title="One beat now, outside the schedule"
                    onClick={() => void act(r(), "run")}
                  >
                    <Ic name="arrow-right" />
                    Run now
                  </button>
                  <button
                    type="button"
                    class="hmc-btn"
                    disabled={busy() === r().jobId}
                    title={paused() ? "Put it back on its schedule" : "Stop it beating until you resume it"}
                    onClick={() => void act(r(), paused() ? "resume" : "pause")}
                  >
                    {paused() ? "Resume" : "Pause"}
                  </button>
                  <button type="button" class="hmc-btn" title={`iris monitor agent ${r().agentId}`} onClick={() => void copyCli(r())}>
                    <Ic name={copied() ? "check" : "copy"} />
                    {copied() ? "Copied" : "CLI"}
                  </button>
                </div>
                <Show when={mine()}>
                  <p class="hbt-note" data-ok={note()!.ok ? "1" : undefined} role="status">
                    {note()!.text}
                  </p>
                </Show>

                <Show when={r().agentActive === false && !paused()}>
                  <p class="hsc-muted hbt-aside">
                    The agent itself is switched off, but this heartbeat still runs on schedule. Pause it here to stop it.
                  </p>
                </Show>
                <Show when={probs().length}>
                  <ul class="hmc-att-list">
                    <For each={probs()}>
                      {(p) => (
                        <li data-level={p.kind === "late" || p.kind === "stopped" ? "crit" : "warn"}>
                          <b>{p.text}</b>
                          <Show when={p.fix}>
                            <span>{p.fix}</span>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>

                <dl class="hmc-stats">
                  <div>
                    <dt>Last beat</dt>
                    <dd class="hsc-num">{ago(lastBeatAt(r()), now())}</dd>
                  </div>
                  <div>
                    <dt>Next beat</dt>
                    <dd class="hsc-num" data-low={st() === "late" ? "1" : undefined}>
                      {paused() ? "paused" : untilOf(r().nextRunAt, now())}
                    </dd>
                  </div>
                  <div>
                    <dt>Beats so far</dt>
                    <dd class="hsc-num">{r().runCount.toLocaleString("en-US")}</dd>
                  </div>
                  <div>
                    <dt>Reports to</dt>
                    <dd class="hsc-num">{r().reportTo ? `${r().reportTo} ${r().reportTo === 1 ? "person" : "people"}` : "nobody"}</dd>
                  </div>
                </dl>

                <h4 title="fl-api does not record every beat; these are the ones it kept">Recorded beats</h4>
                <Show
                  when={r().runs.length}
                  fallback={
                    <p class="hsc-muted">
                      {r().runsMeasured ? "No beats recorded yet." : "Could not read its beats — try again in a minute."}
                    </p>
                  }
                >
                  <ol class="hbt-runs">
                    <For each={r().runs}>
                      {(x) => {
                        const kind = () =>
                          x.status === "running" || x.status === "pending"
                            ? "run"
                            : x.status === "failed" || x.status === "error" || x.error
                              ? "fail"
                              : "ok"
                        return (
                          <li data-b={kind()}>
                            <div class="hbt-run-top">
                              <i aria-hidden="true" />
                              <span>{kind() === "run" ? "Running" : kind() === "fail" ? "Failed" : "Worked"}</span>
                              <span class="hsc-num hbt-when">{ago(x.completedAt ?? x.startedAt, now())}</span>
                            </div>
                            <Show when={x.error || x.preview}>
                              <p class="hbt-run-body" data-fail={x.error ? "1" : undefined}>
                                {x.error ? previewOf(x.error) : previewOf(x.preview)}
                              </p>
                            </Show>
                            <p class="hbt-run-meta hsc-num">
                              {[
                                durationOf(x.durationMs) !== "—" ? durationOf(x.durationMs) : null,
                                x.tokens != null ? `${tokensOf(x.tokens)} tokens` : null,
                                x.model,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                          </li>
                        )
                      }}
                    </For>
                  </ol>
                </Show>

                <details class="hmc-dev">
                  <summary>For developers</summary>
                  <p class="hsc-mono">
                    job {r().jobId} · agent {r().agentId} · status {r().status}
                    {r().tools ? ` · ${r().tools} tools` : ""}
                  </p>
                </details>
              </aside>
            )
          }}
        </Show>
      </div>
    </div>
  )
}
