import { describe, test, expect } from "bun:test"
import { spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import {
  uploadManifest, resolveDrivesBoard, requireDrivesBoard, scanSummary, NO_DRIVES_YET,
  type ManifestDeps, type UploadResult, type BoardApi,
} from "./platform-drives"
import { DRIVES_DATASETS } from "./drives-core"

/**
 * #192927 follow-up. Attachments are stored at cloud-files/<unix-second>_<filename>, so two
 * same-name uploads in one second share an object: the second reads back as the first
 * (verified:false) and deleting either deletes both — that destroyed BK-03's manifest.
 */
function harness(result: UploadResult) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-drives-up-"))
  const tsv = path.join(dir, "files.tsv")
  fs.writeFileSync(tsv, "path\tbytes\tmodified\tkind\na.wav\t1\t\taudio\n")
  const names: string[] = []
  const removed: number[] = []
  const deps: ManifestDeps = {
    upload: async (p) => { names.push(path.basename(p)); return result },
    list: async () => ({ ok: true, files: [{ id: 7, name: "x.txt", title: "drive-manifest fs:abc 2026-11-01" }] }),
    remove: async (id) => { removed.push(id) },
  }
  return { dir, tsv, deps, names, removed }
}

describe("uploadManifest", () => {
  for (const [label, result] of [
    ["verified:false", { ok: true, id: 9, verified: false }],
    ["verified missing", { ok: true, id: 9 }],
    ["ok:false", { ok: false, error: "HTTP 500" }],
  ] as Array<[string, UploadResult]>) {
    test(`${label} is a FAILED upload: no id/key returned, older manifests kept`, async () => {
      const h = harness(result)
      expect(await uploadManifest(h.deps, "fs:abc", h.tsv, "2026-11-09")).toEqual({ fid: null, key: null })
      expect(h.removed).toEqual([])
      fs.rmSync(h.dir, { recursive: true, force: true })
    })
  }

  test("verified:true returns the id + key and removes the older manifest", async () => {
    const h = harness({ ok: true, id: 9, verified: true })
    const r = await uploadManifest(h.deps, "fs:abc", h.tsv, "2026-11-09")
    expect(r.fid).toBe(9)
    expect(r.key).toMatch(/^[0-9a-f]{64}$/)
    expect(h.removed).toEqual([7])
    fs.rmSync(h.dir, { recursive: true, force: true })
  })

  test("every upload goes under a fresh random filename", async () => {
    const h = harness({ ok: true, id: 9, verified: true })
    await uploadManifest(h.deps, "fs:abc", h.tsv, "2026-11-09")
    await uploadManifest(h.deps, "fs:abc", h.tsv, "2026-11-09")
    expect(h.names[0]).toMatch(/^manifest-[0-9a-f]{16}\.enc\.txt$/)
    expect(h.names[1]).not.toBe(h.names[0])
    expect(fs.readdirSync(h.dir)).toEqual(["files.tsv"]) // the temp ciphertext is cleaned up
    fs.rmSync(h.dir, { recursive: true, force: true })
  })
})

// ── #192974: a client never types an internal id ─────────────────────────────────

function fakeBoards(boards: Array<{ id: number; name: string; is_owner: boolean }>, existing: string[] = []) {
  const calls: string[] = []
  const api: BoardApi = {
    list: async () => { calls.push("list"); return boards },
    createBoard: async (name) => { calls.push(`board:${name}`); return 4242 },
    createDataset: async (slug, _name, fields, bloq) => {
      calls.push(`dataset:${slug}@${bloq}:${fields.length}`)
      return existing.includes(slug) ? "exists" : "created"
    },
  }
  return { api, calls }
}

describe("resolveDrivesBoard", () => {
  test("finds the user's own board named Drives — no create, no datasets touched", async () => {
    const { api, calls } = fakeBoards([
      { id: 7, name: "Drives", is_owner: false }, // shared with me, not mine
      { id: 12, name: "Drives", is_owner: true },
    ])
    expect(await resolveDrivesBoard(api, { create: false })).toEqual({ id: 12, created: false })
    expect(calls).toEqual(["list"])
  })

  test("accepts an existing 'IRIS Drives' board (early users)", async () => {
    const { api } = fakeBoards([{ id: 905, name: "IRIS Drives", is_owner: true }, { id: 823, name: "Redwalrus Drive — Inventory", is_owner: true }])
    expect(await resolveDrivesBoard(api, { create: false })).toEqual({ id: 905, created: false })
  })

  test("--bloq / IRIS_DRIVES_BLOQ still override, without a lookup", async () => {
    const { api, calls } = fakeBoards([{ id: 905, name: "IRIS Drives", is_owner: true }])
    expect(await resolveDrivesBoard(api, { override: 31, create: false })).toEqual({ id: 31, created: false })
    expect(calls).toEqual([])
  })

  test("not found + scan → creates the board and all four datasets with the playbook's fields", async () => {
    const { api, calls } = fakeBoards([{ id: 3, name: "Music", is_owner: true }])
    expect(await resolveDrivesBoard(api, { create: true })).toEqual({ id: 4242, created: true })
    expect(calls).toEqual([
      "list", "board:Drives", "dataset:drives@4242:19", "dataset:drive-folders@4242:10", "dataset:drive-findings@4242:9",
      "dataset:drive-reads@4242:10",
    ])
    expect(DRIVES_DATASETS.map((d) => d.slug)).toEqual(["drives", "drive-folders", "drive-findings", "drive-reads"])
    // the manifest key must never be readable by anyone the board is shared with
    expect(DRIVES_DATASETS[0].fields.find((f: any) => f.key === "manifest_key")).toMatchObject({ visibility: "private" })
  })

  test("found + scan → the datasets are made sure of (repairs a half-set-up board), nothing new created", async () => {
    const { api, calls } = fakeBoards([{ id: 905, name: "IRIS Drives", is_owner: true }], ["drives", "drive-folders", "drive-findings"])
    expect(await resolveDrivesBoard(api, { create: true })).toEqual({ id: 905, created: false })
    expect(calls.filter((c) => c.startsWith("board:"))).toEqual([])
  })

  test("'already exists for this bloq' is success", async () => {
    const { api } = fakeBoards([], ["drives", "drive-folders", "drive-findings"])
    expect(await resolveDrivesBoard(api, { create: true })).toEqual({ id: 4242, created: true })
  })

  test("not found + find/list/path → null (nothing created)", async () => {
    const { api, calls } = fakeBoards([])
    expect(await resolveDrivesBoard(api, { create: false })).toBeNull()
    expect(calls).toEqual(["list"])
  })

  test("requireDrivesBoard: none found prints the plain next step and exits non-zero", async () => {
    const { api } = fakeBoards([])
    const errs: string[] = []
    const origErr = console.error
    const origExit = process.exit
    console.error = (...a: any[]) => { errs.push(a.join(" ")) }
    ;(process as any).exit = (code: number) => { throw new Error(`exit ${code}`) }
    try {
      await expect(requireDrivesBoard(api, undefined, { create: false })).rejects.toThrow("exit 1")
    } finally {
      console.error = origErr
      ;(process as any).exit = origExit
    }
    expect(errs.join("\n")).toContain(NO_DRIVES_YET)
    expect(NO_DRIVES_YET).toBe("No drives cataloged yet — run: iris drives scan <drive or folder>")
    expect(errs.join("\n")).not.toMatch(/bloq|IRIS_DRIVES_BLOQ/i)
  })
})

// ── #192974: scan speaks client, not developer ───────────────────────────────────

describe("scanSummary", () => {
  test("one line a client can act on", () => {
    expect(scanSummary({ label: "Studio footage", files: 60072, bytes: 3.0e12, folders: 21, sensitive: 292, encrypted: false })).toBe(
      "Cataloged 'Studio footage': 60,072 files · 3.0 TB · 21 project folders · 292 sensitive files (drive NOT encrypted — run: iris drives list to review)",
    )
    expect(scanSummary({ label: "BK-03", files: 1, bytes: 5e8, folders: 1, sensitive: 0, encrypted: true })).toBe(
      "Cataloged 'BK-03': 1 file · 500 MB · 1 project folder · no sensitive files",
    )
    expect(scanSummary({ label: "BK-03", files: 9, bytes: 2e9, folders: 2, sensitive: 1, encrypted: true })).toBe(
      "Cataloged 'BK-03': 9 files · 2.0 GB · 2 project folders · 1 sensitive file (drive encrypted — contained)",
    )
  })
})

describe("iris drives scan output (runs the CLI, dry run, signed out)", () => {
  const entry = path.join(import.meta.dir, "..", "..", "index.ts")
  function run(...extra: string[]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "iris-drives-home-"))
    const vol = path.join(home, "Footage")
    fs.mkdirSync(path.join(vol, "Shoot"), { recursive: true })
    fs.writeFileSync(path.join(vol, "Shoot", "A001.mov"), "x")
    fs.writeFileSync(path.join(vol, "Shoot", ".env"), "x")
    const env: Record<string, string> = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" } as any
    for (const k of Object.keys(env)) if (/^(IRIS_|XDG_)/.test(k)) delete env[k] // signed out: no token anywhere
    const r = spawnSync(process.execPath, ["run", entry, "drives", "scan", vol, "--dry-run", ...extra], { encoding: "utf8", env, timeout: 120_000 })
    // what the scan left on this machine: drive.json (the drive's row) and files.tsv (the manifest)
    const store = path.join(home, ".iris", "drives")
    const dir = fs.existsSync(store) ? fs.readdirSync(store).map((d) => path.join(store, d)).find((d) => fs.existsSync(path.join(d, "drive.json"))) : undefined
    const drive = dir ? JSON.parse(fs.readFileSync(path.join(dir, "drive.json"), "utf8")).drive : null
    const tsv = dir ? fs.readFileSync(path.join(dir, "files.tsv"), "utf8") : ""
    fs.rmSync(home, { recursive: true, force: true })
    return { out: `${r.stdout}\n${r.stderr}`, status: r.status, drive, tsv }
  }

  test("default: no drive id, no local manifest path, no Atlas row counts", () => {
    const { out, status } = run()
    expect(status).toBe(0)
    expect(out).toContain("Would catalog 'Footage': 2 files · under 1 MB · 1 project folder · 1 sensitive file (drive NOT encrypted")
    expect(out).not.toMatch(/\b(fs|dir):/)
    expect(out).not.toContain("files.tsv")
    expect(out).not.toMatch(/atlas drive-|rows →/)
  }, 120_000)

  test("#192914: the drive row carries free_gb / last_seen_on / last_seen_at; the manifest has a sha256 column", () => {
    const { drive, tsv } = run()
    expect(typeof drive.free_gb).toBe("number")
    expect(drive.last_seen_on).toBe(os.hostname())
    expect(drive.last_seen_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    const lines = tsv.split("\n").filter(Boolean)
    expect(lines[0]).toBe("path\tbytes\tmodified\tkind\tsha256")
    // the .env is sensitive → hashed; the video is not hashed by default
    expect(lines.find((l) => l.startsWith("Shoot/.env"))!.split("\t")[4]).toMatch(/^[0-9a-f]{64}$/)
    expect(lines.find((l) => l.startsWith("Shoot/A001.mov"))!.split("\t")[4]).toBe("")
  }, 120_000)

  test("--checksums none writes the old 4-column manifest", () => {
    const { tsv } = run("--checksums", "none")
    expect(tsv.split("\n")[0]).toBe("path\tbytes\tmodified\tkind")
  }, 120_000)

  test("--verbose prints the old detail", () => {
    const { out } = run("--verbose")
    expect(out).toMatch(/\bdir:/)
    expect(out).toContain("files.tsv")
  }, 120_000)
})
