import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { gzipSync } from "zlib"
import {
  collectBundle,
  extractBundle,
  packBundle,
  sha256Bytes,
  skipReason,
  unpackBundle,
  unsafePathReason,
  type BundleFile,
} from "../../src/skill/bundle"

// #188688 — a playbook is a folder. These guard the two directions it travels: what leaves the
// author's machine (collect/pack) and what is allowed onto an installer's disk (unpack/extract).

const tmp = () => mkdtempSync(path.join(tmpdir(), "pb-bundle-"))
const manifestOf = (files: { path: string; data: Uint8Array }[]): BundleFile[] =>
  files.map((f) => ({ path: f.path, bytes: f.data.length, sha256: sha256Bytes(f.data) }))

/** A raw ustar entry with an arbitrary name/type, for archives our packer would refuse to make. */
function rawEntry(name: string, data: string, type = "0", linkname = ""): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100)
  h.write("0000644\0", 100)
  h.write("0000000\0", 108)
  h.write("0000000\0", 116)
  h.write(data.length.toString(8).padStart(11, "0") + "\0", 124)
  h.write("00000000000\0", 136)
  h.write("        ", 148)
  h.write(type, 156)
  h.write(linkname, 157, 100)
  h.write("ustar\0", 257)
  h.write("00", 263)
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148)
  const body = Buffer.alloc(Math.ceil(data.length / 512) * 512)
  body.write(data)
  return Buffer.concat([h, body])
}
const rawTar = (...entries: Buffer[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))

describe("pack / unpack", () => {
  const files = [
    { path: "assets/poster.html", data: Buffer.from("<html>poster</html>") },
    { path: "assets/frame.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255, 0]) },
    { path: "scripts/determinism.sh", data: Buffer.from("#!/bin/sh\necho ok\n"), executable: true },
    { path: "deep/" + "d".repeat(60) + "/" + "e".repeat(60) + "/file.txt", data: Buffer.from("long path") },
  ]

  test("round-trips text, binary, the executable bit and a path over 100 chars", () => {
    const out = unpackBundle(packBundle(files))
    expect(out.map((f) => f.path).sort()).toEqual(files.map((f) => f.path).sort())
    for (const f of files) {
      const got = out.find((o) => o.path === f.path)!
      expect(Buffer.compare(got.data, f.data)).toBe(0)
      expect(got.executable).toBe(!!f.executable)
    }
  })

  test("is deterministic: same files in any order give the same bytes, so the same sha", () => {
    expect(sha256Bytes(packBundle(files))).toBe(sha256Bytes(packBundle([...files].reverse())))
  })

  test("system tar reads what we write", () => {
    const dir = tmp()
    writeFileSync(path.join(dir, "b.tar.gz"), packBundle(files))
    const listed = execFileSync("tar", ["-tzf", path.join(dir, "b.tar.gz")], { encoding: "utf8" }).trim().split("\n").sort()
    expect(listed).toEqual(files.map((f) => f.path).sort())
  })

  test("we read what system tar writes (ustar)", () => {
    const dir = tmp()
    mkdirSync(path.join(dir, "src/assets"), { recursive: true })
    writeFileSync(path.join(dir, "src/assets/a.txt"), "from gnu tar")
    execFileSync("tar", ["--format=ustar", "-czf", path.join(dir, "b.tar.gz"), "-C", path.join(dir, "src"), "assets/a.txt"])
    const out = unpackBundle(readFileSync(path.join(dir, "b.tar.gz")))
    expect(out.map((f) => [f.path, f.data.toString()])).toEqual([["assets/a.txt", "from gnu tar"]])
  })
})

describe("what may land on an installer's disk", () => {
  test.each(["../escape", "a/../../escape", "/etc/passwd", "C:/x", "a\\b", "./x", "a//b", ""])("refuses path %p", (p) => {
    expect(unsafePathReason(p)).not.toBeNull()
  })

  test("a hand-made archive with ../ is refused before anything is written", () => {
    expect(() => unpackBundle(rawTar(rawEntry("../../.bashrc", "pwned")))).toThrow(/refused/)
  })

  test("a symlink entry is refused, not followed", () => {
    expect(() => unpackBundle(rawTar(rawEntry("assets/key", "", "2", "/home/me/.ssh/id_rsa")))).toThrow(/not a regular file/)
  })

  test("a hardlink entry is refused", () => {
    expect(() => unpackBundle(rawTar(rawEntry("assets/x", "", "1", "/etc/passwd")))).toThrow(/not a regular file/)
  })

  test("extract writes NOTHING if any file fails its published hash", () => {
    const dir = tmp()
    const good = [
      { path: "assets/a.txt", data: Buffer.from("aaa") },
      { path: "assets/b.txt", data: Buffer.from("bbb") },
    ]
    const manifest = manifestOf(good)
    manifest[1].sha256 = "0".repeat(64)
    expect(() => extractBundle(dir, packBundle(good), manifest)).toThrow(/does not match/)
    expect(existsSync(path.join(dir, "assets/a.txt"))).toBe(false)
  })

  test("extract refuses a file the registry did not list", () => {
    const dir = tmp()
    const files = [{ path: "assets/a.txt", data: Buffer.from("a") }, { path: "assets/extra.sh", data: Buffer.from("x") }]
    expect(() => extractBundle(dir, packBundle(files), manifestOf(files.slice(0, 1)))).toThrow()
  })

  test("extract writes, keeps the executable bit, and removes only files the last install put there", () => {
    const dir = tmp()
    const v1 = [
      { path: "assets/old.sh", data: Buffer.from("old"), executable: true },
      { path: "assets/keep.html", data: Buffer.from("k1") },
    ]
    extractBundle(dir, packBundle(v1), manifestOf(v1))
    if (process.platform !== "win32") expect(statSync(path.join(dir, "assets/old.sh")).mode & 0o111).not.toBe(0)

    writeFileSync(path.join(dir, "assets/my-notes.md"), "mine") // the user's own file
    const v2 = [{ path: "assets/keep.html", data: Buffer.from("k2") }]
    const r = extractBundle(dir, packBundle(v2), manifestOf(v2), v1.map((f) => f.path))

    expect(r.removed).toEqual(["assets/old.sh"])
    expect(readFileSync(path.join(dir, "assets/keep.html"), "utf8")).toBe("k2")
    expect(existsSync(path.join(dir, "assets/old.sh"))).toBe(false)
    expect(readFileSync(path.join(dir, "assets/my-notes.md"), "utf8")).toBe("mine")
  })
})

describe("what leaves the author's machine", () => {
  test("bundles assets; skips the markdown, secrets, deps, VCS, run output and symlinks", () => {
    const dir = tmp()
    const put = (p: string, d = "x") => {
      mkdirSync(path.dirname(path.join(dir, p)), { recursive: true })
      writeFileSync(path.join(dir, p), d)
    }
    put("PLAYBOOK.md")
    put(".installed.json")
    put("assets/poster.html")
    put("assets/measure_band.py")
    put("assets/.env")
    put("assets/.env.production")
    put("assets/server.pem")
    put("id_rsa")
    put("node_modules/puppeteer/index.js")
    put(".git/HEAD")
    put("runs/2026-10-09/out.mp4")
    put("render.log")
    symlinkSync("/etc/hostname", path.join(dir, "assets/link"))

    const { files, skipped } = collectBundle(dir)
    expect(files.map((f) => f.path)).toEqual(["assets/measure_band.py", "assets/poster.html"])
    const why = Object.fromEntries(skipped.map((s) => [s.path, s.reason]))
    expect(why["assets/.env"]).toBe("looks like a secret")
    expect(why["assets/.env.production"]).toBe("looks like a secret")
    expect(why["assets/server.pem"]).toBe("looks like a secret")
    expect(why["id_rsa"]).toBe("looks like a secret")
    expect(why["assets/link"]).toBe("symlink (not followed)")
    expect(why["node_modules"]).toBe("build/VCS folder")
  })

  test("a folder with only PLAYBOOK.md has no bundle", () => {
    const dir = tmp()
    writeFileSync(path.join(dir, "PLAYBOOK.md"), "# x")
    expect(collectBundle(dir).files).toEqual([])
    expect(skipReason("PLAYBOOK.md")).toBe("the playbook itself")
    expect(skipReason("assets/PLAYBOOK.md")).toBeNull() // only the top-level one is the playbook
  })
})
