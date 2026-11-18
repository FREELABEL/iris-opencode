/**
 * Map a tool name the model got slightly wrong onto the one tool it plainly meant (#189837).
 *
 * Seen in IRIS Desktop 2026-10-18: the model called `IRIS_OS_iris_iris_help`. The tool is
 * `IRIS_OS_iris_help` — the MCP server is IRIS_OS and its tools are already named iris_*, so the
 * model doubled the segment. The repair hook only fixed letter case, so the call became `invalid`
 * and the turn spent itself recovering.
 *
 * Narrow on purpose: compare after lowercasing and collapsing a segment repeated back-to-back
 * (iris_iris → iris), and repair only when EXACTLY ONE available tool matches. An ambiguous or
 * absent match returns null and the call stays invalid — guessing between two real tools would
 * run the wrong one.
 */
export function repairToolName(name: string, available: string[]): string | null {
  const norm = (s: string) => {
    const parts = s.toLowerCase().split(/[_\-.]+/).filter(Boolean)
    return parts.filter((p, i) => p !== parts[i - 1]).join("_")
  }
  const want = norm(name)
  if (!want) return null
  const matches = available.filter((t) => t !== "invalid" && norm(t) === want)
  if (matches.length !== 1) return null
  return matches[0] === name ? null : matches[0]
}
