import { createEffect, createMemo, createResource, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { itemCommands, renderMarkdown } from "./iris-item"

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

export interface IrisCardEditorProps {
  itemId: number
  bloqId: number
  /** The board's lists, from the Atlas payload already on screen. The List picker. */
  lists: { id: number; name: string }[]
  doFetch: (path: string, init?: RequestInit) => Promise<Response>
  /** Called after any write landed, so the list behind the dialog can refresh its row. */
  onChanged?: () => void
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
  const MISSING = `Not connected yet — sidecar route missing (${HANDOFF})`
  async function readJson(res: Response): Promise<any | undefined> {
    if (!/json/i.test(res.headers.get("content-type") ?? "")) return undefined
    return res.json().catch(() => undefined)
  }
  async function wire<T>(path: string, empty: T, init?: RequestInit): Promise<Wired<T>> {
    try {
      const res = await props.doFetch(path, init)
      const j = await readJson(res)
      if (res.status === 404 || j === undefined) return { measured: false, reason: MISSING, ...empty }
      if (!res.ok) return { measured: false, reason: j?.reason ?? j?.message ?? `sidecar ${res.status}`, ...empty }
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
      if (!res.ok) return { ok: false, reason: j?.reason ?? j?.message ?? `sidecar ${res.status}` }
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

  const [side, setSide] = createSignal<SideTab>("details")
  createEffect(() => {
    if (side() === "tasks" || side() === "chat") setWantAgents(true)
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
  async function upload(list: FileList | null) {
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
    () => (side() === "chat" ? props.itemId : undefined),
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

  return (
    <Dialog
      size="x-large"
      class="iris-card"
      title={
        <span class="iris-card__crumb">
          <span class="text-text-weaker">{doc.latest?.listName ?? "Card"}</span>
          <span class="font-mono tabular-nums text-text-weaker">#{props.itemId}</span>
          <Show when={doc.latest?.isPublic}>
            <span class="iris-card__pub" title="This card is public — see Sharing">public</span>
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
                    <button type="button" class="iris-cmdbar__chip" title={`Copy: ${c.cmd}`} onClick={(e) => copy(e, c.cmd)}>
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
                  <For
                    each={
                      [
                        ["details", "Details", undefined],
                        ["sharing", "Sharing", undefined],
                        ["tasks", "Tasks", doc.latest!.tasksMeasured ? openTasks() : undefined],
                        ["chat", "Chat", undefined],
                      ] as [SideTab, string, number | undefined][]
                    }
                  >
                    {([id, label, count]) => (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={side() === id}
                        class="iris-detailnav__item"
                        classList={{ "iris-detailnav__item--active": side() === id }}
                        onClick={() => setSide(id)}
                      >
                        {label}
                        <Show when={count !== undefined}>
                          <span class="iris-card__count">{count}</span>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>

                <div class="iris-card__sidebody">
                  <Switch>
                    {/* ───────────── DETAILS ───────────── */}
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
                        <input type="date" class="iris-field__input" value={form()?.dueDate ?? ""} onInput={(e) => set("dueDate", e.currentTarget.value)} />
                      </label>

                      <Show when={schema.latest && !schema.latest.measured}>
                        <p class="text-11-regular text-text-weak">Vocabulary unavailable — {schema.latest!.reason}. Current values are kept.</p>
                      </Show>

                      <div class="iris-card__savebar">
                        <NoteLine note={note()} />
                        <button
                          type="button"
                          class="iris-card__linkbtn iris-card__linkbtn--primary ms-auto"
                          disabled={!dirty() || saving()}
                          onClick={() => void saveDetails()}
                        >
                          {saving() ? "Saving…" : dirty() ? "Save" : "No changes"}
                        </button>
                      </div>

                      {/* LABELS — inside content JSON. Type and Priority above are columns; the
                          server derives them from labels when they are not sent, which is why
                          a labels write goes through its own route (HANDOFF). */}
                      <SectionHead count={doc.latest!.labels.length}>Labels</SectionHead>
                      <div class="iris-card__chips">
                        <For each={doc.latest!.labels}>
                          {(l) => <Chip text={l} onRemove={() => void writeLabels(doc.latest!.labels.filter((x) => x !== l))} />}
                        </For>
                        <Show when={doc.latest!.labels.length === 0}>
                          <span class="text-11-regular text-text-weaker">No labels.</span>
                        </Show>
                      </div>
                      <form
                        class="iris-card__inline"
                        onSubmit={(e) => {
                          e.preventDefault()
                          const t = labelText().trim()
                          if (t && !doc.latest!.labels.includes(t)) void writeLabels([...doc.latest!.labels, t])
                        }}
                      >
                        <input
                          class="iris-field__input"
                          list="iris-card-label-options"
                          placeholder="Add a label…"
                          aria-label="New label"
                          value={labelText()}
                          onInput={(e) => setLabelText(e.currentTarget.value)}
                        />
                        <datalist id="iris-card-label-options">
                          <For each={[...(schema.latest?.type ?? []), ...(schema.latest?.priority ?? [])]}>{(o) => <option value={o.label} />}</For>
                        </datalist>
                        <button type="submit" class="iris-card__linkbtn iris-card__linkbtn--primary" disabled={!labelText().trim() || labelBusy()}>
                          Add
                        </button>
                      </form>
                      <Show when={doc.latest!.contentKind === "markdown"}>
                        <p class="text-11-regular text-text-weaker">Labels need a structured body; this one is plain markdown. The sidecar decides whether to convert it ({HANDOFF}).</p>
                      </Show>
                      <NoteLine note={labelNote()} />

                      {/* ATTACHMENTS */}
                      <SectionHead
                        count={files.latest?.measured ? files.latest.files.length : "—"}
                        right={
                          <label class="iris-card__linkbtn iris-card__linkbtn--primary" style={{ cursor: uploading() ? "default" : "pointer" }}>
                            {uploading() ? "Uploading…" : "Upload"}
                            <input type="file" multiple hidden disabled={uploading()} onChange={(e) => void upload(e.currentTarget.files)} />
                          </label>
                        }
                      >
                        Attachments
                      </SectionHead>
                      <NotConnected state={files.latest} />
                      <Show when={missingFiles() > 0}>
                        <p class="iris-card__warn">
                          {missingFiles()} file{missingFiles() === 1 ? "" : "s"} referenced but not stored. Upload {missingFiles() === 1 ? "it" : "them"} again.
                        </p>
                      </Show>
                      <div
                        class="iris-card__drop"
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault()
                          void upload(e.dataTransfer?.files ?? null)
                        }}
                      >
                        <Show when={(files.latest?.files.length ?? 0) === 0}>
                          <span class="text-11-regular text-text-weaker">Drop files here, or Upload.</span>
                        </Show>
                        <For each={files.latest?.files ?? []}>
                          {(f) => (
                            <div class="iris-card__file" classList={{ "iris-card__file--missing": !f.stored }}>
                              <span class="iris-card__filetype">{(f.type ?? f.name.split(".").pop() ?? "file").slice(0, 4)}</span>
                              <span class="iris-card__filename" title={f.name}>
                                {f.name}
                                <span class="font-mono tabular-nums text-11-regular text-text-weaker ms-1">{f.stored ? fileSize(f.size) : "missing"}</span>
                              </span>
                              <Show when={f.url}>
                                <a class="iris-card__linkbtn" href={f.url} target="_blank" rel="noreferrer">
                                  Open
                                </a>
                              </Show>
                              <button type="button" class="iris-card__x" title="Remove attachment" onClick={() => void removeFile(f)}>
                                ×
                              </button>
                            </div>
                          )}
                        </For>
                      </div>
                      <NoteLine note={fileNote()} />

                      {/* EVENTS */}
                      <SectionHead count={events.latest?.measured ? events.latest.events.length : "—"}>Events &amp; deadlines</SectionHead>
                      <NotConnected state={events.latest} />
                      <ul class="iris-card__rows">
                        <For each={events.latest?.events ?? []}>
                          {(ev) => (
                            <li class="iris-card__row">
                              <span class="font-mono tabular-nums text-11-regular text-text-weaker shrink-0">{shortWhen(ev.startsAt)}</span>
                              <span class="iris-card__rowtext">{ev.title}</span>
                            </li>
                          )}
                        </For>
                      </ul>
                      <form
                        class="iris-card__inline iris-card__inline--ev"
                        onSubmit={(e) => {
                          e.preventDefault()
                          void addEvent()
                        }}
                      >
                        <input class="iris-field__input" placeholder="Event or deadline…" aria-label="Event title" value={evTitle()} onInput={(e) => setEvTitle(e.currentTarget.value)} />
                        <input class="iris-field__input" type="datetime-local" aria-label="Event time" value={evAt()} onInput={(e) => setEvAt(e.currentTarget.value)} />
                        <button type="submit" class="iris-card__linkbtn iris-card__linkbtn--primary" disabled={!evTitle().trim() || !evAt()}>
                          Add
                        </button>
                      </form>
                      <NoteLine note={evNote()} />

                      {/* ASKS — "I need X from Y by Z". The thing nothing modelled. */}
                      <SectionHead count={asks.latest?.measured ? asks.latest.asks.filter((a) => a.status === "open").length : "—"}>Asks</SectionHead>
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
                                  <span class="font-mono tabular-nums text-11-regular text-text-weaker ms-1">{shortDate(a.dueAt)}</span>
                                </Show>
                              </span>
                            </li>
                          )}
                        </For>
                      </ul>
                      <form
                        class="iris-card__inline iris-card__inline--ask"
                        onSubmit={(e) => {
                          e.preventDefault()
                          void addAsk()
                        }}
                      >
                        <input class="iris-field__input" placeholder="From whom…" aria-label="Ask: from whom" value={askTo()} onInput={(e) => setAskTo(e.currentTarget.value)} />
                        <input class="iris-field__input" type="date" aria-label="Ask: by when" value={askDue()} onInput={(e) => setAskDue(e.currentTarget.value)} />
                        <input class="iris-field__input" placeholder="What you need…" aria-label="Ask: what" value={askWhat()} onInput={(e) => setAskWhat(e.currentTarget.value)} />
                        <button type="submit" class="iris-card__linkbtn iris-card__linkbtn--primary" disabled={!askTo().trim() || !askWhat().trim()}>
                          Add
                        </button>
                      </form>
                      <NoteLine note={askNote()} />

                      {/* READ-ONLY facts. Agents live in tasks; shown so the panel does not
                          hide what Elon shows, and not written here so there is one write path. */}
                      <dl class="iris-card__facts">
                        <Show when={assigned().length}>
                          <dt>Agents</dt>
                          <dd>
                            <For each={assigned()}>{(a) => <span class="iris-card__chip">{a.name}</span>}</For>
                          </dd>
                        </Show>
                        <dt>Updated</dt>
                        <dd class="font-mono tabular-nums text-11-regular">{shortDate(doc.latest!.updatedAt)}</dd>
                      </dl>
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

                    {/* ───────────── TASKS ───────────── */}
                    <Match when={side() === "tasks"}>
                      <Show
                        when={doc.latest!.tasksMeasured}
                        fallback={<p class="text-12-regular text-text-weak">Could not read tasks — {doc.latest!.tasksReason ?? "unknown"}.</p>}
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
                        <input class="iris-field__input" placeholder="Add a task…" aria-label="New task" value={newTask()} onInput={(e) => setNewTask(e.currentTarget.value)} />
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

                    {/* ───────────── CHAT ───────────── */}
                    <Match when={side() === "chat"}>
                      <div class="iris-card__chat">
                        <div class="iris-card__chathead">
                          <select class="iris-field__input" aria-label="Chat with agent" value={chatAgent() || String(chat.latest?.agentId ?? "")} onChange={(e) => setChatAgent(e.currentTarget.value)}>
                            <option value="">Pick an agent…</option>
                            <For each={agents.latest?.agents ?? []}>{(a) => <option value={String(a.id)}>{a.name}</option>}</For>
                          </select>
                        </div>
                        <NotConnected state={chat.latest} />
                        <div class="iris-card__msgs" ref={chatScroll}>
                          <Show when={chat.latest?.measured && chat.latest.messages.length === 0}>
                            <p class="text-11-regular text-text-weaker">No messages yet. The agent sees this card's body and tasks.</p>
                          </Show>
                          <For each={chat.latest?.messages ?? []}>
                            {(m) => (
                              <div class="iris-card__msg" classList={{ "iris-card__msg--me": m.role === "user" }}>
                                <span class="iris-card__msgwho">{m.role === "user" ? "you" : (m.agentName ?? "agent")}</span>
                                <div class="iris-card__msgtext iris-markdown" innerHTML={renderMarkdown(m.text)} />
                              </div>
                            )}
                          </For>
                          <Show when={thinking()}>
                            <div class="iris-card__msg">
                              <span class="iris-card__msgwho">agent</span>
                              <div class="iris-card__msgtext text-text-weak">thinking…</div>
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
                          <button type="submit" class="iris-card__linkbtn iris-card__linkbtn--primary" disabled={!chatText().trim() || thinking()}>
                            {thinking() ? "…" : "Send"}
                          </button>
                        </form>
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
          Unsaved changes — Save, or they stay in this window until it closes.{" "}
          <button type="button" class="iris-card__linkbtn" onClick={() => dialog.close()}>
            Discard and close
          </button>
        </div>
      </Show>
    </Dialog>
  )
}
