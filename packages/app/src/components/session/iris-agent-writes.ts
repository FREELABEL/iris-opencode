/**
 * Did the agent just change IRIS data? (#194361)
 *
 * Ask the agent to "put the top 5 in a new list Call today" and it runs `iris bloqs create-list` /
 * `add-item` — and the open panel kept showing the old board until you clicked away and back. The
 * panel now re-reads when a tool call that WRITES to IRIS finishes in this chat. Reads (`list`,
 * `get`, `show`, …) do not count, or every look the agent took would reload the panel.
 *
 * The answer is a key — the ids of every finished writing call — so a caller compares it with the
 * last one and refetches when it grows. Pure, so it is tested without a session.
 */

interface PartLike {
  id?: string
  callID?: string
  type?: string
  tool?: string
  state?: { status?: string; input?: any }
}

const SHELL_TOOLS = new Set(["bash", "shell"])

/** Engine tools that write to IRIS when they complete. */
const IRIS_WRITE_TOOLS = new Set(["atlas_artifact", "atlas_epic", "genesis_artifact", "outreach_segment"])

/** MCP tools that run an IRIS command (iris_run, playbook_run), under any server prefix. */
const IRIS_RUN_TOOL = /(^|_)(iris_run|playbook_run)$/

/** A subcommand word that changes something. Matched per hyphen-part: `create-list`, `note-delete`. */
const WRITE_WORD =
  /^(create|add|new|update|edit|set|move|delete|del|rm|remove|import|archive|unarchive|assign|unassign|note|comment|done|complete|close|reopen|rename|tag|untag|label|publish|unpublish|push|send|enroll|convert|merge|link|unlink|attach|detach|upload|save|install|share|invite|approve|reject|pin|unpin|sync|run|start|stop)$/

/** Does this shell command (or `iris_run` command string) run an `iris` command that writes? */
export function irisCommandWrites(command: unknown): boolean {
  if (typeof command !== "string" || !command) return false
  // Each `iris …` invocation in the line: after a start, `;`, `&&`, `||`, `|`, `(`, or a path to the binary.
  for (const m of command.matchAll(/(?:^|[\s;&|(`])(?:[\w./~-]*\/)?iris((?:\s+[^\s;&|)`]+)*)/g)) {
    const words = (m[1] ?? "").trim().split(/\s+/)
    for (const w of words) {
      if (!w || w.startsWith("-")) break // flags end the subcommand path
      if (/^["'\d#]/.test(w)) break // a quoted value or an id: past the subcommand
      if (w.split("-").some((part) => WRITE_WORD.test(part.toLowerCase()))) return true
    }
  }
  return false
}

function partWrites(p: PartLike): boolean {
  if (p?.type !== "tool" || p.state?.status !== "completed" || !p.tool) return false
  if (IRIS_WRITE_TOOLS.has(p.tool)) return true
  const input = p.state.input ?? {}
  if (SHELL_TOOLS.has(p.tool)) return irisCommandWrites(input.command)
  if (IRIS_RUN_TOOL.test(p.tool)) {
    if (/playbook_run$/.test(p.tool)) return true
    const cmd = typeof input.command === "string" ? input.command : Array.isArray(input.args) ? input.args.join(" ") : ""
    return irisCommandWrites(`iris ${cmd.replace(/^\s*iris\s+/, "")}`)
  }
  return false
}

/** The ids of every finished tool call in `parts` that wrote to IRIS, joined — "" when none. */
export function irisWritesKey(parts: PartLike[]): string {
  const ids: string[] = []
  for (const p of parts) if (partWrites(p)) ids.push(p.callID ?? p.id ?? String(ids.length))
  return ids.join(",")
}
