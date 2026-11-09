import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import {
  kindOf, walk, realFs, folderOf, Rollup, seal, unseal, manifestFileText, parseManifestFile, parsePlist,
  diskFactsFromPlist, driveIdFromDisk, tsvRow, parseTsv, manifestTitle, splitRef, type WalkFs,
} from "./drives-core"

/**
 * #192927 — `iris drives` is a port of scripts/drives/drive_scan.py. These tests pin the parts
 * both tools must agree on: classification, the walk's privacy promise, and the sealed manifest
 * (checked against the Python itself when it is on this machine).
 */

describe("kindOf — the classification table drive_scan.py uses", () => {
  const cases: Array<[string, string]> = [
    // credentials
    [".env", "credential"],
    ["site/.env.production", "credential"],
    ["old-site/config.php", "credential"],
    ["wp/wp-config.php", "credential"],
    ["home/.ssh/id_rsa", "credential"],
    ["keys/server.pem", "credential"],
    ["gcp/service-account-prod.json", "credential"],
    // false positives the Python learned the hard way
    ["app/vendor/acme/Config.php", "code"], // vendor library, not our secret
    ["app/system/core/Config.php", "code"], // framework class
    ["src/Config.php", "code"], // CLASSFILE: capitalised class file
    ["src/Database.php", "code"],
    ["tests/fixtures/.env", "code"], // test fixture
    ["lib/thing/id_rsa", "code"],
    ["backup/site.bak", "other"], // .bak alone is NOT a dump
    ["backup/site.sql.bak", "db-dump"],
    ["backup/site.SQL.GZ", "db-dump"],
    ["data/app.sqlite3", "db-dump"],
    // media and the rest
    ["Sessions/Take 1.WAV", "audio"],
    ["Footage/A001.braw", "video"],
    ["Art/cover.PSD", "project"],
    ["Art/IMG_0001.HEIC", "image"],
    ["docs/contract.pdf", "document"],
    ["web/index.html", "code"],
    ["dl/installer.dmg", "archive"],
    ["notes/README", "other"],
  ]
  for (const [rel, kind] of cases) test(`${rel} → ${kind}`, () => expect(kindOf(rel)).toBe(kind))
})

let tmp: string
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iris-drives-test-"))
})
afterAll(() => {
  // restore perms so the tree can be deleted
  try { fs.chmodSync(path.join(tmp, "tree", "Personal", "Diary"), 0o755) } catch {}
  fs.rmSync(tmp, { recursive: true, force: true })
})

function write(rel: string, bytes: number) {
  const p = path.join(tmp, "tree", rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, Buffer.alloc(bytes, 1))
}

describe("walk", () => {
  beforeAll(() => {
    write("Music/Song.logicx/Alternatives/000/ProjectData", 1000)
    write("Music/Song.logicx/Resources/a.wav", 2000)
    write("Music/Song.logicx/Resources/b.wav", 3000)
    write("Music/mix.wav", 10)
    write("Music/._mix.wav", 10)
    write("Music/.DS_Store", 10)
    write("node_modules/x/index.js", 10)
    write("Personal/Diary/secret.txt", 10)
    write("Personal/Diary/more/deeper.txt", 10)
    write("Personal/ok.txt", 10)
    write("site/.env", 10)
  })

  test("a bundle is ONE item with the summed size, its insides never listed", () => {
    const rows = [...walk(path.join(tmp, "tree"), { store: "/nonexistent" })]
    const logic = rows.filter((r) => r.rel.includes("Song.logicx"))
    expect(logic).toHaveLength(1)
    expect(logic[0]).toMatchObject({ rel: "Music/Song.logicx", bytes: 6000, kind: "project" })
  })

  test("._ files, .DS_Store and SKIP_DIRS are skipped", () => {
    const rels = [...walk(path.join(tmp, "tree"), { store: "/nonexistent" })].map((r) => r.rel)
    expect(rels).not.toContain("Music/._mix.wav")
    expect(rels).not.toContain("Music/.DS_Store")
    expect(rels.some((r) => r.startsWith("node_modules"))).toBe(false)
    expect(rels).toContain("Music/mix.wav")
    expect(rels).toContain("site/.env")
  })

  test("an excluded folder is never opened — not listed, not read, not counted as unreadable", () => {
    const priv = path.join(tmp, "tree", "Personal", "Diary")
    fs.chmodSync(priv, 0o000) // opening it would fail and land in `unreadable`
    const opened: string[] = []
    const spy: WalkFs = {
      readdir: (p) => {
        opened.push(p)
        if (p.startsWith(priv)) throw new Error(`walk opened the private folder ${p}`)
        return realFs.readdir(p)
      },
      lstat: (p) => {
        if (p.startsWith(priv)) throw new Error(`walk stat'ed inside the private folder ${p}`)
        return realFs.lstat(p)
      },
    }
    const unreadable: string[] = []
    // case and slashes are normalised the way drive_scan.py does (strip "/", lower())
    const rows = [...walk(path.join(tmp, "tree"), { excludes: ["/personal/DIARY/"], unreadable, fsImpl: spy, store: "/nonexistent" })]
    expect(opened.some((p) => p.startsWith(priv))).toBe(false)
    expect(unreadable).toEqual([])
    expect(rows.some((r) => r.rel.toLowerCase().startsWith("personal/diary"))).toBe(false)
    expect(rows.map((r) => r.rel)).toContain("Personal/ok.txt") // the sibling is still cataloged
    fs.chmodSync(priv, 0o755)
  })

  test("a folder that cannot be opened is reported, never silent", () => {
    if (process.getuid?.() === 0) return // root reads everything
    const priv = path.join(tmp, "tree", "Personal", "Diary")
    fs.chmodSync(priv, 0o000)
    const unreadable: string[] = []
    ;[...walk(path.join(tmp, "tree"), { unreadable, store: "/nonexistent" })]
    fs.chmodSync(priv, 0o755)
    expect(unreadable).toEqual(["Personal/Diary (EACCES)"])
  })
})

describe("rollup", () => {
  test("folderOf matches drive_scan.py", () => {
    expect(folderOf("a.txt", 2)).toBe("(top level)")
    expect(folderOf("A/a.txt", 2)).toBe("A")
    expect(folderOf("A/B/C/a.txt", 2)).toBe("A/B")
    expect(folderOf("A/B/C/a.txt", 1)).toBe("A")
  })

  test("rows carry the Atlas fields; findings status follows encryption", () => {
    const r = new Rollup(2)
    r.add({ rel: "Site/www/.env", bytes: 2048, mtime: 0, kind: "credential" })
    r.add({ rel: "Site/www/index.php", bytes: 10, mtime: 0, kind: "code" })
    r.add({ rel: "Site/www/a.php", bytes: 10, mtime: 0, kind: "code" })
    const [f] = r.folderRows("fs:x", "BK-01")
    expect(f).toMatchObject({ external_id: "fs:x:Site/www", folder: "Site/www", main_kind: "code", files: 3, kinds: "code 2, credential 1", newest: null, sensitive_files: 1 })
    expect(r.findingRows("fs:x", "BK-01", false, "2026-11-09")[0]).toMatchObject({ external_id: "fs:x:Site/www/.env", size_kb: 2, status: "exposed", drive_encrypted: false })
    expect(r.findingRows("fs:x", "BK-01", true, "2026-11-09")[0].status).toBe("contained")
  })
})

describe("manifest TSV", () => {
  test("quotes like python csv (QUOTE_MINIMAL) and parses back", () => {
    const text = tsvRow(["path", "bytes", "modified", "kind"]) + tsvRow(['odd\t"name".wav', 5, "2026-01-02", "audio"]) + tsvRow(["plain.txt", 1, "", "document"])
    expect(text).toContain('"odd\t""name"".wav"')
    expect(parseTsv(text)).toEqual([
      { path: 'odd\t"name".wav', bytes: "5", modified: "2026-01-02", kind: "audio" },
      { path: "plain.txt", bytes: "1", modified: "", kind: "document" },
    ])
  })
  test("title + split ref", () => {
    expect(manifestTitle("dir:iris-hive-001:/home/x y")).toBe("drive-manifest dir:iris-hive-001:_home_x_y")
    expect(splitRef("fs:abc:Music/a.wav")).toEqual(["fs:abc", "Music/a.wav"])
    expect(splitRef("dir:h:/home/x:Music/a.wav", ["dir:h:/home/x"])).toEqual(["dir:h:/home/x", "Music/a.wav"])
  })
})

describe("seal / unseal", () => {
  const raw = new TextEncoder().encode("path\tbytes\tmodified\tkind\nMusic/a.wav\t10\t2026-11-09\taudio\n")

  test("round-trips; wrong key fails", async () => {
    const { blob, keyHex } = await seal(raw)
    expect(keyHex).toMatch(/^[0-9a-f]{64}$/)
    const back = parseManifestFile(manifestFileText(blob))
    expect(new TextDecoder().decode(await unseal(back, keyHex))).toBe(new TextDecoder().decode(raw))
    await expect(unseal(back, "00".repeat(32))).rejects.toThrow()
  })

  test("refuses an unknown file format", () => {
    expect(() => parseManifestFile("something-else\nAAAA\n")).toThrow(/unknown manifest format/)
  })

  // Cross-language: the Python in production must open ours, and we must open its.
  const PY = process.env.DRIVE_SCAN_PY ?? "/home/siralexmayo/work/freelabel/scripts/drives/drive_scan.py"
  const havePy =
    fs.existsSync(PY) && spawnSync("python3", ["-c", "import cryptography"], { encoding: "utf8" }).status === 0
  const py = (code: string) =>
    spawnSync("python3", ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(path.dirname(PY))}); import drive_scan\n${code}`], { encoding: "utf8" })

  test.skipIf(!havePy)("a manifest sealed here opens with drive_scan.py unseal", async () => {
    const { blob, keyHex } = await seal(raw)
    const f = path.join(tmp, "ts-sealed.txt")
    fs.writeFileSync(f, manifestFileText(blob))
    const r = py(
      `import base64; head, _, body = open(${JSON.stringify(f)}).read().partition("\\n"); assert head == "iris-drive-manifest-v1"\n` +
        `sys.stdout.write(drive_scan.unseal(base64.b64decode(body), ${JSON.stringify(keyHex)}).decode())`,
    )
    expect(r.stderr).toBe("")
    expect(r.stdout).toBe(new TextDecoder().decode(raw))
  })

  test.skipIf(!havePy)("a manifest sealed by drive_scan.py opens here", async () => {
    const f = path.join(tmp, "py-sealed.txt")
    const r = py(
      `import base64; blob, key = drive_scan.seal(b"path\\tbytes\\tmodified\\tkind\\nfrom/python.wav\\t1\\t\\taudio\\n")\n` +
        `open(${JSON.stringify(f)}, "w").write("iris-drive-manifest-v1\\n" + base64.b64encode(blob).decode() + "\\n"); print(key)`,
    )
    expect(r.status).toBe(0)
    const out = await unseal(parseManifestFile(fs.readFileSync(f, "utf8")), r.stdout.trim())
    expect(parseTsv(new TextDecoder().decode(out))).toEqual([{ path: "from/python.wav", bytes: "1", modified: "", kind: "audio" }])
  })
})

describe("diskutil info -plist (hand-written fixture, not a recorded capture)", () => {
  const xml = fs.readFileSync(path.join(import.meta.dir, "drives-diskutil.fixture.plist"), "utf8")

  test("parses the plist", () => {
    const p = parsePlist(xml)
    expect(p.VolumeName).toBe("BK & Sessions")
    expect(p.TotalSize).toBe(1000240963584)
    expect(p.Encrypted).toBe(true)
    expect(p.APFSPhysicalStores).toEqual([{ APFSPhysicalStore: "disk4s2" }])
    expect(p.APFSVolumeGroupID).toBe("")
  })

  test("facts: lowercase VolumeUUID as the id, encrypted APFS, mount point", () => {
    const f = diskFactsFromPlist(parsePlist(xml))
    expect(driveIdFromDisk(f)).toBe("fs:7a1c3e55-9b2d-4f60-8e41-2d7c5b9a0f13")
    expect(f).toMatchObject({ filesystem: "apfs", label: "BK & Sessions", encrypted: true, mountPoint: "/Volumes/BK & Sessions" })
  })

  test("FileVault alone counts as encrypted; no UUID falls back like drive_scan.py", () => {
    expect(diskFactsFromPlist({ FileVault: true, Encrypted: false }).encrypted).toBe(true)
    expect(diskFactsFromPlist({ Encrypted: false }).encrypted).toBe(false)
    expect(driveIdFromDisk(diskFactsFromPlist({ DeviceNode: "/dev/disk6s1" }))).toBe("fs:_dev_disk6s1")
  })
})

// #192974 — parity with drive_scan.py on a Mac drive. An installed app carries its own certs and
// keys (Foo.app/Contents/Resources/*.pem): they are the vendor's, not ours, and must not be
// findings. macOS also leaves suffixed copies of its system folders (.DocumentRevisions-V100-bad,
// .Spotlight-V100.old) that are skipped by PREFIX. Both tools walk one fixture and must agree.
describe("interop fixture: app bundles and macOS system folders (#192974)", () => {
  let root: string
  beforeAll(() => {
    root = path.join(tmp, "mac-volume")
    const put = (rel: string, bytes = 10) => {
      const p = path.join(root, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, Buffer.alloc(bytes, 1))
    }
    put("Applications/Zoom.app/Contents/Resources/cacert.pem", 500)
    put("Applications/Zoom.app/Contents/Frameworks/ssl.framework/Versions/A/server.key", 300)
    put("Library/Foo.framework/Resources/client.p12")
    put("Library/Audio/Plug-Ins/Thing.plugin/Contents/Resources/id_rsa")
    put("Library/Thing.bundle/Contents/.env")
    put("Library/Extensions/Driver.kext/Contents/key.pem")
    put(".DocumentRevisions-V100-bad/PerUID/501/dump.sql")
    put(".Spotlight-V100.old/Store-V2/credentials.json")
    put(".TemporaryItems.1/folders.501/.env")
    put(".fseventsd-uuid/backup.sql")
    put("Clients/site/.env")
    put("Footage/A001.mov", 1000)
  })

  const tsWalk = () => [...walk(root, { store: "/nonexistent" })].sort((a, b) => (a.rel < b.rel ? -1 : 1))

  test("an app bundle is ONE item, never walked; macOS system folders are skipped by prefix", () => {
    const rows = tsWalk()
    expect(rows.map((r) => r.rel)).toEqual([
      "Applications/Zoom.app",
      "Clients/site/.env",
      "Footage/A001.mov",
      "Library/Audio/Plug-Ins/Thing.plugin",
      "Library/Extensions/Driver.kext",
      "Library/Foo.framework",
      "Library/Thing.bundle",
    ])
    expect(rows.find((r) => r.rel === "Applications/Zoom.app")).toMatchObject({ bytes: 0, kind: "other" })
  })

  test("the only finding is our own credential — 0 from bundles and system folders", () => {
    const r = new Rollup(2)
    for (const e of tsWalk()) r.add(e)
    expect(r.findings.map((f) => f.path)).toEqual(["Clients/site/.env"])
  })

  const PY = process.env.DRIVE_SCAN_PY ?? "/home/siralexmayo/work/freelabel/scripts/drives/drive_scan.py"
  test.skipIf(!fs.existsSync(PY))("drive_scan.py walks the same fixture to the same items and findings", () => {
    const r = spawnSync(
      "python3",
      [
        "-c",
        `import sys, json; sys.path.insert(0, ${JSON.stringify(path.dirname(PY))}); import drive_scan\n` +
          `print(json.dumps(sorted([[rel, kind] for rel, _b, _m, kind in drive_scan.walk(${JSON.stringify(root)})])))`,
      ],
      { encoding: "utf8" },
    )
    expect(r.stderr).toBe("")
    const py: Array<[string, string]> = JSON.parse(r.stdout)
    expect(py).toEqual(tsWalk().map((e) => [e.rel, e.kind]))
    expect(py.filter(([, k]) => k === "credential" || k === "db-dump").map(([rel]) => rel)).toEqual(["Clients/site/.env"])
  })
})
