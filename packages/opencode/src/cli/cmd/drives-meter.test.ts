import { describe, test, expect } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { meterFields, meterMonth, usageReport, METER_FIELDS, DRIVES_DATASETS } from "./drives-core"
import { uploadManifest, formatUsage, formatBytes } from "./platform-drives"

/**
 * #193356 — the meter lives on the drive's own Atlas record, written by every scan, so billing
 * never depends on analytics consent. These are the fields and the arithmetic.
 */
const NOW = new Date("2026-11-12T15:00:00Z")
const s = (o: Partial<Parameters<typeof meterFields>[1]> = {}) => ({
  files: 60072, bytes: 2_982_000_000_000, manifestBytes: 812_345, durationMs: 179_412.4, version: "iris-cli/1.5.50", now: NOW, ...o,
})

describe("meterFields — what each scan writes onto the drive record", () => {
  test("a new drive: first scan, every meter field present", () => {
    expect(meterFields(undefined, s())).toEqual({
      scan_count: 1, scan_month: "2026-11", scans_in_month: 1, last_scan_ms: 179412,
      files_cataloged: 60072, bytes_cataloged: 2_982_000_000_000, manifest_bytes: 812_345, scanned_by_version: "iris-cli/1.5.50",
    })
  })

  test("a re-scan in the same month counts up both totals", () => {
    const prev = { last_scanned: "2026-11-10", scan_count: 4, scan_month: "2026-11", scans_in_month: 2 }
    expect(meterFields(prev, s())).toMatchObject({ scan_count: 5, scans_in_month: 3 })
  })

  test("a new month starts the month's count again, the total keeps going", () => {
    const prev = { last_scanned: "2026-10-30", scan_count: 9, scan_month: "2026-10", scans_in_month: 6 }
    expect(meterFields(prev, s())).toMatchObject({ scan_count: 10, scan_month: "2026-11", scans_in_month: 1 })
  })

  test("a drive scanned before the meter existed: that scan counts as one", () => {
    expect(meterFields({ last_scanned: "2026-11-09", files: 422 }, s())).toMatchObject({ scan_count: 2, scans_in_month: 2 })
    expect(meterFields({ last_scanned: "2026-10-01" }, s())).toMatchObject({ scan_count: 2, scans_in_month: 1 })
  })

  test("numbers that came back from Atlas as strings still count", () => {
    expect(meterFields({ last_scanned: "2026-11-01", scan_count: "7", scan_month: "2026-11", scans_in_month: "3" }, s()))
      .toMatchObject({ scan_count: 8, scans_in_month: 4 })
  })

  test("a failed manifest upload leaves manifest_bytes out, so the merge keeps the stored list's size", () => {
    const m = meterFields({ manifest_bytes: 700_000 }, s({ manifestBytes: null }))
    expect("manifest_bytes" in m).toBe(false)
  })

  test("the month is UTC, so two machines agree", () => {
    expect(meterMonth(new Date("2026-11-30T23:30:00-08:00"))).toBe("2026-12")
  })

  test("new Drives boards get the meter fields on the drives dataset", () => {
    const keys = DRIVES_DATASETS.find((d) => d.slug === "drives")!.fields.map((f: any) => f.key)
    for (const f of METER_FIELDS) expect(keys).toContain(f.key)
    expect(Object.keys(meterFields(undefined, s())).sort()).toEqual(METER_FIELDS.map((f) => f.key).sort())
  })
})

describe("uploadManifest reports the stored size", () => {
  test("bytes = the size of the encrypted file Atlas holds", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-drives-meter-"))
    const tsv = path.join(dir, "files.tsv")
    fs.writeFileSync(tsv, "path\tbytes\tmodified\tkind\n" + "a.wav\t1\t\taudio\n".repeat(500))
    let uploaded = 0
    const r = await uploadManifest({
      upload: async (p) => { uploaded = fs.statSync(p).size; return { ok: true, id: 11, verified: true } },
      list: async () => ({ ok: true, files: [] }),
      remove: async () => {},
    }, "fs:abc", tsv, "2026-11-12")
    expect(r.bytes).toBe(uploaded)
    expect(r.bytes!).toBeGreaterThan(0)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// ── iris drives usage ────────────────────────────────────────────────────────────

const drives = [
  // metered drive, scanned twice this month
  { external_id: "fs:a", label: "Redwalrus", last_scanned: "2026-11-12", files: 60072, used_gb: 4148, files_cataloged: 60072,
    bytes_cataloged: 2_982_000_000_000, manifest: "atlas-file:2277", manifest_bytes: 812_345, scan_count: 5, scan_month: "2026-11", scans_in_month: 2 },
  // scanned before metering, this month; size from the attachment
  { external_id: "fs:b", label: "BK-03", last_scanned: "2026-11-09", files: 422, used_gb: 14.7, manifest: "atlas-file:2278" },
  // scanned before metering, last month
  { external_id: "dir:h:/x", label: "Hive archive", last_scanned: "2026-10-20", files: 21025, used_gb: 13.4, manifest: "" },
]
const reads = [
  { at: "2026-11-11T10:00:00Z", bytes: 48213, path: "secret/brief.pdf" },
  { at: "2026-11-02T10:00:00Z", bytes: 1_000_000 },
  { at: "2026-10-31T23:59:59Z", bytes: 5 },
]
const findings = [
  ...Array.from({ length: 380 }, () => ({ status: "contained" })),
  ...Array.from({ length: 292 }, () => ({ status: "exposed" })),
  { status: "moved" },
]

describe("usageReport — everything from Atlas", () => {
  const u = usageReport({ drives, reads, findings, attachments: [{ id: 2277, size: 812_400 }, { id: 2278, size: 9_100 }], now: NOW })

  test("adds the meter up across drives", () => {
    expect(u).toEqual({
      month: "2026-11", drives: 3, files: 60072 + 422 + 21025,
      bytes: 2_982_000_000_000 + 14_700_000_000 + 13_400_000_000, bytes_estimated_drives: 2,
      manifest_bytes: 812_400 + 9_100,
      scans_this_month: 2 + 1, scans_total: 5 + 1 + 1,
      gets_this_month: 2, get_bytes_this_month: 1_048_213,
      sensitive_contained: 380, sensitive_exposed: 292,
    })
  })

  test("reads that could not be loaded say so instead of claiming zero", () => {
    expect(usageReport({ drives, reads: null, findings: [], attachments: [], now: NOW }).gets_this_month).toBeNull()
  })

  test("the plain-language summary", () => {
    const text = formatUsage(u).join("\n").replace(/\x1b\[[0-9;]*m/g, "")
    expect(text).toContain("IRIS Drives usage — November 2026")
    expect(text).toMatch(/Drives cataloged\s+3/)
    expect(text).toMatch(/Files cataloged\s+81,519 files · 3\.0 TB/)
    expect(text).toMatch(/Encrypted file lists stored\s+821\.5 KB/)
    expect(text).toMatch(/Scans this month\s+3 {2}\(7 in all\)/)
    expect(text).toMatch(/Files copied \(get\) this month\s+2 · 1 MB/)
    expect(text).toMatch(/Sensitive files protected\s+380 files on encrypted drives · 292 files on drives that are NOT encrypted/)
    // usage never prints a path or a drive's name
    expect(text).not.toContain("Redwalrus")
    expect(text).not.toContain("brief.pdf")
  })

  test("formatBytes keeps small sizes readable", () => {
    expect(formatBytes(512)).toBe("512 bytes")
    expect(formatBytes(9_100)).toBe("9.1 KB")
    expect(formatBytes(2_500_000)).toBe("3 MB")
  })
})
