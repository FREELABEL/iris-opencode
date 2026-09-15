import { createEffect, createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { itemCommands, renderMarkdown } from "./session-iris-tab"

/**
 * The card editor — a board item you can CHANGE from the panel (#185485).
 *
 * WHY A MODAL, in a tab whose whole design is three levels of in-place navigation. Width.
 * The panel is ~500px with the sidebar open; Details beside a body is a two-column layout and
 * 500px cannot hold it honestly — it would be Elon's editor with its sidebar amputated. The
 * navigation objection is real and survivable as long as this opens FROM a row and returns TO
 * it, and never grows a surface switcher of its own. It is a detail view, not a second app.
 *
 * WHAT IT WRITES, and what it does not. Every control here maps to a column fl-api's item
 * update actually accepts — title, status, card_type, priority, due_date, bloq_list_id, the
 * body — and to bloq_item_tasks. Assigning an agent is adding a task that carries the agent,
 * because that is the primitive that exists: there is deliberately no agent column on items.
 * Elon's editor keeps labels and assignedAgents INSIDE the content JSON; those are shown here
 * read-only rather than written a second way.
 *
 * Saves are explicit and field-scoped. A title save cannot blank a body, a body save cannot
 * clear a priority: only what changed is sent, and the sidecar sends only what it was given.
 */

export interface CardTask {
  id: number
  title: string
  description?: string
  done: boolean
  status?: string
  agentId?: number
  agentName?: string
  dueDate?: string
  completedAt?: string
  source?: string
  depth: number
}

export interface CardDoc {
  measured: boolean
  reason?: string
  id: number
  title: string
  content: string
  contentKind: "markdown" | "structured"
  description?: string
  cardType?: string
  priority?: string
  status?: string
  dueDate?: string
  listId?: number
  listName?: string
  labels: string[]
  isPublic: boolean
  publicUrl?: string
  updatedAt?: string
  tasks: CardTask[]
  tasksMeasured: boolean
  tasksReason?: string
}

export interface SchemaOption {
  id: string
  label: string
  color?: string
}
export interface CardSchema {
  measured: boolean
  reason?: string
  type: SchemaOption[]
  priority: SchemaOption[]
  status: SchemaOption[]
}

/** The editable fields, as the form holds them. Empty string means "none" for the nullables. */
export interface CardDraft {
  title: string
  status: string
  cardType: string
  priority: string
  dueDate: string
  listId: string
}

export interface CardPatch {
  title?: string
  body?: string
  bodyMode?: "replace" | "merge"
  status?: string
  priority?: string | null
  cardType?: string | null
  dueDate?: string | null
  listId?: number
}

/** The statuses the item column accepts. Mirrors the sidecar's ITEM_STATUSES; a schema id outside it is shown but cannot be written. */
export const WRITABLE_STATUSES = ["active", "pending", "approved", "rejected", "todo", "in_progress", "done"] as const

export function draftFrom(doc: CardDoc): CardDraft {
  return {
    title: doc.title,
    status: doc.status ?? "",
    cardType: doc.cardType ?? "",
    priority: doc.priority ?? "",
    dueDate: doc.dueDate ?? "",
    listId: doc.listId != null ? String(doc.listId) : "",
  }
}

/**
 * Only what changed. Exported because this is where a save silently becomes a no-op: a field
 * compared wrongly here is a control that appears to work and writes nothing.
 */
export function diffDraft(doc: CardDoc, draft: CardDraft): CardPatch {
  const base = draftFrom(doc)
  const patch: CardPatch = {}
  if (draft.title !== base.title && draft.title.trim()) patch.title = draft.title.trim()
  if (draft.status !== base.status && draft.status) patch.status = draft.status
  if (draft.cardType !== base.cardType) patch.cardType = draft.cardType || null
  if (draft.priority !== base.priority) patch.priority = draft.priority || null
  if (draft.dueDate !== base.dueDate) patch.dueDate = draft.dueDate || null
  if (draft.listId !== base.listId && draft.listId) patch.listId = Number(draft.listId)
  return patch
}

/**
 * The status picker's options: the board's vocabulary, plus whatever the item ALREADY has if
 * the vocabulary does not name it. `active` is a legal stored status the default schema omits;
 * dropping it would render the current value as blank and the first save would change it.
 *
 * Options the column will refuse are kept visible and marked, not hidden — a board admin who
 * declared them should see that they do not work, rather than wonder where they went.
 */
export function statusOptions(
  schema: SchemaOption[],
  current: string | undefined,
): { id: string; label: string; writable: boolean }[] {
  const out = schema.map((o) => ({ id: o.id, label: o.label, writable: (WRITABLE_STATUSES as readonly string[]).includes(o.id) }))
  if (current && !out.some((o) => o.id === current)) {
    out.unshift({ id: current, label: current.replace(/_/g, " "), writable: (WRITABLE_STATUSES as readonly string[]).includes(current) })
  }
  return out
}

/** "2026-08-06T16:14:44.000000Z" → "6 Aug 2026". */
function shortDate(iso: string | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
}

export interface IrisCardEditorProps {
  itemId: number
  bloqId: number
  /** The board's lists, from the Atlas payload already on screen. The List picker. */
  lists: { id: number; name: string }[]
  doFetch: (path: string, init?: RequestInit) => Promise<Response>
  /** Called after any write landed, so the list behind the dialog can refresh its row. */
  onChanged?: () => void
}

type SideTab = "details" | "tasks"

export function IrisCardEditor(props: IrisCardEditorProps) {
  const dialog = useDialog()

  const [doc, { mutate: mutateDoc, refetch: refetchDoc }] = createResource(
    () => props.itemId,
    async (id) => (await (await props.doFetch(`/iris/item/${id}`)).json()) as CardDoc,
  )
  const [schema] = createResource(
    () => props.bloqId,
    async (b) => (await (await props.doFetch(`/iris/card-schema/${b}`)).json()) as CardSchema,
  )
  /** Fetched only once the Tasks tab (or an assign) asks for it. */
  const [wantAgents, setWantAgents] = createSignal(false)
  const [agents] = createResource(
    () => (wantAgents() ? props.bloqId : undefined),
    async (b) =>
      (await (await props.doFetch(`/iris/agents/${b}?page=1&perPage=200`)).json()) as {
        measured: boolean
        reason?: string
        agents: { id: number; name: string }[]
      },
  )

  const [side, setSide] = createSignal<SideTab>("details")
  createEffect(() => {
    if (side() === "tasks") setWantAgents(true)
  })

  // ── Details ─────────────────────────────────────────────────────────────
  const [draft, setDraft] = createSignal<CardDraft | null>(null)
  const form = createMemo((): CardDraft | null => draft() ?? (doc.latest ? draftFrom(doc.latest) : null))
  const patch = createMemo(() => (doc.latest && form() ? diffDraft(doc.latest, form()!) : {}))
  const dirty = createMemo(() => Object.keys(patch()).length > 0)
  const set = <K extends keyof CardDraft>(k: K, v: CardDraft[K]) => {
    const cur = form()
    if (!cur) return
    setDraft({ ...cur, [k]: v })
  }

  const [saving, setSaving] = createSignal(false)
  const [note, setNote] = createSignal<{ ok: boolean; text: string } | null>(null)

  async function post(path: string, body?: unknown): Promise<{ ok: boolean; reason?: string } & Record<string, any>> {
    try {
      const res = await props.doFetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      })
      return (await res.json()) as any
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  async function saveDetails() {
    const d = doc.latest
    const p = patch()
    if (!d || !dirty() || saving()) return
    setSaving(true)
    setNote(null)
    const out = await post(`/iris/item/${d.id}/save`, p)
    if (out.ok) {
      // Adopt what we wrote, so the NEXT diff is against the saved state and a second save
      // does not resend the same fields.
      mutateDoc((cur) =>
        cur
          ? {
              ...cur,
              title: p.title ?? cur.title,
              status: p.status ?? cur.status,
              cardType: p.cardType === undefined ? cur.cardType : (p.cardType ?? undefined),
              priority: p.priority === undefined ? cur.priority : (p.priority ?? undefined),
              dueDate: p.dueDate === undefined ? cur.dueDate : (p.dueDate ?? undefined),
              listId: p.listId ?? cur.listId,
              listName: p.listId != null ? (props.lists.find((l) => l.id === p.listId)?.name ?? cur.listName) : cur.listName,
            }
          : cur,
      )
      setDraft(null)
      setNote({ ok: true, text: `Saved ${Object.keys(p).length} field${Object.keys(p).length === 1 ? "" : "s"}` })
      props.onChanged?.()
    } else {
      setNote({ ok: false, text: out.reason ?? "save failed" })
    }
    setSaving(false)
  }

  // ── Body ────────────────────────────────────────────────────────────────
  const [editingBody, setEditingBody] = createSignal(false)
  const [bodyDraft, setBodyDraft] = createSignal<string | null>(null)
  const bodyDirty = createMemo(() => bodyDraft() != null && bodyDraft() !== (doc.latest?.content ?? ""))
  const [savingBody, setSavingBody] = createSignal(false)
  const [bodyNote, setBodyNote] = createSignal<{ ok: boolean; text: string } | null>(null)

  async function saveBody() {
    const d = doc.latest
    const b = bodyDraft()
    if (!d || b == null || !bodyDirty() || savingBody()) return
    setSavingBody(true)
    setBodyNote(null)
    const out = await post(`/iris/item/${d.id}/save`, {
      body: b,
      bodyMode: d.contentKind === "structured" ? "merge" : "replace",
    })
    if (out.ok) {
      mutateDoc((cur) => (cur ? { ...cur, content: b } : cur))
      setBodyDraft(null)
      setEditingBody(false)
      setBodyNote({ ok: true, text: "Saved" })
      props.onChanged?.()
    } else {
      setBodyNote({ ok: false, text: out.reason ?? "save failed" })
    }
    setSavingBody(false)
  }

  // ── Tasks ───────────────────────────────────────────────────────────────
  const [newTask, setNewTask] = createSignal("")
  const [newAgent, setNewAgent] = createSignal("")
  const [taskNote, setTaskNote] = createSignal<{ ok: boolean; text: string } | null>(null)
  const [busyTask, setBusyTask] = createSignal<number | null>(null)
  const [adding, setAdding] = createSignal(false)
  /** The task whose × was pressed once. A second press within the window deletes. */
  const [armed, setArmed] = createSignal<number | null>(null)

  async function addTask() {
    const d = doc.latest
    const title = newTask().trim()
    if (!d || !title || adding()) return
    setAdding(true)
    setTaskNote(null)
    const agentId = newAgent() ? Number(newAgent()) : undefined
    const out = await post(`/iris/item/${d.id}/tasks`, { title, agentId })
    if (out.ok) {
      setNewTask("")
      setNewAgent("")
      // Re-read rather than append: fl-api's create reply carries the agent id but not its
      // name, and a row that says "agent 701" beside rows that say "XArt Chief of Staff" is
      // the same list drawn two ways.
      await refetchDoc()
      setTaskNote({ ok: true, text: agentId ? "Task added and agent assigned" : "Task added" })
      props.onChanged?.()
    } else {
      setTaskNote({ ok: false, text: out.reason ?? "could not add" })
    }
    setAdding(false)
  }

  async function toggleTask(t: CardTask) {
    const d = doc.latest
    if (!d || busyTask() != null) return
    setBusyTask(t.id)
    setTaskNote(null)
    const out = await post(`/iris/item/${d.id}/tasks/${t.id}/save`, { done: !t.done })
    if (out.ok) {
      mutateDoc((cur) => (cur ? { ...cur, tasks: cur.tasks.map((x) => (x.id === t.id ? { ...x, done: !t.done } : x)) } : cur))
      props.onChanged?.()
    } else {
      setTaskNote({ ok: false, text: out.reason ?? "could not update" })
    }
    setBusyTask(null)
  }

  async function deleteTask(t: CardTask) {
    const d = doc.latest
    if (!d || busyTask() != null) return
    if (armed() !== t.id) {
      setArmed(t.id)
      setTimeout(() => setArmed((a) => (a === t.id ? null : a)), 2500)
      return
    }
    setArmed(null)
    setBusyTask(t.id)
    setTaskNote(null)
    const out = await post(`/iris/item/${d.id}/tasks/${t.id}/delete`)
    if (out.ok) {
      mutateDoc((cur) => (cur ? { ...cur, tasks: cur.tasks.filter((x) => x.id !== t.id) } : cur))
      props.onChanged?.()
    } else {
      setTaskNote({ ok: false, text: out.reason ?? "could not delete" })
    }
    setBusyTask(null)
  }

  const openTasks = createMemo(() => (doc.latest?.tasks ?? []).filter((t) => !t.done).length)
  const assigned = createMemo(() => {
    const seen = new Map<number, string>()
    for (const t of doc.latest?.tasks ?? []) if (t.agentId != null && !seen.has(t.agentId)) seen.set(t.agentId, t.agentName ?? `agent ${t.agentId}`)
    return [...seen.entries()].map(([id, name]) => ({ id, name }))
  })

  const statusOpts = createMemo(() => statusOptions(schema.latest?.status ?? [], doc.latest?.status))

  return (
    <Dialog
      size="x-large"
      class="iris-card"
      title={
        <span class="iris-card__crumb">
          <span class="text-text-weaker">{doc.latest?.listName ?? "Card"}</span>
          <span class="font-mono tabular-nums text-text-weaker">#{props.itemId}</span>
        </span>
      }
    >
      <Switch>
        <Match when={doc.loading && !doc.latest}>
          <p class="px-4 py-2 text-12-regular text-text-weak">Loading…</p>
        </Match>
        {/* NOT MEASURED — never drawn as an empty card. */}
        <Match when={doc.latest && !doc.latest.measured}>
          <p class="px-4 py-2 text-12-regular text-text-weak">Could not load this card — {doc.latest!.reason ?? "unknown"}.</p>
        </Match>
        <Match when={doc.latest?.measured}>
          <div class="iris-card__frame">
            {/* THE TITLE is the one field that lives above both columns: it names the card. */}
            <div class="iris-card__head">
              <input
                class="iris-card__title"
                aria-label="Title"
                value={form()?.title ?? ""}
                onInput={(e) => set("title", e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    void saveDetails()
                  }
                }}
              />
              <div class="iris-cmdbar shrink-0">
                <For each={itemCommands(props.itemId)}>
                  {(c) => (
                    <button
                      type="button"
                      class="iris-cmdbar__chip"
                      title={`Copy: ${c.cmd}`}
                      onClick={(e) => {
                        navigator.clipboard?.writeText(c.cmd)
                        const el = e.currentTarget
                        const was = el.textContent
                        el.textContent = "copied"
                        setTimeout(() => (el.textContent = was), 900)
                      }}
                    >
                      {c.label}
                    </button>
                  )}
                </For>
              </div>
            </div>

            <div class="iris-card__cols">
              {/* LEFT — the body. Read by default; one toggle to a plain textarea. */}
              <section class="iris-card__body">
                <div class="iris-card__bodybar">
                  <span class="text-11-regular text-text-weaker">
                    {doc.latest!.contentKind === "structured" ? "Body · structured (text is merged on save)" : "Body · markdown"}
                  </span>
                  <Show when={bodyNote()}>
                    {(n) => (
                      <span class="text-11-regular" classList={{ "text-text-base": n().ok, "text-text-weak": !n().ok }}>
                        {n().text}
                      </span>
                    )}
                  </Show>
                  <Show
                    when={editingBody()}
                    fallback={
                      <button type="button" class="iris-card__linkbtn" onClick={() => setEditingBody(true)}>
                        Edit body
                      </button>
                    }
                  >
                    <button
                      type="button"
                      class="iris-card__linkbtn"
                      onClick={() => {
                        setBodyDraft(null)
                        setEditingBody(false)
                        setBodyNote(null)
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      class="iris-card__linkbtn iris-card__linkbtn--primary"
                      disabled={!bodyDirty() || savingBody()}
                      onClick={() => void saveBody()}
                    >
                      {savingBody() ? "Saving…" : bodyDirty() ? "Save body" : "No changes"}
                    </button>
                  </Show>
                </div>
                <Show
                  when={editingBody()}
                  fallback={
                    <Show
                      when={doc.latest!.content}
                      fallback={<p class="px-1 py-2 text-12-regular text-text-weak">This card has no body.</p>}
                    >
                      <div
                        class="iris-markdown iris-card__read text-12-regular text-text-base"
                        innerHTML={renderMarkdown(doc.latest!.content)}
                      />
                    </Show>
                  }
                >
                  <textarea
                    class="iris-editor iris-card__textarea"
                    spellcheck={false}
                    value={bodyDraft() ?? doc.latest!.content}
                    onInput={(e) => setBodyDraft(e.currentTarget.value)}
                  />
                </Show>
              </section>

              {/* RIGHT — level-3 chips, the panel's own vocabulary for "which face of one record". */}
              <aside class="iris-card__side">
                <div class="iris-detailnav shrink-0" role="tablist" aria-label="Card views">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={side() === "details"}
                    class="iris-detailnav__item"
                    classList={{ "iris-detailnav__item--active": side() === "details" }}
                    onClick={() => setSide("details")}
                  >
                    Details
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={side() === "tasks"}
                    class="iris-detailnav__item"
                    classList={{ "iris-detailnav__item--active": side() === "tasks" }}
                    onClick={() => setSide("tasks")}
                  >
                    Tasks
                    <Show when={doc.latest!.tasksMeasured}>
                      <span class="iris-card__count">{openTasks()}</span>
                    </Show>
                  </button>
                </div>

                <div class="iris-card__sidebody">
                  <Switch>
                    <Match when={side() === "details"}>
                      <label class="iris-field">
                        <span class="iris-field__label">Status</span>
                        <select class="iris-field__input" value={form()?.status ?? ""} onChange={(e) => set("status", e.currentTarget.value)}>
                          <Show when={!form()?.status}>
                            <option value="">—</option>
                          </Show>
                          <For each={statusOpts()}>
                            {(o) => (
                              <option value={o.id} disabled={!o.writable}>
                                {o.label}
                                {o.writable ? "" : " (not writable)"}
                              </option>
                            )}
                          </For>
                        </select>
                      </label>

                      <label class="iris-field">
                        <span class="iris-field__label">Type</span>
                        <select class="iris-field__input" value={form()?.cardType ?? ""} onChange={(e) => set("cardType", e.currentTarget.value)}>
                          <option value="">None</option>
                          <For each={schema.latest?.type ?? []}>{(o) => <option value={o.id}>{o.label}</option>}</For>
                          <Show when={form()?.cardType && !(schema.latest?.type ?? []).some((o) => o.id === form()!.cardType)}>
                            <option value={form()!.cardType}>{form()!.cardType}</option>
                          </Show>
                        </select>
                      </label>

                      <label class="iris-field">
                        <span class="iris-field__label">Priority</span>
                        <select class="iris-field__input" value={form()?.priority ?? ""} onChange={(e) => set("priority", e.currentTarget.value)}>
                          <option value="">None</option>
                          <For each={schema.latest?.priority ?? []}>{(o) => <option value={o.id}>{o.label}</option>}</For>
                          <Show when={form()?.priority && !(schema.latest?.priority ?? []).some((o) => o.id === form()!.priority)}>
                            <option value={form()!.priority}>{form()!.priority}</option>
                          </Show>
                        </select>
                      </label>

                      <label class="iris-field">
                        <span class="iris-field__label">List</span>
                        <select class="iris-field__input" value={form()?.listId ?? ""} onChange={(e) => set("listId", e.currentTarget.value)}>
                          <Show when={form()?.listId && !props.lists.some((l) => String(l.id) === form()!.listId)}>
                            <option value={form()!.listId}>{doc.latest!.listName ?? `list ${form()!.listId}`}</option>
                          </Show>
                          <For each={props.lists}>{(l) => <option value={String(l.id)}>{l.name}</option>}</For>
                        </select>
                      </label>

                      <label class="iris-field">
                        <span class="iris-field__label">Due</span>
                        <input
                          type="date"
                          class="iris-field__input"
                          value={form()?.dueDate ?? ""}
                          onInput={(e) => set("dueDate", e.currentTarget.value)}
                        />
                      </label>

                      <Show when={schema.latest && !schema.latest.measured}>
                        <p class="text-11-regular text-text-weak">Vocabulary unavailable — {schema.latest!.reason}. Current values are kept.</p>
                      </Show>

                      <div class="iris-card__savebar">
                        <Show when={note()}>
                          {(n) => (
                            <span class="text-11-regular" classList={{ "text-text-base": n().ok, "text-text-weak": !n().ok }}>
                              {n().text}
                            </span>
                          )}
                        </Show>
                        <button
                          type="button"
                          class="iris-card__linkbtn iris-card__linkbtn--primary ms-auto"
                          disabled={!dirty() || saving()}
                          onClick={() => void saveDetails()}
                        >
                          {saving() ? "Saving…" : dirty() ? "Save" : "No changes"}
                        </button>
                      </div>

                      {/* READ-ONLY facts. Labels and agents live inside content / tasks; they
                          are shown so the panel does not hide what Elon shows, and not written
                          here so there is one write path for each. */}
                      <dl class="iris-card__facts">
                        <Show when={doc.latest!.labels.length}>
                          <dt>Labels</dt>
                          <dd>
                            <For each={doc.latest!.labels}>{(l) => <span class="iris-card__chip">{l}</span>}</For>
                          </dd>
                        </Show>
                        <Show when={assigned().length}>
                          <dt>Agents</dt>
                          <dd>
                            <For each={assigned()}>{(a) => <span class="iris-card__chip">{a.name}</span>}</For>
                          </dd>
                        </Show>
                        <Show when={doc.latest!.publicUrl}>
                          <dt>Public</dt>
                          <dd class="truncate font-mono text-11-regular">{doc.latest!.publicUrl}</dd>
                        </Show>
                        <dt>Updated</dt>
                        <dd class="font-mono tabular-nums text-11-regular">{shortDate(doc.latest!.updatedAt)}</dd>
                      </dl>
                    </Match>

                    <Match when={side() === "tasks"}>
                      <Show
                        when={doc.latest!.tasksMeasured}
                        fallback={
                          <p class="text-12-regular text-text-weak">Could not read tasks — {doc.latest!.tasksReason ?? "unknown"}.</p>
                        }
                      >
                        <Show when={doc.latest!.tasks.length === 0}>
                          <p class="text-12-regular text-text-weak pb-2">No tasks on this card.</p>
                        </Show>
                        <ul class="iris-card__tasks">
                          <For each={doc.latest!.tasks}>
                            {(t) => (
                              <li class="iris-card__task" style={{ "padding-inline-start": `${t.depth * 14}px` }}>
                                <input
                                  type="checkbox"
                                  class="iris-card__check"
                                  checked={t.done}
                                  disabled={busyTask() === t.id}
                                  aria-label={`${t.done ? "Reopen" : "Complete"}: ${t.title}`}
                                  onChange={() => void toggleTask(t)}
                                />
                                <span class="iris-card__tasktext" classList={{ "iris-card__tasktext--done": t.done }}>
                                  {t.title}
                                  <Show when={t.agentName}>
                                    <span class="iris-card__chip ms-1">{t.agentName}</span>
                                  </Show>
                                  <Show when={t.dueDate}>
                                    <span class="font-mono tabular-nums text-11-regular text-text-weaker ms-1">{t.dueDate}</span>
                                  </Show>
                                </span>
                                <button
                                  type="button"
                                  class="iris-card__x"
                                  classList={{ "iris-card__x--armed": armed() === t.id }}
                                  disabled={busyTask() === t.id}
                                  title={armed() === t.id ? "Click again to delete" : "Delete task"}
                                  onClick={() => void deleteTask(t)}
                                >
                                  {armed() === t.id ? "sure?" : "×"}
                                </button>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>

                      <form
                        class="iris-card__addtask"
                        onSubmit={(e) => {
                          e.preventDefault()
                          void addTask()
                        }}
                      >
                        <input
                          class="iris-field__input"
                          placeholder="Add a task…"
                          aria-label="New task"
                          value={newTask()}
                          onInput={(e) => setNewTask(e.currentTarget.value)}
                        />
                        <select class="iris-field__input" aria-label="Assign to agent" value={newAgent()} onChange={(e) => setNewAgent(e.currentTarget.value)}>
                          <option value="">No agent</option>
                          <For each={agents.latest?.agents ?? []}>{(a) => <option value={String(a.id)}>{a.name}</option>}</For>
                        </select>
                        <button type="submit" class="iris-card__linkbtn iris-card__linkbtn--primary" disabled={!newTask().trim() || adding()}>
                          {adding() ? "Adding…" : "Add"}
                        </button>
                      </form>
                      <Show when={agents.latest && !agents.latest.measured}>
                        <p class="text-11-regular text-text-weak">Agents unavailable — {agents.latest!.reason}.</p>
                      </Show>
                      <Show when={taskNote()}>
                        {(n) => (
                          <p class="text-11-regular pt-1" classList={{ "text-text-base": n().ok, "text-text-weak": !n().ok }}>
                            {n().text}
                          </p>
                        )}
                      </Show>
                    </Match>
                  </Switch>
                </div>
              </aside>
            </div>
          </div>
        </Match>
      </Switch>
      {/* Escape and the header × already close; this keeps the closing path visible for the
          people who look for a button. Nothing is lost on close: every write was explicit. */}
      <Show when={dirty() || bodyDirty()}>
        <div class="iris-card__unsaved" role="status">
          Unsaved changes — Save, or they stay in this window until it closes.{" "}
          <button type="button" class="iris-card__linkbtn" onClick={() => dialog.close()}>
            Discard and close
          </button>
        </div>
      </Show>
    </Dialog>
  )
}
