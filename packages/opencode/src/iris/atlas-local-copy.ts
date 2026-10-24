import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * A LOCAL COPY OF EACH ATLAS BOARD (#190231 phase 1).
 *
 * The board read is a network call to fl-api on every open, so the panel waited on the user's
 * connection before drawing anything, and showed nothing at all offline. Each board's last read
 * is now kept on this machine and served first; the panel then asks again with `fresh=1`, which
 * goes to fl-api and replaces the copy. Offline, the copy is what you see, and the panel says so.
 *
 * What is kept is the LIGHT read (titles, statuses, card faces, previews — no bodies, #190231 0d):
 * enough to draw the board, ~1 MB on the largest board measured. A card you OPEN is kept too, whole,
 * beside its board (#191003): offline, a card you had never opened could not be opened at all, so
 * its notes could not be changed. Card copies follow their board: same rules, removed with it.
 *
 * SETTINGS live in ~/.iris/atlas/local-copy.json so the desktop Settings switch, the CLI and an
 * admin can all change them, and every field can be overridden later without a release:
 *
 *   enabled      true   keep copies at all
 *   includePhi   false  boards fl-api marks contains_phi are NEVER written unless this is true —
 *                       a copy on disk is readable by anything on the machine, unencrypted
 *   maxBoards    20     most recently opened boards kept, per account
 *   maxMB        200    total size kept, per account; least recently opened go first
 *
 * Copies are per ACCOUNT (a folder per user id), owner-only (0700 dirs, 0600 files), and turning
 * the setting off — or a board becoming contains_phi — deletes them rather than leaving them behind.
 */

export interface LocalCopySettings {
  enabled: boolean
  includePhi: boolean
  maxBoards: number
  maxMB: number
}

export const DEFAULT_LOCAL_COPY: LocalCopySettings = { enabled: true, includePhi: false, maxBoards: 20, maxMB: 200 }

export interface BoardCopy<L = unknown> {
  bloqId: number
  userId: number
  copiedAt: string
  containsPhi: boolean
  lists: L[]
  /** fl-api's board version when this copy was taken (#190231 phase 3) — what a refresh asks "changed since?" with. */
  version?: string
}

/** ~/.iris/atlas, or IRIS_ATLAS_HOME (tests). */
export function atlasHome(): string {
  return process.env.IRIS_ATLAS_HOME || path.join(os.homedir(), ".iris", "atlas")
}

const settingsFile = () => path.join(atlasHome(), "local-copy.json")
const accountDir = (userId: number) => path.join(atlasHome(), "cache", String(userId))
const boardFile = (userId: number, bloqId: number) => path.join(accountDir(userId), `${bloqId}.json`)
/** Cards opened on this board, whole (#191003). Not a .json file, so never read as a board. */
const cardsDir = (userId: number, bloqId: number) => path.join(accountDir(userId), "cards", String(bloqId))
const cardFile = (userId: number, bloqId: number, itemId: number) => path.join(cardsDir(userId, bloqId), `${itemId}.json`)

/** A board copy and the cards kept with it go together. */
function removeBoard(userId: number, bloqId: number) {
  fs.rmSync(boardFile(userId, bloqId), { force: true })
  fs.rmSync(cardsDir(userId, bloqId), { recursive: true, force: true })
}
const bloqOf = (file: string) => Number(path.basename(file, ".json"))
/** Edits made with fl-api unreachable, waiting to be sent (#190537 W3, atlas-outbox.ts). */
export const outboxFile = (userId: number) => path.join(atlasHome(), "outbox", `${userId}.json`)

function mkdirPrivate(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/** Unknown or malformed fields fall back to the default for that field, never to "off for everything". */
export function readLocalCopySettings(): LocalCopySettings {
  let raw: any = {}
  try {
    raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8"))
  } catch {}
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d)
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : DEFAULT_LOCAL_COPY.enabled,
    includePhi: typeof raw?.includePhi === "boolean" ? raw.includePhi : DEFAULT_LOCAL_COPY.includePhi,
    maxBoards: num(raw?.maxBoards, DEFAULT_LOCAL_COPY.maxBoards),
    maxMB: num(raw?.maxMB, DEFAULT_LOCAL_COPY.maxMB),
  }
}

/** Merge a change into the settings, write them, and apply what the change means right away. */
export function writeLocalCopySettings(change: Partial<LocalCopySettings>): LocalCopySettings {
  const clean = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined && v !== null))
  const next = { ...readLocalCopySettings(), ...clean } as LocalCopySettings
  mkdirPrivate(atlasHome())
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 })
  // Off means gone, not hidden: a copy nobody can see is still a copy on disk.
  if (!next.enabled) fs.rmSync(path.join(atlasHome(), "cache"), { recursive: true, force: true })
  else if (!next.includePhi) dropPhiCopies()
  else for (const u of accounts()) evict(u, next)
  return next
}

function accounts(): number[] {
  try {
    return fs
      .readdirSync(path.join(atlasHome(), "cache"))
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

function dropPhiCopies() {
  for (const u of accounts()) {
    for (const f of safeList(accountDir(u))) {
      const p = path.join(accountDir(u), f)
      try {
        if (JSON.parse(fs.readFileSync(p, "utf8"))?.containsPhi) removeBoard(u, bloqOf(f))
      } catch {}
    }
  }
}

/** Board copies only — `_boards.json` (the board list) is not a board and is never evicted. */
function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_"))
  } catch {
    return []
  }
}

/** Whether this board may be kept on disk under these settings. */
export function mayKeep(containsPhi: boolean, s: LocalCopySettings = readLocalCopySettings()): boolean {
  return s.enabled && (!containsPhi || s.includePhi)
}

/** The saved copy, or undefined. Reading counts as opening it (most recently opened is kept longest). */
export function readBoardCopy<L>(userId: number, bloqId: number): BoardCopy<L> | undefined {
  const s = readLocalCopySettings()
  if (!s.enabled) return undefined
  const p = boardFile(userId, bloqId)
  try {
    const c = JSON.parse(fs.readFileSync(p, "utf8")) as BoardCopy<L>
    // A copy written before the board was marked contains_phi, or before includePhi was turned
    // off, is never served — and is removed.
    if (c.userId !== userId || c.bloqId !== bloqId || !mayKeep(!!c.containsPhi, s)) {
      removeBoard(userId, bloqId)
      return undefined
    }
    const now = new Date()
    fs.utimesSync(p, now, now)
    return c
  } catch {
    return undefined
  }
}

/** Save (or, when the board may not be kept, delete) the copy for this board. */
export function writeBoardCopy<L>(userId: number, bloqId: number, containsPhi: boolean, lists: L[], version?: string): boolean {
  const s = readLocalCopySettings()
  const p = boardFile(userId, bloqId)
  if (!mayKeep(containsPhi, s)) {
    removeBoard(userId, bloqId)
    return false
  }
  mkdirPrivate(accountDir(userId))
  const copy: BoardCopy<L> = { bloqId, userId, copiedAt: new Date().toISOString(), containsPhi, lists, ...(version ? { version } : {}) }
  // Write then rename: a crash mid-write must not leave a half file that reads as "no lists".
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(copy), { mode: 0o600 })
  fs.renameSync(tmp, p)
  evict(userId, s, p)
  return true
}

/**
 * The BOARD LIST, kept beside the boards: offline, the panel could not draw any board without it
 * (it showed "Could not reach IRIS" and stopped). Names and ids only — no card data.
 */
const boardListFile = (userId: number) => path.join(accountDir(userId), "_boards.json")

export function writeBoardListCopy<B>(userId: number, bloqs: B[]) {
  if (!readLocalCopySettings().enabled) return
  mkdirPrivate(accountDir(userId))
  const tmp = `${boardListFile(userId)}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ userId, copiedAt: new Date().toISOString(), bloqs }), { mode: 0o600 })
  fs.renameSync(tmp, boardListFile(userId))
}

export function readBoardListCopy<B>(userId: number): { copiedAt: string; bloqs: B[] } | undefined {
  if (!readLocalCopySettings().enabled) return undefined
  try {
    const c = JSON.parse(fs.readFileSync(boardListFile(userId), "utf8"))
    return c?.userId === userId && Array.isArray(c.bloqs) ? { copiedAt: String(c.copiedAt), bloqs: c.bloqs } : undefined
  } catch {
    return undefined
  }
}

/** Remove this board's copy (fl-api refused it: access revoked, board deleted). */
export function deleteBoardCopy(userId: number, bloqId: number) {
  removeBoard(userId, bloqId)
}

/** Boards with edits still waiting in the outbox: their copy is what those edits are drawn on. */
function boardsWithWaitingEdits(userId: number): Set<string> {
  try {
    const o = JSON.parse(fs.readFileSync(outboxFile(userId), "utf8"))
    return new Set((o?.ops ?? []).map((op: { bloqId?: number }) => `${op.bloqId}.json`))
  } catch {
    return new Set()
  }
}

/**
 * Keep the most recently opened boards within maxBoards and maxMB for this account.
 *
 * Two copies are never evicted (#190537 S8, W3): `keep`, the board just written — a board larger
 * than the whole budget used to be deleted the moment it was saved, so the one board on screen was
 * the one with no copy — and any board with edits waiting to be sent.
 */
export function evict(userId: number, s: LocalCopySettings = readLocalCopySettings(), keep?: string) {
  const dir = accountDir(userId)
  const pinned = boardsWithWaitingEdits(userId)
  const files = safeList(dir)
    .filter((f) => !pinned.has(f))
    .map((f) => {
      const p = path.join(dir, f)
      try {
        const st = fs.statSync(p)
        return { p, at: st.mtimeMs, size: st.size + cardsSize(userId, bloqOf(f)) }
      } catch {
        return undefined
      }
    })
    .filter((x): x is { p: string; at: number; size: number } => !!x)
    // The board just written is the newest, even when another was written in the same millisecond.
    .sort((a, b) => Number(b.p === keep) - Number(a.p === keep) || b.at - a.at)
  const budget = s.maxMB * 1024 * 1024
  let used = 0
  files.forEach((f, i) => {
    used += f.size
    if (f.p === keep) return
    if (i >= s.maxBoards || used > budget) removeBoard(userId, bloqOf(f.p))
  })
}

/**
 * Which kept board holds this card, and the card as last read (#190537 W3). Read without touching
 * the file's time: looking a card up is not opening its board. A copy that may not be kept is not
 * an answer — the same rule readBoardCopy applies.
 */
export function findCardInCopies<I extends { id: number }>(
  userId: number,
  itemId: number,
): { bloqId: number; containsPhi: boolean; copiedAt: string; listId: number; listName?: string; item: I } | undefined {
  const s = readLocalCopySettings()
  if (!s.enabled) return undefined
  for (const f of safeList(accountDir(userId))) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(accountDir(userId), f), "utf8")) as BoardCopy<{ id: number; name?: string; items?: I[] }>
      if (c.userId !== userId || !mayKeep(!!c.containsPhi, s)) continue
      for (const l of c.lists ?? []) {
        const item = (l.items ?? []).find((i) => i.id === itemId)
        if (item) return { bloqId: c.bloqId, containsPhi: !!c.containsPhi, copiedAt: c.copiedAt, listId: l.id, listName: l.name, item }
      }
    } catch {}
  }
  return undefined
}

function cardsSize(userId: number, bloqId: number): number {
  let n = 0
  try {
    for (const f of fs.readdirSync(cardsDir(userId, bloqId))) n += fs.statSync(path.join(cardsDir(userId, bloqId), f)).size
  } catch {}
  return n
}

export interface CardCopy<D> {
  itemId: number
  bloqId: number
  userId: number
  copiedAt: string
  doc: D
}

/**
 * Keep a card as it was just read (#191003). Only a card whose board is kept here: the board copy
 * is what says the board may be on disk at all (patient data, settings), and what removes it.
 */
export function writeCardCopy<D>(userId: number, itemId: number, doc: D): boolean {
  const found = findCardInCopies(userId, itemId)
  if (!found) return false
  const dir = cardsDir(userId, found.bloqId)
  mkdirPrivate(dir)
  const p = cardFile(userId, found.bloqId, itemId)
  const copy: CardCopy<D> = { itemId, bloqId: found.bloqId, userId, copiedAt: new Date().toISOString(), doc }
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(copy), { mode: 0o600 })
  fs.renameSync(tmp, p)
  return true
}

/** The card as last read whole, if its board is still kept here. */
export function readCardCopy<D>(userId: number, bloqId: number, itemId: number): CardCopy<D> | undefined {
  try {
    const c = JSON.parse(fs.readFileSync(cardFile(userId, bloqId, itemId), "utf8")) as CardCopy<D>
    return c.userId === userId && c.itemId === itemId && c.bloqId === bloqId ? c : undefined
  } catch {
    return undefined
  }
}

/** fl-api refused this card (deleted, access gone): it is not kept, on any board. */
export function deleteCardCopy(userId: number, itemId: number) {
  let boards: string[] = []
  try {
    boards = fs.readdirSync(path.join(accountDir(userId), "cards"))
  } catch {}
  for (const b of boards) fs.rmSync(path.join(accountDir(userId), "cards", b, `${itemId}.json`), { force: true })
}
