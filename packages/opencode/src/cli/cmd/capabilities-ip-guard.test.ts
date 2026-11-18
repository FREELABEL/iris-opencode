import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { findSecretShapes } from "../../util/redact-secrets"

/**
 * IP-07 phase 2 (#189850) — GUARD. capabilities.json is committed to a PUBLIC repo and embedded
 * in every public binary. Until v1.3.352 it carried the lowercased full text of 406 PRIVATE
 * workspace playbooks and skills (3.8 MB of it). Those now live only in the private API
 * (GET /api/v1/cli/capabilities) and are merged in at runtime for a signed-in user.
 */

const ROOT = join(import.meta.dir, "..", "..", "..")
const INDEX_FILE = join(ROOT, "capabilities.json")

/**
 * Ceiling on the committed index. Measured after the split: 1,195,557 bytes (1,753 commands +
 * 100 how-tos, pretty-printed). 1.5 MB leaves ~25% for ordinary growth in commands and how-tos,
 * and is well under the 5.0 MB the file was with workspace prose in it — so if playbook or skill
 * text (3.8 MB) ever comes back under another kind, this fails long before anyone notices a
 * fatter binary.
 */
const CEILING_BYTES = 1_500_000

describe("capabilities.json carries no private workspace prose (IP-07 #189850)", () => {
  const index = JSON.parse(readFileSync(INDEX_FILE, "utf8"))

  test("zero entries of kind playbook or skill", () => {
    const leaked = (index.entries as { kind: string; name: string }[]).filter(
      (e) => e.kind === "playbook" || e.kind === "skill",
    )
    expect(leaked.map((e) => `${e.kind}:${e.name}`)).toEqual([])
  })

  test("only public kinds, and no top-level field derived from workspace content", () => {
    expect(new Set(index.entries.map((e: { kind: string }) => e.kind))).toEqual(new Set(["command", "how-to"]))
    expect(Object.keys(index.counts).sort()).toEqual(["command", "how-to", "total"])
    expect(Object.keys(index).sort()).toEqual(["counts", "entries", "generated_note", "terms"])
  })

  test(`byte size is under the ${CEILING_BYTES.toLocaleString()} byte ceiling`, () => {
    expect(statSync(INDEX_FILE).size).toBeLessThan(CEILING_BYTES)
  })
})

/**
 * The generator split, run end to end against a FIXTURE workspace — so this proves the split
 * without the private workspace being present (it is not, on CI or a contributor's machine).
 * It is also where the redact-secrets coverage moved: the workspace prose that used to be
 * scanned inside the committed index now goes to --workspace-out, so that file is what must
 * come out clean.
 */
describe("build-capabilities --workspace-out (IP-07 #189850)", () => {
  let dir: string
  let pub: any
  let ws: any
  const FAKE_SECRET = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "caps-split-"))
    const project = join(dir, "workspace")
    mkdirSync(join(project, ".iris/playbooks/fixture-play"), { recursive: true })
    mkdirSync(join(project, ".claude/skills/fixture-skill"), { recursive: true })
    writeFileSync(
      join(project, ".iris/playbooks/fixture-play/playbook.md"),
      `---\nname: fixture-play\ndescription: a fixture playbook\n---\n# Fixture\nthe caption is not the content. use ${FAKE_SECRET} here.\n`,
    )
    writeFileSync(
      join(project, ".claude/skills/fixture-skill/SKILL.md"),
      `---\nname: fixture-skill\ndescription: a fixture skill\n---\nsearch your own system before scoring\n`,
    )
    const r = Bun.spawnSync(
      [
        process.execPath,
        "run",
        join(ROOT, "script/build-capabilities.ts"),
        "--out",
        join(dir, "public.json"),
        "--workspace-out",
        join(dir, "workspace.json"),
      ],
      { cwd: ROOT, env: { ...process.env, IRIS_PROJECT_ROOT: project }, stdout: "pipe", stderr: "pipe" },
    )
    if (r.exitCode !== 0) throw new Error(`generator failed: ${r.stderr.toString()}`)
    pub = JSON.parse(readFileSync(join(dir, "public.json"), "utf8"))
    ws = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"))
  }, 60_000)

  afterAll(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  test("the public output has no playbook/skill entries and none of their text", () => {
    expect(pub.entries.filter((e: any) => e.kind === "playbook" || e.kind === "skill")).toEqual([])
    const text = JSON.stringify(pub).toLowerCase()
    expect(text).not.toContain("the caption is not the content")
    expect(text).not.toContain("search your own system before scoring")
    expect(pub.counts.playbook).toBeUndefined()
    expect(pub.counts.skill).toBeUndefined()
  })

  test("the workspace output is exactly the playbook and skill entries, in the index entry shape", () => {
    expect(Object.keys(ws)).toEqual(["entries"])
    expect(ws.entries.map((e: any) => `${e.kind}:${e.name}`).sort()).toEqual([
      "playbook:fixture-play",
      "skill:fixture-skill",
    ])
    for (const e of ws.entries) {
      expect(Object.keys(e).sort()).toEqual(["aliases", "describe", "haystack", "kind", "name", "run"])
    }
    expect(ws.entries.find((e: any) => e.kind === "playbook").haystack).toContain("the caption is not the content")
  })

  test("workspace prose is still redacted on the way out (#186275)", () => {
    const text = readFileSync(join(dir, "workspace.json"), "utf8")
    expect(text).not.toContain(FAKE_SECRET.toLowerCase())
    expect(findSecretShapes(text)).toEqual([])
  })
})
