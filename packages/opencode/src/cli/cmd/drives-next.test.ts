import { describe, test, expect, beforeAll } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { createHash } from "crypto"
import { spawnSync } from "child_process"
import {
  walk, manifestRow, tsvRow, parseTsv, seal, unseal, TSV_HEADER, TSV_HEADER_SHA, shouldHash, sha256File,
  bundleHash, bundleHashFromLines, copiesReport, copiesLine, copyIndex, liveDriveFields, utcIso,
  DRIVES_DATASETS, type ManifestRow,
} from "./drives-core"
import { runGet, type GetDeps } from "./platform-drives"

/**
 * #192914 — the next Drives slice: copies counted by content (an optional 5th manifest column,
 * sha256), live drive fields (free space, where and when last seen), and `get`: one file read on
 * the record. The 4-column manifest every existing drive has must keep opening.
 */

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iris-drives-next-"))
const put = (root: string, rel: string, body: string | Buffer = "x") => {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  return p
}

describe("manifest: optional 5th column sha256", () => {
  test("a 4-column manifest (every drive scanned before this) still reads; sha256 is simply absent", () => {
    const text = tsvRow(TSV_HEADER) + tsvRow(["a.wav", 5, "2026-01-02", "audio"])
    const [row] = parseTsv(text)
    expect(row).toEqual({ path: "a.wav", bytes: "5", modified: "2026-01-02", kind: "audio" })
    expect(row.sha256 ?? "").toBe("")
  })

  test("a 5-column manifest writes and reads back, with and without a hash", () => {
    const h = sha("x")
    const text =
      tsvRow(TSV_HEADER_SHA) +
      manifestRow({ rel: "a.wav", bytes: 1, mtime: 0, kind: "audio", sha256: h }, true) +
      manifestRow({ rel: "b.mov", bytes: 9, mtime: 0, kind: "video" }, true)
    expect(TSV_HEADER_SHA).toEqual(["path", "bytes", "modified", "kind", "sha256"])
    expect(parseTsv(text)).toEqual([
      { path: "a.wav", bytes: "1", modified: "", kind: "audio", sha256: h },
      { path: "b.mov", bytes: "9", modified: "", kind: "video", sha256: "" },
    ])
    // the 4-column writer is unchanged
    expect(manifestRow({ rel: "a.wav", bytes: 1, mtime: 0, kind: "audio", sha256: h })).toBe("a.wav\t1\t\taudio\n")
  })

  test("the recorded Python-sealed fixture (4 columns) still opens and parses", async () => {
    const fx = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "drives-python-sealed.fixture.json"), "utf8"))
    const text = fs.readFileSync(path.join(import.meta.dir, "drives-python-sealed.fixture.txt"), "utf8")
    const out = new TextDecoder().decode(await unseal(Buffer.from(text.slice(text.indexOf("\n") + 1).trim(), "base64"), fx.key_hex))
    expect(out).toBe(fx.plaintext)
    expect(parseTsv(out).map((r) => [r.path, r.sha256 ?? ""])).toEqual([["Shoots/Day1/A001.mov", ""], ["Old Site/app/config.php", ""]])
  })

  test("a sealed 5-column manifest round-trips", async () => {
    const raw = new TextEncoder().encode(tsvRow(TSV_HEADER_SHA) + tsvRow(["x.pdf", 1, "", "document", sha("1")]))
    const { blob, keyHex } = await seal(raw)
    expect(parseTsv(new TextDecoder().decode(await unseal(blob, keyHex)))[0].sha256).toBe(sha("1"))
  })
})

describe("what gets hashed", () => {
  const MB = 1024 * 1024
  test("default: every sensitive file, and project/document/audio up to 64 MB", () => {
    expect(shouldHash("credential", 10 * 1024 * MB, "default")).toBe(true)
    expect(shouldHash("db-dump", 10 * 1024 * MB, "default")).toBe(true)
    expect(shouldHash("audio", 64 * MB, "default")).toBe(true)
    expect(shouldHash("document", 64 * MB + 1, "default")).toBe(false)
    expect(shouldHash("project", 1, "default")).toBe(true)
    expect(shouldHash("video", 1, "default")).toBe(false)
    expect(shouldHash("image", 1, "default")).toBe(false)
  })
  test("--checksums all / none; an empty file is never hashed (every empty file would be a 'copy')", () => {
    expect(shouldHash("video", 50 * 1024 * MB, "all")).toBe(true)
    expect(shouldHash("credential", 1, "none")).toBe(false)
    expect(shouldHash("credential", 0, "default")).toBe(false)
  })

  test("walk hashes per the rule and NEVER inside an excluded (private) folder", () => {
    const root = path.join(tmp, "hash-walk")
    put(root, "Site/.env", "SECRET=1")
    put(root, "Mix/song.wav", "wav")
    put(root, "Footage/A001.mov", "mov")
    put(root, "Personal/taxes.pdf", "private")
    put(root, "Personal/id_rsa", "private key")
    const hashed: string[] = []
    const hashFile = (abs: string) => { hashed.push(path.relative(root, abs)); return sha256File(abs) }
    const rows = [...walk(root, { excludes: ["Personal"], checksums: "default", hashFile, store: "/nonexistent" })]
    const by = Object.fromEntries(rows.map((r) => [r.rel, r.sha256 ?? ""]))
    expect(by["Site/.env"]).toBe(sha("SECRET=1"))
    expect(by["Mix/song.wav"]).toBe(sha("wav"))
    expect(by["Footage/A001.mov"]).toBe("")
    expect(Object.keys(by).some((k) => k.startsWith("Personal"))).toBe(false)
    expect(hashed.some((h) => h.startsWith("Personal"))).toBe(false)
    expect([...walk(root, { excludes: ["Personal"], checksums: "all", hashFile, store: "/nonexistent" })].find((r) => r.rel === "Footage/A001.mov")?.sha256).toBe(sha("mov"))
    expect(hashed.some((h) => h.startsWith("Personal"))).toBe(false)
  })
})

describe("bundle hash = sha256 of its members' sorted `relpath\\tsha256` lines", () => {
  test("deterministic, independent of creation order, and matches the written rule", () => {
    const a = path.join(tmp, "A.logicx")
    const b = path.join(tmp, "B.logicx")
    put(a, "Alternatives/000/ProjectData", "pd")
    put(a, "Resources/Audio Files/kick.wav", "kick")
    put(b, "Resources/Audio Files/kick.wav", "kick") // reverse order on disk
    put(b, "Alternatives/000/ProjectData", "pd")
    const expected = sha(
      [`Alternatives/000/ProjectData\t${sha("pd")}`, `Resources/Audio Files/kick.wav\t${sha("kick")}`].sort().join("\n") + "\n",
    )
    expect(bundleHash(a)).toBe(expected)
    expect(bundleHash(b)).toBe(expected)
    expect(bundleHashFromLines([["Resources/Audio Files/kick.wav", sha("kick")], ["Alternatives/000/ProjectData", sha("pd")]])).toBe(expected)
    put(b, "Resources/Audio Files/kick.wav", "kick2")
    expect(bundleHash(b)).not.toBe(expected)
  })

  test("walk gives a small bundle its bundle hash", () => {
    const root = path.join(tmp, "bundle-walk")
    put(root, "Songs/Track.logicx/Alternatives/000/ProjectData", "pd")
    const [row] = [...walk(root, { checksums: "default", store: "/nonexistent" })]
    expect(row).toMatchObject({ rel: "Songs/Track.logicx", kind: "project" })
    expect(row.sha256).toBe(bundleHash(path.join(root, "Songs/Track.logicx")))
  })
})

describe("copies", () => {
  const H1 = sha("one"), H2 = sha("two")
  const all: ManifestRow[] = [
    { drive: "Studio", path: "Mixes/final.wav", bytes: 10, sha256: H1 },
    { drive: "Backup", path: "Old/final.wav", bytes: 10, sha256: H1 },
    { drive: "Backup", path: "renamed-final-master.wav", bytes: 10, sha256: H1 }, // a renamed copy still counts
    { drive: "Laptop", path: "Docs/brief.pdf", bytes: 3, sha256: H2 },
    { drive: "Studio", path: "Docs/brief.pdf", bytes: 4, sha256: sha("other") },
    { drive: "Studio", path: "Footage/brief.mov", bytes: 99, sha256: "" },
  ]

  test("identical copies across drives, counted by content", () => {
    const r = copiesReport(all, ["final.wav"])
    expect(r.known).toHaveLength(1)
    expect(r.known[0].versions).toHaveLength(1)
    expect(r.known[0].versions[0].copies).toHaveLength(3)
    expect(copiesLine(r.known[0].versions)).toBe("3 identical copies on: Backup, Studio")
    expect(r.unknown).toEqual([])
  })

  test("same name, different content — and not checksummed yet", () => {
    const r = copiesReport(all, ["brief"])
    const pdf = r.known.find((k) => k.name === "brief.pdf")!
    expect(pdf.versions).toHaveLength(2)
    expect(copiesLine(pdf.versions)).toBe("same name, different content: 2 versions")
    expect(r.unknown.map((u) => u.path)).toEqual(["Footage/brief.mov"])
  })

  test("one copy says so", () => {
    const r = copiesReport([{ drive: "Laptop", path: "a.pdf", bytes: 1, sha256: H2 }], ["a.pdf"])
    expect(copiesLine(r.known[0].versions)).toBe("only 1 copy, on: Laptop")
  })

  test("copyIndex ignores rows without a hash", () => {
    const idx = copyIndex(all)
    expect(idx.get(H1)?.length).toBe(3)
    expect(idx.has("")).toBe(false)
  })
})

describe("live drive fields", () => {
  test("free_gb from statfs, last_seen_on = host, last_seen_at = UTC ISO", () => {
    const f = liveDriveFields({ bavail: 2_000_000, bsize: 4096 }, "studio-mac", new Date("2026-11-09T18:04:05.678Z"))
    expect(f).toEqual({ free_gb: 8.2, last_seen_on: "studio-mac", last_seen_at: "2026-11-09T18:04:05Z" })
    expect(utcIso(new Date(0))).toBe("1970-01-01T00:00:00Z")
  })
  test("the drives schema gains the three fields (optional); drive-reads is bootstrapped", () => {
    const drives = DRIVES_DATASETS.find((d) => d.slug === "drives")!
    for (const k of ["free_gb", "last_seen_on", "last_seen_at"]) expect(drives.fields.some((f: any) => f.key === k)).toBe(true)
    expect(drives.fields.find((f: any) => f.key === "manifest_key")).toMatchObject({ visibility: "private" })
    const reads = DRIVES_DATASETS.find((d) => d.slug === "drive-reads")!
    expect(reads.fields.map((f: any) => f.key)).toEqual([
      "external_id", "drive_id", "drive_label", "path", "bytes", "sha256", "read_by", "read_on", "purpose", "at",
    ])
  })
})

// ── get: one file, on the record ─────────────────────────────────────────────────

describe("iris drives get", () => {
  let mount: string
  let driveId: string
  let to: string
  beforeAll(() => {
    mount = path.join(tmp, "Volume")
    driveId = `dir:${os.hostname()}:${mount}`
    put(mount, "Shoots/brief.pdf", "the brief")
    put(mount, "Site/.env", "SECRET=1")
    put(mount, "Personal/taxes.pdf", "private")
    put(mount, "Songs/Track.logicx/Alternatives/000/ProjectData", "pd")
    put(mount, "Songs/Track.logicx/Resources/kick.wav", "kick")
    fs.symlinkSync(path.join(mount, "Personal"), path.join(mount, "Shoots", "sneaky"))
  })

  function deps(over: Partial<GetDeps> = {}) {
    const audit: any[][] = []
    const d: GetDeps = {
      drives: async () => [{ external_id: driveId, label: "Studio", encrypted: false, private_excluded: "Personal" }],
      findings: async () => [{ path: "Site/.env", kind: "credential", status: "exposed" }],
      ensureReadsDataset: async () => {},
      writeAudit: async (rows) => { audit.push(rows); return { created: rows.length, updated: 0, failed: 0 } },
      account: async () => "user 42",
      host: "studio-mac",
      now: () => new Date("2026-11-09T18:00:00Z"),
      ...over,
    }
    return { d, audit }
  }
  const fresh = () => fs.mkdtempSync(path.join(tmp, "out-"))

  test("refuses without --why, before anything is opened", async () => {
    const { d, audit } = deps({ drives: async () => { throw new Error("must not be called") } })
    const r = await runGet({ ref: "Studio:Shoots/brief.pdf", to: fresh(), why: "  " }, d)
    expect(r.code).toBe(1)
    expect(r.err.join("\n")).toMatch(/--why/)
    expect(audit).toEqual([])
  })

  test("refuses a path inside a private folder — and a link that leads into one", async () => {
    for (const ref of ["Studio:Personal/taxes.pdf", "Studio:personal/taxes.pdf", "Studio:Shoots/../Personal/taxes.pdf", "Studio:Shoots/sneaky/taxes.pdf"]) {
      const { d, audit } = deps()
      const out = fresh()
      const r = await runGet({ ref, to: out, why: "test" }, d)
      expect(r.code).toBe(1)
      expect(r.err.join("\n")).toMatch(/private/)
      expect(fs.readdirSync(out)).toEqual([])
      expect(audit).toEqual([])
    }
  })

  test("a sensitive file needs --confirm, and says so plainly", async () => {
    const { d, audit } = deps()
    const out = fresh()
    const r = await runGet({ ref: "Studio:Site/.env", to: out, why: "rotate the key" }, d)
    expect(r.code).toBe(1)
    expect(r.err.join("\n")).toMatch(/sensitive file \(credential\).*--confirm/s)
    expect(fs.readdirSync(out)).toEqual([])
    expect(audit).toEqual([])
    const ok = await runGet({ ref: "Studio:Site/.env", to: out, why: "rotate the key", confirm: true }, d)
    expect(ok.code).toBe(0)
    expect(audit).toHaveLength(1)
  })

  test("copies one file, verifies its sha256 and writes exactly ONE audit row", async () => {
    const { d, audit } = deps()
    const out = fresh()
    const r = await runGet({ ref: "Studio:Shoots/brief.pdf", to: out, why: "send to client" }, d)
    expect(r.code).toBe(0)
    expect(fs.readFileSync(path.join(out, "brief.pdf"), "utf8")).toBe("the brief")
    expect(audit).toHaveLength(1)
    expect(audit[0]).toHaveLength(1)
    expect(audit[0][0]).toEqual({
      external_id: `${driveId}:Shoots/brief.pdf:2026-11-09T18:00:00Z`,
      drive_id: driveId, drive_label: "Studio", path: "Shoots/brief.pdf", bytes: 9, sha256: sha("the brief"),
      read_by: "user 42", read_on: "studio-mac", purpose: "send to client", at: "2026-11-09T18:00:00Z",
    })
    expect(r.out.join("\n")).toContain("verified")
  })

  test("a bundle comes out as ONE .zip whose contents hash to the bundle hash", async () => {
    const { d, audit } = deps()
    const out = fresh()
    const r = await runGet({ ref: "Studio:Songs/Track.logicx", to: out, why: "mixdown" }, d)
    expect(r.code).toBe(0)
    expect(fs.readdirSync(out)).toEqual(["Track.logicx.zip"])
    expect(audit[0][0].sha256).toBe(bundleHash(path.join(mount, "Songs/Track.logicx")))
  })

  test("a copy that does not match is removed and NOT recorded", async () => {
    const { d, audit } = deps()
    const out = fresh()
    const r = await runGet({ ref: "Studio:Shoots/brief.pdf", to: out, why: "x" }, { ...d, hashFile: (p) => (p.startsWith(out) ? "bad" : sha256File(p)) })
    expect(r.code).toBe(5) // its own exit code since #193362
    expect(r.err.join("\n")).toMatch(/did not match/)
    expect(fs.readdirSync(out)).toEqual([])
    expect(audit).toEqual([])
  })

  test("if the read cannot be recorded, the copy is removed", async () => {
    const { d } = deps({ writeAudit: async () => { throw new Error("HTTP 500") } })
    const out = fresh()
    const r = await runGet({ ref: "Studio:Shoots/brief.pdf", to: out, why: "x" }, d)
    expect(r.code).toBe(1)
    expect(fs.readdirSync(out)).toEqual([])
  })

  test("drive not connected → exit 2 with the same sentence `path` uses", async () => {
    const { d } = deps({ drives: async () => [{ external_id: "fs:0000-not-here", label: "Archive", private_excluded: "" }] })
    const r = await runGet({ ref: "Archive:a.pdf", to: fresh(), why: "x" }, d)
    expect(r.code).toBe(2)
    expect(r.out.join("\n")).toBe("Not a valid path right now: Archive is not connected to this computer")
  })
})

// Parity with drive_scan.py on the same tree: same hashes per file, same bundle hash, same copy
// verdicts. Runs when DRIVE_SCAN_PY points at scripts/drives/drive_scan.py (fl-eco-docker).
describe("parity with drive_scan.py (#192914)", () => {
  const PY = process.env.DRIVE_SCAN_PY ?? ""
  const have = fs.existsSync(PY)
  const py = (code: string) => {
    const r = spawnSync(
      "python3",
      ["-c", `import sys, json; sys.path.insert(0, ${JSON.stringify(path.dirname(PY))}); import drive_scan as D\n${code}`],
      { encoding: "utf8" },
    )
    if (r.status !== 0) throw new Error(r.stderr)
    return JSON.parse(r.stdout)
  }
  let root: string
  beforeAll(() => {
    root = path.join(tmp, "parity")
    put(root, "Site/.env", "S")
    put(root, "Mix/sång – final.wav", "w") // non-ASCII: both sort by code point
    put(root, "Footage/A001.mov", "m")
    put(root, "Personal/id_rsa", "k")
    put(root, "Songs/Ä.logicx/Resources/b.wav", "b")
    put(root, "Songs/Ä.logicx/Resources/a b.wav", "ab")
    put(root, "Songs/Ä.logicx/Alternatives/000/ProjectData", "pd")
  })

  for (const mode of ["default", "all"] as const) {
    test.skipIf(!have)(`walk hashes agree (--checksums ${mode}), private folder never hashed`, () => {
      const ts = Object.fromEntries(
        [...walk(root, { excludes: ["Personal"], checksums: mode, store: "/nonexistent" })].filter((e) => e.sha256).map((e) => [e.rel, e.sha256]),
      )
      const p = py(`h = {}; list(D.walk(${JSON.stringify(root)}, ["Personal"], h, ${JSON.stringify(mode)})); print(json.dumps(h))`)
      expect(p).toEqual(ts)
      expect(Object.keys(ts).some((k) => k.startsWith("Personal"))).toBe(false)
    })
  }

  test.skipIf(!have)("bundle hash agrees", () => {
    const b = path.join(root, "Songs/Ä.logicx")
    expect(py(`print(json.dumps(D.bundle_hash(${JSON.stringify(b)})))`)).toBe(bundleHash(b))
  })

  test.skipIf(!have)("copy verdicts agree", () => {
    const rows: ManifestRow[] = [
      { drive: "Studio", path: "Mixes/final.wav", bytes: 1, sha256: sha("1") },
      { drive: "Backup", path: "x/final.wav", bytes: 1, sha256: sha("1") },
      { drive: "Laptop", path: "Docs/brief.pdf", bytes: 1, sha256: sha("2") },
      { drive: "Studio", path: "Docs/brief.pdf", bytes: 1, sha256: sha("3") },
      { drive: "Studio", path: "brief.mov", bytes: 1, sha256: "" },
    ]
    for (const words of [["final"], ["brief"], ["nothing"]]) {
      const ts = copiesReport(rows, words)
      const p = py(
        `r = D.copies_report(${JSON.stringify(rows)}, ${JSON.stringify(words)})\n` +
          `print(json.dumps({"known": [[k["name"], D.copies_line(k["versions"])] for k in r["known"]], "unknown": [u["path"] for u in r["unknown"]]}))`,
      )
      expect(p).toEqual({ known: ts.known.map((k) => [k.name, copiesLine(k.versions)]), unknown: ts.unknown.map((u) => u.path) })
    }
  })

  test.skipIf(!have)("a 5-column manifest sealed by drive_scan.py opens and parses here", async () => {
    const h = sha("x")
    const p = py(
      `import base64; blob, key = D.seal(("path\\tbytes\\tmodified\\tkind\\tsha256\\na.wav\\t1\\t\\taudio\\t${h}\\n").encode())\n` +
        `print(json.dumps([base64.b64encode(blob).decode(), key]))`,
    )
    const rows = parseTsv(new TextDecoder().decode(await unseal(Buffer.from(p[0], "base64"), p[1])))
    expect(rows).toEqual([{ path: "a.wav", bytes: "1", modified: "", kind: "audio", sha256: h }])
  })
})
