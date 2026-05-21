import z from "zod"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { NamedError } from "@opencode-ai/util/error"
import { ConfigMarkdown } from "../config/markdown"
import { Log } from "../util/log"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { exists } from "fs/promises"

// Re-export v2 execution engine for convenience
export { parsePlan, executeSkill, validatePlan, resolveArgs } from "./executor"
export type { SkillPlan, StepDef, StepResult, SkillResult, ExecuteOptions } from "./executor"

export namespace Skill {
  const log = Log.create({ service: "skill" })
  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
  })
  export type Info = z.infer<typeof Info>

  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  )

  // Scan patterns — playbooks first (new), then skills (legacy)
  const PLAYBOOK_GLOB = new Bun.Glob("playbooks/**/PLAYBOOK.md")
  const CLAUDE_SKILL_GLOB = new Bun.Glob("skills/**/SKILL.md")
  const OPENCODE_SKILL_GLOB = new Bun.Glob("{skill,skills}/**/SKILL.md")

  export const state = Instance.state(async () => {
    const skills: Record<string, Info> = {}

    const addSkill = async (match: string) => {
      const md = await ConfigMarkdown.parse(match)
      if (!md) {
        return
      }

      const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
      if (!parsed.success) return

      // First-found wins (playbooks scanned before skills = playbook takes priority)
      if (skills[parsed.data.name]) {
        return
      }

      skills[parsed.data.name] = {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
      }
    }

    // Helper to scan a glob inside multiple directories
    const scanGlob = async (glob: InstanceType<typeof Bun.Glob>, dirs: string[]) => {
      for (const dir of dirs) {
        const matches = await Array.fromAsync(
          glob.scan({ cwd: dir, absolute: true, onlyFiles: true, followSymlinks: true, dot: true }),
        ).catch(() => [])
        for (const match of matches) {
          await addSkill(match)
        }
      }
    }

    // Collect project-level directories (walk up from cwd to worktree root)
    const irisDirs: string[] = []
    const claudeDirs: string[] = []

    for await (const dir of Filesystem.up({ targets: [".iris"], start: Instance.directory, stop: Instance.worktree })) {
      irisDirs.push(dir)
    }
    for await (const dir of Filesystem.up({ targets: [".claude"], start: Instance.directory, stop: Instance.worktree })) {
      claudeDirs.push(dir)
    }

    // Global dirs
    const globalIris = `${Global.Path.home}/.iris`
    if (await exists(globalIris)) irisDirs.push(globalIris)
    const globalClaude = `${Global.Path.home}/.claude`
    if (await exists(globalClaude)) claudeDirs.push(globalClaude)

    // Scan in priority order: playbooks first, then skills (first-found wins)
    await scanGlob(PLAYBOOK_GLOB, irisDirs)       // 1. .iris/playbooks/**/PLAYBOOK.md
    await scanGlob(CLAUDE_SKILL_GLOB, claudeDirs)  // 2. .claude/skills/**/SKILL.md (legacy)

    // Scan .opencode/skill/ directories (lowest priority)
    for (const dir of await Config.directories()) {
      for await (const match of OPENCODE_SKILL_GLOB.scan({ cwd: dir, absolute: true, onlyFiles: true, followSymlinks: true })) {
        await addSkill(match)
      }
    }

    return skills
  })

  export async function get(name: string) {
    return state().then((x) => x[name])
  }

  export async function all() {
    return state().then((x) => Object.values(x))
  }
}
