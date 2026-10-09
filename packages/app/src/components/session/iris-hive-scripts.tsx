import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  startTransition,
  Suspense,
  Switch,
} from "solid-js"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import "./iris-hive-scripts.css"
import {
  ago,
  commandFor,
  computerVerdict,
  defaultComputer,
  diskCritical,
  diskOf,
  elapsedSeconds,
  fileName,
  findComputer,
  groupComputers,
  isTestScript,
  lastLine,
  parseCommand,
  parseHeader,
  readiness,
  setArgDefault,
  skillsOf,
  STAGES,
  stageStates,
  taskStatusWord,
  taskSucceeded,
  topFix,
  type Computer,
  type Doctor,
  type HiveNodeRow,
  type ScriptRow,
  type TaskView,
} from "./iris-hive-scripts-model"

/**
 * Hive › Scripts (#188817): write a script, send it to one of your computers, watch it run.
 *
 * Three columns: your scripts, the script, your computers. Edit shows the header as inputs above
 * the code; Run shows the five stages the Hive records, the code, and the console. The computer
 * the run went to is marked on the right with its latest output line.
 *
 * Everything comes from the sidecar's /iris/hive/scripts* routes — the same cloud calls as
 * `iris scripts`. What is NOT here, on purpose:
 *  - which line is running: nothing reports it, so nothing is highlighted;
 *  - live output while it runs: the task carries stdout once it finishes. The hub broadcasts
 *    lines over Pusher (`user.<id>.nodes` · NodeTaskOutput) but this app has no Pusher client,
 *    so the console polls the task every second and fills in at the end;
 *  - arguments: the daemon does not pass a header's `arg=` values to the script, so the inputs
 *    edit the declared default in the source and Run sends none.
 *
 * Every view reads its resources inside its OWN <Suspense>, and switching scripts happens in a
 * transition — a resource read before its first value otherwise suspends the boundary around the
 * whole side panel (the Playbooks trap).
 */

type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type IconName = IconProps["name"]
type ScriptsPayload = { measured: boolean; reason?: string | null; scripts: ScriptRow[] }
type HivePayload = { measured: boolean; reason?: string | null; nodes: HiveNodeRow[] }
type SourcePayload = {
  measured: boolean
  reason?: string | null
  script: { slug: string; runtime: string; content: string; sha256: string; updatedAt?: string } | null
}
type RunPayload = { ok: boolean; reason?: string; taskId?: string; nodeId?: string; nodeName?: string; sha256?: string | null }
type TaskPayload = { measured: boolean; reason?: string | null; task: TaskView | null }
type SavePayload = { ok: boolean; reason?: string; sha256?: string; updatedAt?: string }

type RunState = {
  slug: string
  computerId: string
  computerName: string
  taskId?: string
  task: TaskView | null
  reason?: string
  /** Arguments typed in ⌘K that the daemon will not receive — said, not dropped silently. */
  ignoredArgs?: string[]
}

const POLL_MS = 1_000
const SELECTED_KEY = "iris.hive.scripts.slug"
const NEW_TEMPLATE = "#!/bin/bash\n# iris: timeout=120\n# What this script does, in one line.\necho \"hello from $(hostname)\"\n"

function Ic(props: { name: IconName; title?: string; class?: string }) {
  return (
    <span class={`hsc-ic ${props.class ?? ""}`} title={props.title} aria-hidden={props.title ? undefined : "true"}>
      <Icon name={props.name} size="small" />
    </span>
  )
}

const remembered = () => {
  try {
    return localStorage.getItem(SELECTED_KEY) ?? undefined
  } catch {
    return undefined
  }
}

export function IrisHiveScripts(props: { doFetch: Fetch; now?: () => number }) {
  const now = () => props.now?.() ?? Date.now()
  const getJson = async <T,>(path: string, fallback: T, init?: RequestInit): Promise<T> => {
    try {
      const res = await props.doFetch(path, init)
      return (await res.json()) as T
    } catch (e) {
      // A rejected fetch must stop at this pane, not take the panel down (iris-panel-boundary).
      return { ...fallback, reason: e instanceof Error ? e.message : String(e) }
    }
  }
  const post = <T,>(path: string, body: unknown, fallback: T) =>
    getJson<T>(path, fallback, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  // ── data ─────────────────────────────────────────────────────────────────────────────────────
  const [list, { refetch: refetchList }] = createResource(() =>
    getJson<ScriptsPayload>("/iris/hive/scripts", { measured: false, scripts: [] }),
  )
  const [hive] = createResource(() => getJson<HivePayload>("/iris/hive?perPage=200", { measured: false, nodes: [] }))

  const scripts = createMemo(() => list.latest?.scripts ?? [])
  const nodes = createMemo(() => hive.latest?.nodes ?? [])
  const computers = createMemo(() => groupComputers(nodes()))
  const online = createMemo(() => computers().filter((c) => c.online))
  const offline = createMemo(() => computers().filter((c) => !c.online))
  const onlineNames = createMemo(() => new Set(nodes().filter((n) => n.online).map((n) => n.name)))
  const real = createMemo(() => scripts().filter((s) => !isTestScript(s.slug)))
  const tests = createMemo(() => scripts().filter((s) => isTestScript(s.slug)))
  const fix = createMemo(() => topFix(scripts(), onlineNames()))
  const [showTests, setShowTests] = createSignal(false)
  const [showFix, setShowFix] = createSignal(false)

  // ── which script ─────────────────────────────────────────────────────────────────────────────
  const [slug, setSlug] = createSignal<string | undefined>(remembered())
  const [creating, setCreating] = createSignal<string | undefined>()
  const choose = (s: string, transition = true) => {
    const apply = () => {
      setCreating(undefined)
      setSlug(s)
    }
    // A transition keeps the open script on screen while the next one loads, instead of
    // suspending. ⌘K `run` needs the switch to have happened before it dispatches, so it skips it.
    if (transition) void startTransition(apply)
    else apply()
    try {
      localStorage.setItem(SELECTED_KEY, s)
    } catch {}
  }
  createEffect(() => {
    const all = scripts()
    if (!all.length || creating()) return
    const cur = slug()
    if (cur && all.some((s) => s.slug === cur)) return
    if (cur && isTestScript(cur)) return
    const ready = real().find((s) => readiness(s.doctor, onlineNames()).state === "ok")
    const first = ready ?? real()[0] ?? all[0]
    if (first) setSlug(first.slug)
  })
  const current = createMemo(() => scripts().find((s) => s.slug === slug()))
  const doctor = createMemo<Doctor | null>(() => current()?.doctor ?? null)

  const [source, { mutate: mutateSource }] = createResource(
    () => (creating() ? undefined : slug()),
    (s) => getJson<SourcePayload>(`/iris/hive/scripts/${encodeURIComponent(s)}`, { measured: false, script: null }),
  )

  // The editor's text. `null` = untouched, i.e. what was saved.
  const [draft, setDraft] = createSignal<string | null>(null)
  createEffect(on([slug, creating], () => setDraft(null), { defer: true }))
  const saved = () => (creating() ? "" : (source.latest?.script?.content ?? ""))
  const text = () => draft() ?? (creating() ? NEW_TEMPLATE : saved())
  const dirty = () => !!creating() || (draft() !== null && draft() !== saved())
  const header = createMemo(() => parseHeader(text()))
  const runtime = () => source.latest?.script?.runtime ?? current()?.runtime ?? "bash"
  const name = () => creating() ?? slug() ?? ""
  // The hub's parse of the SAVED header first — that is what the run will be held to.
  const timeoutSec = () => (dirty() ? header().timeout : null) ?? doctor()?.timeout ?? header().timeout ?? 120

  // ── where it runs ────────────────────────────────────────────────────────────────────────────
  const [pickedId, setPickedId] = createSignal<string | undefined>()
  createEffect(on(slug, () => setPickedId(undefined), { defer: true }))
  const picked = createMemo<Computer | undefined>(() => {
    const id = pickedId()
    return (id ? online().find((c) => c.id === id) : undefined) ?? defaultComputer(computers(), doctor())
  })

  // ── mode, runs ───────────────────────────────────────────────────────────────────────────────
  const [mode, setMode] = createSignal<"edit" | "run">("edit")
  const [runs, setRuns] = createSignal<Record<string, RunState>>({})
  const run = createMemo(() => runs()[name()])
  const putRun = (r: RunState) => setRuns((all) => ({ ...all, [r.slug]: r }))
  const [tick, setTick] = createSignal(0)
  onMount(() => {
    const t = setInterval(() => setTick((n) => n + 1), POLL_MS)
    onCleanup(() => clearInterval(t))
  })
  // Poll every live run once a second. A failed read keeps the last state on screen.
  createEffect(
    on(tick, () => {
      for (const r of Object.values(runs())) {
        if (!r.taskId || r.task?.terminal) continue
        void getJson<TaskPayload>(`/iris/hive/tasks/${encodeURIComponent(r.taskId)}`, { measured: false, task: null }).then(
          (p) => {
            if (!p.task) return
            const latest = runs()[r.slug]
            if (latest?.taskId !== r.taskId) return
            putRun({ ...latest, task: p.task })
            if (p.task.terminal) void startTransition(() => void refetchList())
          },
        )
      }
    }),
  )

  const [busy, setBusy] = createSignal<"save" | "run" | undefined>()
  const [note, setNote] = createSignal<string | undefined>()
  const [savedAt, setSavedAt] = createSignal<string | undefined>()

  const save = async (): Promise<boolean> => {
    const s = name()
    if (!s) return false
    setBusy("save")
    setNote(undefined)
    const body = text()
    const r = await post<SavePayload>(`/iris/hive/scripts/${encodeURIComponent(s)}/save`, { content: body }, { ok: false })
    setBusy(undefined)
    if (!r.ok) {
      setNote(`Not saved — ${r.reason ?? "the sidecar did not answer"}`)
      return false
    }
    setSavedAt(r.updatedAt ?? new Date(now()).toISOString())
    const wasNew = creating()
    mutateSource({ measured: true, script: { slug: s, runtime: runtime(), content: body, sha256: r.sha256 ?? "", updatedAt: r.updatedAt } })
    setDraft(null)
    if (wasNew) {
      setCreating(undefined)
      setSlug(s)
    }
    void startTransition(() => void refetchList())
    return true
  }

  const runOn = async (target: Computer | undefined, ignoredArgs?: string[]) => {
    const s = name()
    if (!s || !target) return
    if (dirty() && !(await save())) return
    setBusy("run")
    setMode("run")
    putRun({ slug: s, computerId: target.id, computerName: target.name, task: null, ignoredArgs })
    const r = await post<RunPayload>(
      `/iris/hive/scripts/${encodeURIComponent(s)}/run`,
      { node: target.id, timeout: timeoutSec() },
      { ok: false },
    )
    setBusy(undefined)
    if (!r.ok || !r.taskId) {
      putRun({ slug: s, computerId: target.id, computerName: target.name, task: null, reason: r.reason ?? "Dispatch failed", ignoredArgs })
      return
    }
    putRun({ slug: s, computerId: target.id, computerName: r.nodeName ?? target.name, taskId: r.taskId, task: null, ignoredArgs })
  }

  const ready = createMemo(() => readiness(doctor(), onlineNames()))
  const canRun = () => !!picked() && computerVerdict(picked()!, doctor()).can !== false && busy() === undefined
  const runTitle = () => {
    if (!picked()) return ready().state === "blocked" ? (ready().fix ?? ready().label) : "No computer is online"
    const v = computerVerdict(picked()!, doctor())
    if (v.can === false) return `${picked()!.name} can't run it — ${v.why ?? ""}`
    return `Run on ${picked()!.name}${dirty() ? " (saves first — a computer runs the saved version)" : ""}`
  }

  // ── ⌘K ───────────────────────────────────────────────────────────────────────────────────────
  let cmdEl: HTMLInputElement | undefined
  let rootEl: HTMLDivElement | undefined
  const [cmd, setCmd] = createSignal("")
  const [cmdError, setCmdError] = createSignal<string | undefined>()
  const argDefaults = () => Object.fromEntries(header().args.map((a) => [a.name, a.default ?? ""]))
  const hint = () => (name() ? commandFor(name(), argDefaults(), picked()?.name) : "run <script> on <computer>")
  const runCommand = () => {
    const parsed = parseCommand(cmd() || hint())
    if (!parsed) return setCmdError("Try: run <script> name=value on <computer>")
    const target = scripts().find((s) => s.slug === parsed.slug)
    if (!target && parsed.slug !== name()) return setCmdError(`No script named ${parsed.slug}`)
    setCmdError(undefined)
    if (parsed.slug !== name()) choose(parsed.slug, parsed.verb !== "run")
    if (parsed.verb === "edit") return setMode("edit")
    if (parsed.verb === "open") return
    const where = parsed.node ? findComputer(computers(), parsed.node) : undefined
    if (parsed.node && !where) return setCmdError(`No computer named ${parsed.node}`)
    if (where && !where.online) return setCmdError(`${where.name} is offline`)
    if (where) setPickedId(where.id)
    const ignored = Object.keys(parsed.args)
    setCmd("")
    // Wait for the chosen script's doctor to be current before picking a default computer.
    queueMicrotask(() => void runOn(where ?? picked(), ignored.length ? ignored : undefined))
  }
  // ⌘K inside this tab focuses the field. Window capture runs before the app's palette listener
  // (document capture), and only when focus is already in this pane — elsewhere ⌘K is the palette.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k" || e.shiftKey || e.altKey) return
      if (!rootEl || !(e.target instanceof Node) || !rootEl.contains(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      cmdEl?.focus()
      cmdEl?.select()
    }
    window.addEventListener("keydown", onKey, { capture: true })
    onCleanup(() => window.removeEventListener("keydown", onKey, { capture: true }))
  })

  // ── new script ───────────────────────────────────────────────────────────────────────────────
  const [naming, setNaming] = createSignal(false)
  const startNew = (raw: string) => {
    const s = raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
    setNaming(false)
    if (!s) return
    if (scripts().some((x) => x.slug === s)) return choose(s)
    setCreating(s)
    setMode("edit")
  }

  const stages = createMemo(() => stageStates(run()?.task))
  const elapsed = createMemo(() => {
    tick()
    return elapsedSeconds(run()?.task, now())
  })

  return (
    <div class="hsc-wrap" ref={rootEl}>
    <div class="hsc" data-mode={mode()} data-component="hive-scripts">
      {/* ── left: scripts ── */}
      <aside class="hsc-col hsc-list" aria-label="Scripts">
        <div class="hsc-lhead">
          <Ic name="bullet-list" />
          <b>Scripts</b>
          <span class="hsc-spacer" />
          <button class="hsc-ib hsc-ib--bare" type="button" title="New script" onClick={() => setNaming(true)}>
            <Ic name="plus" />
          </button>
        </div>
        <Show when={naming()}>
          <input
            class="hsc-newname hsc-mono"
            placeholder="new-script-name"
            aria-label="New script name"
            autofocus
            onKeyDown={(e) => {
              if (e.key === "Enter") startNew(e.currentTarget.value)
              if (e.key === "Escape") setNaming(false)
            }}
            onBlur={(e) => startNew(e.currentTarget.value)}
          />
        </Show>
        <Suspense fallback={<p class="hsc-muted hsc-pad">Reading…</p>}>
          <Show when={list() && !list()!.measured}>
            <p class="hsc-warn hsc-pad" title={list()!.reason ?? undefined}>
              Could not read your scripts{list()!.reason ? ` — ${list()!.reason}` : ""}
            </p>
          </Show>
          <ul class="hsc-ilist" role="listbox">
            <Show when={creating()}>
              <li class="on" aria-selected="true" title="Not saved yet">
                <span class="hsc-mono">{creating()}</span>
                <i class="hsc-dot hsc-dot--draft" />
              </li>
            </Show>
            {/* A test script opened from ⌘K stays visible while it is open. */}
            <For each={showTests() ? scripts() : real().concat(current() && isTestScript(current()!.slug) ? [current()!] : [])}>
              {(s) => {
                const r = () => readiness(s.doctor, onlineNames())
                return (
                  <li
                    role="option"
                    aria-selected={s.slug === slug() && !creating()}
                    classList={{
                      on: s.slug === slug() && !creating(),
                      bl: r().state === "blocked",
                      unk: r().state === "unknown",
                    }}
                    title={r().state === "blocked" ? (r().fix ?? r().label) : r().label}
                    tabIndex={0}
                    onClick={() => choose(s.slug)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && choose(s.slug)}
                  >
                    <span class="hsc-mono">{s.slug}</span>
                    <Show when={r().state === "blocked"}>
                      <Ic name="lock" class="hsc-amber" />
                    </Show>
                  </li>
                )
              }}
            </For>
          </ul>
          <Show when={tests().length}>
            <button
              class="hsc-more hsc-num"
              type="button"
              aria-pressed={showTests()}
              title={showTests() ? "Hide the Hive's own test scripts" : `${tests().length} test scripts hidden — show them`}
              onClick={() => setShowTests((v) => !v)}
            >
              {showTests() ? "hide tests" : `+${tests().length} tests`}
            </button>
          </Show>
        </Suspense>
      </aside>

      {/* ── middle: the script ── */}
      <section class="hsc-col hsc-ed" aria-label="Script">
        <form
          class="hsc-cmdk"
          onSubmit={(e) => {
            e.preventDefault()
            runCommand()
          }}
        >
          <Ic name="arrow-right" />
          <input
            ref={cmdEl}
            class="hsc-mono"
            value={cmd()}
            placeholder={hint()}
            aria-label="Command"
            spellcheck={false}
            onInput={(e) => {
              setCmd(e.currentTarget.value)
              setCmdError(undefined)
            }}
          />
          <kbd title="Focus this field from anywhere in the Scripts tab">⌘K</kbd>
        </form>
        <Show when={cmdError()}>
          <p class="hsc-warn">{cmdError()}</p>
        </Show>

        <Show when={name()} fallback={<p class="hsc-muted hsc-pad">Pick a script, or press + to write one.</p>}>
          <div class="hsc-edbar">
            <span class="hsc-file hsc-mono">{fileName(name(), runtime())}</span>
            <i
              class="hsc-dot"
              classList={{ "hsc-dot--saved": !dirty(), "hsc-dot--draft": dirty() }}
              title={
                dirty()
                  ? creating()
                    ? "Not saved yet"
                    : "Unsaved changes"
                  : `Saved ${ago(savedAt() ?? source.latest?.script?.updatedAt ?? current()?.updatedAt, now())}`
              }
            />
            <span class="hsc-seg" role="group" aria-label="View">
              <button type="button" title="Edit" aria-pressed={mode() === "edit"} onClick={() => setMode("edit")}>
                <Ic name="pencil-line" />
              </button>
              <button type="button" title="Run view" aria-pressed={mode() === "run"} onClick={() => setMode("run")}>
                <Ic name="terminal" />
              </button>
            </span>
            <span class="hsc-spacer" />
            <button
              class="hsc-ib"
              type="button"
              title={busy() === "save" ? "Saving…" : dirty() ? "Save (iris scripts push)" : "Saved"}
              disabled={!dirty() || busy() !== undefined}
              onClick={() => void save()}
            >
              <Ic name="save" />
            </button>
            <button class="hsc-run" type="button" title={runTitle()} disabled={!canRun()} onClick={() => void runOn(picked())}>
              <Ic name="play" />
              Run
            </button>
          </div>
          <Show when={note()}>
            <p class="hsc-warn">{note()}</p>
          </Show>

          <Suspense fallback={<p class="hsc-muted hsc-pad">Reading the script…</p>}>
            <Show when={!creating() && source() && !source()!.script}>
              <p class="hsc-warn">Could not read {name()}{source()!.reason ? ` — ${source()!.reason}` : ""}</p>
            </Show>
            <Switch>
              <Match when={mode() === "edit"}>
                <div class="hsc-argrow">
                  <For each={header().args}>
                    {(a) => (
                      <label
                        class="hsc-arg"
                        title={`Declared default (# iris: arg=${a.name}). Editing it edits that header line. The computer does not receive arguments yet — the script runs with its own fallback.`}
                      >
                        <span>{a.name}</span>
                        <input
                          class="hsc-mono"
                          value={a.default ?? ""}
                          placeholder={a.required ? "required" : "—"}
                          onChange={(e) => setDraft(setArgDefault(text(), a.name, e.currentTarget.value))}
                        />
                      </label>
                    )}
                  </For>
                  <span class="hsc-chip" title={`Stops the run after ${timeoutSec()} seconds`}>
                    <Ic name="clock" />
                    <b class="hsc-num">{timeoutSec()}s</b>
                  </span>
                  <span
                    class="hsc-chip"
                    title={
                      doctor()?.requires?.length
                        ? `Needs: ${doctor()!.requires!.join(", ")}`
                        : "Declares no special needs — any computer can run it"
                    }
                  >
                    <Ic name="chip" />
                    {doctor()?.requires?.length ? doctor()!.requires!.join(" · ") : "any"}
                  </span>
                  <Show when={doctor()?.manifest_errors?.length}>
                    <span class="hsc-chip hsc-chip--warn" title={doctor()!.manifest_errors!.join("\n")}>
                      <Ic name="warning" />
                      header ignored
                    </span>
                  </Show>
                </div>
                <CodeEditor value={text()} onInput={setDraft} headerLines={header().lines} />
              </Match>
              <Match when={mode() === "run"}>
                <ol class="hsc-track" aria-label="Stages">
                  <For each={STAGES}>
                    {(s) => {
                      const at = () => run()?.task?.[s.field]
                      return (
                        <li
                          data-state={stages()[s.id]}
                          title={`${s.label}${at() ? ` · ${new Date(at()!).toLocaleTimeString()}` : ""}`}
                        >
                          <i>
                            <Ic name={s.icon as IconName} />
                          </i>
                          <b>{s.label}</b>
                        </li>
                      )
                    }}
                  </For>
                </ol>
                <CodeView value={text()} headerLines={header().lines} />
                <div class="hsc-console" data-state={run()?.task?.terminal ? "done" : run() ? "live" : "idle"}>
                  <div class="hsc-chead">
                    <span
                      class="hsc-rstat"
                      data-ok={run()?.task?.terminal ? String(taskSucceeded(run()!.task)) : run()?.reason ? "false" : undefined}
                    >
                      <i />
                      <b>{run()?.reason ? "Not sent" : taskStatusWord(run()?.task)}</b>
                    </span>
                    <For each={header().args}>
                      {(a) => (
                        <span class="hsc-chip hsc-num" title="Declared in the header — not passed to the computer yet">
                          {a.name}={a.default ?? "—"}
                        </span>
                      )}
                    </For>
                    <span class="hsc-spacer" />
                    <span class="hsc-num hsc-clock" title="Since it was queued">
                      {elapsed().toFixed(1)} s
                    </span>
                  </div>
                  <div class="hsc-fbar" title={`Time used of the ${timeoutSec()} s limit`}>
                    <i style={{ width: `${Math.min(100, (elapsed() / timeoutSec()) * 100).toFixed(1)}%` }} />
                  </div>
                  <div class="hsc-term hsc-mono" aria-live="polite">
                    <Show when={run()} fallback={<div class="hsc-dim">Press Run to send {name()} to {picked()?.name ?? "a computer"}.</div>}>
                      <Show when={run()!.reason}>
                        <div class="hsc-err">{run()!.reason}</div>
                      </Show>
                      <Show when={run()!.ignoredArgs}>
                        <div class="hsc-dim">
                          {run()!.ignoredArgs!.join(", ")}: arguments are not delivered to scripts yet — it ran with its own defaults.
                        </div>
                      </Show>
                      <Show when={run()!.task && !run()!.task!.terminal}>
                        <div class="hsc-dim">Output arrives when the run finishes.</div>
                      </Show>
                      <For each={(run()!.task?.stdout ?? "").split("\n").filter(Boolean)}>{(l) => <div>{l}</div>}</For>
                      <For each={(run()!.task?.stderr ?? "").split("\n").filter(Boolean)}>
                        {(l) => <div class="hsc-err">{l}</div>}
                      </For>
                      <Show when={run()!.task?.terminal}>
                        <div class="hsc-dim hsc-num">
                          {run()!.task!.exitCode != null
                            ? `exit ${run()!.task!.exitCode}${run()!.task!.exitCodeSource === "error_text" ? " (inferred)" : ""}`
                            : run()!.task!.status}
                          {" · "}
                          {elapsed().toFixed(0)} s · {run()!.computerName}
                        </div>
                        <Show when={run()!.task!.error}>
                          <div class="hsc-err">{run()!.task!.error}</div>
                        </Show>
                      </Show>
                    </Show>
                  </div>
                </div>
              </Match>
            </Switch>
          </Suspense>
        </Show>
      </section>

      {/* ── right: computers ── */}
      <aside class="hsc-col hsc-where" aria-label="Computers">
        <h5>
          <Ic name="server" />
          {mode() === "run" && run() ? "Sent to" : "Run on"}
        </h5>
        <Suspense fallback={<p class="hsc-muted">Reading…</p>}>
          <Show when={hive() && !hive()!.measured}>
            <p class="hsc-warn" title={hive()!.reason ?? undefined}>
              Could not see your computers
            </p>
          </Show>
          <For each={online()}>
            {(c) => {
              const v = () => computerVerdict(c, doctor())
              const isRun = () => mode() === "run" && run()?.computerId !== undefined && c.ids.includes(run()!.computerId)
              const sel = () => (isRun() ? true : mode() === "edit" || !run() ? picked()?.id === c.id : false)
              const d = diskOf(c)
              return (
                <div
                  class="hsc-cc"
                  classList={{ go: sel(), no: v().can === false, live: isRun() && !run()?.task?.terminal }}
                  role="button"
                  tabIndex={0}
                  aria-pressed={sel()}
                  onClick={() => v().can !== false && setPickedId(c.id)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && v().can !== false && setPickedId(c.id)}
                >
                  <div class="hsc-ccl">
                    <i class="hsc-dot hsc-dot--on" />
                    <b title={c.names.join(" · ")}>{c.name}</b>
                    <Show when={c.regs > 1}>
                      <span class="hsc-x hsc-num" title={`Registered ${c.regs} times — the same computer`}>
                        ×{c.regs}
                      </span>
                    </Show>
                    <span class="hsc-spacer" />
                    <Show when={d && diskCritical(c)}>
                      <span class="hsc-dk" title={`Disk almost full — ${d!.free.toFixed(1)} GB free of ${d!.total.toFixed(0)} GB`}>
                        <Ic name="disk" />
                        <b class="hsc-num">{d!.free.toFixed(1)} GB</b>
                      </span>
                    </Show>
                  </div>
                  <div class="hsc-ccs">
                    <span class="hsc-skills">
                      <For each={skillsOf(c)}>{(s) => <Ic name={s.icon as IconName} title={s.word} class="hsc-skill" />}</For>
                    </span>
                    <span class="hsc-cctag" title={v().can === false ? v().why : undefined}>
                      <Switch fallback={<>Can run it</>}>
                        <Match when={isRun()}>
                          <Ic name="check" />
                          {run()?.task?.terminal ? "Ran here" : "Running here"}
                        </Match>
                        <Match when={v().can === false}>
                          <Ic name="lock" />
                          Can't run it
                        </Match>
                        <Match when={sel()}>
                          <Ic name="check" />
                          Selected
                        </Match>
                      </Switch>
                    </span>
                  </div>
                  <Show when={isRun() && lastLine(run()?.task?.stdout)}>
                    <div class="hsc-dlog hsc-mono">{lastLine(run()?.task?.stdout)}</div>
                  </Show>
                </div>
              )
            }}
          </For>
          <Show when={offline().length}>
            <div
              class="hsc-offrow"
              title={offline()
                .map((c) => `${c.name} — seen ${ago(c.lastHeartbeat, now())}`)
                .join("\n")}
            >
              <i class="hsc-dot hsc-dot--off" />
              <b class="hsc-num">{offline().length}</b> offline
            </div>
          </Show>
          <Show when={fix()}>
            <button class="hsc-fixrow" type="button" title={fix()!.fix} aria-expanded={showFix()} onClick={() => setShowFix((v) => !v)}>
              <Ic name="lock" class="hsc-amber" />
              <span class="hsc-fixtext">
                <b class="hsc-num">{fix()!.slugs.length}</b> scripts wait on one fix
              </span>
              <Ic name={showFix() ? "chevron-down" : "arrow-right"} />
            </button>
            <Show when={showFix()}>
              <div class="hsc-fixbody">
                <p>{fix()!.fix}.</p>
                <p class="hsc-muted hsc-mono">{fix()!.slugs.join(" · ")}</p>
              </div>
            </Show>
          </Show>
        </Suspense>
      </aside>
    </div>
    </div>
  )
}

/** A textarea with a line-number gutter that scrolls with it. No editor dependency. */
function CodeEditor(props: { value: string; onInput: (v: string) => void; headerLines: number[] }) {
  let gutter: HTMLDivElement | undefined
  const count = () => Math.max(1, props.value.split("\n").length)
  return (
    <div class="hsc-code hsc-code--edit">
      <div class="hsc-gutter hsc-num" ref={gutter} aria-hidden="true">
        <For each={Array.from({ length: count() }, (_, i) => i + 1)}>
          {(n) => <span classList={{ h: props.headerLines.includes(n) }}>{n}</span>}
        </For>
      </div>
      <textarea
        class="hsc-mono"
        value={props.value}
        spellcheck={false}
        aria-label="Script source"
        wrap="off"
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onScroll={(e) => gutter && (gutter.scrollTop = e.currentTarget.scrollTop)}
        onKeyDown={(e) => {
          // Tab indents instead of leaving the editor.
          if (e.key !== "Tab" || e.shiftKey) return
          e.preventDefault()
          const el = e.currentTarget
          const at = el.selectionStart
          const next = el.value.slice(0, at) + "  " + el.value.slice(el.selectionEnd)
          props.onInput(next)
          queueMicrotask(() => el.setSelectionRange(at + 2, at + 2))
        }}
      />
    </div>
  )
}

/** The code, compact and read-only. No running-line highlight: nothing reports which line runs. */
function CodeView(props: { value: string; headerLines: number[] }) {
  return (
    <ol class="hsc-code hsc-code--view hsc-mono">
      <For each={props.value.replace(/\n$/, "").split("\n")}>
        {(l, i) => (
          <li classList={{ h: props.headerLines.includes(i() + 1), c: !props.headerLines.includes(i() + 1) && l.trimStart().startsWith("#") }}>
            <span class="n hsc-num">{i() + 1}</span>
            <span class="src">{l || " "}</span>
          </li>
        )}
      </For>
    </ol>
  )
}
