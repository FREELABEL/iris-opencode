import { FL_API, irisFetch, resolveUserId, tokenSource } from "./platform"

/**
 * Drives (#193705) — the Desktop face of `iris drives`: the person's catalogued drives, the project
 * folders on each, and the sensitive files a scan found.
 *
 * ATLAS IS THE ONLY SOURCE. A path is valid only on the machine its drive is plugged into, so this
 * never touches the filesystem and never fetches a file by path — it reads the three datasets the
 * scanner writes (`drives`, `drive-folders`, `drive-findings`), exactly as the CLI does.
 *
 * ONE BOARD FOR ALL THREE: THE DRIVES BOARD. Records are filed under the board the scanner wrote
 * them to, which is the board the `drives` schema lives on — NOT the board a schema row claims.
 * Measured 2026-11-17: the `drive-findings` schema says board 913, yet the real findings are filed
 * under 905 (the Drives board), and asking with 913 returned 2 stray test rows instead of 838. The
 * CLI (`platform-drives.ts` atlasRecords) reads all three with the Drives board; so does this.
 *
 * FINDINGS ARE NOT IN THE FIRST PAYLOAD. One drive held 838 of them; the panel's first paint must not
 * wait on that. They are asked for per drive, filtered upstream (`filter[drive_id]`), one page at a time.
 *
 * Every field the panel reads is named here and in the route Schema; Effect Schema drops what it was
 * not told about (PR #459). Values are coerced here, so a type change upstream is a null on screen.
 */

export const DRIVE_SLUGS = { drives: "drives", folders: "drive-folders", findings: "drive-findings" } as const

export interface DriveRow {
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

export interface DriveFolderRow {
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

export interface DriveFindingRow {
  id: string
  driveId: string
  path: string
  kind: string | null
  sizeKb: number | null
  status: string | null
  found: string | null
  driveEncrypted: boolean
}

/**
 * Why there is nothing to show, when there is nothing. The panel draws one state per value, each with
 * its own copy and action — "0 drives" must never stand in for "we could not ask".
 *   ok          — read; `drives` may still be empty (no scan yet on this account)
 *   signed_out  — no IRIS credential on this machine
 *   no_datasets — signed in, but this account has never run `iris drives scan`
 *   unreachable — the platform did not answer
 */
export type DrivesState = "ok" | "signed_out" | "no_datasets" | "unreachable"

export interface DrivesPayload {
  measured: boolean
  reason?: string
  state: DrivesState
  drives: DriveRow[]
  folders: DriveFolderRow[]
}

export interface DriveFindingsPayload {
  measured: boolean
  reason?: string
  findings: DriveFindingRow[]
  page: number
  total: number | null
  hasMore: boolean
}

/** Swappable in tests. fl-api is never called for real from a unit test. */
export const driveDeps = {
  fetch: (path: string) => irisFetch(path, FL_API),
  userId: () => resolveUserId(),
}

const str = (v: unknown): string | null =>
  typeof v === "string" ? (v.trim() === "" ? null : v) : typeof v === "number" ? String(v) : null
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) ? n : null
}
const bool = (v: unknown): boolean => v === true || v === 1 || v === "1" || v === "true"

/** A record's fields live under `data`; its external id is on the row. */
const fieldsOf = (r: any): Record<string, unknown> => (r?.data && typeof r.data === "object" ? r.data : {})
const extId = (r: any): string => str(r?.external_id) ?? str(fieldsOf(r).external_id) ?? String(r?.id ?? "")

export function readDrive(r: any): DriveRow {
  const d = fieldsOf(r)
  const id = extId(r)
  return {
    id,
    label: str(d.label) ?? id,
    kind: str(d.kind),
    node: str(d.node),
    encrypted: bool(d.encrypted),
    sizeGb: num(d.size_gb),
    usedGb: num(d.used_gb),
    freeGb: num(d.free_gb),
    files: num(d.files),
    folders: num(d.folders),
    sensitiveFiles: num(d.sensitive_files),
    lastScanned: str(d.last_scanned),
    lastSeenOn: str(d.last_seen_on),
    lastSeenAt: str(d.last_seen_at),
    lastBackupAt: str(d.last_backup_at),
  }
}

export function readFolder(r: any): DriveFolderRow {
  const d = fieldsOf(r)
  return {
    id: extId(r),
    driveId: str(d.drive_id) ?? "",
    folder: str(d.folder) ?? "",
    mainKind: str(d.main_kind),
    kinds: str(d.kinds),
    files: num(d.files),
    sizeGb: num(d.size_gb),
    newest: str(d.newest),
    sensitiveFiles: num(d.sensitive_files),
  }
}

export function readFinding(r: any): DriveFindingRow {
  const d = fieldsOf(r)
  return {
    id: extId(r),
    driveId: str(d.drive_id) ?? "",
    path: str(d.path) ?? "",
    kind: str(d.kind),
    sizeKb: num(d.size_kb),
    status: str(d.status),
    found: str(d.found),
    driveEncrypted: bool(d.drive_encrypted),
  }
}

/** Which drive datasets exist, and the Drives board (the `drives` schema's) they are read under. */
async function driveSchemas(): Promise<{ has: Set<string>; board: number | null }> {
  const res = await driveDeps.fetch(`/api/v1/atlas/schemas`)
  if (!res.ok) throw new Error(`fl-api ${res.status}`)
  const json = (await res.json()) as any
  const raw = json?.schemas ?? json?.data ?? json
  const has = new Set<string>()
  let board: number | null = null
  for (const r of Array.isArray(raw) ? raw : []) {
    const slug = String(r?.slug ?? "")
    if (!Object.values(DRIVE_SLUGS).includes(slug as any)) continue
    has.add(slug)
    if (slug === DRIVE_SLUGS.drives) board = num(r?.bloq_id)
  }
  return { has, board }
}

function recordsQuery(bloq: number | null | undefined, page: number, perPage: number, filters: Record<string, string> = {}) {
  const p = new URLSearchParams({ per_page: String(perPage), page: String(page) })
  if (bloq != null) p.set("bloq_id", String(bloq))
  for (const [k, v] of Object.entries(filters)) p.set(`filter[${k}]`, v)
  return p
}

async function recordsPage(slug: string, bloq: number | null | undefined, page: number, perPage: number, filters?: Record<string, string>) {
  const res = await driveDeps.fetch(`/api/v1/atlas/datasets/${slug}?${recordsQuery(bloq, page, perPage, filters)}`)
  if (!res.ok) throw new Error(`reading ${slug}: fl-api ${res.status}`)
  const body = (await res.json()) as any
  const recs = body?.data?.records ?? body?.records
  const rows: any[] = Array.isArray(recs?.data) ? recs.data : Array.isArray(recs) ? recs : []
  const total = num(recs?.total)
  return { rows, total }
}

/** Every record of a small dataset (drives, folders). Capped so a runaway dataset cannot hang the panel. */
async function allRecords(slug: string, bloq: number | null | undefined, maxPages = 10): Promise<any[]> {
  const out: any[] = []
  for (let page = 1; page <= maxPages; page++) {
    const { rows, total } = await recordsPage(slug, bloq, page, 200)
    out.push(...rows)
    if (rows.length === 0 || (total != null ? out.length >= total : rows.length < 200)) break
  }
  return out
}

const signedOut = async (): Promise<string | null> =>
  (await driveDeps.userId()) ? null : `not signed in (token: ${tokenSource()})`

export async function fetchDrives(): Promise<DrivesPayload> {
  const empty = { drives: [] as DriveRow[], folders: [] as DriveFolderRow[] }
  const out = await signedOut().catch(() => "not signed in")
  if (out) return { measured: false, reason: out, state: "signed_out", ...empty }
  try {
    const { has, board } = await driveSchemas()
    if (!has.has(DRIVE_SLUGS.drives)) {
      return { measured: true, reason: "no drive has been scanned on this account", state: "no_datasets", ...empty }
    }
    const [driveRecs, folderRecs] = await Promise.all([
      allRecords(DRIVE_SLUGS.drives, board),
      has.has(DRIVE_SLUGS.folders) ? allRecords(DRIVE_SLUGS.folders, board) : Promise.resolve([]),
    ])
    const drives = driveRecs.map(readDrive).sort((a, b) => a.label.localeCompare(b.label))
    const folders = folderRecs.map(readFolder).sort((a, b) => (b.sizeGb ?? 0) - (a.sizeGb ?? 0))
    return { measured: true, state: "ok", drives, folders }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), state: "unreachable", ...empty }
  }
}

export async function fetchDriveFindings(driveId: string, page = 1, perPage = 100): Promise<DriveFindingsPayload> {
  const p = Math.max(1, Math.floor(page) || 1)
  const pp = Math.min(200, Math.max(1, Math.floor(perPage) || 100))
  const empty = { findings: [] as DriveFindingRow[], page: p, total: null, hasMore: false }
  const out = await signedOut().catch(() => "not signed in")
  if (out) return { measured: false, reason: out, ...empty }
  try {
    const { has, board } = await driveSchemas()
    if (!has.has(DRIVE_SLUGS.findings)) return { measured: true, ...empty, total: 0 }
    const { rows, total } = await recordsPage(DRIVE_SLUGS.findings, board, p, pp, { drive_id: driveId })
    // The filter is applied upstream; this is a second guard so one drive's findings never list under another.
    const findings = rows.map(readFinding).filter((f) => f.driveId === driveId)
    return {
      measured: true,
      findings,
      page: p,
      total,
      hasMore: total != null ? p * pp < total : rows.length >= pp,
    }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), ...empty }
  }
}
