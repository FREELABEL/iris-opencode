import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { goldenOf } from "./golden-of"

const read = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"))

// If this fails, the model's behaviour changed. If that was intended, `bun run golden` and review
// the diff of test/fixtures/golden.json in the PR — every consumer (Desktop, CLI, Genesis) moves with it.
test("golden: every fixture row at capturedAt, +6h, +30h", () => {
  expect(goldenOf(read("heartbeats.json"))).toEqual(read("golden.json"))
})

test("golden covers every fixture row at three moments", () => {
  const g = read("golden.json")
  expect(g.at.map((a: { offsetHours: number }) => a.offsetHours)).toEqual([0, 6, 30])
  for (const a of g.at) expect(a.rows.length).toBe(read("heartbeats.json").heartbeats.length)
})
