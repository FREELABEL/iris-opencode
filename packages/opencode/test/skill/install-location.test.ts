/**
 * `iris playbook install` location + write path (2026-09-18).
 *
 * A client's terminal sat in C:\WINDOWS\system32, so a cwd-relative install put the playbook
 * where neither the IRIS Desktop app nor Claude Code looks. Default is now the home folder.
 * Also #185996 (--force / sync EEXIST on Windows) and #185995 (no staleness signal).
 */
import { test, expect, describe } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import {
  resolveInstallRoot,
  installHome,
  skillsDirForPlaybook,
  shadowingCopies,
  ensureDir,
  writeFileAtomic,
  assessInstalled,
  sha256,
  type FsOps,
} from "../../src/skill/install-location"
import { Skill } from "../../src/skill"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "iris-install-loc-"))
}

describe("resolveInstallRoot — where install lands", () => {
  test("an arbitrary cwd outside any project installs globally (home)", () => {
    const home = scratch()
    const cwd = scratch() // not under home, no git
    const r = resolveInstallRoot({ cwd, home })
    expect(r.scope).toBe("global")
    expect(r.playbooksDir).toBe(path.join(home, ".iris", "playbooks"))
    expect(r.skillsDir).toBe(path.join(home, ".claude", "skills"))
  })

  test("Windows: system32 cwd installs under USERPROFILE, not system32", () => {
    const w = path.win32
    const r = resolveInstallRoot({ cwd: "C:\\WINDOWS\\system32", home: "C:\\Users\\client", exists: () => false, path: w })
    expect(r.scope).toBe("global")
    expect(r.playbooksDir).toBe("C:\\Users\\client\\.iris\\playbooks")
    expect(r.skillsDir).toBe("C:\\Users\\client\\.claude\\skills")
  })

  test("Windows: an old Desktop\\.iris\\playbooks outside a git repo does NOT pin installs there", () => {
    const w = path.win32
    const have = new Set(["C:\\Users\\client\\OneDrive\\Desktop\\.iris\\playbooks"])
    const r = resolveInstallRoot({
      cwd: "C:\\Users\\client\\OneDrive\\Desktop",
      home: "C:\\Users\\client",
      exists: (p) => have.has(p),
      path: w,
    })
    expect(r.scope).toBe("global")
    expect(r.root).toBe("C:\\Users\\client")
  })

  test("installHome follows the env the loader follows (OPENCODE_TEST_HOME, else os.homedir)", () => {
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = "C:\\Users\\someone"
    try {
      expect(installHome()).toBe("C:\\Users\\someone")
    } finally {
      process.env.OPENCODE_TEST_HOME = prev
    }
  })

  test("inside a git project that already has .iris/playbooks, from a nested dir → project root", () => {
    const home = scratch()
    const proj = scratch()
    fs.mkdirSync(path.join(proj, ".git"))
    fs.mkdirSync(path.join(proj, ".iris", "playbooks"), { recursive: true })
    const deep = path.join(proj, "a", "b", "c")
    fs.mkdirSync(deep, { recursive: true })
    const r = resolveInstallRoot({ cwd: deep, home })
    expect(r.scope).toBe("project")
    expect(r.root).toBe(proj)
    expect(r.playbooksDir).toBe(path.join(proj, ".iris", "playbooks"))
  })

  test("a git project WITHOUT .iris/playbooks installs globally", () => {
    const home = scratch()
    const proj = scratch()
    fs.mkdirSync(path.join(proj, ".git"))
    expect(resolveInstallRoot({ cwd: proj, home }).scope).toBe("global")
  })

  test(".iris/playbooks ABOVE the git root is not this project's — global", () => {
    const home = scratch()
    const outer = scratch()
    fs.mkdirSync(path.join(outer, ".iris", "playbooks"), { recursive: true })
    const proj = path.join(outer, "repo")
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true })
    expect(resolveInstallRoot({ cwd: proj, home }).scope).toBe("global")
  })

  test("a dotfiles repo in home with ~/.iris/playbooks is global, not a project", () => {
    const home = scratch()
    fs.mkdirSync(path.join(home, ".git"))
    fs.mkdirSync(path.join(home, ".iris", "playbooks"), { recursive: true })
    const sub = path.join(home, "Desktop")
    fs.mkdirSync(sub)
    const r = resolveInstallRoot({ cwd: sub, home })
    expect(r.scope).toBe("global")
    expect(r.root).toBe(home)
  })

  test("--project uses the git root; --global overrides a project", () => {
    const home = scratch()
    const proj = scratch()
    fs.mkdirSync(path.join(proj, ".git"))
    fs.mkdirSync(path.join(proj, ".iris", "playbooks"), { recursive: true })
    const sub = path.join(proj, "src")
    fs.mkdirSync(sub)
    expect(resolveInstallRoot({ cwd: sub, home, mode: "project" }).root).toBe(proj)
    expect(resolveInstallRoot({ cwd: sub, home, mode: "global" }).root).toBe(home)
  })
})

describe("skillsDirForPlaybook — sync writes beside the playbook's own root", () => {
  test("global and project, posix and windows", () => {
    expect(skillsDirForPlaybook("/home/u/.iris/playbooks/x/PLAYBOOK.md", path.posix)).toBe("/home/u/.claude/skills")
    expect(skillsDirForPlaybook("/r/p/.iris/playbooks/nested/x/PLAYBOOK.md", path.posix)).toBe("/r/p/.claude/skills")
    expect(skillsDirForPlaybook("C:\\Users\\c\\.iris\\playbooks\\x\\PLAYBOOK.md", path.win32)).toBe("C:\\Users\\c\\.claude\\skills")
    expect(skillsDirForPlaybook("/r/p/.opencode/skill/x/SKILL.md", path.posix)).toBeNull()
  })
})

describe("shadowingCopies — an old cwd-local copy would win over the new global one", () => {
  test("names the Desktop copy", () => {
    const w = path.win32
    const old = "C:\\Users\\c\\OneDrive\\Desktop\\.iris\\playbooks\\p\\PLAYBOOK.md"
    const got = shadowingCopies("p", "C:\\Users\\c\\OneDrive\\Desktop", "C:\\Users\\c\\.iris\\playbooks\\p\\PLAYBOOK.md", "C:\\Users\\c", (x) => x === old, w)
    expect(got).toEqual([old])
  })
})

describe("#185996 — overwrite without EEXIST", () => {
  test("--force path: overwriting an existing file in an existing dir replaces it and leaves no temp file", () => {
    const dir = path.join(scratch(), "pb")
    fs.mkdirSync(dir)
    const file = path.join(dir, "PLAYBOOK.md")
    fs.writeFileSync(file, "old")
    writeFileAtomic(file, "new")
    writeFileAtomic(file, "newer")
    expect(fs.readFileSync(file, "utf8")).toBe("newer")
    expect(fs.readdirSync(dir)).toEqual(["PLAYBOOK.md"])
  })

  test("ensureDir tolerates EEXIST from mkdir (OneDrive placeholder)", () => {
    let calls = 0
    const seen = [false, true] // stat cannot see it first, then can
    const ops: FsOps = {
      mkdir: () => {
        calls++
        throw Object.assign(new Error("EEXIST: file already exists, mkdir"), { code: "EEXIST" })
      },
      rename: () => {},
      write: () => {},
      unlink: () => {},
      isDir: () => seen.shift() ?? true,
    }
    expect(() => ensureDir("C:\\Users\\c\\OneDrive\\Desktop\\.iris\\playbooks\\p", ops)).not.toThrow()
    expect(calls).toBe(1)
  })

  test("a refused rename (Windows lock) falls back to an in-place overwrite", () => {
    const writes: Record<string, string> = {}
    const ops: FsOps = {
      mkdir: () => {},
      rename: () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" })
      },
      write: (f, d) => {
        writes[f] = d
      },
      unlink: (f) => {
        delete writes[f]
      },
      isDir: () => true,
    }
    writeFileAtomic("/x/PLAYBOOK.md", "body", ops)
    expect(writes).toEqual({ "/x/PLAYBOOK.md": "body" })
  })
})

describe("#185995 — install says when a newer version exists", () => {
  const rec = (content: string, version: string | null) => ({ name: "p", version, sha256: sha256(content), installed_at: "" })

  test("newer registry version", () => {
    const v = assessInstalled({ name: "p", localContent: "A", record: rec("A", "4"), registryVersion: "9", registryContent: "B" })
    expect(v.state).toBe("newer")
    expect(v.message).toBe("v9 available (you have v4) — run iris playbook install p --force")
  })

  test("newer + local edits warns that --force discards them", () => {
    const v = assessInstalled({ name: "p", localContent: "A-edited", record: rec("A", "4"), registryVersion: "9", registryContent: "B" })
    expect(v.state).toBe("newer")
    expect(v.localEdits).toBe(true)
    expect(v.message).toContain("discards your local edits")
  })

  test("same version, same text → current", () => {
    expect(assessInstalled({ name: "p", localContent: "A", record: rec("A", "4"), registryVersion: "4", registryContent: "A" }).state).toBe("current")
  })

  test("same version, local edits → edited", () => {
    expect(assessInstalled({ name: "p", localContent: "A2", record: rec("A", "4"), registryVersion: "4", registryContent: "A" }).state).toBe("edited")
  })

  test("no record (installed by an older CLI) and different text → differs, measured by content", () => {
    const v = assessInstalled({ name: "p", localContent: "A", record: null, registryVersion: "9", registryContent: "B" })
    expect(v.state).toBe("differs")
    expect(v.message).toContain("v9 differs from your copy")
    expect(assessInstalled({ name: "p", localContent: "A", record: null, registryVersion: "9", registryContent: "A" }).state).toBe("current")
  })
})

describe("the loader finds a global install from any folder; a project copy wins", () => {
  const pb = (desc: string) => `---\nname: loc-test\ndescription: ${desc}\n---\n\n# x\n`

  test("global PLAYBOOK.md is found from an unrelated cwd", async () => {
    await using home = await tmpdir()
    await using elsewhere = await tmpdir({ git: true })
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
    try {
      await Bun.write(path.join(home.path, ".iris", "playbooks", "loc-test", "PLAYBOOK.md"), pb("global copy"))
      await Instance.provide({
        directory: elsewhere.path,
        fn: async () => {
          const s = await Skill.get("loc-test")
          expect(s?.description).toBe("global copy")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = prev
    }
  })

  test("project copy beats the global one on a name clash", async () => {
    await using home = await tmpdir()
    await using proj = await tmpdir({ git: true })
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
    try {
      await Bun.write(path.join(home.path, ".iris", "playbooks", "loc-test", "PLAYBOOK.md"), pb("global copy"))
      await Bun.write(path.join(proj.path, ".iris", "playbooks", "loc-test", "PLAYBOOK.md"), pb("project copy"))
      await Instance.provide({
        directory: proj.path,
        fn: async () => {
          expect((await Skill.get("loc-test"))?.description).toBe("project copy")
          expect((await Skill.locations("loc-test")).length).toBe(2)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = prev
    }
  })
})
