/**
 * How far a CLI walk may go (#191073, #191071). Same policy as Desktop (core Ripgrep.run):
 * the agent ran Glob `**\/.git` from `/`, nothing could match, and the walk covered the whole
 * disk; on macOS it entered ~/Library/Containers and raised a privacy prompt per app.
 */
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import * as WalkPolicy from "../../src/file/walk-policy"
import { Ripgrep } from "../../src/file/ripgrep"
import { directoryHint } from "../../src/tool/glob"

const mac = { home: "/Users/alex", platform: "darwin" as const }
const linux = { home: "/home/alex", platform: "linux" as const }

describe("WalkPolicy.scope", () => {
  test("refuses the disk root and everything above the home folder, with what to do instead", () => {
    expect(WalkPolicy.scope("/", mac).refuse).toContain("root of the disk")
    expect(WalkPolicy.scope("/", mac).refuse).toContain("**/.git/HEAD")
    expect(WalkPolicy.scope("/Users", mac).refuse).toBeDefined()
    expect(WalkPolicy.scope("/home", linux).refuse).toBeDefined()
    expect(WalkPolicy.scope("/proc/self", linux).refuse).toBeDefined()
  })

  test("allows home and projects; a shared prefix is not 'inside'", () => {
    expect(WalkPolicy.scope("/Users/alex", mac).refuse).toBeUndefined()
    expect(WalkPolicy.scope("/home/alex/work", linux).refuse).toBeUndefined()
    expect(WalkPolicy.scope("/procurement", linux).refuse).toBeUndefined()
  })

  test("macOS: prunes ~/Library from home and app containers anywhere; nothing off macOS", () => {
    const fromHome = WalkPolicy.scope("/Users/alex", mac).excludes
    expect(fromHome).toContain("--glob=!/Library")
    expect(fromHome).toContain("--glob=!**/Library/Group Containers")
    expect(WalkPolicy.scope("/Users/alex/Library", mac).excludes).toContain("--glob=!/Containers")
    expect(WalkPolicy.scope("/home/alex", linux).excludes).toEqual([])
  })
})

describe("Ripgrep.files / walkArgs", () => {
  test("a walk rooted at / is refused before ripgrep starts", async () => {
    const started = Date.now()
    await expect(Array.fromAsync(Ripgrep.files({ cwd: "/", glob: ["**/.git"] }))).rejects.toThrow("Refusing to search /")
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("ls and the file index may start at / (refuseBroad: false) — still pruned and budgeted", () => {
    expect(() => Ripgrep.walkArgs("/", false)).not.toThrow()
    expect(() => Ripgrep.walkArgs("/")).toThrow()
  })

  test("stopping early does not wait for the rest of the walk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "walk-early-"))
    try {
      await Promise.all(Array.from({ length: 3000 }, (_, i) => fs.writeFile(path.join(dir, `f${i}.txt`), "")))
      let n = 0
      for await (const _ of Ripgrep.files({ cwd: dir })) if (++n >= 1) break
      // Smoke test: ripgrep finishes 3,000 files in ms, so this cannot tell kill from wait.
      // The kill-on-break is exercised by the real-tree run on the hive and the Mac.
      expect(n).toBe(1)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

// macOS only: off macOS nothing is pruned, so there is nothing to see.
describe.if(process.platform === "darwin")("macOS pruning survives a catch-all pattern", () => {
  test("`**/*` does not re-open Library/Containers (excludes must be the LAST globs)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "walk-mac-"))
    try {
      const box = path.join(dir, "u", "Library", "Containers", "com.example.app", "Data")
      await fs.mkdir(box, { recursive: true })
      await fs.writeFile(path.join(box, "secret.txt"), "x")
      await fs.writeFile(path.join(dir, "visible.txt"), "x")
      const files = await Array.fromAsync(Ripgrep.files({ cwd: dir, glob: ["**/*"] }))
      expect(files).toEqual(["visible.txt"])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("Ripgrep.bound — budget and Stop kill the process", () => {
  test("the budget kills it and reports the cutoff", async () => {
    const proc = Bun.spawn(["sleep", "30"])
    let cutoff: Ripgrep.Cutoff | undefined
    const started = Date.now()
    const unbound = Ripgrep.bound(proc, { budgetMs: 200, onCutoff: (c) => (cutoff = c) })
    await proc.exited
    unbound()
    expect(cutoff?.reason).toBe("time")
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("Stop (abort) kills it, with no cutoff reported", async () => {
    const proc = Bun.spawn(["sleep", "30"])
    const ctl = new AbortController()
    let cutoff: Ripgrep.Cutoff | undefined
    const unbound = Ripgrep.bound(proc, { budgetMs: 60_000, signal: ctl.signal, onCutoff: (c) => (cutoff = c) })
    setTimeout(() => ctl.abort(), 100)
    const started = Date.now()
    await proc.exited
    unbound()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(cutoff).toBeUndefined()
  })

  test("a process that finishes in time is left alone", async () => {
    const proc = Bun.spawn(["true"])
    let cutoff: Ripgrep.Cutoff | undefined
    const unbound = Ripgrep.bound(proc, { budgetMs: 5_000, onCutoff: (c) => (cutoff = c) })
    expect(await proc.exited).toBe(0)
    unbound()
    expect(cutoff).toBeUndefined()
  })
})

describe("directoryHint", () => {
  test(".git always points at **/.git/HEAD; other names only when nothing matched", () => {
    expect(directoryHint("**/.git", 9)).toContain("**/.git/HEAD")
    expect(directoryHint("**/node_modules", 0)).toContain("**/node_modules/*")
    expect(directoryHint("**/Makefile", 1)).toBeUndefined()
    expect(directoryHint("**/*.ts", 0)).toBeUndefined()
  })
})
