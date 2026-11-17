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
  matches,
  moveSelection,
  neverScanned,
  scanCommand,
  statusTone,
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
    expect(driveMeta(drive())).toBe("4.1 GB of 15.4 GB · encrypted · scanned Nov 9")
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

  test("the scan command quotes the label", () => {
    expect(scanCommand(drive({ label: "Hive archive" }))).toBe('iris drives scan "Hive archive"')
  })
})
