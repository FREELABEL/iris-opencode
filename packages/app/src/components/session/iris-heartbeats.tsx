import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import "./iris-hive-scripts.css"
import "./iris-hive-machines.css"
import "./iris-heartbeats.css"
import { ago } from "./iris-hive-scripts-model"
import {
  beatStory,
  beatSummary,
  cadenceOf,
  durationOf,
  errorOf,
  kindOf,
  lastBeatAt,
  rollupOf,
  runAt,
  weekOf,
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
  type HeartbeatRun,
} from "./iris-heartbeats-model"

/**
 * Agents › Heartbeats (#189110): every agent that runs on its own schedule — is it beating, did
 * the last beat work, when is the next — with Run now and Pause on the one you pick.
 */
type IconName = IconProps["name"]
type Payload = { measured: boolean; reason?: string | null; heartbeats: HeartbeatRow[] }
type Action = { ok: boolean; reason?: string; status?: string }

const STATE_WORD = { late: "Late", silent: "Skipping", failing: "Failing", running: "Beating", ok: "OK", paused: "Paused" } as const
const TIMELINE = 10

/** "Tue 14:05" — a beat's time, stated, not aged: a timeline is read across days. */
function shortWhen(x: HeartbeatRun): string {
  const at = runAt(x)
  if (!Number.isFinite(at)) return "—"
  const d = new Date(at)
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`
}

/** One line of what the beat was about — the error if it failed, else its status sentence. */
function gistOf(x: HeartbeatRun): string {
  const e = errorOf(x)
  if (e) return e
  const story = beatStory(x)
  return previewOf(story.happened ?? story.changed ?? x.preview).slice(0, 120)
}

const W = 360
const H = 92
const BASE = 62

/** The week (#189127): every wake the schedule called for, every beat that happened, the gaps. */
function Week(props: { row: HeartbeatRow; now: number; picked?: number; onPick: (id: number) => void }) {
  const w = () => weekOf(props.row, props.now)
  const roll = () => rollupOf(props.row, props.now)
  const x = (ms: number) => ((ms - w().start) / (w().end - w().start)) * W
  return (
    <figure class="hbt-week" aria-label="The last seven days">
      <figcaption>
        <b>This week</b>
        <span class="hsc-num">
          {roll().beats} worked
          {roll().failed ? ` · ${roll().failed} failed` : ""}
          {roll().missed ? ` · ${roll().missed} skipped` : ""}
          {roll().expected ? ` · of ${roll().expected} due` : ""}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${roll().beats} beats worked, ${roll().failed} failed, ${roll().missed} skipped this week`}>
        <For each={w().days}>
          {(d) => (
            <>
              <line class="hbt-wday" x1={x(d.at)} x2={x(d.at)} y1={10} y2={BASE + 8} />
              <text class="hbt-wlbl" data-off={d.on ? undefined : "1"} x={x(d.at) + 3} y={H - 8}>
                {d.label}
              </text>
            </>
          )}
        </For>
        <line class="hbt-wbase" x1={0} x2={W} y1={BASE} y2={BASE} />
        <For each={w().expected}>{(e) => <line class="hbt-wdue" x1={x(e)} x2={x(e)} y1={BASE - 5} y2={BASE + 5} />}</For>
        <For each={w().missed}>{(e) => <circle class="hbt-wmiss" cx={x(e)} cy={BASE} r={2.6} />}</For>
        <For each={w().beats}>
          {(b) => (
            <line
              class="hbt-wbeat"
              data-b={b.kind}
              data-picked={props.picked === b.id ? "1" : undefined}
              x1={x(b.at)}
              x2={x(b.at)}
              y1={BASE}
              y2={b.kind === "fail" ? BASE - 46 : BASE - 34}
              onClick={() => props.row.runs.slice(0, TIMELINE).some((r) => r.id === b.id) && props.onPick(b.id)}
            >
              <title>{new Date(b.at).toLocaleString()}</title>
            </line>
          )}
        </For>
        <line class="hbt-wnow" x1={W - 1} x2={W - 1} y1={6} y2={BASE + 8} />
      </svg>
      <p class="hbt-wkey">
        <span><i data-k="ok" /> worked</span>
        <span><i data-k="fail" /> failed</span>
        <span><i data-k="miss" /> due, did not run</span>
        <span class="hsc-num">{w().next && props.row.status !== "paused"
            ? w().next! > props.now
              ? `next ${untilOf(new Date(w().next!).toISOString(), props.now)}`
              : `was due ${untilOf(new Date(w().next!).toISOString(), props.now)}`
            : ""}</span>
      </p>
      <Show when={roll().unknown}>
        <p class="hbt-wtools">
          {roll().unknown} earlier wake{roll().unknown === 1 ? "" : "s"} not shown: the platform keeps only its newest beat
          for now (#189132).
        </p>
      </Show>
      <Show when={roll().tools.length}>
        <p class="hbt-wtools">
          Used{" "}
          {roll()
            .tools.slice(0, 4)
            .map(([n, c]) => `${n} ×${c}`)
            .join(" · ")}
        </p>
      </Show>
    </figure>
  )
}

/** One beat, opened: what happened, what changed, what it did, what it left — or why it failed. */
function BeatDetail(props: { run: HeartbeatRun }) {
  const s = () => beatStory(props.run)
  const x = props.run
  const outs = () =>
    [
      x.publicUrl ? { href: x.publicUrl, label: "Open the result" } : null,
      x.itemId ? { href: `https://heyiris.io/item/${x.itemId}`, label: `Item #${x.itemId}` } : null,
      x.deliverableId ? { href: undefined, label: `Deliverable #${x.deliverableId}` } : null,
      x.emailSent ? { href: undefined, label: "Report emailed" } : null,
    ].filter((o): o is { href: string | undefined; label: string } => !!o)
  const Part = (p: { title: string; body: string | null }) => (
    <Show when={p.body}>
      <div class="hbt-part">
        <h5>{p.title}</h5>
        <p>{previewOf(p.body)}</p>
      </div>
    </Show>
  )
  return (
    <div class="hbt-beat">
      <Show when={s().error}>
        <div class="hbt-part hbt-part--fail">
          <h5>Why it failed</h5>
          <p>{s().error}</p>
          <Show when={s().laundered}>
            <p class="hbt-fine">Recorded as a success — the model call failed and its error became the reply (#189114).</p>
          </Show>
        </div>
      </Show>
      <Part title="What happened" body={s().happened} />
      <Part title="What changed since the last beat" body={s().changed} />
      <Part title="What it did" body={s().did} />
      <Part title="Numbers" body={s().numbers} />
      <For each={s().rest}>{(r) => <Part title={r.title} body={r.body} />}</For>
      <Show when={s().tools.length}>
        <div class="hbt-part">
          <h5>Tools it called</h5>
          <ul class="hbt-tools">
            <For each={s().tools}>
              {(t) => (
                <li data-ok={t.ok ? "1" : undefined}>
                  <span class="hsc-mono">{t.name}</span> {t.did}
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
      <div class="hbt-part">
        <h5>Result</h5>
        <Show when={outs().length} fallback={<p class="hsc-muted">Left nothing behind — no item, page or email recorded.</p>}>
          <p class="hbt-outs">
            <For each={outs()}>
              {(o) => (o.href ? <a href={o.href} target="_blank" rel="noreferrer">{o.label}</a> : <span>{o.label}</span>)}
            </For>
          </p>
        </Show>
      </div>
      <Show when={!s().error && !s().happened && !s().changed && !s().did && !s().rest.length && !s().tools.length}>
        <p class="hsc-muted">This beat kept no report.</p>
      </Show>
      <p class="hbt-run-meta hsc-num">
        {[
          durationOf(x.durationMs) !== "—" ? durationOf(x.durationMs) : null,
          x.tokens != null ? `${tokensOf(x.tokens)} tokens` : null,
          x.model,
          `run ${x.id}`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </div>
  )
}

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
  // The opened beat. A different agent starts closed; a refresh keeps it open (ids are stable).
  const [beatId, setBeatId] = createSignal<number | undefined>()
  createEffect(on(() => open()?.jobId, () => setBeatId(undefined), { defer: true }))

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
                    <dt title="The newest beat that actually ran — a recorded run">Last real beat</dt>
                    <dd class="hsc-num" data-low={st() === "silent" ? "1" : undefined}>
                      {lastBeatAt(r()) ? ago(lastBeatAt(r()), now()) : "never"}
                    </dd>
                  </div>
                  <div>
                    <dt>Next beat</dt>
                    <dd class="hsc-num" data-low={st() === "late" ? "1" : undefined}>
                      {paused() ? "paused" : untilOf(r().nextRunAt, now())}
                    </dd>
                  </div>
                  <div>
                    <dt title="When the scheduler last woke it, whether or not it then did anything (#189113)">Last woke</dt>
                    <dd class="hsc-num">{ago(r().lastRunAt, now())}</dd>
                  </div>
                  <div>
                    <dt>Reports to</dt>
                    <dd class="hsc-num">{r().reportTo ? `${r().reportTo} ${r().reportTo === 1 ? "person" : "people"}` : "nobody"}</dd>
                  </div>
                </dl>

                <Week row={r()} now={now()} picked={beatId()} onPick={setBeatId} />

                <h4>{r().runs.length === 1 ? "Last beat" : `Last ${Math.min(TIMELINE, r().runs.length) || ""} beats`}</h4>
                <Show
                  when={r().runs.length}
                  fallback={
                    <p class="hsc-muted">
                      {r().runsMeasured ? "No beat has been recorded yet." : "Could not read its beats — try again in a minute."}
                    </p>
                  }
                >
                  <ol class="hbt-runs" aria-label="Beats, newest first">
                    <For each={r().runs.slice(0, TIMELINE)}>
                      {(x) => {
                        const k = () => kindOf(x)
                        const isOpen = () => beatId() === x.id
                        return (
                          <li data-b={k()} data-open={isOpen() ? "1" : undefined}>
                            <button
                              type="button"
                              class="hbt-run-top"
                              aria-expanded={isOpen()}
                              onClick={() => setBeatId(isOpen() ? undefined : x.id)}
                            >
                              <i aria-hidden="true" />
                              <span>{k() === "run" ? "Running" : k() === "fail" ? "Failed" : "Worked"}</span>
                              <span class="hbt-run-gist">{gistOf(x)}</span>
                              <span class="hsc-num hbt-when">{shortWhen(x)}</span>
                            </button>
                            <Show when={isOpen()}>
                              <BeatDetail run={x} />
                            </Show>
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
