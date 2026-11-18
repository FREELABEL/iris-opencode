import z from "zod"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"

import DESCRIPTION from "./grep.txt"
import { Instance } from "../project/instance"

const MAX_LINE_LENGTH = 2000

export const GrepTool = Tool.define("grep", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The regex pattern to search for in file contents"),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
  }),
  async execute(params, ctx) {
    if (!params.pattern) {
      throw new Error("pattern is required")
    }

    await ctx.ask({
      permission: "grep",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
        include: params.include,
      },
    })

    const searchPath = params.path || Instance.directory

    const rgPath = await Ripgrep.filepath()
    // A directory is walked: refuse / and prune protected folders (#191073). A single file is not.
    const isDir = (await Bun.file(searchPath).stat().catch(() => null))?.isDirectory() ?? true
    const walk = isDir ? Ripgrep.walkArgs(searchPath) : []
    const args = ["-nH", "--field-match-separator=|", "--regexp", params.pattern]
    if (params.include) {
      args.push("--glob", params.include)
    }
    // Last among the globs: ripgrep's last matching glob wins, so an include like `**` placed
    // after them would re-open Library/Containers.
    args.push(...walk)
    args.push(searchPath)

    const proc = Bun.spawn([rgPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })
    let cutoff: Ripgrep.Cutoff | undefined
    const unbound = Ripgrep.bound(proc, {
      budgetMs: Ripgrep.GREP_BUDGET_MS,
      signal: ctx.abort,
      onCutoff: (c) => (cutoff = c),
    })

    const [output, errorOutput] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    unbound()

    if (cutoff && !output.trim()) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: true },
        output: `No matches found before the search stopped at ${Math.round(cutoff.elapsedMs / 1000)}s — the directory is too large to search. Search a narrower path.`,
      }
    }

    if (exitCode === 1) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
      }
    }

    // Killed by the budget is not a failure: keep what it found. Exit 2 = some paths unreadable.
    if (exitCode !== 0 && exitCode !== 2 && !cutoff) {
      throw new Error(`ripgrep failed: ${errorOutput}`)
    }

    // Handle both Unix (\n) and Windows (\r\n) line endings
    const lines = output.trim().split(/\r?\n/)
    const matches = []

    for (const line of lines) {
      if (!line) continue

      const [filePath, lineNumStr, ...lineTextParts] = line.split("|")
      if (!filePath || !lineNumStr || lineTextParts.length === 0) continue

      const lineNum = parseInt(lineNumStr, 10)
      const lineText = lineTextParts.join("|")

      const file = Bun.file(filePath)
      const stats = await file.stat().catch(() => null)
      if (!stats) continue

      matches.push({
        path: filePath,
        modTime: stats.mtime.getTime(),
        lineNum,
        lineText,
      })
    }

    matches.sort((a, b) => b.modTime - a.modTime)

    const limit = 100
    const truncated = matches.length > limit
    const finalMatches = truncated ? matches.slice(0, limit) : matches

    if (finalMatches.length === 0) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
      }
    }

    const outputLines = [`Found ${finalMatches.length} matches`]

    let currentFile = ""
    for (const match of finalMatches) {
      if (currentFile !== match.path) {
        if (currentFile !== "") {
          outputLines.push("")
        }
        currentFile = match.path
        outputLines.push(`${match.path}:`)
      }
      const truncatedLineText =
        match.lineText.length > MAX_LINE_LENGTH ? match.lineText.substring(0, MAX_LINE_LENGTH) + "..." : match.lineText
      outputLines.push(`  Line ${match.lineNum}: ${truncatedLineText}`)
    }

    if (truncated) {
      outputLines.push("")
      outputLines.push("(Results are truncated. Consider using a more specific path or pattern.)")
    }
    if (cutoff) {
      outputLines.push("")
      outputLines.push(
        `(Search stopped after ${Math.round(cutoff.elapsedMs / 1000)}s — results are partial. Search a narrower path.)`,
      )
    }

    return {
      title: params.pattern,
      metadata: {
        matches: finalMatches.length,
        truncated: truncated || cutoff !== undefined,
      },
      output: outputLines.join("\n"),
    }
  },
})
