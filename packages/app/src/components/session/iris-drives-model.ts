/**
 * Drives (#193705) — the pure half of the Drives tab: formatting, scoping and keyboard selection, kept
 * out of the component so it is testable without mounting the panel.
 *
 * The shapes mirror packages/opencode/src/iris/drives.ts field for field; the route Schema declares
 * the same names, so the panel never reads a field the engine did not send.
 */

export interface Drive {
  id: string
  label: string
  kind: string | null
  node: string | null
  encrypted: boolean
  sizeGb: number | null
  usedGb: number | null
  freeGb: number | null
  files: number | null
  folders: number | null
  sensitiveFiles: number | null
  lastScanned: string | null
  lastSeenOn: string | null
  lastSeenAt: string | null
  lastBackupAt: string | null
}

export interface DriveFolder {
  id: string
  driveId: string
  folder: string
  mainKind: string | null
  kinds: string | null
  files: number | null
  sizeGb: number | null
  newest: string | null
  sensitiveFiles: number | null
}

export interface DriveFinding {
  id: string
  driveId: string
  path: string
  kind: string | null
  sizeKb: number | null
  status: string | null
  found: string | null
  driveEncrypted: boolean
}

export type DrivesState = "ok" | "signed_out" | "no_datasets" | "unreachable"
export interface DrivesPayload {
  measured: boolean
  reason?: string
  state: DrivesState
  drives: Drive[]
  folders: DriveFolder[]
}
export interface FindingsPayload {
  measured: boolean
  reason?: string
  findings: DriveFinding[]
  page: number
  total: number | null
  hasMore: boolean
}

/** The deep view, opened from the header's ↗. The panel is the tab, not a replacement. */
export const FULL_PAGE_URL = "https://heyiris.io/p/iris-drives-files"

export type Segment = "folders" | "findings" | "info"

/** Sizes in the unit a person would say: 166 MB, 4.1 GB, 5.5 TB. Null stays a dash, never "0". */
export function fmtGb(gb: number | null | undefined): string {
  if (gb == null || !Number.isFinite(gb)) return "—"
  if (gb >= 1000) return `${trim(gb / 1000)} TB`
  if (gb >= 1) return `${trim(gb)} GB`
  const mb = gb * 1000
  if (mb >= 1) return `${Math.round(mb)} MB`
  return `${Math.max(1, Math.round(mb * 1000))} KB`
}
export function fmtKb(kb: number | null | undefined): string {
  if (kb == null || !Number.isFinite(kb)) return "—"
  return fmtGb(kb / 1_000_000)
}
const trim = (n: number) => (n >= 100 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, ""))

export function fmtCount(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US")
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
/** "Nov 9" this year, "Aug 6, 2016" otherwise. Reads the date part only — no timezone shift. */
export function fmtDate(iso: string | null | undefined, now = new Date()): string {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return "—"
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const md = `${MONTHS[mo - 1]} ${d}`
  return y === now.getFullYear() ? md : `${md}, ${y}`
}

/** The last segment of a path — what a row shows on its first line. */
export const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p
/** Everything before the last segment. */
export const dirName = (p: string) => {
  const i = p.replace(/\/+$/, "").lastIndexOf("/")
  return i > 0 ? p.slice(0, i) : ""
}

/** Findings are read 200 at a time, up to this many pages per drive (10,000). The footer says when it stops. */
export const FINDINGS_PER_PAGE = 200
export const MAX_FINDING_PAGES = 50

/** Still on the drive. A `moved` finding was found by an earlier scan and is gone now (#193813). */
export const onDrive = (f: DriveFinding) => f.status !== "moved"

export type Tone = "bad" | "good" | "muted"
/** exposed = on an unencrypted drive, anyone with the drive can read it; contained = encrypted; moved = gone. */
export function statusTone(status: string | null | undefined): Tone {
  if (status === "exposed") return "bad"
  if (status === "contained") return "good"
  return "muted"
}

export function neverScanned(d: Drive): boolean {
  return !d.lastScanned
}

/** Scanned, and nothing catalogued on it. */
export function emptyDrive(d: Drive, folders: DriveFolder[]): boolean {
  return !neverScanned(d) && (d.files ?? 0) === 0 && folders.length === 0
}

export function driveMeta(d: Drive): string {
  if (neverScanned(d)) return "never scanned"
  return [usedOf(d.usedGb, d.sizeGb), d.encrypted ? "encrypted" : "not encrypted", fmtDate(d.lastScanned)].join(" · ")
}

/** "4.1 / 15.4 GB" — one unit when both share it, so the line fits at 360px. */
export function usedOf(used: number | null, size: number | null): string {
  if (used == null || size == null) return fmtGb(size)
  const [u, s] = [fmtGb(used), fmtGb(size)]
  const unit = (x: string) => x.split(" ")[1]
  return unit(u) === unit(s) ? `${u.split(" ")[0]} / ${s}` : `${u} / ${s}`
}

export function folderMeta(f: DriveFolder): string {
  return [`${fmtCount(f.files)} files`, fmtGb(f.sizeGb), f.newest ? `newest ${fmtDate(f.newest)}` : null].filter(Boolean).join(" · ")
}

export function findingMeta(f: DriveFinding): string {
  return [f.kind, fmtKb(f.sizeKb), dirName(f.path) || null].filter(Boolean).join(" · ")
}

export function foldersOf(driveId: string, folders: DriveFolder[]): DriveFolder[] {
  return folders.filter((f) => f.driveId === driveId)
}

/** A folder's findings: the drive's findings whose path sits under the folder. */
export function findingsUnder(folder: string, findings: DriveFinding[]): DriveFinding[] {
  const prefix = folder.replace(/\/+$/, "") + "/"
  return findings.filter((f) => f.path.startsWith(prefix))
}

export function countBy(findings: DriveFinding[], status: string): number {
  return findings.reduce((n, f) => n + (f.status === status ? 1 : 0), 0)
}

/** Case-insensitive, every word must appear somewhere in the text. */
export function matches(query: string, ...text: (string | null | undefined)[]): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = text.filter(Boolean).join(" ").toLowerCase()
  return words.every((w) => hay.includes(w))
}

/** Arrow-key selection: clamps at the ends; from nothing selected, Down picks the first and Up the last. */
export function moveSelection(current: number, delta: number, length: number): number {
  if (length <= 0) return -1
  if (current < 0) return delta > 0 ? 0 : length - 1
  return Math.min(length - 1, Math.max(0, current + delta))
}

/** The command a person runs to (re)scan a drive. Quoted, because labels have spaces. */
export function scanCommand(d?: Drive): string {
  return d ? `iris drives scan "${d.label}"` : "iris drives scan <path-to-drive>"
}
