import fs from "node:fs"
import path from "node:path"
import { findCardInCopies, outboxFile, readBoardCopy, readLocalCopySettings, mayKeep } from "./atlas-local-copy"
import { canon, merge3, type Data } from "./atlas-merge"
import { FL_API, apiFailure, createItem, irisFetch, moveItem, unreachable, type AtlasItem, type AtlasList } from "./platform"

/**
 * EDITS MADE WITH NO CONNECTION (#190537 W3).
 *
 * Until now a card edit with fl-api unreachable said "Not saved" and was gone. Now it waits here,
 * on this machine, and is sent when fl-api answers again. Three kinds wait: a card created, a
 * card's fields saved, and a card moved.
 *
 * A SAVE CARRIES THE CARD AS IT WAS READ — its rev (`base_rev`, fl-api W1) and the values of the
 * fields it changes. fl-api refuses a save whose rev is out of date with 409 `card_changed` and the
 * card as it is now. The three versions are then merged field by field with the same `merge3` the
 * CLI's dataset sync uses:
 *   - a field only you changed is sent;
 *   - a field already equal on both sides is dropped;
 *   - a field you both changed, differently, is HELD — shown on the card with both values, for a
 *     person to choose. It is never decided by whoever replays last. Nothing is dropped silently.
 * A field whose value before your edit is not known (a body edited without the body it started
 * from) counts as changed by both, so it is held rather than guessed.
 *
 * WHAT MAY WAIT: only a card on a board this machine may keep (atlas-local-copy's mayKeep). A
 * patient-data board with includePhi off has no copy, so its edits are refused offline as before,
 * with the reason — an edit queued on disk would put its content on disk.
 *
 * ORDER: first in, first sent. Edits to one card while offline fold into one save that keeps the
 * FIRST base, so the merge compares against what you actually saw. Edits to a card created offline
 * fold into its create. Moves are not guarded by fl-api (the last move wins, as on the web) and
 * are sent as they are.
 *
 * Owner-only file (0600) per account, written by rename so a crash cannot leave half a queue.
 * The board copy is never edited by the queue: it stays fl-api's truth, and waiting edits are
 * drawn over it on every read (`overlay`). Throwing the queue away therefore throws away edits,
 * never a board.
 */

export type OutboxState = "waiting" | "held"

/** A field both sides changed: what it was, what you set, what fl-api has now. */
export interface HeldField {
  field: string
  base?: unknown
  mine: unknown
  theirs: unknown
}

export interface Held {
  /** conflict = held for a person to choose; refused = fl-api said no, the reason is its words. */
  kind: "conflict" | "refused"
  message: string
  fields?: HeldField[]
  /** The rev to save against once a person chooses "keep mine". */
  retryRev?: string
  at: string
}

interface OpBase {
  id: string
  bloqId: number
  at: string
  state: OutboxState
  held?: Held
}

export type OutboxOp =
  | (OpBase & { kind: "create"; tempId: number; listId: number; title: string; body?: string })
  | (OpBase & { kind: "save"; itemId: number; baseRev?: string; base: Data; patch: Data })
  | (OpBase & { kind: "move"; itemId: number; listId: number; position: number })

interface OutboxFile {
  userId: number
  /** Temporary ids for cards created offline count down from -1, so they never meet a real id. */
  nextTempId: number
  ops: OutboxOp[]
}

// ── the file ────────────────────────────────────────────────────────────────

export function readOutbox(userId: number): OutboxFile {
  try {
    const o = JSON.parse(fs.readFileSync(outboxFile(userId), "utf8")) as OutboxFile
    if (o?.userId === userId && Array.isArray(o.ops)) return { userId, nextTempId: o.nextTempId ?? -1, ops: o.ops }
  } catch {}
  return { userId, nextTempId: -1, ops: [] }
}

function writeOutbox(o: OutboxFile) {
  const p = outboxFile(o.userId)
  if (o.ops.length === 0) {
    fs.rmSync(p, { force: true })
    return
  }
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(o), { mode: 0o600 })
  fs.renameSync(tmp, p)
}

const newId = () => `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

// ── fields: the card as the copy holds it ↔ the card as fl-api's write takes it ──

/** One field's value in one comparable form: fl-api answers a date as a timestamp, the editor sends YYYY-MM-DD. */
export function norm(field: string, v: unknown): unknown {
  if (v === undefined || v === "" ) return null
  if (field === "due_date") return typeof v === "string" ? v.slice(0, 10) : v
  if (field === "bloq_list_id") return v === null ? null : Number(v)
  return v
}

/** The wire fields of a card as the copy holds it. `content` is not there: copies carry no bodies. */
function wireOf(item: AtlasItem, listId: number): Data {
  return {
    title: item.title,
    status: item.status ?? null,
    priority: item.priority ?? null,
    card_type: item.cardType ?? null,
    due_date: norm("due_date", item.dueDate),
    bloq_list_id: listId,
  }
}

// ── enqueue ─────────────────────────────────────────────────────────────────

export type Enqueued = { queued: true; opId: string; id?: number } | { queued: false; reason: string }

const NOT_KEPT =
  "You're offline, and this board isn't kept on this computer, so the change can't wait here. Try again when you're back online."

/** Whether this board's edits may wait on disk. */
export function mayQueue(userId: number, bloqId: number): boolean {
  const c = readBoardCopy(userId, bloqId)
  return !!c && mayKeep(!!c.containsPhi, readLocalCopySettings())
}

/**
 * Queue a save. `patch` is the fl-api body (itemPatchBody). `uiBase` is what the editor showed
 * before the edit, for the fields the copy does not hold — the body.
 */
export function enqueueSave(userId: number, itemId: number, patch: Data, uiBase: Data = {}): Enqueued {
  const o = readOutbox(userId)

  // A card created offline: the save folds into its create.
  if (itemId < 0) {
    const create = o.ops.find((op) => op.kind === "create" && op.tempId === itemId) as Extract<OutboxOp, { kind: "create" }> | undefined
    if (!create) return { queued: false, reason: "That card no longer exists here." }
    if (typeof patch.title === "string") create.title = patch.title
    if (typeof patch.content === "string") create.body = patch.content
    if (patch.bloq_list_id !== undefined) create.listId = Number(patch.bloq_list_id)
    writeOutbox(o)
    return { queued: true, opId: create.id, id: itemId }
  }

  const found = findCardInCopies<AtlasItem>(userId, itemId)
  if (!found) return { queued: false, reason: NOT_KEPT }

  // An earlier save to this card that is still waiting takes this one in: one save, the first base.
  const earlier = o.ops.find((op) => op.kind === "save" && op.itemId === itemId && op.state === "waiting") as
    | Extract<OutboxOp, { kind: "save" }>
    | undefined
  const fromCopy = wireOf(found.item, found.listId)
  if (earlier) {
    for (const k of Object.keys(patch)) if (!(k in earlier.base) && (k in fromCopy || k in uiBase)) earlier.base[k] = k in uiBase ? uiBase[k] : fromCopy[k]
    Object.assign(earlier.patch, patch)
    writeOutbox(o)
    return { queued: true, opId: earlier.id }
  }

  const base: Data = {}
  for (const k of Object.keys(patch)) {
    if (k in uiBase) base[k] = uiBase[k]
    else if (k in fromCopy) base[k] = fromCopy[k]
  }
  const op: OutboxOp = {
    id: newId(),
    kind: "save",
    bloqId: found.bloqId,
    itemId,
    ...(found.item.rev ? { baseRev: found.item.rev } : {}),
    base,
    patch: { ...patch },
    at: new Date().toISOString(),
    state: "waiting",
  }
  o.ops.push(op)
  writeOutbox(o)
  return { queued: true, opId: op.id }
}

/** Queue a new card. It shows at once with a temporary (negative) id, replaced when it lands. */
export function enqueueCreate(userId: number, bloqId: number, listId: number, input: { title: string; body?: string }): Enqueued {
  if (!mayQueue(userId, bloqId)) return { queued: false, reason: NOT_KEPT }
  const o = readOutbox(userId)
  const tempId = o.nextTempId
  o.nextTempId = tempId - 1
  const op: OutboxOp = {
    id: newId(),
    kind: "create",
    bloqId,
    tempId,
    listId,
    title: input.title.trim(),
    ...(input.body?.trim() ? { body: input.body.trim() } : {}),
    at: new Date().toISOString(),
    state: "waiting",
  }
  o.ops.push(op)
  writeOutbox(o)
  return { queued: true, opId: op.id, id: tempId }
}

/** Queue a move. A later move of the same card replaces an earlier one still waiting. */
export function enqueueMove(userId: number, itemId: number, listId: number, position: number): Enqueued {
  const o = readOutbox(userId)
  if (itemId < 0) {
    const create = o.ops.find((op) => op.kind === "create" && op.tempId === itemId) as Extract<OutboxOp, { kind: "create" }> | undefined
    if (!create) return { queued: false, reason: "That card no longer exists here." }
    create.listId = listId
    writeOutbox(o)
    return { queued: true, opId: create.id, id: itemId }
  }
  const found = findCardInCopies<AtlasItem>(userId, itemId)
  if (!found) return { queued: false, reason: NOT_KEPT }
  const earlier = o.ops.find((op) => op.kind === "move" && op.itemId === itemId && op.state === "waiting") as
    | Extract<OutboxOp, { kind: "move" }>
    | undefined
  if (earlier) {
    earlier.listId = listId
    earlier.position = position
    writeOutbox(o)
    return { queued: true, opId: earlier.id }
  }
  const op: OutboxOp = { id: newId(), kind: "move", bloqId: found.bloqId, itemId, listId, position, at: new Date().toISOString(), state: "waiting" }
  o.ops.push(op)
  writeOutbox(o)
  return { queued: true, opId: op.id }
}

/** Whether a card has edits waiting. A live save of such a card must queue behind them, or it lands first and they overwrite it. */
export function hasWaiting(userId: number, itemId: number): boolean {
  return readOutbox(userId).ops.some((op) => (op.kind === "create" ? op.tempId === itemId : op.itemId === itemId))
}

// ── what the board shows ────────────────────────────────────────────────────

export interface OutboxCounts {
  waiting: number
  held: number
}

export function counts(userId: number, bloqId?: number): OutboxCounts {
  const ops = readOutbox(userId).ops.filter((op) => bloqId === undefined || op.bloqId === bloqId)
  return { waiting: ops.filter((op) => op.state === "waiting").length, held: ops.filter((op) => op.state === "held").length }
}

/** What the panel needs to show a held edit on its card. */
export interface HeldView {
  opId: string
  itemId: number
  kind: Held["kind"]
  message: string
  fields: HeldField[]
}

export function heldOn(userId: number, bloqId: number): HeldView[] {
  return readOutbox(userId)
    .ops.filter((op) => op.bloqId === bloqId && op.state === "held" && op.held)
    .map((op) => ({
      opId: op.id,
      itemId: op.kind === "create" ? op.tempId : op.itemId,
      kind: op.held!.kind,
      message: op.held!.message,
      fields: op.held!.fields ?? [],
    }))
}

/**
 * The board as fl-api last said it is, with this machine's waiting edits drawn on top. Each card
 * an edit touches says so (`pending`), so the panel can mark it. The lists passed in are not changed.
 */
export function overlay(userId: number, bloqId: number, lists: readonly AtlasList[]): AtlasList[] {
  const ops = readOutbox(userId).ops.filter((op) => op.bloqId === bloqId)
  if (ops.length === 0) return lists as AtlasList[]
  const out = lists.map((l) => ({ ...l, items: l.items.map((i) => ({ ...i })) }))
  const locate = (id: number) => {
    for (const l of out) {
      const k = l.items.findIndex((i) => i.id === id)
      if (k >= 0) return { l, k }
    }
    return undefined
  }
  for (const op of ops) {
    if (op.kind === "create") {
      const l = out.find((x) => x.id === op.listId)
      if (l)
        l.items.push({
          id: op.tempId,
          title: op.title,
          status: "todo",
          ...(op.body ? { preview: op.body.slice(0, 400) } : {}),
          pending: op.state,
        } as AtlasItem)
      continue
    }
    const at = locate(op.itemId)
    if (!at) continue
    const item = at.l.items[at.k] as AtlasItem & { pending?: OutboxState }
    item.pending = item.pending === "held" ? "held" : op.state
    if (op.kind === "move") {
      at.l.items.splice(at.k, 1)
      const to = out.find((x) => x.id === op.listId)
      if (to) to.items.splice(Math.min(op.position, to.items.length), 0, item)
      continue
    }
    const p = op.patch
    if (typeof p.title === "string") item.title = p.title
    if (typeof p.content === "string") item.preview = p.content.slice(0, 400)
    if (typeof p.status === "string") item.status = p.status
    if (p.priority !== undefined) item.priority = (p.priority as string | null) ?? undefined
    if (p.card_type !== undefined) item.cardType = (p.card_type as string | null) ?? undefined
    if (p.due_date !== undefined) item.dueDate = (p.due_date as string | null) ?? undefined
    if (p.bloq_list_id !== undefined && Number(p.bloq_list_id) !== at.l.id) {
      const to = out.find((x) => x.id === Number(p.bloq_list_id))
      if (to) {
        at.l.items.splice(at.k, 1)
        to.items.push(item)
      }
    }
  }
  return out
}

// ── sending ─────────────────────────────────────────────────────────────────

export interface ReplayResult {
  sent: number
  held: number
  waiting: number
  /** fl-api still unreachable: sending stopped at the first edit that could not get through. */
  offline: boolean
}

type Sent = "sent" | "held" | "offline" | "blocked"

let running: Promise<ReplayResult> | undefined

/**
 * Send what is waiting, in order. One run at a time per process: a second call while one is
 * running gets the same answer. Stops at the first edit fl-api cannot be reached for — everything
 * after it would fail the same way, and order matters.
 */
export function replay(userId: number): Promise<ReplayResult> {
  if (running) return running
  running = replayOnce(userId).finally(() => {
    running = undefined
  })
  return running
}

async function replayOnce(userId: number): Promise<ReplayResult> {
  let sent = 0
  let offline = false
  // A card with an edit held stops later edits to the same card: they were made on top of it.
  const blocked = new Set<number>()
  for (;;) {
    const o = readOutbox(userId)
    for (const op of o.ops) if (op.state === "held") blocked.add(op.kind === "create" ? op.tempId : op.itemId)
    const op = o.ops.find((x) => x.state === "waiting" && !blocked.has(x.kind === "create" ? x.tempId : x.itemId))
    if (!op) break
    const r = await send(userId, op)
    if (r === "offline") {
      offline = true
      break
    }
    if (r === "sent") sent++
    if (r === "blocked") blocked.add(op.kind === "create" ? op.tempId : op.itemId)
  }
  const c = counts(userId)
  return { sent, held: c.held, waiting: c.waiting, offline }
}

/** Re-read the queue, change one op (or drop it), write it back — the queue may have grown meanwhile. */
function update(userId: number, opId: string, change: ((op: OutboxOp, o: OutboxFile) => void) | "remove") {
  const o = readOutbox(userId)
  const i = o.ops.findIndex((x) => x.id === opId)
  if (i < 0) return
  if (change === "remove") o.ops.splice(i, 1)
  else change(o.ops[i], o)
  writeOutbox(o)
}

function hold(userId: number, opId: string, held: Omit<Held, "at">) {
  update(userId, opId, (op) => {
    op.state = "held"
    op.held = { ...held, at: new Date().toISOString() }
  })
}

async function send(userId: number, op: OutboxOp): Promise<Sent> {
  if (op.kind === "create") {
    const r = await createItem(op.bloqId, op.listId, { title: op.title, ...(op.body ? { body: op.body } : {}) })
    if (r.offline) return "offline"
    if (!r.ok || !r.id) {
      hold(userId, op.id, { kind: "refused", message: r.reason ?? "Atlas did not create this card." })
      return "held"
    }
    // Later edits to the card name it by its temporary id; from now on it has a real one.
    update(userId, op.id, (_op, o) => {
      o.ops = o.ops.filter((x) => x.id !== op.id)
      for (const x of o.ops) if (x.kind !== "create" && x.itemId === op.tempId) x.itemId = r.id!
    })
    return "sent"
  }

  if (op.kind === "move") {
    const r = await moveItem(op.itemId, op.listId, op.position)
    if (r.offline) return "offline"
    if (!r.ok) {
      hold(userId, op.id, { kind: "refused", message: r.reason ?? "Atlas did not move this card." })
      return "held"
    }
    update(userId, op.id, "remove")
    return "sent"
  }

  return sendSave(userId, op)
}

async function putCard(itemId: number, body: Data): Promise<{ status?: number; j: any; rev?: string }> {
  try {
    const res = await irisFetch(`/api/v1/user/bloqs/list/item/${itemId}`, FL_API, { method: "PUT", body: JSON.stringify(body) })
    const j = (await res.json().catch(() => ({}))) as any
    return { status: res.status, j, rev: res.headers.get("x-card-rev") ?? j?.card_rev ?? undefined }
  } catch {
    return { j: {} }
  }
}

/** A save: sent with its base rev; on 409, merged with the card as it is now. */
async function sendSave(userId: number, op: Extract<OutboxOp, { kind: "save" }>): Promise<Sent> {
  let patch = { ...op.patch }
  let rev = op.baseRev
  // Twice at most: once as queued, once merged. A third refusal means the card is being changed
  // right now — hold it rather than race whoever is changing it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await putCard(op.itemId, rev ? { ...patch, base_rev: rev } : patch)
    if (unreachable(r.status)) return "offline"
    if (r.status! >= 200 && r.status! < 300) {
      update(userId, op.id, "remove")
      return "sent"
    }
    if (r.status !== 409 || r.j?.error !== "card_changed") {
      hold(userId, op.id, { kind: "refused", message: apiFailure(r.j, r.status!) })
      return "held"
    }

    // 409: someone changed the card since it was read here.
    const theirsCard: Data = r.j?.data?.current ?? {}
    const keys = Object.keys(patch).filter((k) => k !== "content_merge")
    const pick = (d: Data, ks: string[]) => Object.fromEntries(ks.filter((k) => k in d).map((k) => [k, norm(k, d[k])]))
    const base = pick(op.base, keys)
    const mine = pick(patch, keys)
    const theirs = pick(theirsCard, keys)
    const { conflicts } = merge3(base, mine, theirs)

    // What still needs sending: your value, where it is not already what fl-api has.
    const next: Data = {}
    for (const k of keys) if (!conflicts.includes(k) && canon(mine[k]) !== canon(theirs[k])) next[k] = patch[k]
    if ("content_merge" in patch) next.content_merge = patch.content_merge // fl-api merges a body itself
    rev = r.j?.data?.retry?.base_rev ?? r.rev

    if (conflicts.length > 0) {
      // Fields that do not overlap still land now; the ones that do wait for a person.
      if (Object.keys(next).length > 0) {
        const landed = await putCard(op.itemId, { ...next, base_rev: rev })
        if (unreachable(landed.status)) return "offline"
        if (landed.status! >= 200 && landed.status! < 300) rev = landed.rev ?? rev
      }
      const fields: HeldField[] = conflicts.map((k) => ({
        field: k,
        ...(k in op.base ? { base: op.base[k] } : {}),
        mine: patch[k],
        theirs: theirsCard[k] ?? null,
      }))
      update(userId, op.id, (x) => {
        if (x.kind !== "save") return
        x.patch = Object.fromEntries(conflicts.map((k) => [k, patch[k]]))
        x.state = "held"
        x.held = { kind: "conflict", message: heldMessage(r.j, conflicts), fields, retryRev: rev, at: new Date().toISOString() }
      })
      return "held"
    }

    if (Object.keys(next).length === 0) {
      update(userId, op.id, "remove") // everything you changed is already there
      return "sent"
    }
    patch = next
  }
  hold(userId, op.id, { kind: "conflict", message: "This card kept changing while your edit was being sent. Review it and send again.", fields: [], retryRev: rev })
  return "held"
}

const FIELD_NAMES: Record<string, string> = {
  title: "title",
  content: "description",
  status: "status",
  priority: "priority",
  card_type: "type",
  due_date: "due date",
  bloq_list_id: "list",
}

/** fl-api's sentence says who changed the card; this says which of your fields it touched. */
function heldMessage(j: any, conflicts: string[]): string {
  const by = j?.data?.changed_by
  const who = by?.is_you ? "You changed" : by?.name ? `${by.name} changed` : "Someone changed"
  const names = conflicts.map((k) => FIELD_NAMES[k] ?? k)
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
  return `${who} the ${list} on this card while you were offline. Choose which to keep.`
}

// ── a person decides ────────────────────────────────────────────────────────

/**
 * Settle a held edit. "theirs" drops it — the card stays as fl-api has it. "mine" sends your
 * values against the card as it was when the conflict was found; if it changed again since, it
 * comes back held, with the new values, rather than overwriting a change nobody here has seen.
 */
export async function resolve(userId: number, opId: string, choice: "mine" | "theirs"): Promise<{ ok: boolean; reason?: string; result?: ReplayResult }> {
  const op = readOutbox(userId).ops.find((x) => x.id === opId)
  if (!op) return { ok: false, reason: "That change is no longer waiting." }
  if (choice === "theirs" || op.held?.kind === "refused") {
    update(userId, opId, "remove")
    return { ok: true, result: await replay(userId) }
  }
  update(userId, opId, (x) => {
    x.state = "waiting"
    if (x.kind === "save") {
      // The new base is what you were shown: fl-api's values when the conflict was found.
      for (const f of x.held?.fields ?? []) x.base[f.field] = norm(f.field, f.theirs)
      if (x.held?.retryRev) x.baseRev = x.held.retryRev
    }
    delete x.held
  })
  return { ok: true, result: await replay(userId) }
}

// ── keep trying ─────────────────────────────────────────────────────────────

const timers = new Map<number, ReturnType<typeof setInterval>>()
export const PUMP_MS = 20_000

/** While anything waits, try every PUMP_MS; stop when the queue is empty. Never keeps the process alive. */
export function pump(userId: number) {
  if (timers.has(userId) || counts(userId).waiting === 0) return
  const t = setInterval(() => {
    if (counts(userId).waiting === 0) {
      clearInterval(t)
      timers.delete(userId)
      return
    }
    void replay(userId).catch(() => {})
  }, PUMP_MS)
  ;(t as { unref?: () => void }).unref?.()
  timers.set(userId, t)
}

/** Tests only. */
export function stopPumps() {
  for (const t of timers.values()) clearInterval(t)
  timers.clear()
}
