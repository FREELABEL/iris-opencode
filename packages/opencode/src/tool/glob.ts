import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./glob.txt"
import * as Tool from "./tool"

/**
 * Glob lists FILES. A pattern whose last part names a directory (`**\/.git`, `**\/node_modules`)
 * finds nothing — or only stray files of that name — and the model reads that as "none exist"
 * (#191073: it went on to walk the whole disk looking for repositories).
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

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The glob pattern to match files against" }),
  path: Schema.optional(Schema.String).annotate({
    description: `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
  }),
})

export const GlobTool = Tool.define(
  "glob",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          yield* ctx.ask({
            permission: "glob",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
            },
          })

          let search = params.path ?? ins.directory
          search = path.isAbsolute(search) ? search : path.resolve(ins.directory, search)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (info?.type === "File") {
            throw new Error(`glob path must be a directory: ${search}`)
          }
          yield* assertExternalDirectoryEffect(ctx, search, {
            bypass: false,
            kind: "directory",
          })

          const limit = 100
          let cutoff: Ripgrep.Cutoff | undefined
          const files = yield* ripgrep.glob({
            cwd: search,
            pattern: params.pattern,
            limit,
            signal: ctx.abort,
            onCutoff: (info) => (cutoff = info),
          })
          const truncated = files.length === limit

          const output = []
          if (files.length === 0) output.push("No files found")
          if (files.length > 0) {
            output.push(...files.map((file) => path.resolve(search, file.path)))
            if (truncated) {
              output.push("")
              output.push(
                `(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`,
              )
            }
          }

          if (cutoff) {
            output.push("")
            output.push(
              `(Search stopped after ${Math.round(cutoff.elapsedMs / 1000)}s — the directory is too large to walk. ` +
                `Results are partial. Search a narrower path.)`,
            )
          }
          const note = directoryHint(params.pattern, files.length)
          if (note) {
            output.push("")
            output.push(note)
          }

          return {
            title: path.relative(ins.worktree, search),
            metadata: {
              count: files.length,
              truncated: truncated || cutoff !== undefined,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
