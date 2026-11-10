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

/**
 * hive_wait (#193064): the way "a session needs you" reaches an agent today. No major MCP client
 * shows a resource-subscription notification to the model (Claude's docs say so outright), so the
 * event is delivered as a call that RETURNS when it happens: wait, answer, wait again. `seen` lets
 * an agent loop without being handed the session it just answered.
 */
export const WAIT_DEFAULT_S = 60
export const WAIT_MAX_S = 600
export const WAIT_POLL_MS = 5_000

export function waitParams(input: { timeout_s?: unknown; seen?: unknown; node?: unknown }) {
  const t = typeof input.timeout_s === "number" && Number.isFinite(input.timeout_s) ? input.timeout_s : WAIT_DEFAULT_S
  const seen = Array.isArray(input.seen) ? input.seen.filter((s): s is string => typeof s === "string") : []
  const node = typeof input.node === "string" && /^[\w.@-]{1,100}$/.test(input.node) ? input.node : undefined
  return { timeoutMs: Math.round(Math.min(WAIT_MAX_S, Math.max(0, t)) * 1000), seen: new Set(seen), node }
}

/** `iris hive sessions` argv for one poll: only sessions waiting on a person. */
export function waitPollArgs(node?: string): string[] {
  return ["hive", "sessions", "--json", "--status", "needs_you", ...(node ? ["--node", node] : [])]
}

/** What an agent needs to act on a waiting session: who, where, the questions, and how to answer. */
export function waitingOf(rows: unknown[], seen: Set<string>) {
  return rows.flatMap((r: any) => {
    if (!r || r.status !== "needs_you" || typeof r.session_id !== "string" || seen.has(r.session_id)) return []
    const questions = (Array.isArray(r.waiting?.questions) ? r.waiting.questions : [])
      .filter((q: any) => q && typeof q.question === "string" && q.question.trim())
      .map((q: any) => ({
        header: typeof q.header === "string" ? q.header : null,
        question: q.question.replace(/\s+/g, " ").trim(),
        options: (Array.isArray(q.options) ? q.options : []).flatMap((o: any, i: number) =>
          o && typeof o.label === "string" && o.label.trim() ? [{ n: i + 1, label: o.label.trim() }] : [],
        ),
      }))
    return [
      {
        session_id: r.session_id,
        node: r.node ?? null,
        provider: r.provider ?? null,
        name: r.label ?? r.name ?? null,
        asked_at: r.waiting?.asked_at ?? r.updated_at ?? null,
        questions,
        answer_with: `hive_answer {session_id: "${r.session_id}", choices: [${questions.map(() => "<n or text>").join(", ")}]}`,
      },
    ]
  })
}

/** `iris hive answer` argv, or why not: one choice per question, as the CLI takes them. */
export function answerArgs(input: { session_id?: unknown; choices?: unknown }): { args: string[] } | { error: string } {
  const id = typeof input.session_id === "string" ? input.session_id.trim() : ""
  if (!/^[\w.:-]{1,200}$/.test(id)) return { error: "session_id is required (from hive_wait or hive_sessions)" }
  const raw = Array.isArray(input.choices) ? input.choices : []
  const choices = raw.map((c) => (typeof c === "string" || typeof c === "number" ? String(c).trim() : ""))
  if (!choices.length || choices.some((c) => c === "")) return { error: "choices: one non-empty answer per question (an option number, a label, or your own words)" }
  if (choices.length > 4 || choices.some((c) => c.length > 2000)) return { error: "choices: at most 4 answers of up to 2000 characters" }
  // The CLI's parser drops positionals after "--" (measured: `hive answer x -- 1` says "need at least
  // 2"), so a leading dash cannot be escaped — it would be read as a flag. Refuse it instead.
  if (choices.some((c) => c.startsWith("-"))) return { error: "choices: an answer cannot start with '-'" }
  return { args: ["hive", "answer", "--json", id, ...choices] }
}

/**
 * The hive_wait loop, with the clock injected so it can be tested. It polls until someone is waiting
 * or the deadline passes, sleeping min(everyMs, time left) between polls, so a 12 s wait lasts 12 s.
 * (It used to stop when the NEXT poll would overrun, returning after 7 s of a 12 s wait.) A failed
 * read is remembered; a later good poll clears it.
 */
export async function waitLoop(
  poll: () => Promise<{ rows: unknown[] } | { error: string }>,
  opts: { timeoutMs: number; everyMs: number; seen?: Set<string>; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<{ waiting: ReturnType<typeof waitingOf>; waited_s: number; timed_out?: true } | { error: string }> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)))
  const started = now()
  const deadline = started + opts.timeoutMs
  let lastError = ""
  for (;;) {
    const fleet = await poll()
    if ("rows" in fleet) {
      const waiting = waitingOf(fleet.rows, opts.seen ?? new Set())
      if (waiting.length) return { waiting, waited_s: Math.round((now() - started) / 1000) }
      lastError = ""
    } else lastError = fleet.error || "iris hive sessions failed"
    const left = deadline - now()
    if (left <= 0) break
    await sleep(Math.min(opts.everyMs, left))
  }
  if (lastError) return { error: lastError }
  return { waiting: [], timed_out: true, waited_s: Math.round((now() - started) / 1000) }
}
