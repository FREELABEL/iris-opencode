import { describe, expect, test } from "bun:test"
import {
  baseName,
  dirName,
  driveMeta,
  emptyDrive,
  findingsUnder,
  fmtDate,
  fmtGb,
  fmtKb,
  maskedFindingMeta,
  maskedName,
  matches,
  moveSelection,
  neverScanned,
  onDrive,
  scanCommand,
  statusTone,
  usedOf,
  type Drive,
  type DriveFinding,
} from "./iris-drives-model"
import { panelScope } from "./iris-panel-nav"
import { IRIS_PANEL_CATALOG } from "./session-iris-tab"

const drive = (over: Partial<Drive> = {}): Drive => ({
  id: "fs:a",
  label: "BK-01",
  kind: "backup-drive",
  node: "iris-hive-001",
  encrypted: true,
  sizeGb: 15.4,
  usedGb: 4.1,
  freeGb: 10.4,
  files: 11,
  folders: 1,
  sensitiveFiles: 6,
  lastScanned: "2026-11-09",
  lastSeenOn: "iris-hive-001",
  lastSeenAt: null,
  lastBackupAt: null,
  ...over,
})
const finding = (path: string, status = "contained"): DriveFinding => ({
  id: path,
  driveId: "fs:a",
  path,
  kind: "db-dump",
  sizeKb: 1,
  status,
  found: "2026-11-09",
  driveEncrypted: true,
})

describe("Drives (#193705)", () => {
  test("is a product tab, account-wide", () => {
    expect(IRIS_PANEL_CATALOG.find((s) => s.id === "drives")?.label).toBe("Drives")
    expect(panelScope("drives", "drives")).toBe("account")
  })

  test("sizes read in the unit a person would say; unknown is a dash, never zero", () => {
    expect(fmtGb(4.13)).toBe("4.1 GB")
    expect(fmtGb(5500)).toBe("5.5 TB")
    expect(fmtGb(0.166)).toBe("166 MB")
    expect(fmtGb(null)).toBe("—")
    expect(fmtKb(1174242.2)).toBe("1.2 GB")
    expect(fmtKb(10)).toBe("10 KB")
  })

  test("dates: short this year, with the year otherwise; no timezone shift", () => {
    const now = new Date("2026-11-17T12:00:00Z")
    expect(fmtDate("2026-11-09", now)).toBe("Nov 9")
    expect(fmtDate("2016-08-06", now)).toBe("Aug 6, 2016")
    expect(fmtDate("2026-01-01T00:30:00-08:00", now)).toBe("Jan 1")
    expect(fmtDate(null, now)).toBe("—")
  })

  test("a folder's findings are the ones under its path — not a sibling with the same prefix", () => {
    const all = [
      finding("_IRIS_WORK/backups/db/a.sql.gz"),
      finding("_IRIS_WORK/backups-old/b.sql.gz"),
      finding("_LEGACY/x.sql"),
    ]
    expect(findingsUnder("_IRIS_WORK/backups", all).map((f) => f.path)).toEqual(["_IRIS_WORK/backups/db/a.sql.gz"])
    expect(findingsUnder("_IRIS_WORK/backups/", all)).toHaveLength(1)
  })

  test("status is a tone: exposed is bad, contained good, anything else quiet", () => {
    expect(statusTone("exposed")).toBe("bad")
    expect(statusTone("contained")).toBe("good")
    expect(statusTone("moved")).toBe("muted")
    expect(statusTone(null)).toBe("muted")
  })

  test("never-scanned and empty are different states", () => {
    expect(neverScanned(drive({ lastScanned: null }))).toBe(true)
    expect(driveMeta(drive({ lastScanned: null }))).toBe("never scanned")
    expect(emptyDrive(drive({ lastScanned: null, files: 0 }), [])).toBe(false)
    expect(emptyDrive(drive({ files: 0 }), [])).toBe(true)
    expect(emptyDrive(drive(), [])).toBe(false)
    expect(driveMeta(drive())).toBe(`4.1 / 15.4 GB · encrypted · ${fmtDate("2026-11-09")}`)
    expect(usedOf(0.5, 15.4)).toBe("500 MB / 15.4 GB")
    expect(usedOf(4100, 6000)).toBe("4.1 / 6 TB")
  })

  test("arrow keys clamp; from nothing, Down picks the first and Up the last", () => {
    expect(moveSelection(-1, 1, 5)).toBe(0)
    expect(moveSelection(-1, -1, 5)).toBe(4)
    expect(moveSelection(4, 1, 5)).toBe(4)
    expect(moveSelection(0, -1, 5)).toBe(0)
    expect(moveSelection(2, 1, 0)).toBe(-1)
  })

  test("search needs every word; paths split into name and folder", () => {
    expect(matches("db 2026", "_IRIS_WORK/backups/db/2026-11-08/x.sql.gz")).toBe(true)
    expect(matches("db 2025", "_IRIS_WORK/backups/db/2026-11-08/x.sql.gz")).toBe(false)
    expect(matches("  ", "anything")).toBe(true)
    expect(baseName("a/b/c.sql")).toBe("c.sql")
    expect(dirName("a/b/c.sql")).toBe("a/b")
    expect(dirName("c.sql")).toBe("")
  })

  test("a finding counts only while it is on the drive (#193813)", () => {
    // Measured on BK-03: 368 contained + 14 moved = 382 records; the drive's own count is 368.
    const all = [...Array(368)].map((_, i) => finding(`a/${i}`, "contained")).concat([...Array(14)].map((_, i) => finding(`b/${i}`, "moved")))
    expect(all.filter(onDrive)).toHaveLength(drive({ sensitiveFiles: 368 }).sensitiveFiles!)
    expect(onDrive(finding("x", "exposed"))).toBe(true)
    expect(onDrive(finding("x", "moved"))).toBe(false)
  })

  test("hidden names show the kind, never the name or the folder (#193817)", () => {
    const f = finding("_IRIS_WORK/backups/db/2026-11-08/.env.production", "exposed")
    expect(maskedName("file", f.kind)).toBe("Hidden db-dump file")
    expect(maskedName("folder", "video")).toBe("Hidden folder · mostly video")
    expect(maskedName("file", null)).toBe("Hidden file")
    const meta = maskedFindingMeta(f)
    expect(meta).not.toContain("_IRIS_WORK")
    expect(meta).not.toContain(".env")
  })

  test("the scan command quotes the label", () => {
    expect(scanCommand(drive({ label: "Hive archive" }))).toBe('iris drives scan "Hive archive"')
  })
})
