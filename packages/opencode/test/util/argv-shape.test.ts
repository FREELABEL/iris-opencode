import { expect, test } from "bun:test"
import { argvShape } from "../../src/util/argv-shape"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const CANARY = "canary-SSN 078-05-1120"
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"

test("keeps the command and flag names", () => {
  expect(argvShape(["run", "-m", "localo/stub", "--format", "json", "hello"])).toEqual({
    command: "run",
    flags: ["-m", "--format"],
  })
})

test("a prompt and a secret flag value never survive", () => {
  const shape = JSON.stringify(
    argvShape(["run", CANARY, "--api-key", KEY, "--token=" + KEY, "--", "-x", KEY, "--after=" + CANARY]),
  )
  expect(shape).not.toContain("078-05-1120")
  expect(shape).not.toContain("sk-ant")
  expect(argvShape(["run", "--token=" + KEY]).flags).toEqual(["--token"])
})

test("a secret shaped like a flag is dropped", () => {
  expect(argvShape(["--" + KEY]).flags).toEqual([])
})

test("a first argument that is not a command word is not logged", () => {
  expect(argvShape([CANARY]).command).toBeUndefined()
  expect(argvShape(["/tmp/private-project"]).command).toBeUndefined()
  expect(argvShape([]).command).toBeUndefined()
})

test("the entry point does not log raw argv", () => {
  const source = readFileSync(join(import.meta.dir, "../../src/index.ts"), "utf8")
  expect(source).not.toMatch(/args:\s*process\.argv/)
})
