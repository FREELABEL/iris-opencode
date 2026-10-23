import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch, type JSX } from "solid-js"
import { pastedFiles } from "./iris-card-files"
import { WRITABLE_STATUSES, type SchemaOption } from "./iris-card-vocab"
import { Avatar, avatarColor, MembersRow, statusDot, type MemberChoice } from "./iris-card-facts"
import { IrisQuickEdit } from "./iris-quick-edit"
import { dueLabel, dueState, type QuickField, type QuickPatch } from "./iris-atlas-view"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { createDictation } from "@opencode-ai/session-ui/v2/prompt-input/dictation"
import { renderMarkdown } from "./iris-item"

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
 *
 * WIRED vs NOT YET. Sharing, Labels, Attachments, Events, Asks and Chat send the requests in
 * the HANDOFF contract (#185506). Until the sidecar grows those routes each section says
 * "Not connected" in place, with its controls visible, rather than hiding — the shape of the
 * UI is the contract, and a backend built against a hidden control is built against a guess.
 *
 * Saves are explicit and field-scoped. A title save cannot blank a body, a body save cannot
 * clear a priority: only what changed is sent, and the sidecar sends only what it was given.
 */

/** The backend/wiring ticket. Every "Not connected" line names it so nobody re-diagnoses a 404. */
export const HANDOFF = "#185506"

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

export { WRITABLE_STATUSES, type SchemaOption }
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

// ─── Sharing ────────────────────────────────────────────────────────────────

export interface ShareMember {
  userId: number
  name: string
  email: string
  permission: string
}
export interface ShareLink {
  id: number
  url: string
  createdAt: string
  expiresAt?: string
  uses: number
  revoked: boolean
}
export interface ShareState {
  measured: boolean
  reason?: string
  isPublic: boolean
  publicUrl?: string
  accessLevel?: string
  /** False: this fl-api build cannot show the list. Not the same as an empty list. */
  allowKnown: boolean
  allowedEmails: string[]
  boardDefaults: { allowedEmails: string[] }
  members: ShareMember[]
  links: ShareLink[]
}

/**
 * Split what someone typed into the allow-list into entries: emails or @domains, comma, space
 * or newline separated, lower-cased, de-duplicated against what is already there.
 */
export function parseAllowEntries(text: string, existing: string[] = []): string[] {
  const seen = new Set(existing.map((e) => e.toLowerCase()))
  const out: string[] = []
  for (const raw of text.split(/[\s,;]+/)) {
    const e = raw.trim().toLowerCase()
    if (!e) continue
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || /^@?[a-z0-9.-]+\.[a-z]{2,}$/.test(e)
    if (!ok || seen.has(e)) continue
    seen.add(e)
    out.push(e)
  }
  return out
}

/**
 * What the allow-list MEANS, said in words. An empty list on a public item admits anyone with
 * the link — that is the gate's real behaviour (never-empty-a-gate-allowlist), and a UI that
 * renders an empty list as a quiet blank is how it leaked three times.
 */
export function allowListSummary(isPublic: boolean, allowed: string[], allowKnown = true): string {
  if (!isPublic) return "Private — only people on this board can open it."
  if (!allowKnown) return "Public. The allow-list cannot be read from this fl-api build — what you set here is stored, but not shown."
  if (allowed.length === 0) return "ANYONE with the link can open it. Add an email or @domain to restrict."
  return `Only ${allowed.length} allowed ${allowed.length === 1 ? "entry" : "entries"} can open the link.`
}

// ─── Attachments / events / asks / chat ─────────────────────────────────────

export interface CardFile {
  id: string
  name: string
  size?: number
  type?: string
  url?: string
  /** False is Elon's "Missing Files Detected": referenced in content, not in storage. */
  stored: boolean
}
export interface CardEvent {
  id: number
  title: string
  startsAt: string
  endsAt?: string
  kind?: string
}
export interface CardAsk {
  id: number
  to: string
  what: string
  dueAt?: string
  status: "open" | "answered"
  answer?: string
}
export interface ChatMessage {
  id: string
  role: "user" | "agent"
  text: string
  at: string
  agentName?: string
}

type Wired<T> = { measured: boolean; reason?: string } & T

/** "12.3 KB" — for attachment rows. */
export function fileSize(n: number | undefined): string {
  if (n == null) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** "2026-08-06T16:14:44.000000Z" → "6 Aug 2026". */
function shortDate(iso: string | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
}
function shortWhen(iso: string | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
}

/** "just now", "5m ago", "2h ago", "3d ago", then a date — how Elon dates a card's history. */
export function timeAgo(iso: string | undefined, now: number): string {
  if (!iso) return ""
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  return shortDate(iso)
}

export interface TrailRow {
  id: number
  type: string
  text: string
  icon?: string
  actor?: string
  actorId?: number
  at?: string
}

/** One line of the card's conversation: a comment, or a run of changes by one person. */
export type TrailEntry =
  | { kind: "comment"; row: TrailRow; mine: boolean }
  | { kind: "change"; actor?: string; at?: string; rows: TrailRow[]; summary: string }

/**
 * The trail as a conversation, oldest first (#card-elon). Comments stay as they are; a run of
 * consecutive changes by the same person becomes ONE line ("Alex edited the card 12×"), because
 * nineteen identical "Item updated" rows bury the two comments that matter. `rows` arrive newest
 * first, as fl-api sends them. `me` is the signed-in person's name and email, for own bubbles.
 */
export function groupTrail(rows: TrailRow[], me: { id?: number | null; name?: string | null; email?: string | null } = {}): TrailEntry[] {
  const mine = (actor?: string, actorId?: number) => {
    if (me.id != null && actorId != null) return me.id === actorId
    const a = (actor ?? "").trim().toLowerCase()
    if (!a) return false
    const name = (me.name ?? "").trim().toLowerCase()
    const email = (me.email ?? "").trim().toLowerCase()
    return a === name || a === email || (!!email && a === email.split("@")[0])
  }
  const out: TrailEntry[] = []
  for (const row of [...rows].reverse()) {
    if (row.type === "comment") {
      out.push({ kind: "comment", row, mine: mine(row.actor, row.actorId) })
      continue
    }
    const last = out[out.length - 1]
    if (last?.kind === "change" && (last.actor ?? "") === (row.actor ?? "")) {
      last.rows.push(row)
      last.at = row.at ?? last.at
      continue
    }
    out.push({ kind: "change", actor: row.actor, at: row.at, rows: [row], summary: "" })
  }
  for (const e of out) {
    if (e.kind !== "change") continue
    const n = e.rows.length
    const edits = e.rows.every((r) => r.type === "item_updated" || /^item updated\b/i.test(r.text))
    e.summary = n === 1 ? e.rows[0].text : edits ? `edited the card ${n}×` : `made ${n} changes`
  }
  return out
}

export interface IrisCardEditorProps {
  itemId: number
  bloqId: number
  /** The board's lists, from the Atlas payload already on screen. The List picker. */
  lists: { id: number; name: string }[]
  doFetch: (path: string, init?: RequestInit) => Promise<Response>
  /** Called after any write landed, so the list behind the dialog can refresh its row. */
  onChanged?: () => void
  /**
   * The local server that records (its /dictate routes). With it the header gets a microphone:
   * record a meeting straight into this card (#190041). Without it, no microphone is drawn.
   */
  recorderUrl?: string
}

/**
 * A meeting transcript lands as a new line at the END of the body, as Elon's CardEditor does
 * (transcriptInsert: 'newline'). Never replaces what is there.
 */
export function appendTranscript(body: string, transcript: string): string {
  const text = transcript.trim()
  if (!text) return body
  const kept = body.replace(/\s+$/, "")
  return kept ? `${kept}\n\n${text}` : text
}

type SideTab = "details" | "sharing" | "tasks" | "chat"

export function IrisCardEditor(props: IrisCardEditorProps) {
  const dialog = useDialog()

  /**
   * One fetch shape for every section. A route the sidecar does not have yet comes back as
   * `measured: false` with the handoff ticket in the reason — the same shape a real outage
   * would have, so the section renders the same way and nobody has to special-case "unbuilt".
   */
  /**
   * A route the sidecar does not have is NOT a 404. The server falls through to the SPA and
   * answers 200 with index.html — measured 2026-09-15 on /iris/item/:id/share: status 200,
   * body "<!doctype html>". Read as JSON that is `{}`, and `{}` spread over empty lists is a
   * confident "no members, no links, nothing shared" about a route that does not exist.
   * So: JSON or it is not connected, and `measured` comes from the body, never assumed.
   */
  /**
   * What a section says when its route is not there yet. It must NOT name the sidecar or the
   * handoff ticket (#186548): "sidecar" is our word for a process the reader does not know
   * exists, and a ticket number is a URL they cannot open. The reader needs the state, not
   * the cause — and this same string is rendered in the Sharing panel of a card about to be
   * shared, where "half-built" is the last thing it should read as.
   */
  const MISSING = "Not available yet"
  async function readJson(res: Response): Promise<any | undefined> {
    if (!/json/i.test(res.headers.get("content-type") ?? "")) return undefined
    return res.json().catch(() => undefined)
  }
  async function wire<T>(path: string, empty: T, init?: RequestInit): Promise<Wired<T>> {
    try {
      const res = await props.doFetch(path, init)
      const j = await readJson(res)
      if (res.status === 404 || j === undefined) return { measured: false, reason: MISSING, ...empty }
      if (!res.ok) return { measured: false, reason: j?.reason ?? j?.message ?? `request failed (${res.status})`, ...empty }
      return { ...empty, ...j, measured: j.measured ?? true, reason: j.reason }
    } catch (e) {
      return { measured: false, reason: e instanceof Error ? e.message : String(e), ...empty }
    }
  }
  async function post(path: string, body?: unknown, init?: RequestInit): Promise<{ ok: boolean; reason?: string } & Record<string, any>> {
    try {
      const res = await props.doFetch(path, {
        method: "POST",
        ...(body instanceof FormData
          ? { body }
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }),
        ...init,
      })
      const j = await readJson(res)
      if (res.status === 404 || j === undefined) return { ok: false, reason: MISSING }
      if (!res.ok) return { ok: false, reason: j?.reason ?? j?.message ?? `request failed (${res.status})` }
      return { ...j, ok: j.ok ?? true }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  const [doc, { mutate: mutateDoc, refetch: refetchDoc }] = createResource(
    () => props.itemId,
    async (id) => (await (await props.doFetch(`/iris/item/${id}`)).json()) as CardDoc,
  )
  const [schema] = createResource(
    () => props.bloqId,
    async (b) => (await (await props.doFetch(`/iris/card-schema/${b}`)).json()) as CardSchema,
  )
  /** Fetched only once something asks for it (Tasks tab, Chat tab). */
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

  /*
   * ASSIGNEES (#189796). Who the card is assigned to, from fl-api's /assignees (#189792). The
   * board's members and agents are offered; anyone else can be assigned BY EMAIL, and that gives
   * them access to the cards assigned to them — assigning ties the access (#189801 ADR-02). Only
   * the board's owner can bring someone in this way; fl-api says so when it refuses.
   */
  type Assignee = { id: number; type: "user" | "agent"; userId?: number; agentId?: number; name?: string }
  const [assignees, { mutate: setAssignees }] = createResource(
    () => props.itemId,
    async (id) =>
      (await (await props.doFetch(`/iris/item/${id}/assignees`)).json()) as {
        measured: boolean
        reason?: string
        assignees: Assignee[]
      },
  )
  const [members] = createResource(
    () => props.bloqId,
    async (b) =>
      (await (await props.doFetch(`/iris/atlas/${b}/members`)).json()) as {
        measured: boolean
        ownerId: number | null
        members: { userId: number; name: string; email: string; permission: string }[]
      },
  )
  /** Your agents on every board: any of them may be put on this card (#190269). */
  const [myAgents] = createResource(
    () => (wantAgents() ? props.bloqId : undefined),
    async () =>
      (await (await props.doFetch(`/iris/agents-mine`)).json()) as { measured: boolean; agents: { id: number; name: string }[] },
  )
  const [assignNote, setAssignNote] = createSignal<{ ok: boolean; text: string } | null>(null)
  const assignable = createMemo(() => {
    const taken = new Set((assignees.latest?.assignees ?? []).map((a) => (a.type === "user" ? `u${a.userId}` : `a${a.agentId}`)))
    const people = (members.latest?.members ?? []).map((m) => ({ key: `u${m.userId}`, label: m.name || m.email, userId: m.userId }))
    const owner = members.latest?.ownerId
    const all = [
      ...(owner && !people.some((p) => p.userId === owner) ? [{ key: `u${owner}`, label: "Board owner", userId: owner }] : []),
      ...people,
      ...(agents.latest?.agents ?? []).map((a) => ({ key: `a${a.id}`, label: `${a.name} (agent)`, agentId: a.id })),
      // Then the rest of yours — a board's own agents first, because they are the likely pick.
      ...(myAgents.latest?.agents ?? [])
        .filter((a) => !(agents.latest?.agents ?? []).some((b) => b.id === a.id))
        .map((a) => ({ key: `a${a.id}`, label: `${a.name} (agent)`, agentId: a.id })),
    ]
    return all.filter((x) => !taken.has(x.key))
  })
  const [assignEmail, setAssignEmail] = createSignal("")
  async function addByEmail() {
    const email = assignEmail().trim()
    if (!email) return
    setAssignNote(null)
    const out = await post(`/iris/item/${props.itemId}/assignees`, { email })
    if (out.ok && Array.isArray(out.assignees)) {
      setAssignees((cur) => (cur ? { ...cur, assignees: out.assignees } : cur))
      setAssignEmail("")
      setAssignNote({
        ok: true,
        text: out.accessGranted ? `${email} can now see and work on the cards assigned to them — nothing else on this board.` : `Assigned ${email}.`,
      })
      props.onChanged?.()
    } else setAssignNote({ ok: false, text: out.reason ?? "could not assign" })
  }
  async function addAssignee(key: string) {
    const pick = assignable().find((x) => x.key === key)
    if (!pick) return
    setAssignNote(null)
    const out = await post(`/iris/item/${props.itemId}/assignees`, "userId" in pick ? { userId: pick.userId } : { agentId: (pick as any).agentId })
    if (out.ok && Array.isArray(out.assignees)) {
      setAssignees((cur) => (cur ? { ...cur, assignees: out.assignees } : cur))
      props.onChanged?.()
    } else setAssignNote({ ok: false, text: out.reason ?? "could not assign" })
  }
  async function removeAssignee(a: Assignee) {
    setAssignNote(null)
    const out = await post(`/iris/item/${props.itemId}/assignees/${a.id}`, undefined, { method: "DELETE" })
    if (out.ok && Array.isArray(out.assignees)) {
      setAssignees((cur) => (cur ? { ...cur, assignees: out.assignees } : cur))
      if (out.accessRemoved) setAssignNote({ ok: true, text: `${a.name ?? "They"} no longer have access to this board — that was their last card.` })
      props.onChanged?.()
    } else setAssignNote({ ok: false, text: out.reason ?? "could not unassign" })
  }

  // Elon's sidebar: Details first, then Tasks and Chat. Chat holds the people's thread (Team,
  // with the activity folded in) and the agent's (AI).
  const [side, setSide] = createSignal<SideTab>("details")
  const [chatSub, setChatSub] = createSignal<"team" | "ai">("team")
  createEffect(() => {
    // Details lists agents too: they are assignable (#189796).
    // The members row under the title lists agents too, on every tab (#190269).
    void side()
    setWantAgents(true)
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

  // ── The facts under the title (#190269) ─────────────────────────────────
  /** Everyone who could be on this card, with the ones who are on it marked. */
  const memberChoices = createMemo((): MemberChoice[] => {
    const on: MemberChoice[] = (assignees.latest?.assignees ?? []).map((a) => ({
      key: a.type === "user" ? `u${a.userId}` : `a${a.agentId}`,
      label: a.name ?? (a.type === "agent" ? "Agent" : "Member"),
      kind: a.type,
      assignedId: a.id,
    }))
    const off: MemberChoice[] = assignable().map((x) => ({
      key: x.key,
      label: x.label.replace(/ \(agent\)$/, ""),
      kind: x.key.startsWith("a") ? "agent" : "user",
      hint: x.key.startsWith("a") ? "agent" : undefined,
    }))
    return [...on, ...off]
  })
  async function addMember(key: string) {
    await addAssignee(key)
  }
  async function removeMember(id: number) {
    const a = (assignees.latest?.assignees ?? []).find((x) => x.id === id)
    if (a) await removeAssignee(a)
  }
  async function inviteMember(email: string) {
    setAssignEmail(email)
    await addByEmail()
  }

  /** A fact changes the moment it is picked — no Save button between a choice and the card. */
  const [quick, setQuick] = createSignal<{ field?: QuickField; anchor: { left: number; top: number; bottom: number }; within: Element } | null>(null)
  function openQuick(field: QuickField, el: HTMLElement) {
    const r = el.getBoundingClientRect()
    setQuick({ field, anchor: { left: r.left, top: r.top, bottom: r.bottom }, within: el })
  }
  function saveFact(p: QuickPatch) {
    if (p.labels) return void writeLabels(p.labels)
    if (p.status !== undefined) set("status", p.status)
    if (p.priority !== undefined) set("priority", p.priority ?? "")
    if (p.dueDate !== undefined) set("dueDate", p.dueDate ?? "")
    void saveDetails()
  }
  const now = () => Date.now()

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

  // ── Record a meeting into this card (#190041) ───────────────────────────
  // The same engine as the chat composer — iris-mic capture, hour-long takes, held recordings —
  // scoped to THIS card's board, so the platform applies the card's board policy, not the
  // person's default board's (ADR-01). Raw transcript, no live words, audio not kept: as Elon.
  const [recNote, setRecNote] = createSignal<{ ok: boolean; text: string } | null>(null)
  const recorder = props.recorderUrl
    ? createDictation({
        url: () => props.recorderUrl!,
        bloqId: () => String(props.bloqId),
        // No background retries: a retried meeting must not land in whatever card is open later.
        // Retry is offered on this card, by hand.
        autoRetry: false,
        onError: (message) => setRecNote({ ok: false, text: message }),
        onTranscript: (text) => void landTranscript(text),
      })
    : undefined

  /**
   * Put a finished take into the body and save it. A body being edited gets the line in its
   * draft and is saved WITH the edit (as Elon autosaves the card); otherwise the card is re-read
   * first, so an hour-long meeting does not save over a body changed elsewhere in that hour.
   */
  async function landTranscript(text: string) {
    setRecNote(null)
    if (!editingBody()) await refetchDoc()
    const d = doc.latest
    if (!d?.measured) {
      // Nowhere to save it: keep the words on screen rather than lose them.
      setEditingBody(true)
      setBodyDraft(appendTranscript("", text))
      setRecNote({ ok: false, text: "Could not load the card to save the transcript — it is in the body, unsaved." })
      return
    }
    setBodyDraft(appendTranscript(bodyDraft() ?? d.content ?? "", text))
    await saveBody()
    if (bodyDirty()) {
      // The save failed: the transcript stays in an open, unsaved body, with the reason beside it.
      setEditingBody(true)
      setRecNote({ ok: false, text: "The transcript is in the body but did not save — press Save body." })
      return
    }
    setRecNote({ ok: true, text: "Transcript added to the card" })
  }

  const recClock = () => {
    const s = recorder?.seconds() ?? 0
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
  }

  // ── Window shape: full screen and a sidebar you can put away (#186549) ───
  // Remembered across opens: this is a preference about how you read cards, not a fact about
  // one card, so a reader who maximises once should not have to do it every time.
  const VIEW_PREF = "iris.card.view"
  const readViewPref = (): { full: boolean; collapsed: boolean } => {
    try {
      const raw = localStorage.getItem(VIEW_PREF)
      if (!raw) return { full: false, collapsed: false }
      const j = JSON.parse(raw) as { full?: boolean; collapsed?: boolean }
      return { full: !!j.full, collapsed: !!j.collapsed }
    } catch {
      return { full: false, collapsed: false }
    }
  }
  const viewPref = readViewPref()
  const [full, setFull] = createSignal(viewPref.full)
  const [collapsed, setCollapsed] = createSignal(viewPref.collapsed)
  const rememberView = (next: { full: boolean; collapsed: boolean }) => {
    try {
      localStorage.setItem(VIEW_PREF, JSON.stringify(next))
    } catch {
      /* a preference that cannot be stored is not worth failing a render over */
    }
  }
  const toggleFull = () => {
    setFull((v) => !v)
    rememberView({ full: full(), collapsed: collapsed() })
  }
  const toggleSide = () => {
    setCollapsed((v) => !v)
    rememberView({ full: full(), collapsed: collapsed() })
  }

  /**
   * One save for whatever is dirty — the Save in the footer and Cmd+S both land here
   * (#186547). It saves each dirty SECTION rather than sending one global patch, because a
   * details save must never blank a body: the field-scoped contract is the reason a body edit
   * cannot clear a priority, and a single "save everything" button would quietly undo it.
   */
  async function saveAll() {
    if (bodyDirty()) await saveBody()
    if (dirty()) await saveDetails()
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return
      if (!dirty() && !bodyDirty()) return
      e.preventDefault()
      void saveAll()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  // ── Labels (HANDOFF: POST /iris/item/:id/labels {labels}) ───────────────
  const [labelText, setLabelText] = createSignal("")
  const [labelNote, setLabelNote] = createSignal<{ ok: boolean; text: string } | null>(null)
  const [labelBusy, setLabelBusy] = createSignal(false)
  async function writeLabels(next: string[]) {
    const d = doc.latest
    if (!d || labelBusy()) return
    setLabelBusy(true)
    setLabelNote(null)
    const out = await post(`/iris/item/${d.id}/labels`, { labels: next })
    if (out.ok) {
      mutateDoc((cur) => (cur ? { ...cur, labels: next } : cur))
      setLabelText("")
      setLabelNote({ ok: true, text: "Labels saved" })
      props.onChanged?.()
    } else setLabelNote({ ok: false, text: out.reason ?? "could not save labels" })
    setLabelBusy(false)
  }

  // ── Attachments (HANDOFF: GET/POST /iris/item/:id/attachments) ──────────
  const [files, { mutate: mutateFiles, refetch: refetchFiles }] = createResource(
    () => props.itemId,
    (id) => wire<{ files: CardFile[] }>(`/iris/item/${id}/attachments`, { files: [] }),
  )
  const [fileNote, setFileNote] = createSignal<{ ok: boolean; text: string } | null>(null)
  const [uploading, setUploading] = createSignal(false)
  async function upload(list: FileList | File[] | null) {
    const d = doc.latest
    if (!d || !list || list.length === 0 || uploading()) return
    setUploading(true)
    setFileNote(null)
    let okCount = 0
    let lastReason: string | undefined
    for (const f of Array.from(list)) {
      // Base64 in JSON: the sidecar route is plain JSON and forwards multipart to fl-api itself.
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result ?? ""))
        r.onerror = () => reject(r.error ?? new Error("could not read file"))
        r.readAsDataURL(f)
      }).catch((e) => {
        lastReason = e instanceof Error ? e.message : String(e)
        return ""
      })
      if (!data) continue
      const out = await post(`/iris/item/${d.id}/attachments`, { name: f.name, type: f.type || undefined, data, bloq: props.bloqId })
      if (out.ok) okCount++
      else lastReason = out.reason
    }
    if (okCount) await refetchFiles()
    setFileNote(okCount ? { ok: true, text: `Uploaded ${okCount} of ${list.length}` } : { ok: false, text: lastReason ?? "upload failed" })
    setUploading(false)
    props.onChanged?.()
  }
  async function removeFile(f: CardFile) {
    const d = doc.latest
    if (!d) return
    const out = await post(`/iris/item/${d.id}/attachments/${encodeURIComponent(f.id)}/delete`)
    if (out.ok) {
      mutateFiles((cur) => (cur ? { ...cur, files: cur.files.filter((x) => x.id !== f.id) } : cur))
      props.onChanged?.()
    } else setFileNote({ ok: false, text: out.reason ?? "could not delete" })
  }
  const missingFiles = createMemo(() => (files.latest?.files ?? []).filter((f) => !f.stored).length)

  // ── Activity (#189799): what happened to this card, and who did it ──────
  const [trail, { refetch: refetchTrail }] = createResource(
    () => (side() === "chat" && chatSub() === "team" ? props.itemId : undefined),
    (id) =>
      wire<{ activity: TrailRow[] }>(
        `/iris/item/${id}/activity`,
        { activity: [] },
      ),
  )

  // Who is signed in — only so your own comments sit on the right, as in Elon's team chat.
  const [me] = createResource(
    () => (side() === "chat" ? props.itemId : undefined),
    async () => {
      try {
        return (await (await props.doFetch(`/iris/me`)).json()) as { id: number | null; name: string | null; email: string | null }
      } catch {
        return { id: null, name: null, email: null }
      }
    },
  )
  const thread = createMemo(() => groupTrail(trail.latest?.activity ?? [], me.latest ?? {}))
  let threadScroll: HTMLDivElement | undefined
  createEffect(() => {
    thread().length
    if (threadScroll) queueMicrotask(() => threadScroll && (threadScroll.scrollTop = threadScroll.scrollHeight))
  })

  // A comment, and the board people it @mentions (#189799). Picking someone from the list writes
  // "@their-email" — the one handle fl-api matches without ambiguity — and remembers their id.
  const [comment, setComment] = createSignal("")
  const [picked, setPicked] = createSignal<{ userId: number; handle: string }[]>([])
  const [commentNote, setCommentNote] = createSignal<{ ok: boolean; text: string } | null>(null)
  const [posting, setPosting] = createSignal(false)
  const mentionQuery = createMemo(() => /(?:^|\s)@([\w.+-]*)$/.exec(comment())?.[1])
  const mentionable = createMemo(() => {
    const q = mentionQuery()
    if (q === undefined) return []
    const lower = q.toLowerCase()
    return (members.latest?.members ?? [])
      .filter((m) => !lower || (m.name ?? "").toLowerCase().includes(lower) || (m.email ?? "").toLowerCase().includes(lower))
      .slice(0, 6)
  })
  function pickMention(m: { userId: number; name: string; email: string }) {
    const handle = m.email || m.name
    setComment((t) => t.replace(/@([\w.+-]*)$/, `@${handle} `))
    setPicked((p) => (p.some((x) => x.userId === m.userId) ? p : [...p, { userId: m.userId, handle }]))
  }
  async function postComment() {
    const d = doc.latest
    const body = comment().trim()
    if (!d || !body || posting()) return
    setPosting(true)
    setCommentNote(null)
    const mentions = picked().filter((p) => body.includes(`@${p.handle}`)).map((p) => p.userId)
    const out = await post(`/iris/item/${d.id}/comments`, { body, mentions })
    setPosting(false)
    if (!out.ok) return setCommentNote({ ok: false, text: out.reason ?? "could not post" })
    setComment("")
    setPicked([])
    const told = (out.mentioned as number[] | undefined)?.length ?? 0
    setCommentNote({ ok: true, text: told ? `Posted — told ${told} ${told === 1 ? "person" : "people"}` : "Posted" })
    void refetchTrail()
  }

  // Paste a screenshot or file anywhere in an open card and it is attached (#189797).
  onMount(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = pastedFiles(e)
      if (!files.length) return
      e.preventDefault()
      void upload(files)
    }
    document.addEventListener("paste", onPaste)
    onCleanup(() => document.removeEventListener("paste", onPaste))
  })

  // ── Events + asks (HANDOFF) ─────────────────────────────────────────────
  const [events, { refetch: refetchEvents }] = createResource(
    () => props.itemId,
    (id) => wire<{ events: CardEvent[] }>(`/iris/item/${id}/events`, { events: [] }),
  )
  const [evTitle, setEvTitle] = createSignal("")
  const [evAt, setEvAt] = createSignal("")
  const [evNote, setEvNote] = createSignal<{ ok: boolean; text: string } | null>(null)
  async function addEvent() {
    const d = doc.latest
    if (!d || !evTitle().trim() || !evAt()) return
    const out = await post(`/iris/item/${d.id}/events`, { title: evTitle().trim(), startsAt: new Date(evAt()).toISOString() })
    if (out.ok) {
      setEvTitle("")
      setEvAt("")
      await refetchEvents()
      setEvNote({ ok: true, text: "Event added" })
    } else setEvNote({ ok: false, text: out.reason ?? "could not add" })
  }

  const [asks, { refetch: refetchAsks, mutate: mutateAsks }] = createResource(
    () => props.itemId,
    (id) => wire<{ asks: CardAsk[] }>(`/iris/item/${id}/asks`, { asks: [] }),
  )
  const [askTo, setAskTo] = createSignal("")
  const [askWhat, setAskWhat] = createSignal("")
  const [askDue, setAskDue] = createSignal("")
  const [askNote, setAskNote] = createSignal<{ ok: boolean; text: string } | null>(null)
  async function addAsk() {
    const d = doc.latest
    if (!d || !askTo().trim() || !askWhat().trim()) return
    const out = await post(`/iris/item/${d.id}/asks`, { to: askTo().trim(), what: askWhat().trim(), dueAt: askDue() || undefined })
    if (out.ok) {
      setAskTo("")
      setAskWhat("")
      setAskDue("")
      await refetchAsks()
      setAskNote({ ok: true, text: "Ask recorded" })
    } else setAskNote({ ok: false, text: out.reason ?? "could not record" })
  }
  async function answerAsk(a: CardAsk) {
    const d = doc.latest
    if (!d) return
    const out = await post(`/iris/item/${d.id}/asks/${a.id}/answer`, { answer: "" })
    if (out.ok) mutateAsks((cur) => (cur ? { ...cur, asks: cur.asks.map((x) => (x.id === a.id ? { ...x, status: "answered" } : x)) } : cur))
    else setAskNote({ ok: false, text: out.reason ?? "could not update" })
  }

  // ── Sharing (HANDOFF: /iris/item/:id/share/*) ───────────────────────────
  const [share, { mutate: mutateShare, refetch: refetchShare }] = createResource(
    () => (side() === "sharing" ? props.itemId : undefined),
    (id) =>
      wire<Omit<ShareState, "measured" | "reason">>(`/iris/item/${id}/share?bloq=${props.bloqId}`, {
        isPublic: doc.latest?.isPublic ?? false,
        publicUrl: doc.latest?.publicUrl,
        allowKnown: false,
        allowedEmails: [],
        boardDefaults: { allowedEmails: [] },
        members: [],
        links: [],
      }),
  )
  const [shareNote, setShareNote] = createSignal<{ ok: boolean; text: string } | null>(null)
  const [shareBusy, setShareBusy] = createSignal(false)
  const [allowText, setAllowText] = createSignal("")
  const [inviteEmail, setInviteEmail] = createSignal("")
  const [invitePerm, setInvitePerm] = createSignal("viewer")
  const [linkDays, setLinkDays] = createSignal("")
  const [armedRevoke, setArmedRevoke] = createSignal<string | null>(null)

  async function shareCall(path: string, body: unknown, onOk: () => void, okText: string) {
    const d = doc.latest
    if (!d || shareBusy()) return
    setShareBusy(true)
    setShareNote(null)
    const out = await post(`/iris/item/${d.id}/share/${path}`, body)
    if (out.ok) {
      onOk()
      setShareNote({ ok: true, text: okText })
      props.onChanged?.()
    } else setShareNote({ ok: false, text: out.reason ?? "failed" })
    setShareBusy(false)
  }
  const setVisibility = (pub: boolean) =>
    shareCall(
      "visibility",
      { public: pub },
      () => {
        mutateShare((s) => (s ? { ...s, isPublic: pub } : s))
        mutateDoc((c) => (c ? { ...c, isPublic: pub } : c))
        void refetchShare()
      },
      pub ? "Public — anyone allowed below can open the link" : "Private",
    )
  const writeAllow = (next: string[]) =>
    shareCall("allowlist", { emails: next }, () => {
      mutateShare((s) => (s ? { ...s, allowedEmails: next } : s))
      setAllowText("")
    }, next.length ? `Allow-list saved (${next.length})` : "Allow-list EMPTIED — anyone with the link can open it")
  const invite = () =>
    shareCall("invite", { email: inviteEmail().trim().toLowerCase(), permission: invitePerm(), bloq: props.bloqId }, () => {
      setInviteEmail("")
      void refetchShare()
    }, "Invited")
  const setPermission = (m: ShareMember, permission: string) =>
    shareCall("permission", { userId: m.userId, permission, bloq: props.bloqId }, () => {
      mutateShare((s) => (s ? { ...s, members: s.members.map((x) => (x.userId === m.userId ? { ...x, permission } : x)) } : s))
    }, `${m.name || m.email}: ${permission}`)
  const revokeMember = (m: ShareMember) => {
    const key = `m${m.userId}`
    if (armedRevoke() !== key) {
      setArmedRevoke(key)
      setTimeout(() => setArmedRevoke((a) => (a === key ? null : a)), 2500)
      return
    }
    setArmedRevoke(null)
    void shareCall("revoke", { userId: m.userId, bloq: props.bloqId }, () => {
      mutateShare((s) => (s ? { ...s, members: s.members.filter((x) => x.userId !== m.userId) } : s))
    }, `Removed ${m.name || m.email}`)
  }
  const createLink = () =>
    shareCall("link", { bloq: props.bloqId, expiresInDays: linkDays() ? Number(linkDays()) : undefined }, () => {
      setLinkDays("")
      void refetchShare()
    }, "Share link created — copy it now, it is a bearer link")
  const revokeLink = (l: ShareLink) => {
    const key = `l${l.id}`
    if (armedRevoke() !== key) {
      setArmedRevoke(key)
      setTimeout(() => setArmedRevoke((a) => (a === key ? null : a)), 2500)
      return
    }
    setArmedRevoke(null)
    void shareCall(`link/${l.id}/revoke`, { bloq: props.bloqId }, () => {
      mutateShare((s) => (s ? { ...s, links: s.links.map((x) => (x.id === l.id ? { ...x, revoked: true } : x)) } : s))
    }, "Link revoked")
  }

  // ── Chat (HANDOFF: GET/POST /iris/item/:id/chat) ────────────────────────
  const [chat, { mutate: mutateChat }] = createResource(
    () => (side() === "chat" && chatSub() === "ai" ? props.itemId : undefined),
    (id) => wire<{ agentId?: number; messages: ChatMessage[] }>(`/iris/item/${id}/chat?bloq=${props.bloqId}`, { messages: [] }),
  )
  const [chatAgent, setChatAgent] = createSignal("")
  const [chatText, setChatText] = createSignal("")
  const [thinking, setThinking] = createSignal(false)
  const [chatNote, setChatNote] = createSignal<string | null>(null)
  let chatScroll: HTMLDivElement | undefined
  createEffect(() => {
    chat.latest?.messages.length
    thinking()
    if (chatScroll) chatScroll.scrollTop = chatScroll.scrollHeight
  })
  async function sendChat() {
    const d = doc.latest
    const text = chatText().trim()
    const agentId = chatAgent() ? Number(chatAgent()) : (chat.latest?.agentId ?? undefined)
    if (!d || !text || thinking()) return
    if (agentId == null) {
      setChatNote("Pick an agent to talk to.")
      return
    }
    setChatNote(null)
    const mine: ChatMessage = { id: `local-${Date.now()}`, role: "user", text, at: new Date().toISOString() }
    mutateChat((c) => (c ? { ...c, messages: [...c.messages, mine] } : c))
    setChatText("")
    setThinking(true)
    const out = await post(`/iris/item/${d.id}/chat`, { agentId, text, bloq: props.bloqId })
    setThinking(false)
    if (out.ok && out.message) {
      mutateChat((c) => (c ? { ...c, messages: [...c.messages, out.message as ChatMessage] } : c))
    } else {
      setChatNote(out.reason ?? "no reply")
    }
  }

  // ── Tasks ───────────────────────────────────────────────────────────────
  const [newTask, setNewTask] = createSignal("")
  /** Adding UNDER this item makes a subtask (#189794); fl-api rolls completion up the chain. */
  const [addParent, setAddParent] = createSignal<CardTask | null>(null)
  const [newDue, setNewDue] = createSignal("")
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
    const parentId = addParent()?.id
    const out = await post(`/iris/item/${d.id}/tasks`, { title, agentId, parentId, dueDate: newDue() || undefined })
    if (out.ok) {
      setNewTask("")
      setNewAgent("")
      setNewDue("")
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

  // ── Small pieces ────────────────────────────────────────────────────────
  const NoteLine = (p: { note: { ok: boolean; text: string } | null }) => (
    <Show when={p.note}>
      {(n) => (
        <p class="text-11-regular py-1" classList={{ "text-text-base": n().ok, "text-text-weak": !n().ok }}>
          {n().text}
        </p>
      )}
    </Show>
  )
  /** A section that is not measured says so IN PLACE, controls still visible beneath. */
  const NotConnected = (p: { state: { measured: boolean; reason?: string } | undefined; loading?: boolean }) => (
    <Show when={p.state && !p.state.measured}>
      <p class="iris-card__unwired">{p.state!.reason ?? "unavailable"}</p>
    </Show>
  )
  const SectionHead = (p: { children: JSX.Element; count?: number | string; right?: JSX.Element }) => (
    <h4 class="iris-card__section">
      <span>{p.children}</span>
      <Show when={p.count !== undefined}>
        <span class="iris-card__count">{p.count}</span>
      </Show>
      <Show when={p.right}>
        <span class="ms-auto">{p.right}</span>
      </Show>
    </h4>
  )
  const Chip = (p: { text: string; onRemove?: () => void; title?: string }) => (
    <span class="iris-card__chip" title={p.title}>
      {p.text}
      <Show when={p.onRemove}>
        <button type="button" class="iris-card__chipx" aria-label={`Remove ${p.text}`} onClick={p.onRemove}>
          ×
        </button>
      </Show>
    </span>
  )
  const copy = (e: MouseEvent & { currentTarget: HTMLButtonElement }, text: string) => {
    navigator.clipboard?.writeText(text)
    const el = e.currentTarget
    const was = el.textContent
    el.textContent = "copied"
    setTimeout(() => (el.textContent = was), 900)
  }

  // Elon's card (CardEditor.vue): the title sits in the header row with who is on the card and a
  // cluster of icon buttons; the body fills the left; Details | Tasks | Chat on the right.
  const [editingTitle, setEditingTitle] = createSignal(false)
  const [evOpen, setEvOpen] = createSignal(false)
  const [askOpen, setAskOpen] = createSignal(false)
  const [moreOpen, setMoreOpen] = createSignal(false)
  const saveState = () =>
    saving() || savingBody() ? "saving" : dirty() || bodyDirty() ? "unsaved" : note()?.ok === false || bodyNote()?.ok === false ? "error" : "saved"
  const priorityTone = (p: string | undefined) =>
    /^(urgent|critical|p0)$/i.test(p ?? "") ? "#ef4444" : /^(high|p1)$/i.test(p ?? "") ? "#f59e0b" : /^(low|p3)$/i.test(p ?? "") ? "#94a3b8" : undefined
  const typeColor = (id: string | undefined) => (schema.latest?.type ?? []).find((o) => o.id === id)?.color
  const labelTint = (l: string) => {
    const known = [...(schema.latest?.type ?? []), ...(schema.latest?.priority ?? [])].find((o) => o.label === l)?.color
    return known ?? avatarColor(l)
  }
  const Dd = (p: {
    icon: Parameters<typeof Icon>[0]["name"]
    label: string
    value: string
    placeholder: string
    color?: string
    onClick: (e: MouseEvent & { currentTarget: HTMLButtonElement }) => void
  }) => (
    <button type="button" class="iris-dd" data-empty={p.value ? undefined : ""} title={p.label} onClick={p.onClick}>
      <Icon name={p.icon} size="small" />
      <span class="iris-dd__label">{p.label}</span>
      <span class="iris-dd__value" style={p.color ? { color: p.color } : undefined}>
        {p.value || p.placeholder}
      </span>
      <Icon name="chevron-down" size="small" />
    </button>
  )
  const SideHead = (p: { icon: Parameters<typeof Icon>[0]["name"]; children: JSX.Element; count?: number | string; tint?: string; right?: JSX.Element }) => (
    <h4 class="iris-sh">
      <Icon name={p.icon} size="small" />
      <span>{p.children}</span>
      <Show when={p.count !== undefined && p.count !== "—"}>
        <span class="iris-sh__count" style={p.tint ? { "--tint": p.tint } : undefined}>
          {p.count}
        </span>
      </Show>
      <Show when={p.right}>
        <span class="iris-sh__right">{p.right}</span>
      </Show>
    </h4>
  )

  return (
    <Dialog
      size="x-large"
      class="iris-card iris-card--elon"
      classList={{ "iris-card--full": full() }}
      action={
        <span class="iris-card__winbtns">
          <span class="iris-card__saved" data-state={saveState()} title={{ saving: "Saving…", unsaved: "Unsaved changes", error: "Last save failed", saved: "All changes saved" }[saveState()]}>
            <Icon name={saveState() === "error" ? "warning" : saveState() === "unsaved" ? "dot-grid" : "circle-check"} size="small" />
          </span>
          <Show when={recorder}>
            {(rec) => (
              <button
                type="button"
                class="iris-card__rec iris-ib"
                data-phase={rec().phase()}
                disabled={rec().phase() === "transcribing"}
                aria-label={rec().phase() === "recording" ? "Stop recording" : "Record a meeting into this card"}
                title={
                  rec().phase() === "recording"
                    ? "Stop — the transcript is added to the end of the body"
                    : rec().phase() === "transcribing"
                      ? "Transcribing…"
                      : "Record a meeting into this card (up to 1 hour)"
                }
                onClick={() => {
                  if (rec().phase() === "recording") rec().toggle()
                  else if (rec().phase() === "idle") {
                    setRecNote(null)
                    void rec().startBackground()
                  }
                }}
              >
                <Icon name={rec().phase() === "recording" ? "stop" : "microphone"} size="small" />
                <Show when={rec().phase() === "recording"}>
                  <span class="font-mono text-11-regular tabular-nums">{recClock()}</span>
                </Show>
                <Show when={rec().phase() === "transcribing"}>
                  <span class="text-11-regular">Transcribing…</span>
                </Show>
              </button>
            )}
          </Show>
          <button
            type="button"
            class="iris-ib"
            aria-pressed={side() === "sharing"}
            aria-label="Share"
            title="Who can open this card, and its links"
            onClick={() => {
              if (collapsed()) toggleSide()
              setSide(side() === "sharing" ? "details" : "sharing")
            }}
          >
            <Icon name="share" size="small" />
          </button>
          <button type="button" class="iris-ib" aria-label={full() ? "Exit full screen" : "Full screen"} title={full() ? "Exit full screen" : "Full screen"} onClick={toggleFull}>
            <Icon name={full() ? "collapse" : "expand"} size="small" />
          </button>
          <button
            type="button"
            class="iris-ib"
            aria-label={collapsed() ? "Show the sidebar" : "Hide the sidebar"}
            title={collapsed() ? "Show the sidebar" : "Hide the sidebar"}
            onClick={toggleSide}
          >
            <Icon name={collapsed() ? "layout-right" : "layout-right-full"} size="small" />
          </button>
          <button type="button" class="iris-ib iris-ib--close" aria-label="Close" title="Close" onClick={() => dialog.close()}>
            <Icon name="close" size="small" />
          </button>
        </span>
      }
      title={
        <span class="iris-card__hdr">
          <Show
            when={editingTitle()}
            fallback={
              <span
                class="iris-card__htitle"
                tabindex="0"
                title="Double-click to rename"
                onDblClick={() => setEditingTitle(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    setEditingTitle(true)
                  }
                }}
              >
                {form()?.title || doc.latest?.title || "Card"}
              </span>
            }
          >
            <input
              ref={(el) => queueMicrotask(() => el.select())}
              class="iris-card__title"
              aria-label="Title"
              data-dismiss-first
              value={form()?.title ?? ""}
              onInput={(e) => set("title", e.currentTarget.value)}
              onBlur={() => {
                setEditingTitle(false)
                if (dirty()) void saveDetails()
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  e.currentTarget.blur()
                } else if (e.key === "Escape") {
                  e.preventDefault()
                  set("title", doc.latest?.title ?? "")
                  setEditingTitle(false)
                }
              }}
            />
          </Show>
          <Show when={doc.latest?.isPublic}>
            <span class="iris-card__pub" title="This card is public — see Sharing">public</span>
          </Show>
          <Show when={doc.latest?.measured}>
            <MembersRow
              compact
              choices={memberChoices()}
              loading={assignees.loading || members.loading}
              unavailable={assignees.latest && !assignees.latest.measured ? assignees.latest.reason : undefined}
              note={assignNote() ?? (note()?.ok === false ? note() : null) ?? labelNote()}
              onAdd={addMember}
              onRemove={removeMember}
              onEmail={inviteMember}
            />
          </Show>
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
            <Show when={quick()}>
              {(q) => (
                <IrisQuickEdit
                  card={{
                    id: props.itemId,
                    title: form()?.title ?? doc.latest!.title,
                    status: form()?.status || undefined,
                    priority: form()?.priority || undefined,
                    dueDate: form()?.dueDate || undefined,
                    labels: doc.latest!.labels,
                  }}
                  anchor={q().anchor}
                  within={q().within}
                  field={q().field}
                  only
                  status={schema.latest?.status}
                  priority={schema.latest?.priority}
                  boardLabels={[...(schema.latest?.type ?? []), ...(schema.latest?.priority ?? [])].map((o) => o.label)}
                  now={now()}
                  note={note()?.ok === false ? note()!.text : labelNote()?.ok === false ? labelNote()!.text : null}
                  onSave={saveFact}
                  onClose={() => setQuick(null)}
                />
              )}
            </Show>

            <div class="iris-card__cols" data-side-collapsed={collapsed() ? "" : undefined}>
              {/* LEFT — the body, and nothing else: Elon's document pane. */}
              <section class="iris-card__body">
                <Show when={recNote() || (recorder?.held().length ?? 0) > 0}>
                  <div class="iris-card__recbar" role="status">
                    <Show when={recNote()}>
                      {(n) => (
                        <span class="text-11-regular" classList={{ "text-text-base": n().ok, "text-text-weak": !n().ok }}>
                          {n().text}
                        </span>
                      )}
                    </Show>
                    <Show when={(recorder?.held().length ?? 0) > 0}>
                      <span class="text-11-regular text-text-weak">
                        {recorder!.held().length === 1
                          ? "A recording for this board is saved, not yet transcribed."
                          : `${recorder!.held().length} recordings for this board are saved, not yet transcribed.`}
                      </span>
                      <button
                        type="button"
                        class="iris-card__linkbtn"
                        disabled={recorder!.retrying() || recorder!.phase() !== "idle"}
                        onClick={() => void recorder!.retryHeld()}
                      >
                        {recorder!.retrying() ? "Retrying…" : "Retry"}
                      </button>
                      <button type="button" class="iris-card__linkbtn" onClick={() => void recorder!.discardHeld()}>
                        Discard
                      </button>
                    </Show>
                  </div>
                </Show>
                <Show when={bodyNote()}>
                  {(n) => (
                    <p class="iris-card__bodynote text-11-regular" classList={{ "text-text-base": n().ok, "text-text-weak": !n().ok }}>
                      {n().text}
                    </p>
                  )}
                </Show>
                <Show
                  when={editingBody()}
                  fallback={
                    <div class="iris-card__doc">
                      <button
                        type="button"
                        class="iris-card__fab"
                        aria-label="Edit description"
                        title="Edit (E, triple-click or ⌘-click)"
                        onClick={() => setEditingBody(true)}
                      >
                        <Icon name="pencil-line" size="small" />
                      </button>
                      <Show
                        when={doc.latest!.content}
                        fallback={
                          <button type="button" class="iris-card__empty" onClick={() => setEditingBody(true)}>
                            Start writing your thoughts…
                          </button>
                        }
                      >
                        {/* Triple-click, ⌘/Ctrl-click or E to edit (#190282). Triple, not double: a
                            double-click still selects a word to copy. A link inside still opens. */}
                        <div
                          class="iris-markdown iris-card__read"
                          tabindex="0"
                          title="Triple-click, ⌘-click or press E to edit"
                          innerHTML={renderMarkdown(doc.latest!.content)}
                          onClick={(e) => {
                            if ((e.target as HTMLElement).closest("a")) return
                            if (e.detail >= 3 || e.metaKey || e.ctrlKey) {
                              window.getSelection()?.removeAllRanges()
                              setEditingBody(true)
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "e" && !e.metaKey && !e.ctrlKey && !e.altKey) {
                              e.preventDefault()
                              setEditingBody(true)
                            }
                          }}
                        />
                      </Show>
                    </div>
                  }
                >
                  <div class="iris-card__editwrap">
                    <textarea
                      ref={(el) => queueMicrotask(() => el.focus())}
                      class="iris-card__textarea"
                      spellcheck={false}
                      data-dismiss-first
                      placeholder="Start writing your thoughts…"
                      value={bodyDraft() ?? doc.latest!.content}
                      onInput={(e) => setBodyDraft(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault()
                          void saveBody()
                        } else if (e.key === "Escape") {
                          // Cancel the edit; the card stays open (the dialog skips Escape while this exists).
                          e.preventDefault()
                          setBodyDraft(null)
                          setEditingBody(false)
                          setBodyNote(null)
                        }
                      }}
                      onBlur={(e) => {
                        // Clicking away keeps what you typed — unless it was onto Cancel.
                        const to = e.relatedTarget as HTMLElement | null
                        if (to?.dataset.bodyCancel !== undefined) return
                        if (bodyDirty()) void saveBody()
                        else setEditingBody(false)
                      }}
                    />
                    <div class="iris-card__editbar">
                      <span class="text-11-regular text-text-weaker">⌘↵ to save · Esc to cancel</span>
                      <button
                        type="button"
                        class="iris-card__linkbtn"
                        data-body-cancel
                        onClick={() => {
                          setBodyDraft(null)
                          setEditingBody(false)
                          setBodyNote(null)
                        }}
                      >
                        Cancel
                      </button>
                      <button type="button" class="iris-card__save" disabled={!bodyDirty() || savingBody()} onClick={() => void saveBody()}>
                        {savingBody() ? "Saving…" : bodyDirty() ? "Save" : "No changes"}
                      </button>
                    </div>
                  </div>
                </Show>
              </section>

              {/* RIGHT — Elon's sidebar: underline tabs, then sections. */}
              <aside class="iris-card__side">
                <Show
                  when={side() !== "sharing"}
                  fallback={
                    <div class="iris-tabs iris-tabs--back">
                      <button type="button" class="iris-card__linkbtn" onClick={() => setSide("details")}>
                        ← Back
                      </button>
                      <span class="iris-tabs__title">Sharing</span>
                    </div>
                  }
                >
                  <div class="iris-tabs" role="tablist" aria-label="Card">
                    <button type="button" role="tab" class="iris-tabs__tab" aria-selected={side() === "details"} onClick={() => setSide("details")}>
                      Details
                    </button>
                    <button type="button" role="tab" class="iris-tabs__tab" aria-selected={side() === "tasks"} onClick={() => setSide("tasks")}>
                      Tasks
                      <Show when={doc.latest!.tasksMeasured && doc.latest!.tasks.length > 0}>
                        <span class="iris-tabs__count">
                          {doc.latest!.tasks.filter((t) => t.done).length}/{doc.latest!.tasks.length}
                        </span>
                      </Show>
                    </button>
                    <button type="button" role="tab" class="iris-tabs__tab" aria-selected={side() === "chat"} onClick={() => setSide("chat")}>
                      Chat
                    </button>
                  </div>
                </Show>
                <div class="iris-card__sidebody">
                  <Switch>
                    {/* ───────────── DETAILS ───────────── */}
                    <Match when={side() === "details"}>
                      <div class="iris-sec">
                        <SideHead icon="subagent" count={assignees.latest?.measured ? memberChoices().filter((c) => c.assignedId != null).length : undefined} tint="#3b82f6">
                          Assigned
                        </SideHead>
                        <MembersRow
                          list
                          choices={memberChoices()}
                          loading={assignees.loading || members.loading}
                          unavailable={assignees.latest && !assignees.latest.measured ? assignees.latest.reason : undefined}
                          note={assignNote()}
                          onAdd={addMember}
                          onRemove={removeMember}
                          onEmail={inviteMember}
                        />
                      </div>

                      <div class="iris-sec">
                        <div class="iris-dds">
                          <Dd
                            icon="status"
                            label="Status"
                            value={(form()?.status ?? "").replace(/_/g, " ")}
                            placeholder="Set"
                            color={form()?.status ? statusDot(form()?.status) : undefined}
                            onClick={(e) => openQuick("status", e.currentTarget)}
                          />
                          <Dd
                            icon="pin"
                            label="Priority"
                            value={form()?.priority || ""}
                            placeholder="None"
                            color={priorityTone(form()?.priority)}
                            onClick={(e) => openQuick("priority", e.currentTarget)}
                          />
                          <label class="iris-dd" data-empty={form()?.cardType ? undefined : ""} title="Type">
                            <Icon name="box" size="small" />
                            <span class="iris-dd__label">Type</span>
                            <select
                              class="iris-dd__select"
                              style={typeColor(form()?.cardType) ? { color: typeColor(form()?.cardType) } : undefined}
                              value={form()?.cardType ?? ""}
                              onChange={(e) => {
                                set("cardType", e.currentTarget.value)
                                void saveDetails()
                              }}
                            >
                              <option value="">None</option>
                              <For each={schema.latest?.type ?? []}>{(o) => <option value={o.id}>{o.label}</option>}</For>
                              <Show when={form()?.cardType && !(schema.latest?.type ?? []).some((o) => o.id === form()!.cardType)}>
                                <option value={form()!.cardType}>{form()!.cardType}</option>
                              </Show>
                            </select>
                            <Icon name="chevron-down" size="small" />
                          </label>
                          <Dd
                            icon="clock"
                            label="Due"
                            value={form()?.dueDate ? dueLabel(form()!.dueDate, now()) : ""}
                            placeholder="No date"
                            color={
                              form()?.dueDate
                                ? ({ overdue: "#ef4444", soon: "#f59e0b", later: undefined } as const)[dueState(form()!.dueDate, now()) ?? "later"]
                                : undefined
                            }
                            onClick={(e) => openQuick("due", e.currentTarget)}
                          />
                          <label class="iris-dd iris-dd--wide" title="List">
                            <Icon name="bullet-list" size="small" />
                            <span class="iris-dd__label">List</span>
                            <select
                              class="iris-dd__select"
                              value={form()?.listId ?? ""}
                              onChange={(e) => {
                                set("listId", e.currentTarget.value)
                                void saveDetails()
                              }}
                            >
                              <Show when={form()?.listId && !props.lists.some((l) => String(l.id) === form()!.listId)}>
                                <option value={form()!.listId}>{doc.latest!.listName ?? `list ${form()!.listId}`}</option>
                              </Show>
                              <For each={props.lists}>{(l) => <option value={String(l.id)}>{l.name}</option>}</For>
                            </select>
                            <Icon name="chevron-down" size="small" />
                          </label>
                        </div>
                        <NoteLine note={note()?.ok === false ? note() : null} />
                      </div>

                      <div class="iris-sec">
                        <SideHead
                          icon="pin"
                          count={doc.latest!.labels.length || undefined}
                          tint="#a855f7"
                          right={
                            <button
                              type="button"
                              class="iris-sh__add"
                              disabled={doc.latest!.contentKind === "markdown" || labelBusy()}
                              title={
                                doc.latest!.contentKind === "markdown"
                                  ? "Labels live in a card's structured body; this card's body is plain markdown"
                                  : "Add or remove labels"
                              }
                              onClick={(e) => openQuick("labels", e.currentTarget)}
                            >
                              + Add
                            </button>
                          }
                        >
                          Labels
                        </SideHead>
                        <div class="iris-pills">
                          <For each={doc.latest!.labels}>
                            {(l) => (
                              <span class="iris-pill" style={{ "--tint": labelTint(l) }}>
                                {l}
                                <Show when={doc.latest!.contentKind !== "markdown"}>
                                  <button
                                    type="button"
                                    class="iris-pill__x"
                                    aria-label={`Remove label ${l}`}
                                    disabled={labelBusy()}
                                    onClick={() => void writeLabels(doc.latest!.labels.filter((x) => x !== l))}
                                  >
                                    ×
                                  </button>
                                </Show>
                              </span>
                            )}
                          </For>
                          <Show when={doc.latest!.labels.length === 0}>
                            <span class="iris-sec__none">No labels</span>
                          </Show>
                        </div>
                        <NoteLine note={labelNote()?.ok === false ? labelNote() : null} />
                      </div>

                      <div
                        class="iris-sec"
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault()
                          void upload(e.dataTransfer?.files ?? null)
                        }}
                      >
                        <SideHead
                          icon="photo"
                          count={files.latest?.measured ? files.latest.files.length || undefined : undefined}
                          tint="#22c55e"
                          right={
                            <label class="iris-sh__add" style={{ cursor: uploading() ? "default" : "pointer" }}>
                              {uploading() ? "Uploading…" : "+ Add"}
                              <input type="file" multiple hidden disabled={uploading()} onChange={(e) => void upload(e.currentTarget.files)} />
                            </label>
                          }
                        >
                          Attachments
                        </SideHead>
                        <NotConnected state={files.latest} />
                        <Show when={missingFiles() > 0}>
                          <p class="iris-card__warn">
                            {missingFiles()} file{missingFiles() === 1 ? "" : "s"} referenced but not stored. Upload {missingFiles() === 1 ? "it" : "them"} again.
                          </p>
                        </Show>
                        <div class="iris-pills">
                          <For each={files.latest?.files ?? []}>
                            {(f) => (
                              <span class="iris-file" classList={{ "iris-file--missing": !f.stored }} title={`${f.name}${f.stored ? ` · ${fileSize(f.size)}` : " · missing"}`}>
                                <span class="iris-file__type">{(f.type ?? f.name.split(".").pop() ?? "file").slice(0, 4)}</span>
                                <Show when={f.url} fallback={<span class="iris-file__name">{f.name}</span>}>
                                  <a class="iris-file__name" href={f.url} target="_blank" rel="noreferrer">
                                    {f.name}
                                  </a>
                                </Show>
                                <button type="button" class="iris-pill__x" aria-label={`Remove ${f.name}`} onClick={() => void removeFile(f)}>
                                  ×
                                </button>
                              </span>
                            )}
                          </For>
                        </div>
                        <Show when={(files.latest?.files.length ?? 0) === 0}>
                          <p class="iris-drop">Drop files here, or paste a screenshot.</p>
                        </Show>
                        <NoteLine note={fileNote()} />
                      </div>

                      <div class="iris-sec">
                        <SideHead
                          icon="checklist"
                          count={doc.latest!.tasksMeasured && doc.latest!.tasks.length ? `${doc.latest!.tasks.filter((t) => t.done).length}/${doc.latest!.tasks.length}` : undefined}
                          tint="#3b82f6"
                          right={
                            <button type="button" class="iris-sh__add" onClick={() => setSide("tasks")}>
                              {doc.latest!.tasks.length ? "View all" : "+ Add"}
                            </button>
                          }
                        >
                          Tasks
                        </SideHead>
                        <Show when={doc.latest!.tasksMeasured} fallback={<p class="iris-sec__none">Could not read tasks — {doc.latest!.tasksReason ?? "unknown"}.</p>}>
                          <Show when={doc.latest!.tasks.length > 0} fallback={<p class="iris-sec__none">No tasks yet</p>}>
                            <ul class="iris-minitasks">
                              <For each={doc.latest!.tasks.slice(0, 3)}>
                                {(t) => (
                                  <li class="iris-minitask" classList={{ "iris-minitask--done": t.done }}>
                                    <input
                                      type="checkbox"
                                      class="iris-card__check"
                                      checked={t.done}
                                      disabled={busyTask() === t.id}
                                      aria-label={`${t.done ? "Reopen" : "Complete"}: ${t.title}`}
                                      onChange={() => void toggleTask(t)}
                                    />
                                    <span class="iris-minitask__text">{t.title}</span>
                                    <Show when={t.agentName}>
                                      <Avatar name={t.agentName!} kind="agent" size={18} />
                                    </Show>
                                  </li>
                                )}
                              </For>
                            </ul>
                            <Show when={doc.latest!.tasks.length > 3}>
                              <button type="button" class="iris-sec__more" onClick={() => setSide("tasks")}>
                                +{doc.latest!.tasks.length - 3} more
                              </button>
                            </Show>
                          </Show>
                        </Show>
                      </div>

                      <div class="iris-sec">
                        <SideHead
                          icon="clock"
                          count={events.latest?.measured ? events.latest.events.length || undefined : undefined}
                          tint="#22c55e"
                          right={
                            <button type="button" class="iris-sh__add" onClick={() => setEvOpen(!evOpen())}>
                              {evOpen() ? "Cancel" : "+ Add"}
                            </button>
                          }
                        >
                          Events &amp; deadlines
                        </SideHead>
                        <NotConnected state={events.latest} />
                        <ul class="iris-card__rows">
                          <For each={events.latest?.events ?? []}>
                            {(ev) => (
                              <li class="iris-card__row">
                                <span class="iris-sec__when">{shortWhen(ev.startsAt)}</span>
                                <span class="iris-card__rowtext">{ev.title}</span>
                              </li>
                            )}
                          </For>
                        </ul>
                        <Show when={(events.latest?.events.length ?? 0) === 0 && !evOpen()}>
                          <p class="iris-sec__none">Nothing scheduled</p>
                        </Show>
                        <Show when={evOpen()}>
                          <form
                            class="iris-card__inline iris-card__inline--ev"
                            onSubmit={(e) => {
                              e.preventDefault()
                              void addEvent().then(() => !evTitle() && setEvOpen(false))
                            }}
                          >
                            <input class="iris-field__input" placeholder="Event or deadline…" aria-label="Event title" value={evTitle()} onInput={(e) => setEvTitle(e.currentTarget.value)} />
                            <input class="iris-field__input" type="datetime-local" aria-label="Event time" value={evAt()} onInput={(e) => setEvAt(e.currentTarget.value)} />
                            <button type="submit" class="iris-card__linkbtn iris-card__linkbtn--primary" disabled={!evTitle().trim() || !evAt()}>
                              Add
                            </button>
                          </form>
                        </Show>
                        <NoteLine note={evNote()} />
                      </div>

                      <div class="iris-sec">
                        <SideHead
                          icon="hand"
                          count={asks.latest?.measured ? asks.latest.asks.filter((a) => a.status === "open").length || undefined : undefined}
                          tint="#f59e0b"
                          right={
                            <button type="button" class="iris-sh__add" onClick={() => setAskOpen(!askOpen())}>
                              {askOpen() ? "Cancel" : "+ Add"}
                            </button>
                          }
                        >
                          Asks
                        </SideHead>
                        <NotConnected state={asks.latest} />
                        <ul class="iris-card__rows">
                          <For each={asks.latest?.asks ?? []}>
                            {(a) => (
                              <li class="iris-card__row">
                                <input
                                  type="checkbox"
                                  class="iris-card__check"
                                  checked={a.status === "answered"}
                                  disabled={a.status === "answered"}
                                  aria-label={`Answered: ${a.what}`}
                                  onChange={() => void answerAsk(a)}
                                />
                                <span class="iris-card__rowtext" classList={{ "iris-card__tasktext--done": a.status === "answered" }}>
                                  <span class="text-text-strong">{a.to}</span> — {a.what}
                                  <Show when={a.dueAt}>
                                    <span class="iris-sec__when ms-1">{shortDate(a.dueAt)}</span>
                                  </Show>
                                </span>
                              </li>
                            )}
                          </For>
                        </ul>
                        <Show when={(asks.latest?.asks.length ?? 0) === 0 && !askOpen()}>
                          <p class="iris-sec__none">Nothing asked of anyone</p>
                        </Show>
                        <Show when={askOpen()}>
                          <form
                            class="iris-card__inline iris-card__inline--ask"
                            onSubmit={(e) => {
                              e.preventDefault()
                              void addAsk().then(() => !askWhat() && setAskOpen(false))
                            }}
                          >
                            <input class="iris-field__input" placeholder="From whom…" aria-label="Ask: from whom" value={askTo()} onInput={(e) => setAskTo(e.currentTarget.value)} />
                            <input class="iris-field__input" type="date" aria-label="Ask: by when" value={askDue()} onInput={(e) => setAskDue(e.currentTarget.value)} />
                            <input class="iris-field__input" placeholder="What you need…" aria-label="Ask: what" value={askWhat()} onInput={(e) => setAskWhat(e.currentTarget.value)} />
                            <button type="submit" class="iris-card__linkbtn iris-card__linkbtn--primary" disabled={!askTo().trim() || !askWhat().trim()}>
                              Add
                            </button>
                          </form>
                        </Show>
                        <NoteLine note={askNote()} />
                      </div>

                      <div class="iris-sec iris-sec--more">
                        <button type="button" class="iris-more" aria-expanded={moreOpen()} onClick={() => setMoreOpen(!moreOpen())}>
                          <Icon name={moreOpen() ? "chevron-down" : "chevron-right"} size="small" />
                          More
                        </button>
                        <Show when={moreOpen()}>
                          <dl class="iris-more__facts">
                            <dt>Sharing</dt>
                            <dd>
                              <button type="button" class="iris-sh__add" onClick={() => setSide("sharing")}>
                                {doc.latest!.isPublic ? "Public link · manage" : "Private · manage"}
                              </button>
                            </dd>
                            <dt>List</dt>
                            <dd>{doc.latest!.listName ?? "—"}</dd>
                            <dt>Card</dt>
                            <dd class="font-mono tabular-nums">#{props.itemId}</dd>
                            <Show when={assigned().length}>
                              <dt>Task agents</dt>
                              <dd>{assigned().map((a) => a.name).join(", ")}</dd>
                            </Show>
                            <dt>Updated</dt>
                            <dd title={doc.latest!.updatedAt}>{timeAgo(doc.latest!.updatedAt, now()) || "—"}</dd>
                          </dl>
                        </Show>
                      </div>
                    </Match>

                    {/* ───────────── TASKS ───────────── */}
                    <Match when={side() === "tasks"}>
                      <Show
                        when={doc.latest!.tasksMeasured}
                        fallback={<p class="text-12-regular text-text-weak">Could not read tasks — {doc.latest!.tasksReason ?? "unknown"}.</p>}
                      >
                        <Show
                          when={doc.latest!.tasks.length > 0}
                          fallback={<p class="iris-sec__none pb-2">No tasks yet. Add the first step below.</p>}
                        >
                          {(() => {
                            const done = () => doc.latest!.tasks.filter((t) => t.done).length
                            const total = () => doc.latest!.tasks.length
                            return (
                              <div class="iris-card__progress" title={`${done()} of ${total()} done`}>
                                <span class="tabular-nums text-11-regular text-text-weak">
                                  {done()}/{total()} done
                                </span>
                                <span class="iris-card__progressbar">
                                  <span style={{ width: `${(done() / total()) * 100}%` }} />
                                </span>
                              </div>
                            )
                          })()}
                        </Show>
                        <ul class="iris-card__tasks">
                          <For each={doc.latest!.tasks}>
                            {(t) => (
                              <li class="iris-card__task" style={{ "padding-inline-start": `${8 + t.depth * 14}px` }}>
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
                                    <span class="iris-sec__when ms-1">{t.dueDate}</span>
                                  </Show>
                                </span>
                                <button
                                  type="button"
                                  class="iris-card__x"
                                  title="Add a subtask under this"
                                  onClick={() => {
                                    setAddParent(t)
                                    queueMicrotask(() => document.querySelector<HTMLInputElement>(".iris-card__addtask input")?.focus())
                                  }}
                                >
                                  +
                                </button>
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
                        <Show when={addParent()}>
                          {(p) => (
                            <span class="iris-card__chip iris-card__under">
                              under “{p().title}”
                              <button type="button" class="iris-card__x" title="Add at the top level instead" onClick={() => setAddParent(null)}>
                                ×
                              </button>
                            </span>
                          )}
                        </Show>
                        <input
                          class="iris-field__input"
                          placeholder={addParent() ? "Add a subtask…" : "Add a task…"}
                          aria-label="New checklist item"
                          value={newTask()}
                          onInput={(e) => setNewTask(e.currentTarget.value)}
                        />
                        <input
                          class="iris-field__input iris-card__due"
                          type="date"
                          aria-label="Due date"
                          title="Due date (optional)"
                          value={newDue()}
                          onInput={(e) => setNewDue(e.currentTarget.value)}
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
                      <NoteLine note={taskNote()} />
                    </Match>

                    {/* ───────────── SHARING ───────────── */}
                    <Match when={side() === "sharing"}>
                      <NotConnected state={share.latest} />
                      <NoteLine note={shareNote()} />

                      {/* THE LINK. Visibility is a column on the item; the allow-list is the gate. */}
                      <SectionHead>Link</SectionHead>
                      <div class="iris-card__seg" role="radiogroup" aria-label="Visibility">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={!(share.latest?.isPublic ?? doc.latest!.isPublic)}
                          class="iris-card__segitem"
                          classList={{ "iris-card__segitem--on": !(share.latest?.isPublic ?? doc.latest!.isPublic) }}
                          disabled={shareBusy()}
                          onClick={() => void setVisibility(false)}
                        >
                          Private
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={share.latest?.isPublic ?? doc.latest!.isPublic}
                          class="iris-card__segitem"
                          classList={{ "iris-card__segitem--on": share.latest?.isPublic ?? doc.latest!.isPublic }}
                          disabled={shareBusy()}
                          onClick={() => void setVisibility(true)}
                        >
                          Public link
                        </button>
                      </div>
                      <p
                        class="text-11-regular pt-2"
                        classList={{
                          "iris-card__warn": (share.latest?.isPublic ?? doc.latest!.isPublic) && share.latest?.allowKnown === true && share.latest.allowedEmails.length === 0,
                          "text-text-weak": !((share.latest?.isPublic ?? doc.latest!.isPublic) && share.latest?.allowKnown === true && share.latest.allowedEmails.length === 0),
                        }}
                      >
                        {allowListSummary(share.latest?.isPublic ?? doc.latest!.isPublic, share.latest?.allowedEmails ?? [], share.latest?.allowKnown ?? false)}
                      </p>
                      <Show when={share.latest?.publicUrl ?? doc.latest!.publicUrl}>
                        {(url) => (
                          <div class="iris-card__url">
                            <span class="font-mono text-11-regular truncate" title={url()}>
                              {url()}
                            </span>
                            <button type="button" class="iris-card__linkbtn" onClick={(e) => copy(e, url())}>
                              copy
                            </button>
                          </div>
                        )}
                      </Show>

                      <SectionHead count={share.latest?.allowedEmails.length ?? "—"}>Who can open the link</SectionHead>
                      <div class="iris-card__chips">
                        <For each={share.latest?.allowedEmails ?? []}>
                          {(e) => <Chip text={e} onRemove={() => void writeAllow((share.latest?.allowedEmails ?? []).filter((x) => x !== e))} />}
                        </For>
                        <Show when={(share.latest?.boardDefaults.allowedEmails.length ?? 0) > 0}>
                          <For each={share.latest!.boardDefaults.allowedEmails}>
                            {(e) => <Chip text={e} title="From the board's share defaults — change it on the board" />}
                          </For>
                        </Show>
                      </div>
                      <form
                        class="iris-card__inline"
                        onSubmit={(e) => {
                          e.preventDefault()
                          const add = parseAllowEntries(allowText(), share.latest?.allowedEmails ?? [])
                          if (add.length) void writeAllow([...(share.latest?.allowedEmails ?? []), ...add])
                          else setShareNote({ ok: false, text: "Nothing to add — use an email or an @domain" })
                        }}
                      >
                        <input
                          class="iris-field__input"
                          placeholder="email or @domain, comma separated…"
                          aria-label="Allow email or domain"
                          value={allowText()}
                          onInput={(e) => setAllowText(e.currentTarget.value)}
                        />
                        <button type="submit" class="iris-card__linkbtn iris-card__linkbtn--primary" disabled={!allowText().trim() || shareBusy()}>
                          Allow
                        </button>
                      </form>

                      {/* PEOPLE — board membership. Not item membership; the label says so. */}
                      <SectionHead count={share.latest?.measured ? share.latest.members.length : "—"}>People on this board</SectionHead>
                      <ul class="iris-card__rows">
                        <For each={share.latest?.members ?? []}>
                          {(m) => (
                            <li class="iris-card__row">
                              <span class="iris-card__rowtext">
                                <span class="text-text-strong">{m.name || m.email}</span>
                                <Show when={m.name}>
                                  <span class="text-text-weaker ms-1">{m.email}</span>
                                </Show>
                              </span>
                              <select class="iris-field__input iris-card__perm" aria-label={`Permission for ${m.email}`} value={m.permission} onChange={(e) => void setPermission(m, e.currentTarget.value)}>
                                <option value="viewer">viewer</option>
                                <option value="editor">editor</option>
                                <option value="owner">owner</option>
                              </select>
                              <button type="button" class="iris-card__x" classList={{ "iris-card__x--armed": armedRevoke() === `m${m.userId}` }} onClick={() => revokeMember(m)}>
                                {armedRevoke() === `m${m.userId}` ? "sure?" : "×"}
                              </button>
                            </li>
                          )}
                        </For>
                      </ul>
                      <form
                        class="iris-card__inline iris-card__inline--3"
                        onSubmit={(e) => {
                          e.preventDefault()
                          if (inviteEmail().trim()) void invite()
                        }}
                      >
                        <input class="iris-field__input" type="email" placeholder="Invite by email…" aria-label="Invite email" value={inviteEmail()} onInput={(e) => setInviteEmail(e.currentTarget.value)} />
                        <select class="iris-field__input iris-card__perm" aria-label="Invite permission" value={invitePerm()} onChange={(e) => setInvitePerm(e.currentTarget.value)}>
                          <option value="viewer">viewer</option>
                          <option value="editor">editor</option>
                          <option value="owner">owner</option>
                        </select>
                        <button type="submit" class="iris-card__linkbtn iris-card__linkbtn--primary" disabled={!inviteEmail().trim() || shareBusy()}>
                          Invite
                        </button>
                      </form>

                      {/* SHARE LINKS — bearer links. Said in the row. */}
                      <SectionHead count={share.latest?.measured ? share.latest.links.filter((l) => !l.revoked).length : "—"}>Share links</SectionHead>
                      <ul class="iris-card__rows">
                        <For each={share.latest?.links ?? []}>
                          {(l) => (
                            <li class="iris-card__row" classList={{ "iris-card__row--off": l.revoked }}>
                              <span class="iris-card__rowtext font-mono text-11-regular truncate" title={l.url}>
                                {l.url}
                              </span>
                              <span class="font-mono tabular-nums text-11-regular text-text-weaker shrink-0">
                                {l.uses} use{l.uses === 1 ? "" : "s"}
                                {l.expiresAt ? ` · until ${shortDate(l.expiresAt)}` : ""}
                              </span>
                              <Show when={!l.revoked} fallback={<span class="text-11-regular text-text-weaker">revoked</span>}>
                                <button type="button" class="iris-card__linkbtn" onClick={(e) => copy(e, l.url)}>
                                  copy
                                </button>
                                <button type="button" class="iris-card__x" classList={{ "iris-card__x--armed": armedRevoke() === `l${l.id}` }} onClick={() => revokeLink(l)}>
                                  {armedRevoke() === `l${l.id}` ? "sure?" : "×"}
                                </button>
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                      <form
                        class="iris-card__inline"
                        onSubmit={(e) => {
                          e.preventDefault()
                          void createLink()
                        }}
                      >
                        <input class="iris-field__input" type="number" min="1" placeholder="Expires in days (blank = never)" aria-label="Link expiry in days" value={linkDays()} onInput={(e) => setLinkDays(e.currentTarget.value)} />
                        <button type="submit" class="iris-card__linkbtn iris-card__linkbtn--primary" disabled={shareBusy()}>
                          New link
                        </button>
                      </form>
                      <p class="text-11-regular text-text-weaker pt-1">A share link is a bearer link: whoever holds it is in. Revoke it here when it has done its job.</p>
                    </Match>

                    {/* ───────────── CHAT: Team (people + what happened) | AI ───────────── */}
                    <Match when={side() === "chat"}>
                      <div class="iris-card__chat">
                        <div class="iris-subtabs" role="tablist" aria-label="Chat">
                          <button type="button" role="tab" class="iris-subtabs__tab" data-tone="team" aria-selected={chatSub() === "team"} onClick={() => setChatSub("team")}>
                            Team
                          </button>
                          <button type="button" role="tab" class="iris-subtabs__tab" data-tone="ai" aria-selected={chatSub() === "ai"} onClick={() => setChatSub("ai")}>
                            ✦ AI
                          </button>
                        </div>
                        <Switch>
                          <Match when={chatSub() === "team"}>
                            <NotConnected state={trail.latest} />
                            <div class="iris-thread" ref={threadScroll}>
                              <Show when={trail.latest?.measured && thread().length === 0}>
                                <p class="iris-sec__none">
                                  No messages yet. Comments, assignments, finished tasks, moves and changes to status, priority and
                                  due date show here.
                                </p>
                              </Show>
                              <For each={thread()}>
                                {(e) => (
                                  <Switch>
                                    <Match when={e.kind === "comment" && e}>
                                      {(c) => (
                                        <div class="iris-bubble" classList={{ "iris-bubble--me": c().mine }}>
                                          <Avatar name={c().row.actor || "?"} kind="user" size={26} />
                                          <div class="iris-bubble__col">
                                            <div class="iris-bubble__meta">
                                              <span class="iris-bubble__who">{c().mine ? "You" : c().row.actor || "Someone"}</span>
                                              <span title={c().row.at}>{timeAgo(c().row.at, now())}</span>
                                            </div>
                                            <div class="iris-bubble__text">{c().row.text}</div>
                                          </div>
                                        </div>
                                      )}
                                    </Match>
                                    <Match when={e.kind === "change" && e}>
                                      {(g) => (
                                        <Show
                                          when={g().rows.length > 1}
                                          fallback={
                                            <div class="iris-event">
                                              <span aria-hidden="true">{g().rows[0].icon ?? "·"}</span>
                                              <span class="iris-event__text">
                                                <Show when={g().actor}>
                                                  <b>{g().actor}</b>{" "}
                                                </Show>
                                                {g().summary}
                                              </span>
                                              <span class="iris-event__at" title={g().at}>
                                                {timeAgo(g().at, now())}
                                              </span>
                                            </div>
                                          }
                                        >
                                          <details class="iris-event iris-event--group">
                                            <summary>
                                              <span aria-hidden="true">{g().rows[0].icon ?? "·"}</span>
                                              <span class="iris-event__text">
                                                <b>{g().actor ?? "Someone"}</b> {g().summary}
                                              </span>
                                              <span class="iris-event__at" title={g().at}>
                                                {timeAgo(g().at, now())}
                                              </span>
                                            </summary>
                                            <ul>
                                              <For each={[...g().rows].reverse()}>
                                                {(r) => (
                                                  <li>
                                                    <span>{r.text}</span>
                                                    <span class="iris-event__at">{timeAgo(r.at, now())}</span>
                                                  </li>
                                                )}
                                              </For>
                                            </ul>
                                          </details>
                                        </Show>
                                      )}
                                    </Match>
                                  </Switch>
                                )}
                              </For>
                            </div>
                            <Show when={commentNote()}>
                              <NoteLine note={commentNote()} />
                            </Show>
                            <form
                              class="iris-card__compose iris-comment"
                              onSubmit={(e) => {
                                e.preventDefault()
                                void postComment()
                              }}
                            >
                              <textarea
                                class="iris-field__input iris-card__composetext"
                                rows={2}
                                placeholder="Message the team… @ to mention someone on this board"
                                aria-label="Comment"
                                value={comment()}
                                onInput={(e) => setComment(e.currentTarget.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && !e.shiftKey && mentionable().length === 0) {
                                    e.preventDefault()
                                    void postComment()
                                  }
                                }}
                              />
                              <button type="submit" class="iris-send" aria-label="Send" disabled={!comment().trim() || posting()}>
                                <Icon name="send" size="small" />
                              </button>
                              <Show when={mentionable().length > 0}>
                                <ul class="iris-comment__mentions" role="listbox" aria-label="Mention someone">
                                  <For each={mentionable()}>
                                    {(m) => (
                                      <li>
                                        <button type="button" onClick={() => pickMention(m)}>
                                          <span>{m.name || m.email}</span>
                                          <span class="iris-trail__meta">{m.email}</span>
                                        </button>
                                      </li>
                                    )}
                                  </For>
                                </ul>
                              </Show>
                            </form>
                          </Match>
                          <Match when={chatSub() === "ai"}>
                            <div class="iris-card__chathead">
                              <select class="iris-field__input" aria-label="Chat with agent" value={chatAgent() || String(chat.latest?.agentId ?? "")} onChange={(e) => setChatAgent(e.currentTarget.value)}>
                                <option value="">Pick an agent…</option>
                                <For each={agents.latest?.agents ?? []}>{(a) => <option value={String(a.id)}>{a.name}</option>}</For>
                              </select>
                            </div>
                            <NotConnected state={chat.latest} />
                            <div class="iris-card__msgs" ref={chatScroll}>
                              <Show when={chat.latest?.measured && chat.latest.messages.length === 0}>
                                <p class="iris-sec__none">No messages yet. The agent sees this card's body and tasks.</p>
                              </Show>
                              <For each={chat.latest?.messages ?? []}>
                                {(m) => (
                                  <div class="iris-bubble" classList={{ "iris-bubble--me": m.role === "user" }}>
                                    <Avatar name={m.role === "user" ? "You" : (m.agentName ?? "Agent")} kind={m.role === "user" ? "user" : "agent"} size={26} />
                                    <div class="iris-bubble__col">
                                      <div class="iris-bubble__meta">
                                        <span class="iris-bubble__who">{m.role === "user" ? "You" : (m.agentName ?? "Agent")}</span>
                                      </div>
                                      <div class="iris-bubble__text iris-markdown" innerHTML={renderMarkdown(m.text)} />
                                    </div>
                                  </div>
                                )}
                              </For>
                              <Show when={thinking()}>
                                <div class="iris-bubble">
                                  <Avatar name="Agent" kind="agent" size={26} />
                                  <div class="iris-bubble__col">
                                    <div class="iris-bubble__text text-text-weak">thinking…</div>
                                  </div>
                                </div>
                              </Show>
                            </div>
                            <Show when={chatNote()}>
                              <p class="text-11-regular text-text-weak">{chatNote()}</p>
                            </Show>
                            <form
                              class="iris-card__compose"
                              onSubmit={(e) => {
                                e.preventDefault()
                                void sendChat()
                              }}
                            >
                              <textarea
                                class="iris-field__input iris-card__composetext"
                                rows={2}
                                placeholder="Ask about this card…"
                                aria-label="Message"
                                value={chatText()}
                                onInput={(e) => setChatText(e.currentTarget.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault()
                                    void sendChat()
                                  }
                                }}
                              />
                              <button type="submit" class="iris-send" aria-label="Send" disabled={!chatText().trim() || thinking()}>
                                <Icon name="send" size="small" />
                              </button>
                            </form>
                          </Match>
                        </Switch>
                      </div>
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
          <span>
            {dirty() && bodyDirty()
              ? "Unsaved changes to the details and the body."
              : dirty()
                ? "Unsaved changes to the details."
                : "Unsaved changes to the body."}
          </span>
          <button type="button" class="iris-card__save" disabled={saving() || savingBody()} onClick={() => void saveAll()}>
            {saving() || savingBody() ? "Saving…" : "Save"}
          </button>
          <button type="button" class="iris-card__linkbtn" onClick={() => dialog.close()}>
            Discard and close
          </button>
        </div>
      </Show>
    </Dialog>
  )
}
