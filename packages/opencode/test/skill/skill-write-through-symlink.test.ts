/**
 * #186155 — `iris playbook install --force` updated the playbook but left a symlinked
 * ~/.claude/skills/<name> alone and still said "Installed", so Claude Code kept reading the old
 * SKILL.md. Install now writes THROUGH the link when the file behind it is a generated replica.
 */
import { test, expect, describe } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import { decideSkillWrite, SKILL_GENERATED_MARKER } from "../../src/skill/install-location"

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-symlink-"))
  const repoSkill = path.join(root, "repo", ".claude", "skills", "demo")
  const homeSkills = path.join(root, "home", ".claude", "skills")
  fs.mkdirSync(repoSkill, { recursive: true })
  fs.mkdirSync(homeSkills, { recursive: true })
  const link = path.join(homeSkills, "demo")
  fs.symlinkSync(repoSkill, link, "dir")
  return { root, repoSkill, link }
}

describe("decideSkillWrite", () => {
  test("install writes through a symlink whose SKILL.md is a generated replica", () => {
    const { repoSkill, link } = sandbox()
    fs.writeFileSync(path.join(repoSkill, "SKILL.md"), `<!-- ${SKILL_GENERATED_MARKER} -->\nold`)
    const d = decideSkillWrite(link, { home: true, followSymlink: true })
    expect(d.write).toBe(true)
    if (d.write) expect(d.via).toBe(fs.realpathSync(repoSkill))
  })

  test("install writes through a symlink to an empty skill folder", () => {
    const { link } = sandbox()
    expect(decideSkillWrite(link, { home: true, followSymlink: true }).write).toBe(true)
  })

  test("a hand-written skill behind a symlink is never overwritten", () => {
    const { repoSkill, link } = sandbox()
    fs.writeFileSync(path.join(repoSkill, "SKILL.md"), "---\nname: demo\n---\nmy own words")
    const d = decideSkillWrite(link, { home: true, followSymlink: true })
    expect(d.write).toBe(false)
    if (!d.write) expect(d.reason).toContain("hand-written")
  })

  test("a dangling symlink is refused, not written into", () => {
    const { repoSkill, link } = sandbox()
    fs.rmSync(repoSkill, { recursive: true })
    const d = decideSkillWrite(link, { home: true, followSymlink: true })
    expect(d.write).toBe(false)
    if (!d.write) expect(d.reason).toContain("no longer exists")
  })

  test("sync (no followSymlink) still leaves a symlinked folder alone", () => {
    const { repoSkill, link } = sandbox()
    fs.writeFileSync(path.join(repoSkill, "SKILL.md"), `<!-- ${SKILL_GENERATED_MARKER} -->\nold`)
    const d = decideSkillWrite(link, { home: true, followSymlink: false })
    expect(d.write).toBe(false)
    if (!d.write) expect(d.reason).toContain("symlinked")
  })

  test("a plain folder with a generated replica is written in place", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-plain-"))
    fs.writeFileSync(path.join(root, "SKILL.md"), `<!-- ${SKILL_GENERATED_MARKER} -->`)
    const d = decideSkillWrite(root, { home: true, followSymlink: true })
    expect(d.write).toBe(true)
    if (d.write) expect(d.via).toBeNull()
  })
})
