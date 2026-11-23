import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import "./iris-hive-scripts.css"
import "./iris-hive-sims.css"
import {
  atBottom,
  basis,
  duration,
  engineName,
  mergeRead,
  offsets,
  percent,
  pickRun,
  STATUS_WORD,
  transcript,
  type RunRead,
  type RunSummary,
  type RunView,
  type StepStatus,
} from "./iris-hive-sims-model"

/**
 * Hive › Simulations (#194084): a hive-simulations run, live, then its results. The agent starts
 * one with side_panel `simulate` (or anything POSTs /session/:id/hive-sim); this view lists the
 * chat's runs and follows one — its five steps, the progress, MEASURED vs DRAWN pinned at the top,
 * the engine's tables, the flip, and the raw output — with Stop while it runs.
 *
 * Under Hive because a simulation is the playbook that runs "on a machine you already own": the
 * same family as Scripts (a script sent to a machine) and Sessions (agents on machines). The runs
 * are the CHAT's — this panel is the chat's panel — so the list is this session's runs.
 */
const LIST_MS = 2_000
const READ_MS = 500

function Glyph(props: { status: StepStatus }) {
  return (
    <span class="hsm-glyph" data-status={props.status} aria-label={props.status} role="img">
      <Show when={props.status === "running"} fallback={props.status === "passed" ? "✓" : props.status === "failed" ? "✗" : "·"}>
        <span class="hsm-spinner" aria-hidden="true" />
      </Show>
    </span>
  )
}

export function IrisHiveSims(props: {
  doFetch: (path: string, init?: RequestInit) => Promise<Response>
  sessionId?: string
  directory?: string
  now?: () => number
}) {
  const now = () => props.now?.() ?? Date.now()
  const q = (extra?: string) => {
    const parts = [extra, props.directory ? `directory=${encodeURIComponent(props.directory)}` : undefined].filter(Boolean)
    return parts.length ? `?${parts.join("&")}` : ""
  }
  const base = () => `/session/${encodeURIComponent(props.sessionId ?? "")}/hive-sim`

  const [runs, setRuns] = createSignal<RunSummary[]>([])
  const [listError, setListError] = createSignal<string | undefined>()
  const [picked, setPicked] = createSignal<{ id: string; at: number } | undefined>()
  const [view, setView] = createSignal<RunView | undefined>()
  const [stopping, setStopping] = createSignal(false)
  const [rawOpen, setRawOpen] = createSignal(true)
  const [tick, setTick] = createSignal(now())

  const loadList = async () => {
    if (!props.sessionId) return
    try {
      const res = await props.doFetch(`${base()}${q()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { runs: RunSummary[] }
      setRuns(body.runs ?? [])
      setListError(undefined)
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e))
    }
  }

  const selected = createMemo(() => pickRun(runs(), picked()))

  // One reader at a time; a new selection starts from offset zero.
  let reading = false
  const read = async () => {
    const id = selected()
    if (!id || reading || !props.sessionId) return
    reading = true
    try {
      const cur = view()
      const from = cur && cur.id === id ? offsets(cur) : ""
      const res = await props.doFetch(`${base()}/${encodeURIComponent(id)}${q(from ? `from=${from}` : undefined)}`)
      if (!res.ok) return
      const r = (await res.json()) as RunRead
      if (selected() !== id) return
      setView((prev) => mergeRead(prev && prev.id === id ? prev : undefined, r))
    } catch {
      // A missed poll is retried on the next tick; the run is the engine's, not this view's.
    } finally {
      reading = false
    }
  }

  createEffect(
    on(selected, (id) => {
      if (view()?.id !== id) setView(undefined)
      void read()
    }),
  )

  void loadList()
  const listTimer = setInterval(() => void loadList(), LIST_MS)
  const readTimer = setInterval(() => {
    setTick(now())
    const v = view()
    if (!v || v.status === "running" || v.id !== selected()) void read()
  }, READ_MS)
  onCleanup(() => {
    clearInterval(listTimer)
    clearInterval(readTimer)
  })

  const stop = async () => {
    const id = selected()
    if (!id || stopping()) return
    setStopping(true)
    try {
      await props.doFetch(`${base()}/${encodeURIComponent(id)}/cancel${q()}`, { method: "POST" })
      await read()
      await loadList()
    } finally {
      setStopping(false)
    }
  }

  // Raw output: follow the end while the reader is at the end.
  let rawEl: HTMLPreElement | undefined
  let follow = true
  const raw = createMemo(() => {
    const v = view()
    return v ? transcript(v) : ""
  })
  createEffect(
    on(raw, () => {
      if (rawEl && follow) queueMicrotask(() => rawEl && (rawEl.scrollTop = rawEl.scrollHeight))
    }),
  )

  const pct = createMemo(() => percent(view()?.feed.progress))
  const b = createMemo(() => {
    const v = view()
    return v ? basis(v) : undefined
  })

  return (
    <div class="hsm" data-component="hive-sims">
      <Show
        when={props.sessionId}
        fallback={<p class="hsm-empty">Open a chat to see its simulations — they belong to the conversation that ran them.</p>}
      >
        <div class="hsm-runs" role="listbox" aria-label="Simulations">
          <For
            each={runs()}
            fallback={
              <p class="hsm-empty">
                {listError()
                  ? `Could not load simulations: ${listError()}`
                  : "No simulations in this chat yet. Ask the agent to run one — it uses the hive-simulations playbook, and the run shows here live."}
              </p>
            }
          >
            {(r) => (
              <button
                type="button"
                role="option"
                class="hsm-run"
                data-status={r.status}
                aria-selected={selected() === r.id}
                onClick={() => setPicked({ id: r.id, at: now() })}
                title={r.engine}
              >
                <Glyph status={r.status === "running" ? "running" : r.status === "passed" ? "passed" : "failed"} />
                <span class="hsm-run-name">{engineName(r.engine)}</span>
                <span class="hsm-run-meta hsc-num">
                  {r.status === "running" && percent(r.progress) !== undefined
                    ? `${percent(r.progress)}%`
                    : r.status === "running"
                      ? duration(tick() - r.started)
                      : STATUS_WORD[r.status]}
                </span>
              </button>
            )}
          </For>
        </div>

        <Show when={view()}>
          {(v) => (
            <div class="hsm-body" data-run={v().id} data-status={v().status}>
              {/* MEASURED vs DRAWN: pinned, never scrolled away, never blank. */}
              <div class="hsm-basis" data-kind={b()?.kind}>
                <Show when={b()?.kind === "feed" && b()} keyed>
                  {(x) =>
                    x.kind === "feed" && (
                      <>
                        <span class="hsm-basis-row">
                          <b class="hsm-measured">MEASURED</b>
                          <span>{x.measured.join(" · ") || "—"}</span>
                        </span>
                        <span class="hsm-basis-row">
                          <b class="hsm-drawn">DRAWN</b>
                          <span>{x.drawn.join(" · ") || "—"}</span>
                        </span>
                      </>
                    )
                  }
                </Show>
                <Show when={b()?.kind === "header" && b()} keyed>
                  {(x) => x.kind === "header" && <For each={x.lines}>{(l) => <span class="hsm-basis-row hsc-mono">{l}</span>}</For>}
                </Show>
                <Show when={b()?.kind === "missing" && b()} keyed>
                  {(x) =>
                    x.kind === "missing" && (
                      <span class="hsm-basis-row hsm-basis-missing">
                        {x.waiting
                          ? "MEASURED vs DRAWN: waiting for the engine's header…"
                          : "MEASURED vs DRAWN: this engine did not say which figures are guesses — the contract requires it. Treat every number as unlabelled."}
                      </span>
                    )
                  }
                </Show>
              </div>

              <div class="hsm-head">
                <div class="hsm-title">
                  <span class="hsm-engine" title={v().engine}>
                    {engineName(v().engine)}
                  </span>
                  <span class="hsm-status" data-status={v().status}>
                    {STATUS_WORD[v().status]}
                  </span>
                  <span class="hsc-spacer" />
                  <Show when={v().status === "running"}>
                    <button type="button" class="hsm-stop" data-action="hive-sim-stop" disabled={stopping()} onClick={() => void stop()}>
                      {stopping() ? "Stopping…" : "Stop"}
                    </button>
                  </Show>
                </div>
                <div class="hsm-knobs hsc-num">
                  worlds {v().knobs.worlds} · cohort {v().knobs.cohort} · {v().knobs.days}d · {v().knobs.refresh ? "fresh pull" : "data on disk"} ·{" "}
                  {duration((v().ended ?? tick()) - v().started)}
                </div>
                <Show when={v().reason && v().status !== "passed"}>
                  <p class="hsm-reason">{v().reason}</p>
                </Show>
              </div>

              <Show when={pct() !== undefined}>
                <div class="hsm-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct()}>
                  <div class="hsm-progress-fill" style={{ width: `${pct()}%` }} />
                  <span class="hsm-progress-label hsc-num">
                    {v().feed.progress!.done} / {v().feed.progress!.total} · {pct()}%
                  </span>
                </div>
              </Show>

              <ol class="hsm-steps">
                <For each={v().steps}>
                  {(s) => (
                    <li class="hsm-step" data-step={s.id} data-status={s.status}>
                      <Glyph status={s.status} />
                      <div class="hsm-step-main">
                        <div class="hsm-step-line">
                          <span class="hsm-step-title">{s.title}</span>
                          <span class="hsm-step-time hsc-num">
                            {s.started !== null && s.id !== "flip" ? duration((s.ended ?? tick()) - s.started) : ""}
                          </span>
                        </div>
                        <Show when={s.reason}>
                          <div class="hsm-step-reason" data-status={s.status}>
                            {s.reason}
                          </div>
                        </Show>
                      </div>
                    </li>
                  )}
                </For>
              </ol>

              <For each={v().feed.flips}>
                {(f) => (
                  <div class="hsm-flip" data-flip>
                    <div class="hsm-flip-head">
                      <span aria-hidden="true">⇄</span> The guess that flips it
                    </div>
                    <p class="hsm-flip-text">{f.text}</p>
                    <Show when={f.input || f.range}>
                      <p class="hsm-flip-meta hsc-num">
                        {f.input ? `input: ${f.input}` : ""}
                        {f.input && f.range ? " · " : ""}
                        {f.range ? `range: ${f.range}` : ""}
                      </p>
                    </Show>
                  </div>
                )}
              </For>

              <For each={v().feed.tables}>
                {(t) => (
                  <div class="hsm-table" data-table={t.title}>
                    <div class="hsm-table-title">{t.title}</div>
                    <div class="hsm-table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <For each={t.columns}>{(c) => <th>{c}</th>}</For>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={t.rows}>
                            {(row) => (
                              <tr>
                                <For each={row}>{(c) => <td class="hsc-num">{c}</td>}</For>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </For>

              <Show when={v().feed.ignored > 0}>
                <p class="hsm-note">
                  {v().feed.ignored} line{v().feed.ignored === 1 ? "" : "s"} of the engine's event feed did not parse and were ignored.
                </p>
              </Show>

              <div class="hsm-raw">
                <button type="button" class="hsm-raw-toggle" aria-expanded={rawOpen()} onClick={() => setRawOpen(!rawOpen())}>
                  <span aria-hidden="true">{rawOpen() ? "▾" : "▸"}</span> Raw output
                  <Show when={v().steps.some((s) => s.truncated)}>
                    <span class="hsm-note"> (earlier output dropped by the 1 MB cap)</span>
                  </Show>
                </button>
                <Show when={rawOpen()}>
                  <pre
                    class="hsm-raw-text hsc-mono"
                    ref={(el) => (rawEl = el)}
                    onScroll={(e) => (follow = atBottom(e.currentTarget))}
                  >
                    {raw() || "(no output yet)"}
                  </pre>
                </Show>
              </div>
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}
