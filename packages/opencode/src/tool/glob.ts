import z from "zod"
import path from "path"
import { Tool } from "./tool"
import DESCRIPTION from "./glob.txt"
import { Ripgrep } from "../file/ripgrep"
import { Instance } from "../project/instance"

/**
 * Glob lists FILES. A pattern naming a directory (`**\/.git`, `**\/node_modules`) finds nothing,
 * or only stray files of that name, and the model reads that as "none exist" (#191073: it went
 * on to walk the whole disk looking for repositories).
 */
export function directoryHint(pattern: string, found: number): string | undefined {
  const last = pattern.replace(/\/+$/u, "").split("/").pop() ?? ""
  if (!last || /[*?[\]{}]/u.test(last)) return undefined
  if (last === ".git") {
    // Always: a worktree's .git is a FILE, so this pattern "finds" a few and hides every real repo.
    return "(Glob matches files, not directories. To find git repositories, use **/.git/HEAD.)"
  }
  // Only when nothing matched: HEAD, Makefile and Dockerfile are files with no dot.
  if (found > 0) return undefined
  return `(Glob matches files, not directories. If ${last} is a directory, use ${pattern.replace(/\/+$/u, "")}/* to list what is inside it.)`
}

export const GlobTool = Tool.define("glob", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The glob pattern to match files against"),
    path: z
      .string()
      .optional()
      .describe(
        `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
      ),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "glob",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
      },
    })

    let search = params.path ?? Instance.directory
    search = path.isAbsolute(search) ? search : path.resolve(Instance.directory, search)

    const limit = 100
    const files = []
    let truncated = false
    let cutoff: Ripgrep.Cutoff | undefined
    for await (const file of Ripgrep.files({
      cwd: search,
      glob: [params.pattern],
      signal: ctx.abort,
      onCutoff: (c) => (cutoff = c),
    })) {
      if (files.length >= limit) {
        truncated = true
        break
      }
      const full = path.resolve(search, file)
      const stats = await Bun.file(full)
        .stat()
        .then((x) => x.mtime.getTime())
        .catch(() => 0)
      files.push({
        path: full,
        mtime: stats,
      })
    }
    files.sort((a, b) => b.mtime - a.mtime)

    const output = []
    if (files.length === 0) output.push("No files found")
    if (files.length > 0) {
      output.push(...files.map((f) => f.path))
      if (truncated) {
        output.push("")
        output.push("(Results are truncated. Consider using a more specific path or pattern.)")
      }
    }

    if (cutoff) {
      output.push("")
      output.push(
        `(Search stopped after ${Math.round(cutoff.elapsedMs / 1000)}s — the directory is too large to walk. Results are partial. Search a narrower path.)`,
      )
    }
    const note = directoryHint(params.pattern, files.length)
    if (note) {
      output.push("")
      output.push(note)
    }

    return {
      title: path.relative(Instance.worktree, search),
      metadata: {
        count: files.length,
        truncated,
      },
      output: output.join("\n"),
    }
  },
})
