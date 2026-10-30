/**
 * Agents › New agent / Edit agent (#191840).
 *
 * ELON's SimpleAgentModal, brought into Desktop: the same header (name, save state, Save), the
 * same row of step pills with completion ticks, the same step order and per-step logic — redrawn
 * on Desktop's tokens. What each step reads and writes, and why Capabilities became Tools, is in
 * iris-agent-editor-model.ts. Everything goes through the sidecar's /iris/agent-editor/* routes.
 *
 * Saving: in EDIT mode every step saves on its own ("Save step") and "Save all" saves every step
 * that changed, each through its own endpoint, so no step can overwrite another's data. In CREATE
 * mode there is one button, "Create agent": the agent is created with its model and an explicit
 * tool list, then its rules and heartbeat are applied to it.
 */
import { createEffect, createMemo, createResource, createSignal, For, Match, on, Show, Switch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import "./iris-agent-editor.css"
import {
  AGENT_TYPES,
  DAYS,
  FREQUENCIES,
  HEARTBEAT_MODES,
  RESPONSE_LENGTHS,
  RESPONSE_MODES,
  STEPS,
  addToList,
  agentAutonomy,
  agentConfig,
  alertSources,
  alertValue,
  alertsChanges,
  alertsForm,
  approvalBadge,
  attachmentCounts,
  createBody,
  draftFromAgent,
  effectLabel,
  effectSummary,
  emptyDraft,
  groupTools,
  isChecked,
  isOffered,
  readCatalog,
  riskyTools,
  sameModel,
  saveCalls,
  slice,
  stepComplete,
  stepErrors,
  toggleTool,
  unknownEntries,
  visibleSteps,
  type AlertsForm,
  type Catalog,
  type Draft,
  type OfferedModel,
  type SaveCall,
  type StepId,
} from "./iris-agent-editor-model"

type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type Proxied = { ok: boolean; status: number; reason?: string; data?: any }

export interface IrisAgentEditorProps {
  doFetch: Fetch
  /** Absent = create a new agent on `bloqId`. */
  agentId?: number
  bloqId: number | null
  bloqName?: string
  boards: () => { id: number; name: string }[]
  onClose: () => void
  /** After a create (and after each save in edit mode), with what fl-api returned. */
  onSaved: (agent: { id: number; name: string; created: boolean }) => void
  /** Open the read-only record (Info · Tasks · JSON) this editor replaced as the click target. */
  onDetails?: () => void
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

async function ask(doFetch: Fetch, path: string, init?: RequestInit): Promise<Proxied> {
  try {
    const res = await doFetch(path, init)
    const j = (await res.json().catch(() => null)) as Proxied | null
    if (!j || typeof j.ok !== "boolean") return { ok: false, status: res.status, reason: `sidecar HTTP ${res.status}` }
    return j
  } catch (e) {
    return { ok: false, status: 0, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** A geometric mark from the name — the avatar ELON drew from an icon, without an asset. */
function Mark(props: { name: string }) {
  const hue = () => [...(props.name || "?")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
  const initials = () =>
    (props.name || "New")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?"
  return (
    <span class="iae-mark" style={{ "--iae-hue": String(hue()) }} aria-hidden="true">
      {initials()}
    </span>
  )
}

export function IrisAgentEditor(props: IrisAgentEditorProps) {
  const creating = () => props.agentId === undefined

  // ── reads ────────────────────────────────────────────────────────────────────────────────
  const [catalogRes] = createResource(async () => {
    const r = await ask(props.doFetch, "/iris/agent-editor/tool-catalog")
    return { catalog: readCatalog(r.ok ? r.data : undefined), reason: r.ok ? undefined : r.reason }
  })
  const catalog = (): Catalog => catalogRes.latest?.catalog ?? readCatalog(undefined)
  const [modelsRes] = createResource(async () => {
    const r = await ask(props.doFetch, "/iris/agent-editor/models")
    return { models: (r.ok ? (r.data?.models ?? []) : []) as OfferedModel[], reason: r.ok ? undefined : r.reason }
  })
  const models = () => modelsRes.latest?.models ?? []
  const [agentRes] = createResource(
    () => props.agentId,
    async (id) => ask(props.doFetch, `/iris/agent-editor/agent/${id}`),
  )
  const [policyRes, { refetch: refetchPolicy }] = createResource(
    () => props.agentId,
    async (id) => ask(props.doFetch, `/iris/agent-editor/agent/${id}/policy`),
  )
  const raw = () => (agentRes.latest?.ok ? agentRes.latest.data : undefined)

  // ── the draft ────────────────────────────────────────────────────────────────────────────
  const [draft, setDraft] = createStore<Draft>(emptyDraft(props.bloqId, catalog()))
  const [ready, setReady] = createSignal(false)
  /** What each step looked like when last read or saved — dirty = differs from this. */
  const [saved, setSaved] = createSignal<Partial<Record<StepId, string>>>({})
  const snap = (d: Draft) => Object.fromEntries(STEPS.map((s) => [s.id, JSON.stringify(slice(s.id, d))])) as Record<StepId, string>
  const dirty = (step: StepId) => saved()[step] !== JSON.stringify(slice(step, draft))

  // CREATE: once the catalogue and models are in, start from the defaults (checked) and the
  // first offered model. EDIT: once the agent is in.
  createEffect(
    on([() => catalogRes.state, () => modelsRes.state, () => agentRes.state, () => policyRes.state], () => {
      if (ready() || catalogRes.loading || modelsRes.loading) return
      if (creating()) {
        const d = emptyDraft(props.bloqId, catalog(), models()[0]?.id ?? "")
        setDraft(reconcile(d))
        setSaved({})
        setReady(true)
        return
      }
      if (agentRes.loading || policyRes.loading || !raw()) return
      const d = draftFromAgent(raw(), catalog())
      // iris-api's /policy is the authority on the policy (same column, read through the gate's own normaliser).
      if (policyRes.latest?.ok) {
        const p = draftFromAgent({ config: { policy: policyRes.latest.data?.policy } }, catalog()).policy
        d.policy = p
      }
      setDraft(reconcile(d))
      setSaved(snap(d))
      setReady(true)
    }),
  )

  const [alertLevel, setAlertLevel] = createSignal<"project" | "account">(props.bloqId ? "project" : "account")
  const [alertsRes, { refetch: refetchAlerts }] = createResource(
    () => props.bloqId ?? 0,
    async (b) => ask(props.doFetch, `/iris/agent-editor/alerts${b ? `?bloqID=${b}` : ""}`),
  )
  const ctx = () => ({ models: models(), alertsRead: alertsRes.state === "ready" && !!alertsRes.latest?.ok })
  const steps = createMemo(() => visibleSteps(draft.isHuman))
  const [step, setStep] = createSignal<StepId>("basic")
  createEffect(() => {
    if (!steps().some((s) => s.id === step())) setStep("basic")
  })
  const index = () => steps().findIndex((s) => s.id === step())
  const go = (delta: number) => {
    const next = steps()[index() + delta]
    if (next) setStep(next.id)
  }

  // ── saving ───────────────────────────────────────────────────────────────────────────────
  const [busy, setBusy] = createSignal(false)
  const [note, setNote] = createSignal<{ ok: boolean; text: string } | null>(null)
  const [savedAt, setSavedAt] = createSignal<Date | null>(null)

  async function run(agentId: number, call: SaveCall): Promise<string | null> {
    const r =
      call.kind === "agent"
        ? await ask(props.doFetch, "/iris/agent-editor/save", post({ agentID: agentId, body: call.body, configPatch: call.configPatch }))
        : call.kind === "tools"
          ? await ask(props.doFetch, `/iris/agent-editor/agent/${agentId}/tools/save`, post({ tools: call.tools }))
          : call.kind === "policy"
            ? await ask(props.doFetch, `/iris/agent-editor/agent/${agentId}/policy/save`, post({ policy: call.policy }))
            : await ask(props.doFetch, `/iris/agent-editor/agent/${agentId}/heartbeat`, post({ body: call.body }))
    if (r.ok) return null
    const unknown = Array.isArray(r.data?.unknown) && r.data.unknown.length ? ` (${r.data.unknown.join(", ")})` : ""
    return `${r.reason ?? `HTTP ${r.status}`}${unknown}`
  }

  async function saveSteps(ids: StepId[]) {
    const id = props.agentId!
    const failures: string[] = []
    const done: StepId[] = []
    for (const s of ids) {
      const errs = stepErrors(s, draft, ctx()).filter((e) => !(s === "tools" && draft.toolsLegacy))
      if (errs.length) {
        failures.push(`${STEPS.find((x) => x.id === s)!.label}: ${errs[0]}`)
        continue
      }
      let failed: string | null = null
      for (const call of saveCalls(s, draft, null, agentConfig(raw()))) {
        failed = await run(id, call)
        if (failed) break
      }
      if (failed) failures.push(`${STEPS.find((x) => x.id === s)!.label}: ${failed}`)
      else {
        done.push(s)
        if (s === "tools") setDraft("toolsLegacy", false)
      }
    }
    if (done.length) {
      const now = snap(draft)
      setSaved((prev) => ({ ...prev, ...Object.fromEntries(done.map((s) => [s, now[s]])) }))
      setSavedAt(new Date())
      if (done.includes("rules")) void refetchPolicy()
      props.onSaved({ id, name: draft.name, created: false })
    }
    return failures
  }

  async function saveStep() {
    if (step() === "alerts") return saveAlerts()
    setBusy(true)
    setNote(null)
    const failures = await saveSteps([step()])
    setBusy(false)
    setNote(failures.length ? { ok: false, text: `Not saved — ${failures.join(" · ")}` } : { ok: true, text: "Saved." })
  }

  async function saveAll() {
    if (creating()) return create()
    const ids = steps()
      .filter((s) => s.phase === 1 && s.id !== "alerts" && dirty(s.id))
      .map((s) => s.id)
    if (alertsDirty()) await saveAlerts()
    if (!ids.length) {
      if (!alertsDirty()) setNote({ ok: true, text: "Nothing to save." })
      return
    }
    setBusy(true)
    setNote(null)
    const failures = await saveSteps(ids)
    setBusy(false)
    setNote(
      failures.length
        ? { ok: false, text: `Saved ${ids.length - failures.length} of ${ids.length} — ${failures.join(" · ")}` }
        : { ok: true, text: `Saved ${ids.map((s) => STEPS.find((x) => x.id === s)!.label).join(", ")}.` },
    )
  }

  /** Create: the agent (with model + explicit tools), then its tools (validated), rules, heartbeat. */
  async function create() {
    const blocking = (["basic", "model", "rules", "schedule", "memory"] as StepId[])
      .filter((s) => steps().some((x) => x.id === s))
      .flatMap((s) => stepErrors(s, draft, ctx()).map((e) => ({ s, e })))
    if (blocking.length) {
      setStep(blocking[0].s)
      setNote({ ok: false, text: blocking[0].e })
      return
    }
    setBusy(true)
    setNote(null)
    const r = await ask(props.doFetch, "/iris/agent-editor/save", post({ body: createBody(draft) }))
    const id = Number(r.data?.id)
    if (!r.ok || !Number.isFinite(id)) {
      setBusy(false)
      setNote({ ok: false, text: `Not created — ${r.reason ?? "fl-api returned no agent id"}` })
      return
    }
    const follow: string[] = []
    if (!draft.isHuman) {
      // The validated write. The create already carried the list, so a 404 here (endpoint not
      // deployed) changes nothing; anything else is reported.
      if (catalog().available) {
        const t = await run(id, { kind: "tools", tools: [...draft.tools] })
        if (t) follow.push(`tools: ${t}`)
      }
      for (const call of [...saveCalls("rules", draft, null), ...(draft.heartbeat.mode !== "off" ? saveCalls("schedule", draft, null) : [])]) {
        if (call.kind === "policy" && call.policy === null) continue
        const f = await run(id, call)
        if (f) follow.push(`${call.kind === "policy" ? "rules" : "schedule"}: ${f}`)
      }
    }
    setBusy(false)
    props.onSaved({ id, name: draft.name, created: true })
    if (follow.length) setNote({ ok: false, text: `Created #${id}, but — ${follow.join(" · ")}` })
  }

  // ── alerts (their own state: they belong to the board / account, not the agent) ──────────
  const [alerts, setAlerts] = createStore<AlertsForm>(alertsForm(null, "account"))
  const [alertsSnap, setAlertsSnap] = createSignal("")
  createEffect(
    on([() => alertsRes.latest, alertLevel], () => {
      const data = alertsRes.latest?.ok ? alertsRes.latest.data : null
      const f = alertsForm(data, alertLevel())
      setAlerts(reconcile(f))
      setAlertsSnap(JSON.stringify(f))
    }),
  )
  const alertsDirty = () => alertsRes.latest?.ok === true && JSON.stringify(alerts) !== alertsSnap()
  async function saveAlerts() {
    const { changes, errors } = alertsChanges(alerts)
    if (errors.length) return setNote({ ok: false, text: errors[0] })
    setBusy(true)
    const r = await ask(
      props.doFetch,
      "/iris/agent-editor/alerts/save",
      post({ bloqID: alertLevel() === "project" ? (props.bloqId ?? undefined) : undefined, changes }),
    )
    setBusy(false)
    if (!r.ok) return setNote({ ok: false, text: `Alerts not saved — ${r.reason}` })
    setNote({ ok: true, text: `Alerts saved at ${alertLevel() === "project" ? "this board's" : "your account's"} level.` })
    await refetchAlerts()
  }
  async function testAlerts() {
    setBusy(true)
    const r = await ask(props.doFetch, "/iris/agent-editor/alerts/test", post({ bloqID: props.bloqId ?? undefined }))
    setBusy(false)
    const results = Array.isArray(r.data?.results) ? r.data.results : []
    setNote(
      r.ok
        ? { ok: true, text: `Test sent to ${results.map((x: any) => x.to).join(", ") || "you"}.` }
        : { ok: false, text: `Test not sent — ${r.reason}` },
    )
  }

  // ── tools view state ─────────────────────────────────────────────────────────────────────
  const [toolQuery, setToolQuery] = createSignal("")
  const [onlySelected, setOnlySelected] = createSignal(false)
  const autonomy = () => agentAutonomy(raw()) ?? (policyRes.latest?.ok ? (policyRes.latest.data?.autonomy?.set ? policyRes.latest.data.autonomy.level : null) : null)
  const groups = createMemo(() =>
    groupTools(catalog(), toolQuery())
      .map((g) => ({ ...g, tools: onlySelected() ? g.tools.filter((t) => isChecked(catalog(), draft.tools, t)) : g.tools }))
      .filter((g) => g.tools.length),
  )
  const [modelQuery, setModelQuery] = createSignal("")
  const shownModels = createMemo(() => {
    const q = modelQuery().trim().toLowerCase()
    return models().filter((m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
  })

  const anyDirty = () => steps().some((s) => s.phase === 1 && s.id !== "alerts" && dirty(s.id)) || alertsDirty()
  const status = () =>
    busy() ? "Saving…" : creating() ? "Not created yet" : anyDirty() ? "Unsaved changes" : savedAt() ? "Saved" : "Up to date"
  const loadError = () => (!creating() && agentRes.latest && !agentRes.latest.ok ? agentRes.latest.reason : undefined)
  const counts = () => attachmentCounts(raw())

  return (
    <div class="iae-wrap">
      <section class="iae" data-testid="iris-agent-editor" data-mode={creating() ? "create" : "edit"}>
        {/* HEADER — ELON's: who it is, whether it is saved, Save, close. */}
        <header class="iae-head">
          <Mark name={draft.name} />
          <div class="iae-who">
            <h3 class="iae-title">{draft.name.trim() || (creating() ? "New agent" : "Agent")}</h3>
            <p class="iae-sub">
              <Show when={!creating()}>
                <span class="iae-num">#{props.agentId}</span> ·{" "}
              </Show>
              {props.boards().find((b) => b.id === draft.bloqId)?.name ?? props.bloqName ?? "No board"}
              <Show when={autonomy()}>
                {(a) => <span class="iae-chip">trust: {a()}</span>}
              </Show>
            </p>
          </div>
          <span class="iae-status" data-state={busy() ? "busy" : anyDirty() || creating() ? "dirty" : "clean"} role="status">
            {status()}
          </span>
          <Show when={!creating() && props.onDetails}>
            <button type="button" class="iae-btn iae-btn--ghost" onClick={() => props.onDetails!()}>
              Details
            </button>
          </Show>
          <button
            type="button"
            class="iae-btn iae-btn--primary"
            data-testid="iris-agent-save-all"
            disabled={busy() || !ready()}
            onClick={() => void saveAll()}
          >
            {creating() ? "Create agent" : "Save all"}
          </button>
          <button type="button" class="iae-x" title="Close" aria-label="Close" onClick={() => props.onClose()}>
            ×
          </button>
        </header>

        {/* STEPS — ELON's pills: label, a tick when complete, a dot when changed. */}
        <nav class="iae-steps" role="tablist" aria-label="Agent settings">
          <For each={steps()}>
            {(s) => (
              <button
                type="button"
                role="tab"
                class="iae-step"
                data-step={s.id}
                data-phase={s.phase}
                aria-selected={step() === s.id}
                onClick={() => setStep(s.id)}
              >
                {s.label}
                <Show when={s.phase === 1 && ready() && !creating() && (s.id === "alerts" ? alertsDirty() : dirty(s.id))}>
                  <i class="iae-dot" title="Changed" />
                </Show>
                <Show when={s.phase === 1 && ready() && stepComplete(s.id, draft, ctx())}>
                  <span class="iae-tick" aria-label="complete">
                    ✓
                  </span>
                </Show>
                <Show when={s.id === "tools" && !draft.isHuman}>
                  <span class="iae-count">{draft.tools.length}</span>
                </Show>
                <Show when={s.id === "memory" && counts().memory > 0}>
                  <span class="iae-count">{counts().memory}</span>
                </Show>
              </button>
            )}
          </For>
        </nav>

        <div class="iae-body" data-testid={`iris-agent-step-${step()}`}>
          <Show when={loadError()}>
            <p class="iae-warn">Could not read this agent — {loadError()}.</p>
          </Show>
          <Show when={!ready() && !loadError()}>
            <p class="iae-muted">Reading…</p>
          </Show>
          <Show when={ready()}>
            <Show when={stepErrors(step(), draft, ctx()).length && step() !== "tools"}>
              <ul class="iae-errors">
                <For each={stepErrors(step(), draft, ctx())}>{(e) => <li>{e}</li>}</For>
              </ul>
            </Show>
            <Switch>
              {/* ── PERSONALITY ───────────────────────────────────────────────────────── */}
              <Match when={step() === "basic"}>
                <div class="iae-seg" role="radiogroup" aria-label="Kind">
                  <button type="button" aria-pressed={!draft.isHuman} onClick={() => setDraft("isHuman", false)}>
                    AI agent
                  </button>
                  <button type="button" aria-pressed={draft.isHuman} onClick={() => setDraft("isHuman", true)}>
                    Human team member
                  </button>
                </div>
                <div class="iae-grid">
                  <label class="iae-field">
                    <span>Name</span>
                    <input
                      data-testid="iris-agent-name"
                      value={draft.name}
                      maxLength={255}
                      placeholder="e.g. Bid Desk"
                      onInput={(e) => setDraft("name", e.currentTarget.value)}
                    />
                  </label>
                  <Show
                    when={!draft.isHuman}
                    fallback={
                      <label class="iae-field">
                        <span>Role</span>
                        <input value={draft.role} placeholder="e.g. Account manager" onInput={(e) => setDraft("role", e.currentTarget.value)} />
                      </label>
                    }
                  >
                    <label class="iae-field">
                      <span>Type</span>
                      <select value={draft.type} onChange={(e) => setDraft("type", e.currentTarget.value)}>
                        <For each={AGENT_TYPES}>{(t) => <option value={t.id}>{t.label}</option>}</For>
                        <Show when={!AGENT_TYPES.some((t) => t.id === draft.type)}>
                          <option value={draft.type}>{draft.type}</option>
                        </Show>
                      </select>
                    </label>
                  </Show>
                </div>
                <label class="iae-field">
                  <span>Description</span>
                  <input
                    value={draft.description}
                    placeholder="One line: what it is for"
                    onInput={(e) => setDraft("description", e.currentTarget.value)}
                  />
                </label>
                <Show when={draft.isHuman}>
                  <div class="iae-grid">
                    <label class="iae-field">
                      <span>Email</span>
                      <input type="email" value={draft.email} onInput={(e) => setDraft("email", e.currentTarget.value)} />
                    </label>
                    <label class="iae-field">
                      <span>Phone</span>
                      <input value={draft.phone} onInput={(e) => setDraft("phone", e.currentTarget.value)} />
                    </label>
                  </div>
                </Show>
                <Show when={!draft.isHuman}>
                  <label class="iae-field">
                    <span>Personality</span>
                    <textarea
                      rows={4}
                      data-testid="iris-agent-personality"
                      value={draft.personality}
                      placeholder="How it sounds and behaves: tone, what it never does, how it answers."
                      onInput={(e) => setDraft("personality", e.currentTarget.value)}
                    />
                  </label>
                  <label class="iae-field">
                    <span>Instructions</span>
                    <textarea
                      rows={5}
                      data-testid="iris-agent-instructions"
                      value={draft.instructions}
                      placeholder="What it does each time it runs."
                      onInput={(e) => setDraft("instructions", e.currentTarget.value)}
                    />
                    <small class="iae-hint iae-num">{draft.instructions.length.toLocaleString()} / 50,000</small>
                  </label>
                  <Show when={draft.systemPrompt || !creating()}>
                    <label class="iae-field">
                      <span>System prompt</span>
                      <textarea rows={4} value={draft.systemPrompt} onInput={(e) => setDraft("systemPrompt", e.currentTarget.value)} />
                      <small class="iae-hint">Set by the CLI and agents API (config.system_prompt). Leave empty if you use Personality + Instructions.</small>
                    </label>
                  </Show>
                </Show>
              </Match>

              {/* ── MODEL ─────────────────────────────────────────────────────────────── */}
              <Match when={step() === "model"}>
                <p class="iae-lede">Models IRIS serves today — the same list as the chat model picker.</p>
                <Show when={modelsRes.latest?.reason}>
                  <p class="iae-warn">Could not read the model list — {modelsRes.latest!.reason}.</p>
                </Show>
                <Show when={draft.model && models().length && !isOffered(models(), draft.model)}>
                  <p class="iae-warn">
                    Currently <span class="iae-num">{draft.model}</span> — not offered any more. Pick one below.
                  </p>
                </Show>
                <input class="iae-find" type="search" placeholder="Find a model…" value={modelQuery()} onInput={(e) => setModelQuery(e.currentTarget.value)} />
                <div class="iae-models" role="radiogroup" aria-label="Model">
                  <For each={shownModels()}>
                    {(m) => (
                      <label class="iae-model" data-on={sameModel(m.id, draft.model) ? "" : undefined}>
                        <input type="radio" name="iae-model" checked={sameModel(m.id, draft.model)} onChange={() => setDraft("model", m.id)} />
                        <span class="iae-model__name">{m.name}</span>
                        <span class="iae-num iae-model__id">{m.id.replace(/^iris\//, "")}</span>
                        <Show when={m.reasoning}>
                          <span class="iae-chip">reasoning</span>
                        </Show>
                        <Show when={!m.toolCalling}>
                          <span class="iae-chip iae-chip--warn" title="This model cannot call tools">no tools</span>
                        </Show>
                        <Show when={m.context}>
                          <span class="iae-num iae-model__ctx">{Math.round(m.context! / 1000)}k</span>
                        </Show>
                      </label>
                    )}
                  </For>
                </div>
                <div class="iae-grid">
                  <div class="iae-field">
                    <span>Response style</span>
                    <div class="iae-seg">
                      <For each={Object.keys(RESPONSE_MODES) as (keyof typeof RESPONSE_MODES)[]}>
                        {(k) => (
                          <button type="button" aria-pressed={draft.responseMode === k} onClick={() => setDraft("responseMode", k)}>
                            {k}
                          </button>
                        )}
                      </For>
                    </div>
                    <small class="iae-hint iae-num">temperature {RESPONSE_MODES[draft.responseMode]}</small>
                  </div>
                  <div class="iae-field">
                    <span>Response length</span>
                    <div class="iae-seg">
                      <For each={Object.keys(RESPONSE_LENGTHS) as (keyof typeof RESPONSE_LENGTHS)[]}>
                        {(k) => (
                          <button type="button" aria-pressed={draft.responseLength === k} onClick={() => setDraft("responseLength", k)}>
                            {k}
                          </button>
                        )}
                      </For>
                    </div>
                    <small class="iae-hint iae-num">max {RESPONSE_LENGTHS[draft.responseLength].toLocaleString()} tokens</small>
                  </div>
                </div>
              </Match>

              {/* ── TOOLS (was Capabilities) ──────────────────────────────────────────── */}
              <Match when={step() === "tools"}>
                <Show when={draft.toolsLegacy}>
                  <p class="iae-warn">
                    This agent was never given a tool list, so it may be getting every tool. The read-only defaults are checked below — save to scope it.
                  </p>
                </Show>
                <Show when={!catalog().available}>
                  <p class="iae-note">
                    The full tool catalogue is not on this server yet{catalogRes.latest?.reason ? ` (${catalogRes.latest.reason})` : ""}. Showing the read-only
                    set every new agent starts with.
                  </p>
                </Show>
                <div class="iae-summary" data-testid="iris-agent-tool-summary">
                  <span class="iae-num">{draft.tools.length}</span> selected
                  <For each={effectSummary(catalog(), draft.tools)}>
                    {(e) => (
                      <span class="iae-effect" data-effect={e.effect}>
                        {effectLabel(catalog(), e.effect)} <b class="iae-num">{e.count}</b>
                      </span>
                    )}
                  </For>
                </div>
                <div class="iae-toolbar">
                  <input class="iae-find" type="search" placeholder="Find a tool…" value={toolQuery()} onInput={(e) => setToolQuery(e.currentTarget.value)} />
                  <label class="iae-check">
                    <input type="checkbox" checked={onlySelected()} onChange={(e) => setOnlySelected(e.currentTarget.checked)} /> Selected only
                  </label>
                </div>
                <For each={groups()}>
                  {(g) => (
                    <details class="iae-group" open={g.id !== "business" || !!toolQuery() || onlySelected()}>
                      <summary>
                        {g.name}
                        <span class="iae-num iae-muted">
                          {g.tools.filter((t) => isChecked(catalog(), draft.tools, t)).length}/{g.tools.length}
                        </span>
                        <Show when={g.id === "business"}>
                          <span class="iae-muted"> · includes tools built for specific clients</span>
                        </Show>
                      </summary>
                      <For each={g.tools}>
                        {(t) => {
                          const badge = () => approvalBadge(catalog(), t, autonomy())
                          return (
                            <label class="iae-tool" data-tool={t.id}>
                              <input
                                type="checkbox"
                                checked={isChecked(catalog(), draft.tools, t)}
                                onChange={(e) => setDraft("tools", toggleTool(catalog(), draft.tools, t, e.currentTarget.checked))}
                              />
                              <span class="iae-tool__main">
                                <span class="iae-tool__name">
                                  {t.name}
                                  <Show when={t.isDefault}>
                                    <span class="iae-chip">default</span>
                                  </Show>
                                  <Show when={t.alwaysOn}>
                                    <span class="iae-chip" title="Every scoped agent has this, listed or not">always on</span>
                                  </Show>
                                </span>
                                <Show when={t.description}>
                                  <span class="iae-tool__desc">{t.description}</span>
                                </Show>
                              </span>
                              <span class="iae-effect" data-effect={t.effect}>
                                {effectLabel(catalog(), t.effect)}
                              </span>
                              <Show when={badge()}>
                                {(b) => (
                                  <span class="iae-approval" data-kind={b().kind}>
                                    {b().label}
                                  </span>
                                )}
                              </Show>
                            </label>
                          )
                        }}
                      </For>
                    </details>
                  )}
                </For>
                <Show when={unknownEntries(catalog(), draft.tools).length}>
                  <details class="iae-group" open>
                    <summary>
                      Not in the catalogue <span class="iae-num iae-muted">{unknownEntries(catalog(), draft.tools).length}</span>
                    </summary>
                    <p class="iae-hint">Already on this agent's list. Kept unless you remove them{catalog().available ? " — iris-api will refuse names it does not know" : ""}.</p>
                    <For each={unknownEntries(catalog(), draft.tools)}>
                      {(name) => (
                        <label class="iae-tool">
                          <input type="checkbox" checked onChange={() => setDraft("tools", draft.tools.filter((x) => x !== name))} />
                          <span class="iae-tool__main">
                            <span class="iae-tool__name iae-num">{name}</span>
                          </span>
                          <span class="iae-effect" data-effect="unclassified">
                            unknown
                          </span>
                        </label>
                      )}
                    </For>
                  </details>
                </Show>
                <Show when={catalog().integrations.length}>
                  <details class="iae-group">
                    <summary>
                      Integrations <span class="iae-num iae-muted">{catalog().integrations.length}</span>
                    </summary>
                    <p class="iae-hint">Switched on per agent with its connections (Channels, in ELON for now) — not through this list. Shown for what each can do.</p>
                    <For each={catalog().integrations}>
                      {(i) => (
                        <div class="iae-tool" data-readonly>
                          <span class="iae-tool__main">
                            <span class="iae-tool__name">{i.name}</span>
                          </span>
                          <span class="iae-effect" data-effect={i.effect}>
                            {effectLabel(catalog(), i.effect)}
                          </span>
                        </div>
                      )}
                    </For>
                  </details>
                </Show>
              </Match>

              {/* ── RULES & APPROVALS ─────────────────────────────────────────────────── */}
              <Match when={step() === "rules"}>
                <p class="iae-lede">Limits iris-api enforces on every tool call that changes shared data, sends, or pays. Reads are never limited.</p>
                <Show when={policyRes.latest?.ok && policyRes.latest.data?.autonomy}>
                  {(_) => {
                    const a = policyRes.latest!.data.autonomy
                    return (
                      <p class="iae-note">
                        Trust level <b>{a.set ? a.level : "not set"}</b>
                        {a.meaning ? ` — ${a.meaning}` : ""}
                        <Show when={Array.isArray(a.holds) && a.holds.length}>
                          . Holds for approval: <span class="iae-num">{a.holds.join(", ")}</span>
                        </Show>
                      </p>
                    )
                  }}
                </Show>
                <Show when={policyRes.latest && !policyRes.latest.ok}>
                  <p class="iae-warn">Could not read the current rules — {policyRes.latest!.reason}.</p>
                </Show>
                <Show when={creating()}>
                  <p class="iae-hint">Applied right after the agent is created.</p>
                </Show>
                <div class="iae-grid">
                  <label class="iae-field">
                    <span>Never allow</span>
                    <input value={draft.policy.denied} placeholder="publish_*, delete_*" onInput={(e) => setDraft("policy", "denied", e.currentTarget.value)} />
                    <small class="iae-hint">Tool names or patterns, comma-separated.</small>
                  </label>
                  <label class="iae-field">
                    <span>Only allow</span>
                    <input value={draft.policy.allowed} placeholder="(any on its tool list)" onInput={(e) => setDraft("policy", "allowed", e.currentTarget.value)} />
                  </label>
                  <label class="iae-field">
                    <span>Always ask first</span>
                    <input
                      data-testid="iris-agent-require-approval"
                      value={draft.policy.requireApproval}
                      placeholder="send_email"
                      onInput={(e) => setDraft("policy", "requireApproval", e.currentTarget.value)}
                    />
                    <Show when={riskyTools(catalog(), draft.tools).length}>
                      <button
                        type="button"
                        class="iae-link"
                        onClick={() => setDraft("policy", "requireApproval", addToList(draft.policy.requireApproval, riskyTools(catalog(), draft.tools)))}
                      >
                        Ask first for its {riskyTools(catalog(), draft.tools).length} send/payment tools
                      </button>
                    </Show>
                  </label>
                  <label class="iae-field">
                    <span>Pre-approved</span>
                    <input value={draft.policy.preApproved} onInput={(e) => setDraft("policy", "preApproved", e.currentTarget.value)} />
                    <small class="iae-hint">Run without an effect-based hold. Never lifts a gated schedule.</small>
                  </label>
                  <label class="iae-field">
                    <span>Calls per day</span>
                    <textarea rows={3} value={draft.policy.caps} placeholder="send_email: 20" onInput={(e) => setDraft("policy", "caps", e.currentTarget.value)} />
                  </label>
                  <label class="iae-field">
                    <span>Spend cap per day</span>
                    <input inputMode="decimal" value={draft.policy.spendCap} placeholder="0.00" onInput={(e) => setDraft("policy", "spendCap", e.currentTarget.value)} />
                    <small class="iae-hint">A payment whose amount cannot be read is refused.</small>
                  </label>
                </div>
                <div class="iae-grid iae-grid--4">
                  <label class="iae-field">
                    <span>Quiet from</span>
                    <input type="time" value={draft.policy.quietStart} onInput={(e) => setDraft("policy", "quietStart", e.currentTarget.value)} />
                  </label>
                  <label class="iae-field">
                    <span>until</span>
                    <input type="time" value={draft.policy.quietEnd} onInput={(e) => setDraft("policy", "quietEnd", e.currentTarget.value)} />
                  </label>
                  <label class="iae-field">
                    <span>Quiet-hours time zone</span>
                    <input value={draft.policy.quietTimezone} placeholder="America/Chicago" onInput={(e) => setDraft("policy", "quietTimezone", e.currentTarget.value)} />
                  </label>
                  <label class="iae-field">
                    <span>“Per day” time zone</span>
                    <input value={draft.policy.timezone} placeholder="UTC" onInput={(e) => setDraft("policy", "timezone", e.currentTarget.value)} />
                  </label>
                </div>
                <Show when={policyRes.latest?.ok && (policyRes.latest.data?.recent_refusals ?? []).length}>
                  <h4 class="iae-h4">Recently refused</h4>
                  <ul class="iae-refusals">
                    <For each={policyRes.latest!.data.recent_refusals as any[]}>
                      {(x) => (
                        <li>
                          <span class="iae-num">{x.tool_name}</span> — {x.reason} <span class="iae-muted">({x.rule}, {x.occurred_at})</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </Match>

              {/* ── SCHEDULE (heartbeat) ──────────────────────────────────────────────── */}
              <Match when={step() === "schedule"}>
                <p class="iae-lede">Whether it wakes by itself, how often, and on which days.</p>
                <div class="iae-modes" role="radiogroup" aria-label="Heartbeat">
                  <For each={HEARTBEAT_MODES}>
                    {(m) => (
                      <label class="iae-mode" data-on={draft.heartbeat.mode === m.id ? "" : undefined}>
                        <input type="radio" name="iae-hb" checked={draft.heartbeat.mode === m.id} onChange={() => setDraft("heartbeat", "mode", m.id)} />
                        <b>{m.label}</b>
                        <span>{m.hint}</span>
                      </label>
                    )}
                  </For>
                </div>
                <Show when={draft.heartbeat.mode !== "off"}>
                  <div class="iae-grid">
                    <label class="iae-field">
                      <span>How often</span>
                      <select value={draft.heartbeat.frequency} onChange={(e) => setDraft("heartbeat", "frequency", e.currentTarget.value)}>
                        <For each={FREQUENCIES}>{(f) => <option value={f.id}>{f.label}</option>}</For>
                        <Show when={!FREQUENCIES.some((f) => f.id === draft.heartbeat.frequency)}>
                          <option value={draft.heartbeat.frequency}>{draft.heartbeat.frequency}</option>
                        </Show>
                      </select>
                    </label>
                    <Show when={draft.heartbeat.mode === "briefing"}>
                      <label class="iae-field">
                        <span>Briefing at</span>
                        <input type="time" value={draft.heartbeat.briefingTime} onInput={(e) => setDraft("heartbeat", "briefingTime", e.currentTarget.value)} />
                      </label>
                    </Show>
                  </div>
                  <div class="iae-field">
                    <span>Working days</span>
                    <div class="iae-days">
                      <For each={DAYS}>
                        {(d) => (
                          <button
                            type="button"
                            aria-pressed={draft.heartbeat.workingDays.includes(d)}
                            onClick={() =>
                              setDraft(
                                "heartbeat",
                                "workingDays",
                                draft.heartbeat.workingDays.includes(d)
                                  ? draft.heartbeat.workingDays.filter((x) => x !== d)
                                  : DAYS.filter((x) => x === d || draft.heartbeat.workingDays.includes(x)),
                              )
                            }
                          >
                            {d}
                          </button>
                        )}
                      </For>
                      <button type="button" class="iae-link" onClick={() => setDraft("heartbeat", "workingDays", ["mon", "tue", "wed", "thu", "fri"])}>
                        Weekdays
                      </button>
                      <button type="button" class="iae-link" onClick={() => setDraft("heartbeat", "workingDays", [...DAYS])}>
                        Every day
                      </button>
                    </div>
                  </div>
                </Show>
                <p class="iae-hint">Recurring tasks and report e-mails from ELON's schedule tab stay in ELON for now; runs and pauses are under Agents › Heartbeats.</p>
              </Match>

              {/* ── MEMORY & FILES ────────────────────────────────────────────────────── */}
              <Match when={step() === "memory"}>
                <p class="iae-lede">The board it works from is also what it knows: its knowledge search reads that board.</p>
                <label class="iae-field">
                  <span>Board (knowledge base)</span>
                  <select
                    data-testid="iris-agent-board"
                    value={draft.bloqId ?? ""}
                    onChange={(e) => setDraft("bloqId", e.currentTarget.value ? Number(e.currentTarget.value) : null)}
                  >
                    <Show when={draft.bloqId == null}>
                      <option value="">Pick a board…</option>
                    </Show>
                    <For each={props.boards()}>{(b) => <option value={b.id}>{b.name} · #{b.id}</option>}</For>
                    <Show when={draft.bloqId != null && !props.boards().some((b) => b.id === draft.bloqId)}>
                      <option value={draft.bloqId!}>#{draft.bloqId}</option>
                    </Show>
                  </select>
                  <Show when={!creating() && raw()?.bloq_id && draft.bloqId !== raw()?.bloq_id}>
                    <small class="iae-hint iae-amber">Saving moves the agent to this board.</small>
                  </Show>
                </label>
                <label class="iae-check">
                  <input type="checkbox" checked={draft.useKnowledgeBase} onChange={(e) => setDraft("useKnowledgeBase", e.currentTarget.checked)} /> Search the board's
                  knowledge when answering
                </label>
                <label class="iae-check">
                  <input type="checkbox" checked={draft.memoryPersistence} onChange={(e) => setDraft("memoryPersistence", e.currentTarget.checked)} /> Remember across
                  conversations
                </label>
                <Show when={!creating()}>
                  <p class="iae-note">
                    <span class="iae-num">{counts().memory}</span> memory {counts().memory === 1 ? "entry" : "entries"} ·{" "}
                    <span class="iae-num">{counts().files}</span> attached {counts().files === 1 ? "file" : "files"}. Uploading and pruning stay in ELON for now.
                  </p>
                </Show>
              </Match>

              {/* ── ALERTS (status settings) ──────────────────────────────────────────── */}
              <Match when={step() === "alerts"}>
                <p class="iae-lede">Who is told when something this agent depends on breaks. Set for this board, or for your whole account.</p>
                <Show when={alertsRes.latest && !alertsRes.latest.ok}>
                  <p class="iae-warn">Could not read alert settings — {alertsRes.latest!.reason}.</p>
                </Show>
                <Show when={alertsRes.latest?.ok}>
                  <table class="iae-levels">
                    <thead>
                      <tr>
                        <th>Setting</th>
                        <th>In effect</th>
                        <th>From</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={Object.entries(alertSources(alertsRes.latest!.data))}>
                        {([field, v]) => (
                          <tr>
                            <td>{field.replace(/_/g, " ")}</td>
                            <td class="iae-num">{alertValue(field as any, v.value)}</td>
                            <td>
                              <span class="iae-from" data-from={v.from}>
                                {v.from === "project" ? "this board" : v.from === "account" ? "your account" : "default"}
                              </span>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                  <div class="iae-seg" role="radiogroup" aria-label="Level">
                    <button type="button" disabled={!props.bloqId} aria-pressed={alertLevel() === "project"} onClick={() => setAlertLevel("project")}>
                      This board
                    </button>
                    <button type="button" aria-pressed={alertLevel() === "account"} onClick={() => setAlertLevel("account")}>
                      Your account
                    </button>
                  </div>
                  <div class="iae-grid">
                    <div class="iae-field">
                      <span>Channels</span>
                      <div class="iae-seg">
                        <button type="button" aria-pressed={alerts.channels === "inherit"} onClick={() => setAlerts("channels", "inherit")}>
                          {alertLevel() === "project" ? "Account's" : "By severity"}
                        </button>
                        <button
                          type="button"
                          aria-pressed={typeof alerts.channels === "object"}
                          onClick={() => setAlerts("channels", { email: true, in_app: true, sms: false })}
                        >
                          Choose
                        </button>
                        <button type="button" aria-pressed={alerts.channels === "off"} onClick={() => setAlerts("channels", "off")}>
                          Off
                        </button>
                      </div>
                      <Show when={typeof alerts.channels === "object" && alerts.channels}>
                        {(c) => (
                          <div class="iae-days">
                            <For each={["email", "in_app", "sms"] as const}>
                              {(k) => (
                                <button type="button" aria-pressed={c()[k]} onClick={() => setAlerts("channels", { ...c(), [k]: !c()[k] })}>
                                  {k === "in_app" ? "in-app" : k}
                                </button>
                              )}
                            </For>
                          </div>
                        )}
                      </Show>
                    </div>
                    <label class="iae-field">
                      <span>Tell me from</span>
                      <select value={alerts.minSeverity} onChange={(e) => setAlerts("minSeverity", e.currentTarget.value as any)}>
                        <option value="inherit">{alertLevel() === "project" ? "Account's setting" : "Default (major)"}</option>
                        <option value="minor">Minor and up</option>
                        <option value="major">Major and up</option>
                        <option value="critical">Critical only</option>
                      </select>
                    </label>
                    <label class="iae-field">
                      <span>Platform incidents</span>
                      <select value={alerts.platformNotices} onChange={(e) => setAlerts("platformNotices", e.currentTarget.value as any)}>
                        <option value="inherit">{alertLevel() === "project" ? "Account's setting" : "Default (affected)"}</option>
                        <option value="affected">Only ones that affect me</option>
                        <option value="all">All</option>
                        <option value="none">None</option>
                      </select>
                    </label>
                    <label class="iae-field">
                      <span>Also email</span>
                      <input value={alerts.emails} placeholder="ops@example.com (up to 10)" onInput={(e) => setAlerts("emails", e.currentTarget.value)} />
                    </label>
                    <label class="iae-field">
                      <span>Also tell (user ids)</span>
                      <input value={alerts.userIds} placeholder="People on your boards, up to 10" onInput={(e) => setAlerts("userIds", e.currentTarget.value)} />
                      <small class="iae-hint">Blank = use the {alertLevel() === "project" ? "account's" : "default"} list.</small>
                    </label>
                  </div>
                  <div class="iae-actions">
                    <button type="button" class="iae-btn" disabled={busy() || !alertsDirty()} onClick={() => void saveAlerts()}>
                      Save alerts
                    </button>
                    <button type="button" class="iae-btn iae-btn--ghost" disabled={busy()} onClick={() => void testAlerts()}>
                      Send a test alert
                    </button>
                  </div>
                </Show>
              </Match>

              {/* ── PHASE 2 ───────────────────────────────────────────────────────────── */}
              <Match when={STEPS.find((s) => s.id === step())?.phase === 2}>
                <div class="iae-later">
                  <b>{STEPS.find((s) => s.id === step())!.label} is still in ELON for now.</b>
                  <p>
                    It comes to Desktop in the next phase of #191840.{" "}
                    {
                      {
                        voice: "Voice (VAPI) needs its phone-number and assistant-sync flow.",
                        prompts: "Prompt categories feed the public Ask page.",
                        public: "Public page, slug and copy settings.",
                        channels: "Discord, Slack and other channels the agent answers on.",
                        monetization: "Free, email-gated or paid access.",
                      }[step() as "voice"]
                    }
                  </p>
                </div>
              </Match>
            </Switch>
          </Show>
        </div>

        <footer class="iae-foot">
          <button type="button" class="iae-btn iae-btn--ghost" disabled={index() <= 0} onClick={() => go(-1)}>
            ← Back
          </button>
          <Show when={note()}>
            {(n) => (
              <p class="iae-note-line" data-ok={n().ok ? "" : undefined} role="status" data-testid="iris-agent-note">
                {n().text}
              </p>
            )}
          </Show>
          <span class="iae-spacer" />
          <Show when={!creating() && STEPS.find((s) => s.id === step())?.phase === 1}>
            <button
              type="button"
              class="iae-btn"
              data-testid="iris-agent-save-step"
              disabled={busy() || !ready() || (step() === "alerts" ? !alertsDirty() : !dirty(step()))}
              onClick={() => void saveStep()}
            >
              Save {STEPS.find((s) => s.id === step())!.label}
            </button>
          </Show>
          <button type="button" class="iae-btn iae-btn--ghost" disabled={index() >= steps().length - 1} onClick={() => go(1)}>
            Next →
          </button>
        </footer>
      </section>
    </div>
  )
}
