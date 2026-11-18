/**
 * The MCP hive_* tools' words (#191981). Pure: the handlers in mcp-serve.ts do the I/O.
 *
 * Two different things share the name "Hive session":
 *   - the FLEET: every AI session (Claude Code, opencode, Codex, …) your machines report to the
 *     cloud — what `iris hive sessions` lists, on any machine, tmux or not;
 *   - LOCAL tmux swarm sessions, which only the daemon bridge on THIS machine can see or type into.
 * hive_sessions answered with the second alone, so on a machine without tmux an agent asking "what
 * is the fleet doing?" was told "nothing" while the CLI showed several sessions. It now returns
 * both, each labelled. hive_panes / hive_send_input stay local, and say so when they fail.
 */

/** `iris hive sessions` argv for the hive_sessions tool: the same command a person runs. */
export function fleetArgs(input: { status?: unknown; all?: unknown }): string[] {
  const args = ["hive", "sessions", "--json"]
  const status = typeof input.status === "string" ? input.status.trim() : ""
  if (/^(needs_you|active|idle|stale|unknown)$/.test(status)) args.push("--status", status)
  else if (input.all === true) args.push("--all")
  return args
}

/** The CLI's --json output as rows, or why it could not be read. */
export function parseFleet(stdout: string): { rows: unknown[] } | { error: string } {
  const text = stdout.trim()
  const start = text.indexOf("[")
  if (start < 0) return { error: text.slice(0, 300) || "iris hive sessions printed nothing" }
  try {
    const rows = JSON.parse(text.slice(start))
    return Array.isArray(rows) ? { rows } : { error: "iris hive sessions did not return a list" }
  } catch {
    return { error: "iris hive sessions returned output that is not JSON" }
  }
}

/**
 * A failed bridge response in words an agent can act on. The bridge says why in its JSON body
 * (`{error: "tmux not available"}`), which the old message dropped — so "this machine has no tmux"
 * and "this session does not exist" both read as "Bridge error: 503", i.e. as a dead daemon.
 */
export function bridgeErrorText(status: number, statusText: string, body: unknown, session?: string): string {
  const said = body && typeof body === "object" && typeof (body as any).error === "string" ? (body as any).error : ""
  if (status === 401)
    return "Bridge error: Unauthorized — the local daemon bridge rejected the key. Ensure the iris daemon is running (the key in ~/.iris/bridge-token rotates on restart)."
  if (/tmux not available/i.test(said))
    return (
      "tmux is not installed on this machine, so there are no local swarm sessions to read or type into. " +
      "hive_panes and hive_send_input reach LOCAL tmux sessions only. For a session in hive_sessions' fleet, " +
      'use iris_run with "hive send-input <session id> <text>" (or "hive ask").'
    )
  if (status === 404) return `No tmux session${session ? ` named "${session}"` : ""} on this machine.${said ? ` (${said})` : ""}`
  return `Bridge error: ${status} ${statusText}${said ? ` — ${said}` : ""}`
}
