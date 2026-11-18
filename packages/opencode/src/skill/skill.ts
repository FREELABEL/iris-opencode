import z from "zod"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { NamedError } from "@opencode-ai/util/error"
import { ConfigMarkdown } from "../config/markdown"
import { Log } from "../util/log"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { exists } from "fs/promises"
import path from "path"

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

  /**
   * True when `file`, below the root it was found under, sits inside a dot-folder — `.trash`,
   * `.cache`, `.git`, anything hidden (#190877).
   *
   * Claude Code deletes a skill by moving it to `.claude/skills/.trash/<stamp>/<name>/`. The scan
   * runs with `dot: true` (the roots themselves are dot-folders), so a deleted google-workspace was
   * an ordinary candidate and, by directory order, resolved ahead of the live synced copy: `show`
   * printed it, `sync` could copy it back. A hidden folder is never where a live playbook lives.
   * Only the path BELOW the root is checked: the roots (`~/.iris`, `~/.claude`) are dot-folders.
   */
  export function isInHiddenFolder(root: string, file: string): boolean {
    const rel = path.relative(root, file)
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false
    return rel
      .split(/[\\/]/)
      .slice(0, -1)
      .some((seg) => seg.startsWith(".") && seg !== "." && seg !== "..")
  }

  /**
   * The `name:` a file declares, read from its raw text — used only when the YAML did not parse,
   * so a broken file can still be found by the name the author gave it (#190274). A folder named
   * differently from the playbook otherwise turned a parse error into "not found".
   */
  function declaredName(text: string): string | undefined {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!fm) return undefined
    const m = /^name:[ \t]*["']?([^"'\r\n#]+?)["']?[ \t]*(?:#.*)?$/m.exec(fm[1])
    return m?.[1]?.trim() || undefined
  }

  export const state = Instance.state(async () => {
    const skills: Record<string, Info> = {}
    // Every match for a name, in scan order — not just the winner. A second
    // PLAYBOOK.md/SKILL.md for the same name (a stray global copy, an old
    // clone) silently shadows the real one; `get`/`all` only ever see the
    // first, so nothing before this said the shadow existed at all.
    const allMatches: Record<string, Info[]> = {}
    // Files that could not be parsed. ONE malformed file used to throw out of the whole scan, so
    // `iris playbook sync` exited 1 with a YAML error naming no file and regenerated nothing —
    // hit on 2026-10-18 with a SKILL.md still holding merge-conflict markers (#189878). Skip the
    // file, keep scanning, and let callers say which file it was.
    const invalid: { path: string; message: string; name: string; names: string[]; order: number }[] = []
    // Files under a dot-folder (.trash, …) that were seen and deliberately NOT used (#190877).
    const ignored: { path: string; reason: string }[] = []
    // Scan position of every file, valid or not, so get() can tell whether a broken file would
    // have OUTRANKED the copy it is about to return (#190274).
    const order: Record<string, number> = {}
    let seq = 0

    const addSkill = async (match: string) => {
      const at = seq++
      let md
      try {
        md = await ConfigMarkdown.parse(match)
      } catch (e) {
        // NamedError keeps the useful text in .data.message; .message is only the error's name.
        const detail = (e as { data?: { message?: unknown } })?.data?.message
        const message = String(typeof detail === "string" && detail ? detail : e instanceof Error ? e.message : e).split("\n")[0]
        // The file cannot say its own name through YAML, so take it from the folder — which is
        // what `sync` and `install` always write (<name>/PLAYBOOK.md, <name>/SKILL.md) — and from
        // the raw `name:` line, for a folder named something else.
        const folder = path.basename(path.dirname(match))
        const declared = declaredName(await Bun.file(match).text().catch(() => ""))
        const names = [...new Set([folder, ...(declared ? [declared] : [])])]
        invalid.push({ path: match, message, name: declared ?? folder, names, order: at })
        log.warn("skipping unparseable skill file", { path: match, message })
        return
      }
      if (!md) {
        return
      }

      const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
      if (!parsed.success) return

      const info: Info = {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
      }
      ;(allMatches[parsed.data.name] ??= []).push(info)

      // First-found wins (playbooks scanned before skills = playbook takes priority)
      if (skills[parsed.data.name]) {
        return
      }

      skills[parsed.data.name] = info
      order[parsed.data.name] = at
    }

    // Helper to scan a glob inside multiple directories
    const scanGlob = async (glob: InstanceType<typeof Bun.Glob>, dirs: string[]) => {
      for (const dir of dirs) {
        const matches = await Array.fromAsync(
          glob.scan({ cwd: dir, absolute: true, onlyFiles: true, followSymlinks: true, dot: true }),
        ).catch(() => [])
        for (const match of matches) {
          if (isInHiddenFolder(dir, match)) {
            ignored.push({ path: match, reason: "inside a hidden folder (e.g. .trash) — treated as deleted" })
            continue
          }
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
    // Outside a git repo the project walk runs to "/", so it can already have visited ~/.iris.
    // Scanning it twice made every global playbook look like its own shadow copy.
    const seen = (list: string[], dir: string) => list.some((d) => path.resolve(d) === path.resolve(dir))
    if ((await exists(globalIris)) && !seen(irisDirs, globalIris)) irisDirs.push(globalIris)
    const globalClaude = `${Global.Path.home}/.claude`
    if ((await exists(globalClaude)) && !seen(claudeDirs, globalClaude)) claudeDirs.push(globalClaude)

    // Scan in priority order: playbooks first, then skills (first-found wins)
    await scanGlob(PLAYBOOK_GLOB, irisDirs)       // 1. .iris/playbooks/**/PLAYBOOK.md
    await scanGlob(CLAUDE_SKILL_GLOB, claudeDirs)  // 2. .claude/skills/**/SKILL.md (legacy)

    // Scan .opencode/skill/ directories (lowest priority)
    for (const dir of await Config.directories()) {
      for await (const match of OPENCODE_SKILL_GLOB.scan({ cwd: dir, absolute: true, onlyFiles: true, followSymlinks: true })) {
        if (isInHiddenFolder(dir, match)) {
          ignored.push({ path: match, reason: "inside a hidden folder (e.g. .trash) — treated as deleted" })
          continue
        }
        await addSkill(match)
      }
    }

    return { skills, allMatches, invalid, ignored, order }
  })

  /**
   * The playbook or skill called `name` — or an error, never a stand-in.
   *
   * #190274: a PLAYBOOK.md whose frontmatter did not parse was dropped with a log line, and this
   * returned the NEXT file with that name — usually the SKILL.md summary that `sync` generates
   * from the playbook. Every command then acted on the summary: `run` executed no steps, `test`
   * called it valid, `publish` uploaded it over the real playbook (atlas-epic registry v11). A
   * stand-in that looks like success is worse than an error, so when a broken file would have
   * won for this name, this throws with the file and the YAML error instead.
   *
   * A broken file that ranks BELOW the winner (a stray old copy, #189878) does not block: the
   * file that would have been used anyway is fine.
   */
  export async function get(name: string) {
    const s = await state()
    const winner = s.skills[name]
    const broken = s.invalid.find((x) => x.names.includes(name) && (winner === undefined || x.order < s.order[name]))
    if (broken) {
      throw new ConfigMarkdown.FrontmatterError({
        path: broken.path,
        message:
          `${broken.message}\n\n` +
          `Nothing was run or published. ` +
          (winner
            ? `The next file named '${name}' is ${winner.location}, and it is not this playbook — using it in its place is how a stale copy ran without anyone noticing.`
            : `No other file is named '${name}'.`) +
          `\nFix the header and re-run. A value containing ': ' or starting with a quote must be quoted.`,
      })
    }
    return winner
  }

  /**
   * True for a SKILL.md that `iris playbook sync` generated from a playbook (#190275). Such a file
   * is a summary for Claude Code, never the playbook: it has no steps, and publishing it replaces
   * the real playbook for everyone who installs it.
   */
  export function isGeneratedSummary(text: string): boolean {
    return text.includes("<!-- AUTO-GENERATED by iris playbook sync")
  }

  export async function all() {
    return state().then((x) => Object.values(x.skills))
  }

  /**
   * Skill/playbook files that were skipped because they could not be parsed, with the reason.
   * `blocks` is true when the broken file would have WON for its name — `get()` refuses that name
   * (#190274) — and false for a stray broken copy ranked below a working one (#189878).
   */
  export async function invalid(): Promise<{ path: string; message: string; name: string; blocks: boolean }[]> {
    return state().then((x) =>
      x.invalid.map((i) => ({
        path: i.path,
        message: i.message,
        name: i.name,
        blocks: i.names.some((n) => x.skills[n] === undefined || i.order < x.order[n]),
      })),
    )
  }

  /** Files seen under a hidden folder (.trash, …) and deliberately not used (#190877). */
  export async function ignored(): Promise<{ path: string; reason: string }[]> {
    return state().then((x) => x.ignored)
  }

  /** Every discovered location for `name`, in scan/priority order — [0] is the winner `get()` returns. */
  export async function locations(name: string): Promise<Info[]> {
    return state().then((x) => x.allMatches[name] ?? [])
  }

  /** Every name with more than one discovered location, i.e. a shadow copy exists somewhere. */
  export async function duplicates(): Promise<Record<string, Info[]>> {
    return state().then((x) =>
      Object.fromEntries(Object.entries(x.allMatches).filter(([, v]) => v.length > 1)),
    )
  }
}
