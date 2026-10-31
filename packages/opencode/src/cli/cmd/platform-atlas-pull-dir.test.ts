import { describe, expect, test } from "bun:test"
import { resolvePullDir } from "./platform-atlas-tree"

// #189896 — `pull 352 /tmp/dir` was rejected; the folder is now a positional meaning --out.
describe("resolvePullDir", () => {
  test("a positional folder is used as the output folder", () => {
    expect(resolvePullDir("/tmp/a", undefined)).toEqual({ dir: "/tmp/a" })
  })
  test("--out alone still works", () => {
    expect(resolvePullDir(undefined, "/tmp/b")).toEqual({ dir: "/tmp/b" })
  })
  test("neither: undefined, so pull keeps its default folder", () => {
    expect(resolvePullDir(undefined, undefined)).toEqual({ dir: undefined })
  })
  test("both and different is refused, not guessed", () => {
    expect("error" in resolvePullDir("/tmp/a", "/tmp/b")).toBe(true)
  })
  test("both and the same is fine", () => {
    expect(resolvePullDir("/tmp/a", "/tmp/a")).toEqual({ dir: "/tmp/a" })
  })
})
