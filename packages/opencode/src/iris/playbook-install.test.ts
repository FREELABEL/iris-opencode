import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { installArgs, installState, playbookAction, runPlaybookInstall, ttlCache } from "./playbook-install"

/**
 * #186274 — the Marketplace card could only print a command to paste into a terminal. These are
 * the decisions behind the Install / Update buttons, and the one call that performs the install:
 * the real `iris playbook install`, never a second implementation of it.
 *
 * The shapes are real: `.installed.json` is what `iris playbook install` writes next to the
 * PLAYBOOK.md (measured 2026-09-19: {name, version: "18", sha256, installed_at}); a playbook that
 * was written or synced locally has none.
 */

const root = mkdtempSync(path.join(tmpdir(), "pb-install-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const sha = (s: string) => createHash("sha256").update(s).digest("hex")
function installed(name: string, body: string, record?: object) {
  const dir = path.join(root, name)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "PLAYBOOK.md")
  writeFileSync(file, body)
  if (record) writeFileSync(path.join(dir, ".installed.json"), JSON.stringify(record))
  return file
}

describe("what the local copy is", () => {
  test("installed from the Marketplace: its version, and not edited since", () => {
    const f = installed("a", "BODY", { name: "a", version: "18", sha256: sha("BODY") })
    expect(installState(f)).toEqual({ installedVersion: 18, edited: false })
  })
  test("installed, then changed by hand → edited (an update would discard that)", () => {
    const f = installed("b", "CHANGED", { name: "b", version: "3", sha256: sha("ORIGINAL") })
    expect(installState(f)).toEqual({ installedVersion: 3, edited: true })
  })
  test("written or synced locally (no install record) → no installed version", () => {
    const f = installed("c", "MINE")
    expect(installState(f)).toEqual({ installedVersion: undefined, edited: false })
  })
  test("an unreadable record is treated as no record, never as a version", () => {
    const dir = path.join(root, "d")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "PLAYBOOK.md"), "X")
    writeFileSync(path.join(dir, ".installed.json"), "{not json")
    expect(installState(path.join(dir, "PLAYBOOK.md")).installedVersion).toBeUndefined()
  })
})

describe("which button a card shows", () => {
  test("not installed here → Install", () => {
    expect(playbookAction({ hasLocal: false, version: 5 })).toBe("install")
  })
  test("installed from the Marketplace, a newer version published → Update", () => {
    expect(playbookAction({ hasLocal: true, installedVersion: 17, version: 18 })).toBe("update")
  })
  test("installed and current → Run", () => {
    expect(playbookAction({ hasLocal: true, installedVersion: 18, version: 18 })).toBe("run")
  })
  test("a local copy that was never installed from here → Run, never Update (it is your source)", () => {
    expect(playbookAction({ hasLocal: true, installedVersion: undefined, version: 99 })).toBe("run")
  })
  test("unknown published version → Run (no evidence an update exists)", () => {
    expect(playbookAction({ hasLocal: true, installedVersion: 3, version: undefined })).toBe("run")
  })
})

describe("the install command", () => {
  test("install into the project, as JSON", () => {
    expect(installArgs("capture-sops", { project: true })).toEqual(["playbook", "install", "capture-sops", "--json", "--project"])
  })
  test("update = --force (replaces the local copy)", () => {
    expect(installArgs("capture-sops", { force: true })).toEqual(["playbook", "install", "capture-sops", "--json", "--force"])
  })
  test("a name that is not a slug is refused before anything runs", () => {
    expect(() => installArgs("a; rm -rf ~", {})).toThrow(/not a playbook name/)
    expect(() => installArgs("--force", {})).toThrow(/not a playbook name/)
    expect(() => installArgs("../x", {})).toThrow(/not a playbook name/)
  })
})

describe("running it", () => {
  test("runs the real CLI with those args (no shell), in the project, and reads its JSON", async () => {
    let seen: any
    const r = await runPlaybookInstall(
      { name: "capture-sops", project: "/tmp/proj", force: false },
      {
        cli: "/home/u/.iris/bin/iris",
        exec: async (file, args, opts) => {
          seen = { file, args, cwd: opts.cwd }
          return { code: 0, stdout: '{"installed":"capture-sops","version":"18","location":"project","path":"/tmp/proj/.iris/playbooks/capture-sops/PLAYBOOK.md"}', stderr: "" }
        },
      },
    )
    expect(seen).toEqual({ file: "/home/u/.iris/bin/iris", args: ["playbook", "install", "capture-sops", "--json", "--project"], cwd: "/tmp/proj" })
    expect(r).toMatchObject({ ok: true, version: 18, location: "project" })
  })

  test("a failure says what the CLI said, not 'something went wrong'", async () => {
    const r = await runPlaybookInstall(
      { name: "private-thing" },
      { cli: "/x/iris", exec: async () => ({ code: 1, stdout: "", stderr: "Playbook \"private-thing\" is private — you cannot install it" }) },
    )
    expect(r.ok).toBe(false)
    expect(r.message).toContain("is private")
  })

  test("no IRIS CLI on this machine → a clear message, nothing run", async () => {
    let ran = false
    const r = await runPlaybookInstall({ name: "x" }, { cli: null, exec: async () => ((ran = true), { code: 0, stdout: "", stderr: "" }) })
    expect(ran).toBe(false)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/IRIS CLI/)
  })
})

describe("the account playbook list is cached briefly (#186279)", () => {
  test("a second read inside the window is served from the cache", async () => {
    let now = 0
    let calls = 0
    const c = ttlCache<string, number>(60_000, () => now)
    const load = async () => ++calls
    expect(await c.get("503:marketplace", load)).toBe(1)
    now = 30_000
    expect(await c.get("503:marketplace", load)).toBe(1)
    expect(calls).toBe(1)
  })
  test("after the window it loads again", async () => {
    let now = 0
    let calls = 0
    const c = ttlCache<string, number>(60_000, () => now)
    await c.get("k", async () => ++calls)
    now = 61_000
    expect(await c.get("k", async () => ++calls)).toBe(2)
  })
  test("invalidate (after an install) forces the next read to load", async () => {
    let calls = 0
    const c = ttlCache<string, number>(60_000, () => 0)
    await c.get("k", async () => ++calls)
    c.invalidate()
    expect(await c.get("k", async () => ++calls)).toBe(2)
  })
  test("a failed load is not cached", async () => {
    let calls = 0
    const c = ttlCache<string, number>(60_000, () => 0)
    await expect(c.get("k", async () => { calls++; throw new Error("boom") })).rejects.toThrow("boom")
    expect(await c.get("k", async () => ++calls)).toBe(2)
  })
})
