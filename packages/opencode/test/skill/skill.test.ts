import { test, expect } from "bun:test"
import { Skill } from "../../src/skill"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"

async function createGlobalSkill(homeDir: string) {
  const skillDir = path.join(homeDir, ".claude", "skills", "global-test-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-test-skill
description: A global skill from ~/.claude/skills for testing.
---

# Global Test Skill

This skill is loaded from the global home directory.
`,
  )
}

test("discovers skills from .opencode/skill/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "test-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: test-skill
description: A test skill for verification.
---

# Test Skill

Instructions here.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.length).toBe(1)
      const testSkill = skills.find((s) => s.name === "test-skill")
      expect(testSkill).toBeDefined()
      expect(testSkill!.description).toBe("A test skill for verification.")
      expect(testSkill!.location).toContain("skill/test-skill/SKILL.md")
    },
  })
})

test("discovers multiple skills from .opencode/skill/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir1 = path.join(dir, ".opencode", "skill", "skill-one")
      const skillDir2 = path.join(dir, ".opencode", "skill", "skill-two")
      await Bun.write(
        path.join(skillDir1, "SKILL.md"),
        `---
name: skill-one
description: First test skill.
---

# Skill One
`,
      )
      await Bun.write(
        path.join(skillDir2, "SKILL.md"),
        `---
name: skill-two
description: Second test skill.
---

# Skill Two
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.length).toBe(2)
      expect(skills.find((s) => s.name === "skill-one")).toBeDefined()
      expect(skills.find((s) => s.name === "skill-two")).toBeDefined()
    },
  })
})

test("skips skills with missing frontmatter", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "no-frontmatter")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `# No Frontmatter

Just some content without YAML frontmatter.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills).toEqual([])
    },
  })
})

test("discovers skills from .claude/skills/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".claude", "skills", "claude-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.length).toBe(1)
      const claudeSkill = skills.find((s) => s.name === "claude-skill")
      expect(claudeSkill).toBeDefined()
      expect(claudeSkill!.location).toContain(".claude/skills/claude-skill/SKILL.md")
    },
  })
})

test("discovers global skills from ~/.claude/skills/ directory", async () => {
  await using tmp = await tmpdir({ git: true })

  const originalHome = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    await createGlobalSkill(tmp.path)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.length).toBe(1)
        expect(skills[0].name).toBe("global-test-skill")
        expect(skills[0].description).toBe("A global skill from ~/.claude/skills for testing.")
        expect(skills[0].location).toContain(".claude/skills/global-test-skill/SKILL.md")
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = originalHome
  }
})

test("returns empty array when no skills exist", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills).toEqual([])
    },
  })
})

// #189878 — one malformed SKILL.md (here: merge-conflict markers in its frontmatter) used to
// throw out of the whole scan, so `iris playbook sync` exited 1 and regenerated nothing.
test("an unparseable skill file is skipped and reported, not fatal", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".iris", "playbooks", "good", "PLAYBOOK.md"),
        `---
name: good
description: A valid playbook next to a broken skill file.
version: 2
---

# Good
`,
      )
      await Bun.write(
        path.join(dir, ".claude", "skills", "broken", "SKILL.md"),
        `---
name: "broken"
<<<<<<< ours
client: pathways
=======
client: other
>>>>>>> theirs
description: "x"
---

body
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.map((s) => s.name)).toContain("good")
      expect(skills.map((s) => s.name)).not.toContain("broken")
      const invalid = await Skill.invalid()
      expect(invalid.length).toBe(1)
      expect(invalid[0].path).toContain(path.join("skills", "broken", "SKILL.md"))
      expect(invalid[0].message.length).toBeGreaterThan(0)
    },
  })
})

// #190274 — a broken PLAYBOOK.md must not be replaced, in silence, by the next file with its name.
test("a playbook whose header does not parse is an error, not a fallback to its generated summary", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".iris", "playbooks", "demo", "PLAYBOOK.md"),
        // An unquoted ': ' inside a plain scalar — the exact header that broke atlas-epic.
        `---
name: demo
description: Close it out — run with --ticket <id>: every worktree cleaned up.
version: 2
---

# Demo
`,
      )
      await Bun.write(
        path.join(dir, ".claude", "skills", "demo", "SKILL.md"),
        `---
name: "demo"
description: "generated stub"
---
<!-- AUTO-GENERATED by iris playbook sync — do not edit -->
# Demo stub
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const err = await Skill.get("demo").then(() => null, (e) => e)
      expect(err).not.toBeNull()
      expect(String(err?.data?.path)).toContain(path.join("playbooks", "demo", "PLAYBOOK.md"))
      expect(String(err?.data?.message)).toContain(path.join("skills", "demo", "SKILL.md"))
    },
  })
})

test("a broken file that ranks BELOW the winner does not block it", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".iris", "playbooks", "demo", "PLAYBOOK.md"),
        `---
name: demo
description: "The real one."
version: 2
---

# Demo
`,
      )
      await Bun.write(path.join(dir, ".claude", "skills", "demo", "SKILL.md"), `---\nname: "demo"\n<<<<<<< ours\n=======\n>>>>>>> theirs\n---\n`)
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const info = await Skill.get("demo")
      expect(info?.location).toContain(path.join("playbooks", "demo", "PLAYBOOK.md"))
    },
  })
})

test("a broken file with no valid copy anywhere is an error, not 'not found'", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, ".iris", "playbooks", "lonely", "PLAYBOOK.md"), `---\nname: lonely\ndescription: a: b: c\n---\n`)
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(Skill.get("lonely")).rejects.toBeDefined()
    },
  })
})

// #190275
test("a generated SKILL.md is recognised as a summary, a playbook is not", () => {
  expect(Skill.isGeneratedSummary(`---\nname: x\n---\n<!-- AUTO-GENERATED by iris playbook sync — do not edit -->\n`)).toBe(true)
  expect(Skill.isGeneratedSummary(`---\nname: x\nversion: 2\n---\n# X\n## Steps\n`)).toBe(false)
})

// #190877 — a skill moved to .claude/skills/.trash (or any dot-folder) is deleted, not a candidate.
// The trashed google-workspace resolved ahead of the live synced copy on a real machine.
test("discovery skips .trash and every dot-folder, in every root, and the live copy wins", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skill = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`
      // .claude/skills — trashed copy and the live one
      await Bun.write(path.join(dir, ".claude", "skills", ".trash", "1790-x", "gw", "SKILL.md"), skill("gw", "TRASHED"))
      await Bun.write(path.join(dir, ".claude", "skills", "synced", "abc", "gw", "SKILL.md"), skill("gw", "LIVE"))
      // .iris/playbooks — only a trashed copy exists: it must not be found at all
      await Bun.write(path.join(dir, ".iris", "playbooks", ".trash", "9", "gone", "PLAYBOOK.md"), skill("gone", "TRASHED"))
      // any other dot-folder, and the .opencode root
      await Bun.write(path.join(dir, ".claude", "skills", ".cache", "hid", "SKILL.md"), skill("hid", "HIDDEN"))
      await Bun.write(path.join(dir, ".opencode", "skill", ".trash", "oc", "SKILL.md"), skill("oc", "TRASHED"))
      // a broken file in the trash must not block anything either
      await Bun.write(path.join(dir, ".iris", "playbooks", ".trash", "8", "gw", "PLAYBOOK.md"), `---\nname: gw\ndescription: bad: yaml: here\n---\n`)
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const gw = await Skill.get("gw")
      expect(gw?.description).toBe("LIVE")
      const locs = await Skill.locations("gw")
      expect(locs.map((l) => l.location).filter((l) => l.includes(`${path.sep}.trash${path.sep}`))).toEqual([])
      expect(locs.length).toBe(1)
      expect(await Skill.get("gone")).toBeUndefined()
      expect(await Skill.get("hid")).toBeUndefined()
      expect(await Skill.get("oc")).toBeUndefined()
      expect((await Skill.invalid()).length).toBe(0)
      // Named as ignored, so doctor can say so instead of pretending they do not exist.
      const ignored = (await Skill.ignored()).map((i) => i.path)
      expect(ignored.some((p) => p.includes(path.join(".trash", "1790-x", "gw")))).toBe(true)
      expect(ignored.some((p) => p.includes(path.join(".cache", "hid")))).toBe(true)
    },
  })
})

// #190274 (2026-10-23 measurement) — a broken header in a folder whose name is NOT the playbook's
// name used to answer "not found". The name is read from the raw text, so the error still names
// the file and the YAML line.
test("a broken playbook is reported by its frontmatter name even when its folder is named differently", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".iris", "playbooks", "probe-folder", "PLAYBOOK.md"),
        `---\nname: zz-probe\ndescription: stress test (safe: echo only)\n---\n# probe\n`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const err = await Skill.get("zz-probe").then(() => null, (e) => e)
      expect(err).not.toBeNull()
      expect(String(err?.data?.path)).toContain(path.join("probe-folder", "PLAYBOOK.md"))
      expect(String(err?.data?.message)).toContain("line 3")
      const inv = await Skill.invalid()
      expect(inv.length).toBe(1)
      expect(inv[0].path).toContain("probe-folder")
    },
  })
})
