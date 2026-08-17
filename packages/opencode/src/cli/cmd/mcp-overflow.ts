import { mkdirSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

/**
 * Spill oversized tool output to disk and hand the model a MAP of it.
 *
 * WHY. The MCP used to hard-truncate at 100KB with `...(truncated)`, which is the
 * worst available option: a JSON payload cut mid-object is unparseable, so the model
 * loses the data AND any way to recover it. Observed 2026-08-17 on
 * `bloqs get 544 --json` — 68KB of a real board, sliced into garbage.
 *
 * Claude's own harness handles this better: it writes the full result to a file and
 * tells the model to use offset/limit/jq. That turns a dead end into an artifact.
 * This does that, and one thing more — it returns an OUTLINE of the payload, so the
 * model does not have to spend a round-trip discovering the shape before it can query
 * it. In the transcript that motivated this, Claude's first move after the overflow
 * was `jq keys`; the outline below answers that question up front.
 *
 * The output is deliberately written as instructions rather than as an error. An
 * agent that reads "exceeds maximum" and nothing else concludes the tool failed —
 * and then tells the user the platform is unavailable, which is exactly what
 * happened with the `Unknown command "iris"` bug.
 */

/** Where spilled results live. One directory, easy to find and easy to clear. */
export function spoolDir(): string {
  return join(homedir(), ".iris", "tool-results")
}

/** Describe a parsed JSON value in one short line. */
function describe(v: unknown): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return `array(${v.length})`
  switch (typeof v) {
    case "string":
      return `string(${v.length})`
    case "number":
      return "number"
    case "boolean":
      return "boolean"
    case "object":
      return `object(${Object.keys(v as object).length} keys)`
    default:
      return typeof v
  }
}

/**
 * Build a compact outline of the payload so the model can aim its next query.
 *
 * For JSON: top-level keys with types, plus the shape of the first element of any
 * array — that is almost always what the model needs to write a useful jq filter.
 * For text: line count and a head sample.
 */
export function outline(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed)
      const lines: string[] = []
      if (Array.isArray(parsed)) {
        lines.push(`JSON array, ${parsed.length} elements.`)
        if (parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null) {
          lines.push(`Element shape: ${Object.keys(parsed[0]).join(", ")}`)
        }
      } else {
        lines.push(`JSON object, ${Object.keys(parsed).length} top-level keys:`)
        for (const [k, v] of Object.entries(parsed)) {
          lines.push(`  ${k}: ${describe(v)}`)
        }
        // Arrays of objects are where the content usually is — show one shape.
        for (const [k, v] of Object.entries(parsed)) {
          if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null) {
            lines.push(`  ↳ ${k}[0] keys: ${Object.keys(v[0] as object).join(", ")}`)
          }
        }
      }
      return lines.join("\n")
    } catch {
      // Fall through to the text outline — a payload that merely starts with a brace
      // is not necessarily JSON, and guessing wrong should not lose the sample.
    }
  }

  const allLines = raw.split("\n")
  const head = allLines.slice(0, 15).join("\n")
  return `Plain text, ${allLines.length} lines, ${raw.length} characters.\nFirst 15 lines:\n${head}`
}

/**
 * Write the payload to the spool and return the guidance block to show the model.
 *
 * Returns null if writing fails — in that case the caller should fall back to
 * truncation rather than losing the result entirely. A degraded answer beats none.
 */
export function spill(raw: string, command: string): string | null {
  try {
    const dir = spoolDir()
    mkdirSync(dir, { recursive: true })
    const safe = command.replace(/[^a-z0-9]+/gi, "-").slice(0, 40) || "result"
    const isJson = raw.trim().startsWith("{") || raw.trim().startsWith("[")
    // Date.now() is fine here: this is a filename, not workflow state.
    const path = join(dir, `${safe}-${Date.now()}.${isJson ? "json" : "txt"}`)
    writeFileSync(path, raw, "utf8")

    const jqHint = isJson
      ? [
          "",
          "Query it with jq, e.g.:",
          `  jq 'keys' ${path}`,
          `  jq -r '.lists[] | "\\(.name) (\\(.items|length))"' ${path}`,
        ].join("\n")
      : [
          "",
          "Read or search it, e.g.:",
          `  head -100 ${path}`,
          `  grep -n "<term>" ${path}`,
        ].join("\n")

    return [
      `The full result was ${raw.length} characters — too large to return inline, so it has been SAVED, not lost.`,
      "",
      `FILE: ${path}`,
      "",
      "OUTLINE:",
      outline(raw),
      jqHint,
      "",
      "The command SUCCEEDED. Read the file to answer the question — do not report this as a failure or as the platform being unavailable.",
      "Tip: re-running with a narrower command (a specific list/id, or --json piped through jq) is usually better than reading the whole file.",
    ].join("\n")
  } catch {
    return null
  }
}
