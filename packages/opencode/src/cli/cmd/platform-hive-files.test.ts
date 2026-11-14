import { describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import { join } from "path"

/**
 * yargs DROPS a lone "-" from a variadic positional. `fs push <node> - --to <dir>` therefore saw
 * zero files and printed {"ok": true, "results": []} — success, with nothing moved. Found by a live
 * run, not by the unit tests, because it lives in argument parsing. These run the real CLI; every
 * case is refused before the node is resolved, so no network or sign-in is involved.
 */
const ENTRY = join(import.meta.dir, "..", "..", "index.ts")
function push(args: string[], stdin = "hi") {
  const r = spawnSync(process.execPath, ["run", ENTRY, "hive", "fs", "push", "some-node", ...args], {
    input: stdin,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" },
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}
// Each case boots the whole CLI; a cold start passes bun's 5 s default on a warm laptop and not in CI.
const BOOT = 60_000

describe("hive fs push — a stream or nothing is never silently 'ok'", () => {
  test("'-' reaches the command (it asks for --name instead of reporting success)", () => {
    const r = push(["-", "--to", "/tmp/x"])
    expect(r.code).toBe(1)
    expect(r.out).toContain("needs --name")
    expect(r.out).not.toContain('"ok": true')
  }, BOOT)

  test("--stdin is the same as '-'", () => {
    expect(push(["--stdin", "--to", "/tmp/x"]).out).toContain("needs --name")
  }, BOOT)

  test("no source at all is an error, not an empty success", () => {
    const r = push(["--to", "/tmp/x", "--json"])
    expect(r.code).toBe(1)
    expect(r.out).toContain("Nothing to push")
  }, BOOT)

  test("a file and '-' together are refused", () => {
    expect(push(["./a.txt", "-", "--to", "/tmp/x", "--name", "a"]).out).toContain("must be the only source")
  }, BOOT)

  test("a path as --name is refused before anything connects", () => {
    expect(push(["-", "--to", "/tmp/x", "--name", "../evil"]).out).toContain("plain file name")
  }, BOOT)
})
