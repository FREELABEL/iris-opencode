import { createMemo, createResource, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import "./iris-hive-scripts.css"
import "./iris-hive-machines.css"
import "./iris-pulse.css"
import {
  bandWord,
  blindLine,
  pinsOf,
  priorLine,
  PROVENANCE_WORD,
  runsLine,
  sparkOf,
  tallyOf,
  readAgo,
  topicParts,
  touchedLine,
  whenOf,
  type ContactPulse,
  type ContactRow,
  type PulseStop,
  type TopicPulse,
} from "./iris-pulse-model"

/**
 * Pulse (#189286) — heyiris.io/p/pulse-panel-directions, pick 01 "the route".
 *
 * A pickup route: every pulse drives a fixed route of stops and, at each one, picks up what is
 * there, notes what is owed, and says which doors it could not get through. Two routes — a topic
 * and a contact. OPENING NEVER WRITES: the sidecar endpoints are GETs, and nothing on this panel
 * files, sends or heals.
 */
type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type Payload<T> = { measured: boolean; reason?: string | null; data: T }
const WINDOWS = [7, 30, 90] as const

function remember(key: string, value?: string): string | undefined {
  try {
    if (value === undefined) return localStorage.getItem(key) ?? undefined
    localStorage.setItem(key, value)
  } catch {}
  return value
}

async function getJson<T>(doFetch: Fetch, path: string, empty: T): Promise<Payload<T>> {
  try {
    const res = await doFetch(path)
    if (!res.ok) return { measured: false, reason: `HTTP ${res.status}`, data: empty }
    return (await res.json()) as Payload<T>
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: empty }
  }
}

function Mark(props: { p: PulseStop["provenance"] }) {
  return <i class="pls-mark" data-p={props.p} title={PROVENANCE_WORD[props.p]} aria-label={PROVENANCE_WORD[props.p]} />
}

function Windows(props: { days: number; onPick: (d: number) => void }) {
  return (
    <span class="hmc-seg" role="tablist" aria-label="Window">
      <For each={WINDOWS}>
        {(d) => (
          <button type="button" role="tab" aria-selected={props.days === d} onClick={() => props.onPick(d)}>
            <span class="hsc-num">{d}d</span>
          </button>
        )}
      </For>
    </span>
  )
}

/** The route itself: one stop per row, in the order Pulse visits them. */
function Route(props: { stops: PulseStop[]; picked: string | undefined; onPick: (id: string) => void }) {
  const pins = createMemo(() => pinsOf(props.stops))
  return (
    <ol class="pls-route" aria-label="The route, in the order Pulse visits each stop">
      <For each={props.stops}>
        {(s, i) => {
          const t = () => tallyOf(s)
          return (
            <li
              class="pls-stop"
              tabindex="0"
              role="button"
              data-shut={s.shut ? "1" : undefined}
              data-tone={t().tone}
              data-owed={s.owed ? "1" : undefined}
              aria-pressed={props.picked === s.id}
              onClick={() => props.onPick(s.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  props.onPick(s.id)
                }
              }}
            >
              <span class="pls-pin hsc-num" aria-hidden="true">
                {pins()[i()]}
              </span>
              <div class="pls-body">
                <h4>{s.label}</h4>
                <p>{s.text}</p>
                <Show when={s.shut && s.fix}>
                  {(f) => <span class="pls-fix">{f().command ? <code class="hsc-mono">{f().command}</code> : f().label}</span>}
                </Show>
              </div>
              <span class="pls-tally">
                <span class="pls-main hsc-num">{t().main}</span>
                <Show when={t().delta}>
                  <span class="pls-delta hsc-num" data-up={t().delta!.startsWith("+") ? "1" : undefined}>
                    {t().delta}
                  </span>
                </Show>
                <Show when={s.owed && s.id === "tasks"}>
                  <span class="pls-owe hsc-num" title={`${s.owed} overdue`}>
                    {s.owed}
                  </span>
                </Show>
                <Mark p={s.provenance} />
              </span>
            </li>
          )
        }}
      </For>
    </ol>
  )
}

function Legend() {
  return (
    <p class="pls-legend">
      <span>
        <Mark p="measured" /> measured
      </span>
      <span>
        <Mark p="partial" /> partial
      </span>
      <span>
        <Mark p="not-kept" /> not kept
      </span>
      <span>
        <Mark p="not-measured" /> not measured — shut, never 0
      </span>
    </p>
  )
}

/** The picked stop: what it picked up, where it was read from. */
function StopDetail(props: { stop: PulseStop | undefined; index: string; now: number; children?: JSX.Element }) {
  const [copied, setCopied] = createSignal(false)
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {}
  }
  return (
    <aside class="hmc-detail pls-detail" aria-label="Stop detail">
      <Show when={props.stop} fallback={<p class="hsc-muted">Pick a stop to see what it picked up.</p>}>
        {(s) => (
          <>
            <h3 class="hmc-dname">
              <span>
                Stop {props.index} · {s().label}
              </span>
              <b class="hsc-num pls-dcount">{tallyOf(s()).main}</b>
            </h3>
            <p class="hmc-spec">
              <Mark p={s().provenance} /> {PROVENANCE_WORD[s().provenance]}
            </p>
            <Show when={s().reason && !s().shut}>
              <p class="pls-caveat">{s().reason}</p>
            </Show>
            <Show when={s().items.length} fallback={<p class="hsc-muted">{s().shut ? s().text : "Nothing to itemise."}</p>}>
              <ul class="pls-items">
                <For each={s().items}>
                  {(it) => (
                    <li>
                      <span class="pls-iw">{it.where || it.text}</span>
                      <Show when={it.where && it.text}>
                        <span class="pls-it">{it.text}</span>
                      </Show>
                      <span class="hsc-muted pls-iwhen">{whenOf(it.when, props.now)}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={s().from}>
              {(f) => (
                <>
                  <h4>Read from</h4>
                  <button type="button" class="pls-cmd hsc-mono" title="Copy" onClick={() => void copy(f())}>
                    {f()}
                    <span class="hsc-muted">{copied() ? " copied" : ""}</span>
                  </button>
                </>
              )}
            </Show>
          </>
        )}
      </Show>
      {props.children}
    </aside>
  )
}

// ── topic ────────────────────────────────────────────────────────────────────

/**
 * Run the route again, with how old the numbers on screen are. The age matters as much as the
 * button: it is how you know whether to press it. Re-runs exactly what is shown.
 */
function Ico(props: { d: string[]; rect?: { x: number; y: number; w: number; h: number } }) {
  return (
    <svg class="pls-ico" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <Show when={props.rect}>{(r) => <rect x={r().x} y={r().y} width={r().w} height={r().h} rx="2" />}</Show>
      <For each={props.d}>{(d) => <path d={d} />}</For>
    </svg>
  )
}
// lucide (ISC): refresh-cw, building-2, lock
const REFRESH = ["M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5"]
const BUILDING = ["M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z", "M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2", "M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2", "M10 6h4", "M10 10h4", "M10 14h4", "M10 18h4"]
const LOCK = ["M7 11V7a5 5 0 0 1 10 0v4"]

function Again(props: { at?: number; now: () => number; onRun: () => void; label?: string }) {
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((n) => n + 1), 30_000)
  onCleanup(() => clearInterval(timer))
  const ago = () => (tick(), readAgo(props.at, props.now()))
  const label = () => props.label ?? "Run again"
  return (
    <span class="pls-again">
      <Show when={ago()}>{(t) => <span class="pls-ago">{t().replace(/^read /, "")}</span>}</Show>
      <button type="button" class="pls-again-btn" onClick={props.onRun} aria-label={label()} title={`${label()}${ago() ? ` · ${ago()}` : ""}`}>
        <Ico d={REFRESH} />
      </button>
    </span>
  )
}

/** What the streamed route has reported so far (#189319). */
type Live = { current?: string; done: Record<string, PulseStop> }

/**
 * Read the streamed topic route (#189319): `start` as Pulse reaches a stop, `stop` as it lands,
 * then `done` with the whole route. Returns null when there is no stream to read — an older
 * sidecar without the endpoint, or a fetch that cannot hand back a body — so the caller falls
 * back to the one-shot route.
 */
async function streamTopic(doFetch: Fetch, path: string, onLive: (l: Live) => void): Promise<Payload<TopicPulse | null> | null> {
  let res: Response
  try {
    res = await doFetch(path, { headers: { Accept: "text/event-stream" } })
  } catch {
    return null
  }
  if (!res.ok || !res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) return null
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  let live: Live = { done: {} }
  for (;;) {
    const { value, done } = await reader.read()
    if (value) buf += dec.decode(value, { stream: true })
    let cut: number
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, cut)
      buf = buf.slice(cut + 2)
      let event = "message"
      let data = ""
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim()
        else if (line.startsWith("data:")) data += line.slice(5).trimStart()
      }
      if (!data) continue
      const body = JSON.parse(data)
      if (event === "start") live = { ...live, current: body.source }
      else if (event === "stop") live = { current: live.current === body.stop.id ? undefined : live.current, done: { ...live.done, [body.stop.id]: body.stop } }
      else if (event === "done") return body as Payload<TopicPulse | null>
      else if (event === "error") return { measured: false, reason: body.reason ?? "the route did not finish", data: null }
      onLive(live)
    }
    if (done) return { measured: false, reason: "the route stopped before it finished", data: null }
  }
}

/**
 * The route while it is being driven.
 *
 * TOPIC is sequential (pulse/topic.ts: disk- and AppleScript-bound sources, one at a time), and it
 * is streamed (#189319): a stop that has landed shows its real count, the stop being read now
 * pulses, the ones ahead wait. CONTACT reads its stops in parallel (Promise.all) and is not
 * streamed, so every pin pulses together and a light runs down the rail — drawing them lit in turn
 * would claim an order that is not happening. Either way a clock counts, so a slow read never
 * looks frozen, and no number appears before it exists.
 */
function PulseRunning(props: { stops: { id: string; label: string }[]; usual: string; label: string; live?: Live }) {
  const started = Date.now()
  const [t, setT] = createSignal(0)
  const timer = setInterval(() => setT(Date.now() - started), 100)
  onCleanup(() => clearInterval(timer))
  const sequential = () => !!props.live
  const state = (id: string): "read" | "reading" | "waiting" => {
    const l = props.live
    if (!l) return "reading"
    if (l.done[id]) return "read"
    return l.current === id ? "reading" : "waiting"
  }
  const doneCount = () => Object.keys(props.live?.done ?? {}).length
  return (
    <div class="pls-running" role="status" aria-label={props.label}>
      <p class="pls-checking">
        <span class="pls-spin" aria-hidden="true" />
        {props.label} <b class="hsc-num pls-clock">{(t() / 1000).toFixed(1)} s</b>
        <Show when={sequential()} fallback={<span class="hsc-muted">usually {props.usual}</span>}>
          <span class="hsc-muted">
            <span class="hsc-num">{doneCount()}</span> of <span class="hsc-num">{props.stops.length}</span> stops read
          </span>
        </Show>
      </p>
      <ol
        class="pls-route pls-route--running"
        data-sequential={sequential() ? "" : undefined}
        aria-hidden="true"
        ref={(el) => queueMicrotask(() => el.style.setProperty("--rail", `${Math.max(0, el.offsetHeight - 50)}px`))}
      >
        <For each={props.stops}>
          {(s, i) => {
            const stop = () => props.live?.done[s.id]
            return (
              <li class="pls-stop" classList={{ "pls-stop--reading": state(s.id) === "reading", "pls-stop--waiting": state(s.id) === "waiting", "pls-stop--read": state(s.id) === "read" }} data-shut={stop()?.shut ? "" : undefined} style={{ "--i": i() }}>
                <span class="pls-pin">{stop()?.shut ? "×" : i() + 1}</span>
                <div class="pls-body">
                  <h4>{s.label}</h4>
                  <p>{state(s.id) === "read" ? (stop()!.shut ? "shut" : stop()!.text) : state(s.id) === "reading" ? "reading…" : "next"}</p>
                </div>
                <span class="pls-tally">
                  <Show when={stop()} fallback={<Show when={state(s.id) === "reading"}><span class="pls-bar" /></Show>}>
                    {(st) => <span class="pls-main hsc-num">{tallyOf(st()).main}</span>}
                  </Show>
                </span>
              </li>
            )
          }}
        </For>
      </ol>
    </div>
  )
}

const TOPIC_RUN = [
  { id: "git", label: "Commits" },
  { id: "diary", label: "Diary" },
  { id: "files", label: "Files" },
  { id: "claude_code", label: "Claude Code sessions" },
  { id: "opencode", label: "opencode sessions" },
  { id: "imessage", label: "iMessage" },
  { id: "email", label: "Apple Mail" },
  { id: "gmail", label: "Gmail" },
  { id: "bloq", label: "Atlas" },
]
const CONTACT_RUN = ["Lead record", "Deal", "Tasks", "Checks", "Pulse score", "Email log"].map((label) => ({ id: label, label }))

export function IrisPulseTopic(props: { doFetch: Fetch; project?: string; now?: () => number }) {
  const now = () => props.now?.() ?? Date.now()
  const [q, setQ] = createSignal(remember("iris.pulse.topic") ?? "")
  const [days, setDays] = createSignal(Number(remember("iris.pulse.days") ?? 30) || 30)
  const [ask, setAsk] = createSignal<{ q: string; days: number; n: number } | undefined>()
  const [picked, setPicked] = createSignal<string | undefined>()
  const [live, setLive] = createSignal<Live>({ done: {} })
  const [readAt, setReadAt] = createSignal<number | undefined>()
  const again = () => {
    const a = ask()
    if (!a) return
    setPicked(undefined)
    setAsk({ ...a, n: a.n + 1 })
  }
  const [run] = createResource(ask, async (a) => {
    const p = new URLSearchParams({ q: a.q, days: String(a.days) })
    if (props.project) p.set("project", props.project)
    setLive({ done: {} })
    const streamed = await streamTopic(props.doFetch, `/iris/pulse/topic/stream?${p}`, setLive)
    setReadAt(Date.now())
    if (streamed) return streamed
    // No stream to read (older sidecar): the one-shot route, with the all-at-once running view.
    setLive({ done: {}, current: "__none" })
    const r = await getJson<TopicPulse | null>(props.doFetch, `/iris/pulse/topic?${p}`, null)
    setReadAt(Date.now())
    return r
  })
  const streaming = () => live().current !== "__none"
  const drive = () => {
    const k = q().trim()
    if (!k) return
    remember("iris.pulse.topic", k)
    remember("iris.pulse.days", String(days()))
    setPicked(undefined)
    setAsk({ q: k, days: days(), n: (ask()?.n ?? 0) + 1 })
  }
  const data = () => (run.loading ? undefined : run.latest?.data ?? undefined)
  const stops = () => data()?.stops ?? []
  const pick = createMemo(() => stops().find((s) => s.id === picked()) ?? stops().find((s) => !s.shut && (s.count ?? 0) > 0) ?? stops()[0])
  const pickIndex = () => {
    const i = stops().findIndex((s) => s.id === pick()?.id)
    return i < 0 ? "" : pinsOf(stops())[i]
  }

  return (
    <div class="hsc-wrap">
      <div class="hmc pls">
        <section class="hmc-main" aria-label="Pulse a topic">
          <form
            class="pls-query"
            onSubmit={(e) => {
              e.preventDefault()
              drive()
            }}
          >
            <span class="hsc-muted">Pulse</span>
            <input
              class="pls-input"
              type="search"
              placeholder="a client, a project, a feature…"
              aria-label="Topic to pulse"
              value={q()}
              onInput={(e) => setQ(e.currentTarget.value)}
            />
            <Windows
              days={days()}
              onPick={(d) => {
                setDays(d)
                if (ask()) drive()
              }}
            />
            <button type="submit" class="hmc-btn hmc-btn--go" disabled={!q().trim() || run.loading}>
              Drive the route
            </button>
          </form>

          <Show when={run.loading}>
            <PulseRunning stops={TOPIC_RUN} usual="10–30 s" label={`Driving the route for “${ask()?.q ?? ""}”`} live={streaming() ? live() : undefined} />
          </Show>
          <Show when={!run.loading && run.latest && !run.latest.measured}>
            <p class="hsc-warn pls-err">
              {run.latest!.reason ?? "The route did not finish."}{" "}
              <button type="button" class="hmc-btn pls-retry" onClick={again}>
                Try again
              </button>
            </p>
          </Show>
          <Show when={!ask()}>
            <div class="pls-empty">
              <p>
                <b>Name a topic and drive the route.</b> Pulse visits your commits, diary, files, Claude Code and opencode
                sessions, iMessage, Mail, Gmail and Atlas — and at each stop says what it found, or why it could not get in.
              </p>
              <p class="hsc-muted">Opening a route only reads. Nothing is filed or sent from here.</p>
            </div>
          </Show>

          <Show when={data()}>
            {(d) => {
              const prior = () => priorLine(d().summary, d().days)
              return (
                <>
                  <div class="pls-sum">
                    <span>
                      Last touched <b>{touchedLine(d().summary.lastTouched, now())}</b>
                    </span>
                    <span>
                      <b class="hsc-num">{topicParts(d().summary).hits}</b> {topicParts(d().summary).rest}
                    </span>
                    <span class="pls-prior" data-tone={prior().tone}>
                      {prior().text}
                    </span>
                    <span class="hsc-muted hsc-num">
                      {d().summary.shut} shut · checked in {(d().ms / 1000).toFixed(1)} s
                    </span>
                    <Again at={readAt()} now={now} onRun={again} />
                  </div>
                  <Route stops={stops()} picked={pick()?.id} onPick={setPicked} />
                  <Legend />
                </>
              )
            }}
          </Show>
        </section>
        <StopDetail stop={pick()} index={pickIndex()} now={now()} />
      </div>
    </div>
  )
}

// ── contact ──────────────────────────────────────────────────────────────────

export function IrisPulseContact(props: { doFetch: Fetch; now?: () => number }) {
  const now = () => props.now?.() ?? Date.now()
  const [q, setQ] = createSignal("")
  const [term, setTerm] = createSignal("")
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  const [found] = createResource(term, (t) => getJson<ContactRow[]>(props.doFetch, `/iris/pulse/contacts?q=${encodeURIComponent(t)}`, []))
  const [leadId, setLeadId] = createSignal<number | undefined>(Number(remember("iris.pulse.contact")) || undefined)
  const [days, setDays] = createSignal(30)
  const [picked, setPicked] = createSignal<string | undefined>()
  const [nonce, setNonce] = createSignal(0)
  const [readAt, setReadAt] = createSignal<number | undefined>()
  const [run] = createResource(
    () => (leadId() ? { id: leadId()!, days: days(), n: nonce() } : undefined),
    async (a) => {
      const r = await getJson<ContactPulse | null>(props.doFetch, `/iris/pulse/contacts/${a.id}?days=${a.days}`, null)
      setReadAt(Date.now())
      return r
    },
  )
  const again = () => {
    setPicked(undefined)
    setNonce((n) => n + 1)
  }
  const data = () => (run.loading ? undefined : run.latest?.data ?? undefined)
  const stops = () => data()?.stops ?? []
  const pick = createMemo(() => stops().find((s) => s.id === picked()) ?? stops().find((s) => s.owed > 0) ?? stops()[0])
  const pickIndex = () => {
    const i = stops().findIndex((s) => s.id === pick()?.id)
    return i < 0 ? "" : pinsOf(stops())[i]
  }
  const choose = (id: number) => {
    remember("iris.pulse.contact", String(id))
    setPicked(undefined)
    setQ("")
    setTerm("")
    setLeadId(id)
  }

  return (
    <div class="hsc-wrap">
      <div class="hmc pls">
        <section class="hmc-main" aria-label="Pulse a contact">
          <div class="pls-query">
            <span class="hsc-muted">Contact</span>
            <div class="pls-find">
              <input
                class="pls-input"
                type="search"
                placeholder={data() ? data()!.lead.name : "Find a contact by name, email or company"}
                aria-label="Find a contact"
                value={q()}
                onInput={(e) => {
                  const v = e.currentTarget.value
                  setQ(v)
                  clearTimeout(timer)
                  timer = setTimeout(() => setTerm(v.trim()), 250)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setQ("")
                    setTerm("")
                  }
                  if (e.key === "Enter" && found.latest?.data[0]) choose(found.latest.data[0].id)
                }}
              />
              <Show when={term() && found.latest}>
                <ul class="pls-results" role="listbox" aria-label="Contacts">
                  <Show when={found.latest!.data.length} fallback={<li class="hsc-muted">No contact matches “{term()}”.</li>}>
                    <For each={found.latest!.data.slice(0, 8)}>
                      {(c) => (
                        <li role="option" tabindex="0" onClick={() => choose(c.id)} onKeyDown={(e) => e.key === "Enter" && choose(c.id)}>
                          <b>{c.name}</b>
                          <span class="hsc-muted">{[c.company, c.status].filter(Boolean).join(" · ")}</span>
                        </li>
                      )}
                    </For>
                  </Show>
                </ul>
              </Show>
            </div>
            <Windows days={days()} onPick={setDays} />
          </div>

          <Show when={run.loading}>
            <PulseRunning stops={CONTACT_RUN} usual="1–3 s" label="Reading the contact’s stops" />
          </Show>
          <Show when={!run.loading && run.latest && !run.latest.measured}>
            <p class="hsc-warn pls-err">
              {run.latest!.reason ?? "Could not read this contact."}{" "}
              <button type="button" class="hmc-btn pls-retry" onClick={again}>
                Try again
              </button>
            </p>
          </Show>
          <Show when={!leadId()}>
            <div class="pls-empty">
              <p>
                <b>Find a contact and Pulse reads its route</b> — the record, the deal, tasks, checks and the email log —
                and says which channels it could not read.
              </p>
              <p class="hsc-muted">Read-only. The score is read, never re-saved; nothing is sent from here.</p>
            </div>
          </Show>

          <Show when={data()}>
            {(d) => {
              const spark = () => sparkOf(d().score.history)
              return (
                <>
                  <div class="pls-lead">
                    <b>{d().lead.name}</b>
                    <Show when={d().lead.company}>
                      {(c) => (
                        <span class="pls-chip" title="Company">
                          <Ico d={BUILDING} />
                          {c()}
                        </span>
                      )}
                    </Show>
                    <Show when={d().lead.status}>{(st) => <span class="pls-chip pls-chip--status">{st()}</span>}</Show>
                    <span class="pls-lock" title="Read-only: opening a contact never writes — the score is read, not re-saved" aria-label="Read-only">
                      <Ico d={LOCK} rect={{ x: 3, y: 11, w: 18, h: 11 }} />
                    </span>
                    <Again at={readAt()} now={now} onRun={again} />
                  </div>
                  <div class="pls-sum">
                    <span>
                      Pulse{" "}
                      <b class="hsc-num pls-score" data-band={d().score.band ?? undefined}>
                        {d().score.score ?? "—"}
                      </b>{" "}
                      · {bandWord(d().score.band)}
                    </span>
                    <Show when={spark().length > 1}>
                      <span class="pls-spark" role="img" aria-label="Score trend, oldest to newest">
                        <For each={spark()}>{(h) => <i style={{ height: `${h}px` }} />}</For>
                      </span>
                    </Show>
                    <Show when={runsLine(d().score.history)}>
                      <span class="hsc-muted hsc-num">{runsLine(d().score.history)}</span>
                    </Show>
                    <Show when={blindLine(d().channels)}>
                      <span class="pls-blind">{blindLine(d().channels)}</span>
                    </Show>
                  </div>
                  <Route stops={stops()} picked={pick()?.id} onPick={setPicked} />
                  <Show when={d().owed.length}>
                    <section class="pls-owed" aria-label="What is owed">
                      <h4>What is owed</h4>
                      <ul>
                        <For each={d().owed}>
                          {(o) => (
                            <li>
                              <span>{o.what}</span>
                              <span class="hsc-num">{[o.amount, o.since].filter(Boolean).join(" · ")}</span>
                            </li>
                          )}
                        </For>
                      </ul>
                    </section>
                  </Show>
                  <Legend />
                </>
              )
            }}
          </Show>
        </section>
        <StopDetail stop={pick()} index={pickIndex()} now={now()}>
          <Show when={data()}>
            {(d) => (
              <p class="hsc-muted pls-cli">
                In a terminal: <code class="hsc-mono">iris leads pulse {d().lead.id}</code> — also reads iMessage, WhatsApp,
                Mail and the calendar on a Mac.
              </p>
            )}
          </Show>
        </StopDetail>
      </div>
    </div>
  )
}
