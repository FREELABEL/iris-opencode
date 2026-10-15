import { NamedError } from "@opencode-ai/util/error"
import matter from "gray-matter"
import { z } from "zod"

export namespace ConfigMarkdown {
  export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g
  export const SHELL_REGEX = /!`([^`]+)`/g

  export function files(template: string) {
    return Array.from(template.matchAll(FILE_REGEX))
  }

  export function shell(template: string) {
    return Array.from(template.matchAll(SHELL_REGEX))
  }

  export async function parse(filePath: string) {
    const template = await Bun.file(filePath).text()

    try {
      const md = matter(template)
      return md
    } catch (err) {
      // Claude Code and the IRIS app accept an unquoted colon in a frontmatter value
      // ("description: Ship it: safely"); this parser did not, so such a playbook installed,
      // never became a skill, and took every other playbook's listing down with it. Retry the
      // way the app does (1.18 core ConfigMarkdown.sanitize) before giving up.
      try {
        return matter(sanitize(template))
      } catch {}
      throw new FrontmatterError(
        {
          path: filePath,
          message: `Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        },
        { cause: err },
      )
    }
  }

  /** Unquoted values containing ":" become block scalars — the IRIS app's own fallback, verbatim. */
  export function sanitize(content: string) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!match) return content
    const frontmatter = match[1]
    const result = frontmatter.split(/\r?\n/).flatMap((line) => {
      if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line]
      const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
      if (!entry) return [line]
      const value = entry[2].trim()
      if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line]
      if (!value.includes(":")) return [line]
      return [`${entry[1]}: |-`, `  ${value}`]
    })
    return content.replace(frontmatter, () => result.join("\n"))
  }

  export const FrontmatterError = NamedError.create(
    "ConfigFrontmatterError",
    z.object({
      path: z.string(),
      message: z.string(),
    }),
  )
}
