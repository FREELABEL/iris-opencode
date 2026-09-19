import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { findLocalPlaybook, markLocal, projectRoot } from "./playbook-local"

/**
 * #186277 — the Marketplace said "installed here: no" for 17 of the first 25 playbooks on a
 * machine whose project had them. It only looked in ~/.iris/playbooks, while `iris playbook sync`
 * puts them in the project's .iris/playbooks and .claude/skills — where the session actually
 * reads them. Measured 2026-09-19 on Desktop 1.18.71 (only agentic-loop and document-crossref,
 * the two also in ~/.iris/playbooks, said "installed").
 */

const root = mkdtempSync(path.join(tmpdir(), "pb-local-"))
const home = path.join(root, "home")
const project = path.join(root, "project")
const put = (file: string, body = "---\nname: x\n---\n# doc\n") => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
}
put(path.join(home, ".iris", "playbooks", "in-home", "PLAYBOOK.md"), "HOME COPY")
put(path.join(project, ".iris", "playbooks", "in-project", "PLAYBOOK.md"), "PROJECT COPY")
put(path.join(project, ".claude", "skills", "only-skill", "SKILL.md"), "SKILL COPY")
put(path.join(home, ".iris", "playbooks", "both", "PLAYBOOK.md"), "HOME BOTH")
put(path.join(project, ".iris", "playbooks", "both", "PLAYBOOK.md"), "PROJECT BOTH")
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("is this playbook installed where this session can use it?", () => {
  test("in ~/.iris/playbooks (the old, only check) — still found", () => {
    expect(findLocalPlaybook("in-home", { home, project })).toMatchObject({ found: true, where: "home" })
  })

  test("in the project's .iris/playbooks — found (was reported 'not installed')", () => {
    expect(findLocalPlaybook("in-project", { home, project })).toMatchObject({ found: true, where: "project" })
  })

  test("only as a synced skill in .claude/skills — found", () => {
    expect(findLocalPlaybook("only-skill", { home, project })).toMatchObject({ found: true, where: "skill" })
  })

  test("in both places — the project's copy wins, because that is what this session runs", () => {
    const r = findLocalPlaybook("both", { home, project })
    expect(r.where).toBe("project")
    expect(r.path).toBe(path.join(project, ".iris", "playbooks", "both", "PLAYBOOK.md"))
  })

  test("nowhere → not found, and says so", () => {
    expect(findLocalPlaybook("nope", { home, project })).toMatchObject({ found: false, where: null })
  })

  test("no project known (e.g. no session directory) → home only, exactly as before", () => {
    expect(findLocalPlaybook("in-project", { home })).toMatchObject({ found: false })
    expect(findLocalPlaybook("in-home", { home })).toMatchObject({ found: true, where: "home" })
  })

  test("a name that is not a slug never reaches the filesystem", () => {
    put(path.join(root, "secret", "PLAYBOOK.md"), "SECRET")
    expect(findLocalPlaybook("../../secret", { home, project: path.join(project, "x") }).found).toBe(false)
    expect(findLocalPlaybook("a/b", { home, project }).found).toBe(false)
  })
})

describe("marking a page of rows", () => {
  test("hasLocal follows the same rule, and each row says where", () => {
    const rows = markLocal(
      [{ name: "in-home", hasLocal: false }, { name: "in-project", hasLocal: false }, { name: "nope", hasLocal: true }],
      { home, project },
    )
    expect(rows.map((r) => [r.name, r.hasLocal, r.localWhere])).toEqual([
      ["in-home", true, "home"],
      ["in-project", true, "project"],
      ["nope", false, undefined],
    ])
  })
})

describe("the project directory a client sends", () => {
  test("an absolute path to a real directory is used", () => {
    expect(projectRoot(project)).toBe(project)
  })
  test("relative, missing, a file, or not a string → ignored (home-only, as before)", () => {
    expect(projectRoot("freelabel")).toBeUndefined()
    expect(projectRoot(path.join(root, "does-not-exist"))).toBeUndefined()
    expect(projectRoot(path.join(home, ".iris", "playbooks", "in-home", "PLAYBOOK.md"))).toBeUndefined()
    expect(projectRoot(undefined)).toBeUndefined()
    expect(projectRoot(42)).toBeUndefined()
  })
})
