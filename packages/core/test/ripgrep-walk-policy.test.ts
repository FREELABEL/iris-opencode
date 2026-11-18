/**
 * How far a walk may go (#191073, #191071).
 *
 * The agent ran Glob `**\/.git` from `/`: `.git` is a directory and Glob lists files, so it
 * could never match, the 100-result cap never fired, and the walk covered the whole disk for
 * 9+ minutes. On macOS that walk entered ~/Library/Containers, where each app's container
 * raises its own "IRIS would like to access data from other apps" prompt — thousands of them.
 */
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { readdirSync, readlinkSync } from "fs"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import * as WalkPolicy from "@opencode-ai/core/ripgrep/walk-policy"
import { RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Ripgrep.node))
const mac = { home: "/Users/alex", platform: "darwin" as const }
const linux = { home: "/home/alex", platform: "linux" as const }

describe("WalkPolicy.scope — refuses walks that can only mean 'the whole disk'", () => {
  test("the disk root, and every folder above the home folder", () => {
    expect(WalkPolicy.scope("/", mac).refuse).toContain("root of the disk")
    expect(WalkPolicy.scope("/Users", mac).refuse).toContain("every user's home")
    expect(WalkPolicy.scope("/home", linux).refuse).toContain("every user's home")
  })

  test("system and pseudo filesystems", () => {
    expect(WalkPolicy.scope("/Volumes", mac).refuse).toBeDefined()
    expect(WalkPolicy.scope("/System", mac).refuse).toBeDefined()
    expect(WalkPolicy.scope("/proc", linux).refuse).toBeDefined()
    expect(WalkPolicy.scope("/proc/1/fd", linux).refuse).toBeDefined()
  })

  test("the refusal tells the model what to do instead", () => {
    expect(WalkPolicy.scope("/", mac).refuse).toContain("**/.git/HEAD")
  })

  test("project folders and the home folder itself are allowed", () => {
    expect(WalkPolicy.scope("/Users/alex", mac).refuse).toBeUndefined()
    expect(WalkPolicy.scope("/Users/alex/code/app", mac).refuse).toBeUndefined()
    expect(WalkPolicy.scope("/home/alex/work", linux).refuse).toBeUndefined()
    // A folder that merely shares a prefix with a refused one is not inside it.
    expect(WalkPolicy.scope("/procurement", linux).refuse).toBeUndefined()
  })
})

describe("WalkPolicy.scope — prunes macOS protected folders the walk would pass through", () => {
  test("from home: ~/Library is pruned whole, anchored to THIS home", () => {
    const { excludes } = WalkPolicy.scope("/Users/alex", mac)
    expect(excludes).toContain("--glob=!/Library")
    expect(excludes).toContain("--glob=!**/Library/Containers")
    expect(excludes).toContain("--glob=!**/Library/Group Containers")
  })

  test("from inside ~/Library: the containers below are pruned by their relative path", () => {
    const { excludes } = WalkPolicy.scope("/Users/alex/Library", mac)
    expect(excludes).not.toContain("--glob=!/Library")
    expect(excludes).toContain("--glob=!/Containers")
    expect(excludes).toContain("--glob=!/Group Containers")
  })

  test("a walk that STARTS inside a container is the user's choice and is not pruned away", () => {
    const { refuse, excludes } = WalkPolicy.scope("/Users/alex/Library/Containers", mac)
    expect(refuse).toBeUndefined()
    expect(excludes).not.toContain("--glob=!/Containers")
    expect(excludes.some((e) => e === "--glob=!/" || e === "--glob=!")).toBe(false)
  })

  test("nothing is pruned off macOS", () => {
    expect(WalkPolicy.scope("/home/alex", linux).excludes).toEqual([])
  })
})

describe("WalkPolicy.withExcludes — excludes must be the LAST globs (ripgrep: last match wins)", () => {
  const ex = ["--glob=!**/Library/Containers"]
  test("list walks: after the pattern glob, before the path", () => {
    expect(WalkPolicy.withExcludes(["--no-config", "--files", "--glob=**/*", "--glob=!**/.git/**", "."], ex)).toEqual([
      "--no-config", "--files", "--glob=**/*", "--glob=!**/.git/**", ...ex, ".",
    ])
  })
  test("grep: before --, so the pattern and path stay positional", () => {
    expect(WalkPolicy.withExcludes(["--json", "--glob=*.ts", "--", "needle", "."], ex)).toEqual([
      "--json", "--glob=*.ts", ...ex, "--", "needle", ".",
    ])
  })
  test("nothing to add leaves the args alone", () => {
    expect(WalkPolicy.withExcludes(["--files", "."], [])).toEqual(["--files", "."])
  })
})

describe("Ripgrep — the policy is enforced where every walk starts", () => {
  it.live("a walk rooted at / fails fast with the reason, before ripgrep runs", () =>
    Effect.gen(function* () {
      const ripgrep = yield* Ripgrep.Service
      const started = Date.now()
      const failure = yield* ripgrep.glob({ cwd: "/", pattern: "**/.git", limit: 100 }).pipe(Effect.flip)
      expect(failure.message).toContain("Refusing to search /")
      expect(Date.now() - started).toBeLessThan(2_000)
    }),
  )

  it.live("**/.git/HEAD finds repositories (it found none: .git is hidden and was excluded)", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          for (const repo of ["a", "nested/b"]) {
            yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, repo, ".git", "objects", "aa"), { recursive: true }))
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, repo, ".git", "HEAD"), "ref: refs/heads/main\n"))
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, repo, ".git", "objects", "aa", "obj"), "x"))
          }
          const ripgrep = yield* Ripgrep.Service

          const repos = yield* ripgrep.glob({ cwd: tmp.path, pattern: "**/.git/HEAD", limit: 100 })
          expect(repos.map((e) => e.path).sort()).toEqual([
            RelativePath.make("a/.git/HEAD"),
            RelativePath.make("nested/b/.git/HEAD"),
          ])
          // Naming .git opens its top level only — never the object store.
          const inside = yield* ripgrep.glob({ cwd: tmp.path, pattern: "**/.git/**", limit: 100 })
          expect(inside.map((e) => e.path).some((p) => p.includes("objects"))).toBe(false)
          // An ordinary pattern still never sees .git.
          const all = yield* ripgrep.glob({ cwd: tmp.path, pattern: "**/*", limit: 100 })
          expect(all.map((e) => e.path).some((p) => p.includes(".git"))).toBe(false)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("a walk that outlives its budget is stopped, reports the cutoff, and leaves no ripgrep behind", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          // ripgrep blocks forever reading a FIFO nobody writes to: the budget is the only way out.
          const fifo = path.join(tmp.path, "pipe")
          yield* Effect.promise(() => Bun.$`mkfifo ${fifo}`.quiet())
          const ripgrep = yield* Ripgrep.Service

          let cutoff: Ripgrep.Cutoff | undefined
          const started = Date.now()
          const matches = yield* ripgrep.grep({
            cwd: tmp.path,
            pattern: "x",
            file: "pipe",
            limit: 10,
            budgetMs: 300,
            onCutoff: (c) => (cutoff = c),
          })
          expect(matches).toEqual([])
          expect(cutoff?.reason).toBe("time")
          expect(Date.now() - started).toBeLessThan(5_000)

          // The process must be gone, not orphaned still walking.
          if (process.platform === "linux") {
            yield* Effect.sleep("300 millis")
            const alive = readdirSync("/proc")
              .filter((p) => /^\d+$/.test(p))
              .filter((pid) => {
                try {
                  return readlinkSync(`/proc/${pid}/cwd`) === tmp.path
                } catch {
                  return false
                }
              })
            expect(alive).toEqual([])
          }
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // macOS only: off macOS nothing is pruned (WalkPolicy.scope), so there is nothing to see.
  if (process.platform === "darwin")
    it.live("macOS: a walk from above never lists anything inside a Library/Containers folder", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const box = path.join(tmp.path, "someone", "Library", "Containers", "com.example.app", "Data")
            yield* Effect.promise(() => fs.mkdir(box, { recursive: true }))
            yield* Effect.promise(() => fs.writeFile(path.join(box, "secret.txt"), "x"))
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "visible.txt"), "x"))
            // `**/*` matches the Containers folder itself: the case that defeated excludes placed first.
            const files = yield* (yield* Ripgrep.Service).glob({ cwd: tmp.path, pattern: "**/*", limit: 100 })
            expect(files.map((e) => e.path)).toEqual([RelativePath.make("visible.txt")])
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )

  it.live("a walk inside its budget is untouched", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "a.ts"), "x"))
          let cutoff: Ripgrep.Cutoff | undefined
          const files = yield* (yield* Ripgrep.Service).glob({
            cwd: tmp.path,
            pattern: "**/*.ts",
            limit: 10,
            onCutoff: (c) => (cutoff = c),
          })
          expect(files.map((e) => e.path)).toEqual([RelativePath.make("a.ts")])
          expect(cutoff).toBeUndefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
