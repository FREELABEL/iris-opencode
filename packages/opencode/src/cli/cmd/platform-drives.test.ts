import { describe, test, expect } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { uploadManifest, type ManifestDeps, type UploadResult } from "./platform-drives"

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
