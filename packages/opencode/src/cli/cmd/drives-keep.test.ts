import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { runKeep, folderMembers, vaultCopiesBySha, REMOTE_FOLDER_LIMIT, type KeepDeps } from "./drives-keep"
import type { VaultCatalog } from "./vault-replicas"

/**
 * #193363 — `iris drives keep`: the same rules as `get` (--why, private folders, --confirm for a
 * sensitive file, one audit row), then the files go into the vault and one kept row per file says
 * where it came from and how many copies hold it.
 */

let dir: string
let mount: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "iris-keep-test-"))
  mount = join(dir, "drive")
  mkdirSync(join(mount, "Album", "stems"), { recursive: true })
  mkdirSync(join(mount, "Album", "Private notes"), { recursive: true })
  mkdirSync(join(mount, "Album", "Song.logicx", "Alternatives"), { recursive: true })
  mkdirSync(join(mount, "Album", "Tool.app", "Contents"), { recursive: true })
  mkdirSync(join(mount, "Family"), { recursive: true })
  writeFileSync(join(mount, "Album", "master.wav"), "master")
  writeFileSync(join(mount, "Album", "stems", "kick.wav"), "kick")
  writeFileSync(join(mount, "Album", "Private notes", "diary.txt"), "secret")
  writeFileSync(join(mount, "Album", "Song.logicx", "Alternatives", "project.data"), "logic")
  writeFileSync(join(mount, "Album", "Tool.app", "Contents", "bin"), "app")
  writeFileSync(join(mount, "Family", "photo.jpg"), "family")
  writeFileSync(join(mount, ".env"), "KEY=1")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex")
const DRIVE = { external_id: "fs:studio", label: "Studio", encrypted: false, private_excluded: "Family\nAlbum/Private notes" }
const VAULT = { id: "v-1", name: "masters", replicas: 3, targets: [{}] }

function deps(over: Partial<KeepDeps> = {}) {
  const audit: any[] = []
  const puts: Array<Array<{ src: string; as: string }>> = []
  const kept = new Map<string, any>()
  const driveRows: any[] = []
  const remote: any[] = []
  const catalog: VaultCatalog = {
    drives: async () => [DRIVE],
    replicaRows: async () => [],
    keptRows: async () => [...kept.values()],
    ensure: async () => {},
    upsert: async (schema, rows) => {
      if (schema === "drive-kept") for (const r of rows) kept.set(r.external_id, r)
      if (schema === "drives") driveRows.push(...rows)
      return { created: rows.length, updated: 0, failed: 0 }
    },
  }
  const d: KeepDeps = {
    drives: async () => [DRIVE],
    findings: async () => [],
    ensureReadsDataset: async () => {},
    writeAudit: async (rows) => { audit.push(...rows); return { created: rows.length, updated: 0, failed: 0 } },
    account: async () => "me@example.com",
    host: "laptop",
    now: () => new Date("2026-11-13T12:00:00Z"),
    resolveMount: (id) => (id === "fs:studio" ? mount : null),
    vault: async (n) => (n === "masters" ? VAULT : `no vault named "${n}" on this machine`),
    put: async (_v, files) => {
      puts.push(files)
      return {
        results: files.map((f) => ({ ok: true, path: f.src, vault_path: f.as, size: readFileSync(f.src).length, plain_sha256: sha(readFileSync(f.src)), content_id: "cid-" + sha(readFileSync(f.src)).slice(0, 8), held_by: ["drive:fs:a", "machine:laptop"], copies: 2 })),
        problems: [],
        checks: [{ key: "drive:fs:a", status: "ok", target: { label: "Backup A" } }, { key: "drive:fs:b", status: "pending", target: { label: "Backup B" } }, { key: "machine:laptop", status: "ok", target: { name: "laptop" } }],
      }
    },
    remoteGet: async (a) => {
      remote.push(a)
      const rel = a.ref.slice("fs:studio:".length)
      const f = join(a.to, rel.split("/").pop()!)
      writeFileSync(f, "remote:" + rel)
      return { code: 0, out: [], err: [], dest: f, row: { path: rel, bytes: 7, sha256: sha("remote:" + rel), file_sha256: sha("remote:" + rel) }, served_by: "studio-mac" }
    },
    catalogFiles: async () => [{ path: "Album/master.wav", bytes: 6 }, { path: "Album/stems/kick.wav", bytes: 4 }, { path: "Album/Private notes/diary.txt", bytes: 6 }],
    catalog,
    ...over,
  }
  return { d, audit, puts, kept, driveRows, remote }
}

const keep = (ref: string, extra: Record<string, any> = {}, over: Partial<KeepDeps> = {}) => {
  const t = deps(over)
  return runKeep({ ref, vault: "masters", why: "only copy of the masters", bloq: 1, ...extra }, t.d).then((r) => ({ r, ...t }))
}

describe("refusals: nothing read, nothing recorded, nothing put", () => {
  test("--why is required", async () => {
    const { r, audit, puts } = await keep("Studio:Album/master.wav", { why: "  " })
    expect(r.code).toBe(1)
    expect(r.err[0]).toMatch(/--why is required/)
    expect(audit.length + puts.length).toBe(0)
  })
  test("a vault that cannot hold counted copies is refused with how to make one", async () => {
    const { r } = await keep("Studio:Album/master.wav", { vault: "nope" })
    expect(r.err[0]).toMatch(/no vault named "nope"/)
  })
  test("a private folder, named directly or reached by a link, is never opened", async () => {
    let x = await keep("Studio:Family/photo.jpg")
    expect(x.r.err[0]).toMatch(/inside a private folder/)
    symlinkSync(join(mount, "Family"), join(mount, "Album", "shortcut"))
    x = await keep("Studio:Album/shortcut/photo.jpg")
    expect(x.r.code).toBe(1)
    expect(x.r.err[0]).toMatch(/inside a private folder/)
    expect(x.audit.length + x.puts.length).toBe(0)
  })
  test("a sensitive file needs --confirm; with it, it is kept and recorded", async () => {
    let x = await keep("Studio:.env")
    expect(x.r.err[0]).toMatch(/\.env is a sensitive file \(credential\)/)
    expect(x.audit.length + x.puts.length).toBe(0)
    x = await keep("Studio:.env", { confirm: true })
    expect(x.r.code).toBe(0)
    expect(x.puts[0].map((f) => f.as)).toEqual(["Studio/.env"])
  })
  test("one sensitive file in a folder is enough to ask", async () => {
    writeFileSync(join(mount, "Album", "stems", "db.sql"), "dump")
    const x = await keep("Studio:Album")
    expect(x.r.err[0]).toMatch(/sensitive files are in Album: Album\/stems\/db.sql \(db-dump\)|Album\/stems\/db.sql is a sensitive file/)
    expect(x.puts.length).toBe(0)
  })
  test("if the read cannot be recorded, nothing is kept", async () => {
    const x = await keep("Studio:Album/master.wav", {}, { writeAudit: async () => { throw new Error("offline") } })
    expect(x.r.code).toBe(1)
    expect(x.r.err[0]).toMatch(/Could not record this read.*Nothing was kept/)
    expect(x.puts.length).toBe(0)
  })
})

describe("kept from a drive plugged in here", () => {
  test("one file: an audit row first, then the vault, then a kept row with its content id and holders", async () => {
    const { r, audit, puts, kept, driveRows } = await keep("Studio:Album/master.wav")
    expect(r.code).toBe(0)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ drive_id: "fs:studio", path: "Album/master.wav", sha256: sha("master"), purpose: "kept in vault masters: only copy of the masters", read_on: "laptop" })
    expect(puts[0]).toEqual([{ src: join(mount, "Album", "master.wav"), as: "Studio/Album/master.wav" }])
    const row = kept.get("v-1|fs:studio:Album/master.wav")
    expect(row).toMatchObject({ vault_name: "masters", sha256: sha("master"), content_id: expect.stringMatching(/^cid-/), copies: 2, target_copies: 3, status: "below", held_by: "drive:fs:a\nmachine:laptop", kept_from: "" })
    expect(r.out.join("\n")).toMatch(/2 of 3 copies so far: Backup A ✓ · Backup B pending · laptop ✓/)
    expect(r.out.join("\n")).toMatch(/catches up when it is: iris vault sync/)
    // its drive's record gets the alert
    expect(driveRows[0]).toMatchObject({ external_id: "fs:studio", kept_files: 1, kept_below_target: 1 })
  })
  test("a folder: every file, private subfolders never opened, apps skipped, project bundles opened into files", async () => {
    const m = folderMembers(mount, "Album", DRIVE.private_excluded.split("\n"))
    expect(m.files.map((f) => f.rel)).toEqual(["Album/Song.logicx/Alternatives/project.data", "Album/master.wav", "Album/stems/kick.wav"])
    expect(m.skipped[0]).toMatch(/Tool.app/)
    const { r, audit, kept } = await keep("Studio:Album")
    expect(r.code).toBe(0)
    expect(audit).toHaveLength(1) // one read on the record for the folder
    expect(audit[0].path).toBe("Album")
    expect([...kept.values()].map((k) => k.path).sort()).toEqual(m.files.map((f) => f.rel))
    expect([...kept.values()][0].kept_from).toBe("Studio:Album")
  })
})

describe("kept from a drive plugged into another of your machines", () => {
  test("files come over the remote-get path (each recorded there), listed from the catalog, private ones left out", async () => {
    const { r, remote, puts, kept } = await keep("Studio:Album", {}, { resolveMount: () => null })
    expect(r.code).toBe(0)
    expect(remote.map((a) => a.ref)).toEqual(["fs:studio:Album/master.wav", "fs:studio:Album/stems/kick.wav"])
    expect(remote[0].why).toBe("kept in vault masters: only copy of the masters")
    expect(puts[0].map((f) => f.as)).toEqual(["Studio/Album/master.wav", "Studio/Album/stems/kick.wav"])
    expect(kept.size).toBe(2)
    expect(r.out.join("\n")).toMatch(/on studio-mac/)
  })
  test("--from asks that machine even when the drive is plugged in here", async () => {
    const { remote } = await keep("Studio:Album/master.wav", { from: "studio-mac" })
    expect(remote[0]).toMatchObject({ ref: "fs:studio:Album/master.wav", from: "studio-mac" })
  })
  test("a big folder is refused before anything is fetched", async () => {
    const many = Array.from({ length: REMOTE_FOLDER_LIMIT + 1 }, (_, i) => ({ path: `Album/f${i}.wav`, bytes: 1 }))
    const { r, remote } = await keep("Studio:Album", {}, { resolveMount: () => null, catalogFiles: async () => many })
    expect(r.err[0]).toMatch(/keep folders of up to 200/)
    expect(remote.length).toBe(0)
  })
  test("a refusal from the machine with the drive stops the keep; nothing is put", async () => {
    const { r, puts } = await keep("Studio:Album/master.wav", {}, { resolveMount: () => null, remoteGet: async () => ({ code: 4, out: [], err: ["studio-mac is not answering"] }) })
    expect(r.code).toBe(4)
    expect(puts.length).toBe(0)
  })
})

describe("copies by content include the vault's", () => {
  test("one line per vault per content; stale holders named, not counted", () => {
    const now = new Date("2026-11-20T00:00:00Z")
    const kept = [
      { sha256: "s1", vault_id: "v-1", vault_name: "masters", target_copies: 3, held_by: "drive:fs:a\ndrive:fs:b\nmachine:laptop" },
      { sha256: "s1", vault_id: "v-1", vault_name: "masters", target_copies: 3, held_by: "drive:fs:a" }, // same content kept twice
    ]
    const reps = [
      { vault_id: "v-1", target: "drive:fs:a", target_label: "Backup A", status: "ok", last_verified_at: "2026-11-19T00:00:00Z" },
      { vault_id: "v-1", target: "drive:fs:b", target_label: "Backup B", status: "ok", last_verified_at: "2026-10-01T00:00:00Z" },
      { vault_id: "v-1", target: "machine:laptop", target_label: "laptop", status: "ok", last_verified_at: "2026-11-19T00:00:00Z" },
    ]
    expect(vaultCopiesBySha(kept, reps, now).get("s1")).toEqual([{ vault: "masters", copies: 2, target: 3, held: ["Backup A", "laptop"], stale: ["Backup B"] }])
  })
})
