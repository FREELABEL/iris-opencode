import { describe, expect, test } from "bun:test"
import { lostEdits, mainSourceFor } from "../script/check-iris-v1-edits"

describe("mainSourceFor — which main file the release copies over each path (#190589)", () => {
  test("platform commands come from packages/opencode/src", () => {
    expect(mainSourceFor("packages/cli/src/iris-v1/cli/cmd/platform-hive.ts")).toBe(
      "packages/opencode/src/cli/cmd/platform-hive.ts",
    )
  })

  test("every copy of the capability index comes from main's", () => {
    for (const p of ["packages/cli/src/iris-v1/capabilities.json", "packages/cli/src/capabilities.json", "packages/cli/capabilities.json"])
      expect(mainSourceFor(p)).toBe("packages/opencode/capabilities.json")
  })

  test("vendored sources map to their packages; vendored config is left alone", () => {
    expect(mainSourceFor("packages/cli/src/iris-v1/vendor/js/src/client.ts")).toBe("packages/sdk/js/src/client.ts")
    expect(mainSourceFor("packages/cli/src/iris-v1/vendor/lazy.ts")).toBe("packages/util/src/lazy.ts")
    expect(mainSourceFor("packages/cli/src/iris-v1/vendor/pulse-core/index.ts")).toBe("packages/pulse-core/src/index.ts")
    expect(mainSourceFor("packages/cli/src/iris-v1/vendor/js/package.json")).toBeNull()
  })

  test("index.ts is regenerated, SYNCED_FROM and files outside the layer are not touched", () => {
    expect(mainSourceFor("packages/cli/src/iris-v1/index.ts")).toBe("patched")
    expect(mainSourceFor("packages/cli/src/iris-v1/SYNCED_FROM")).toBeNull()
    expect(mainSourceFor("packages/cli/src/cli/cmd/iris2.ts")).toBeNull()
  })
})

describe("lostEdits", () => {
  const files: Record<string, string | null> = {
    "HEAD:packages/cli/src/iris-v1/cli/cmd/platform-hive.ts": "rerun added here only",
    "main:packages/opencode/src/cli/cmd/platform-hive.ts": "old",
    "HEAD:packages/cli/src/iris-v1/cli/cmd/platform-agents.ts": "synced",
    "main:packages/opencode/src/cli/cmd/platform-agents.ts": "synced",
    "HEAD:packages/cli/src/iris-v1/cli/cmd/gone.ts": null,
    "main:packages/opencode/src/cli/cmd/gone.ts": "still on main",
  }
  const read = async (ref: string, file: string) => files[`${ref}:${file}`] ?? null

  test("refuses an edit main does not have, and a deletion main would undo", async () => {
    const lost = await lostEdits(
      [
        "packages/cli/src/iris-v1/cli/cmd/platform-hive.ts",
        "packages/cli/src/iris-v1/cli/cmd/platform-agents.ts",
        "packages/cli/src/iris-v1/cli/cmd/gone.ts",
      ],
      "HEAD",
      ["main"],
      read,
    )
    expect(lost.map((l) => [l.file, l.mainFile])).toEqual([
      ["packages/cli/src/iris-v1/cli/cmd/platform-hive.ts", "packages/opencode/src/cli/cmd/platform-hive.ts"],
      ["packages/cli/src/iris-v1/cli/cmd/gone.ts", "packages/opencode/src/cli/cmd/gone.ts"],
    ])
  })

  test("a sync commit — every file equal to main — passes", async () => {
    expect(await lostEdits(["packages/cli/src/iris-v1/cli/cmd/platform-agents.ts"], "HEAD", ["main"], read)).toEqual([])
  })

  test("an edit to the regenerated index.ts is refused, except in a sync", async () => {
    const lost = await lostEdits(["packages/cli/src/iris-v1/index.ts"], "HEAD", ["main"], read)
    expect(lost[0]?.mainFile).toBe("packages/opencode/src/index.ts")
    expect(await lostEdits(["packages/cli/src/iris-v1/index.ts"], "HEAD", ["main"], read, true)).toEqual([])
  })

  test("a sync is judged against the main commit it synced from, not today's main", async () => {
    const at: Record<string, string> = {
      "HEAD:packages/cli/src/iris-v1/cli/cmd/x.ts": "as of the sync",
      "main:packages/opencode/src/cli/cmd/x.ts": "main moved on",
      "abc123:packages/opencode/src/cli/cmd/x.ts": "as of the sync",
    }
    const r = async (ref: string, file: string) => at[`${ref}:${file}`] ?? null
    const changed = ["packages/cli/src/iris-v1/cli/cmd/x.ts"]
    expect(await lostEdits(changed, "HEAD", ["main"], r)).toHaveLength(1)
    expect(await lostEdits(changed, "HEAD", ["main", "abc123"], r, true)).toEqual([])
  })
})
