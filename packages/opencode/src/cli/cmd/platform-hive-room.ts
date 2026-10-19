import { cmd } from "./cmd"
import { requireAuth, requireUserId, writeJson, dim, bold, success, highlight } from "./iris-api"
import { hiveFetch } from "./platform-hive-nodes"
import {
  type Session,
  age,
  label,
  fetchFleetNodes,
  matchSessionId,
  createSessionMessageTask,
} from "./platform-hive-sessions"
import { TERMINAL_STATUSES, pickResultPayload } from "./hive-task-create"

/**
 * `iris hive room "<message>" @a @b @c` — one message, several running sessions, one thread of
 * replies (eval #189927, gap 3).
 *
 * This is a fan-out over `hive send-input`, not a second transport. Each @name is resolved the
 * way a person reads `iris hive sessions`, every target goes through the same
 * `session_message` task that send-input creates, and the reply is read from that task's own
 * result: the bridge's /message route answers synchronously, so the task output IS the reply.
 *
 * Two rules carry the whole design:
 *  - Resolution happens for EVERY name before ANYTHING is sent. One ambiguous or unknown name
 *    refuses the room. A message typed into the wrong agent cannot be taken back, and a room
 *    that half-sends leaves the person working out who got it.
 *  - Each target is collected independently. One session erroring or timing out is reported
 *    on its own line; it never hides the others.
 */

export type Row = { node: any; s: Session }

export type Resolution =
  | { mention: string; ok: true; node: any; s: Session; by: "id" | "name" }
  | { mention: string; ok: false; reason: "not_found" | "ambiguous" | "stale" | "empty"; candidates: Row[] }

/** "@Hermes" → "Hermes". Whitespace and any number of leading @ are dropped. */
export function parseMention(raw: string): string {
  return String(raw ?? "").trim().replace(/^@+/, "").trim()
}

function rowsOf(nodes: any[]): Row[] {
  const out: Row[] = []
  for (const n of nodes) for (const s of (n.active_sessions || []) as Session[]) out.push({ node: n, s })
  return out
}

/** The names a person could reasonably type for a session: what `hive sessions` prints, the raw
 * name, and the project folder. Lower-cased; empties dropped. */
export function namesOf(s: Session): string[] {
  const proj = (s.project_path || "").split("/").filter(Boolean).pop() || ""
  return [label(s), s.name || "", proj]
    .map((x) => x.replace(/\s+/g, " ").trim().toLowerCase())
    .filter((x) => x.length > 0)
}

/** Shortest substring a name match will accept. "@a" matching whatever contains an "a" is a
 * guess, not a match. */
const MIN_PARTIAL = 3

/**
 * Resolve one @mention to exactly one live session, or say why not.
 *
 * Order: session id (full or ≥6-char suffix, the send-input rule), then an exact name, then a
 * unique partial name. Stale sessions never win a name match — send-input refuses them — but
 * if ONLY stale sessions match, that is reported as such rather than as "not found".
 */
export function resolveMention(nodes: any[], raw: string): Resolution {
  const mention = parseMention(raw)
  if (!mention) return { mention, ok: false, reason: "empty", candidates: [] }

  const idHits = matchSessionId(nodes, mention)
  if (idHits.length === 1) {
    const h = idHits[0]
    if (h.s.status === "stale") return { mention, ok: false, reason: "stale", candidates: idHits }
    return { mention, ok: true, node: h.node, s: h.s, by: "id" }
  }
  if (idHits.length > 1) return { mention, ok: false, reason: "ambiguous", candidates: idHits }

  const q = mention.toLowerCase()
  const rows = rowsOf(nodes)
  const live = (rs: Row[]) => rs.filter((r) => r.s.status !== "stale")

  const exact = rows.filter((r) => namesOf(r.s).includes(q))
  const partial =
    q.length >= MIN_PARTIAL ? rows.filter((r) => namesOf(r.s).some((n) => n.includes(q))) : []

  for (const tier of [exact, partial]) {
    const l = live(tier)
    if (l.length === 1) return { mention, ok: true, node: l[0].node, s: l[0].s, by: "name" }
    if (l.length > 1) return { mention, ok: false, reason: "ambiguous", candidates: l }
  }

  const staleOnly = exact.length ? exact : partial
  if (staleOnly.length) return { mention, ok: false, reason: "stale", candidates: staleOnly }

  // Nothing matched: show what COULD have been meant, i.e. every live session.
  return { mention, ok: false, reason: "not_found", candidates: live(rows) }
}

export type Target = { mentions: string[]; node: any; s: Session; by: "id" | "name" }

/** Resolve every mention. Two mentions of the same session become one target (it is sent once). */
export function resolveRoom(nodes: any[], mentions: string[]) {
  const resolutions = mentions.map((m) => resolveMention(nodes, m))
  const problems = resolutions.filter((r): r is Extract<Resolution, { ok: false }> => !r.ok)
  const targets: Target[] = []
  for (const r of resolutions) {
    if (!r.ok) continue
    const seen = targets.find((t) => t.s.session_id === r.s.session_id)
    if (seen) seen.mentions.push(r.mention)
    else targets.push({ mentions: [r.mention], node: r.node, s: r.s, by: r.by })
  }
  return { resolutions, targets, problems }
}

export type ReplyStatus = "replied" | "delivered" | "timeout" | "error"

export type Reply = {
  mentions: string[]
  session_id: string
  label: string
  node: string
  provider: string
  status: ReplyStatus
  reply: string | null
  error: string | null
  task_id: string | null
  elapsed_ms: number
}

/**
 * What a finished `session_message` task says the session answered.
 *
 * The task's output is the bridge's /message response body (curl stdout):
 *   claude-code / ollama → {response: "...", model, tokens_used}
 *   opencode             → {status: "delivered", response: null}  — a live notification runs no
 *                          model turn, so there is NO reply to read; that is "delivered", never
 *                          a fabricated "replied".
 *   any failure          → {error: "..."} or a failed task with stderr.
 */
export function readReply(task: Record<string, any> | null | undefined): {
  status: ReplyStatus
  reply: string | null
  error: string | null
} {
  const st = String(task?.status ?? "")
  const view = pickResultPayload(task)
  if (st === "timeout") return { status: "timeout", reply: null, error: "the node timed the task out" }
  if (st !== "succeeded" && st !== "completed") {
    const why =
      view.stderr?.trim() || (task?.error as string) || view.text.trim() || `task ${st || "ended"} with no reason given`
    return { status: "error", reply: null, error: why.slice(0, 500) }
  }

  const text = view.text.trim()
  if (!text) return { status: "delivered", reply: null, error: null }

  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    return { status: "replied", reply: text, error: null }
  }
  if (!body || typeof body !== "object") return { status: "replied", reply: text, error: null }
  if (body.error) return { status: "error", reply: null, error: String(body.error).slice(0, 500) }
  if (typeof body.response === "string" && body.response.trim()) {
    return { status: "replied", reply: body.response.trim(), error: null }
  }
  return { status: "delivered", reply: null, error: null }
}

/** The two calls a room makes, injectable so tests never touch a real session. */
export interface RoomTransport {
  /** Create the session_message task. Returns its id, or throws with the reason. */
  send(target: Target, message: string): Promise<string>
  /** The task as the hub currently has it, or null if it could not be read this time. */
  getTask(taskId: string): Promise<Record<string, any> | null>
  sleep(ms: number): Promise<void>
  now(): number
}

export async function runRoom(
  targets: Target[],
  message: string,
  transport: RoomTransport,
  opts: { timeoutMs: number; pollMs?: number },
): Promise<Reply[]> {
  const pollMs = opts.pollMs ?? 2000
  return Promise.all(
    targets.map(async (t): Promise<Reply> => {
      const started = transport.now()
      const base = {
        mentions: t.mentions,
        session_id: t.s.session_id,
        label: label(t.s),
        node: String(t.node?.name ?? "?"),
        provider: String(t.s.provider ?? "?"),
      }
      const done = (r: Pick<Reply, "status" | "reply" | "error" | "task_id">): Reply => ({
        ...base,
        ...r,
        elapsed_ms: transport.now() - started,
      })

      let taskId: string
      try {
        taskId = await transport.send(t, message)
      } catch (e) {
        return done({ status: "error", reply: null, error: `not sent: ${errText(e)}`, task_id: null })
      }

      const deadline = started + opts.timeoutMs
      while (transport.now() < deadline) {
        await transport.sleep(pollMs)
        let task: Record<string, any> | null = null
        try {
          task = await transport.getTask(taskId)
        } catch {
          task = null // a failed poll is retried, not reported as the session's answer
        }
        if (task && TERMINAL_STATUSES.has(String(task.status ?? ""))) {
          return done({ ...readReply(task), task_id: taskId })
        }
      }
      return done({
        status: "timeout",
        reply: null,
        error: `no reply within ${Math.round(opts.timeoutMs / 1000)}s — the task may still finish: iris hive tasks get ${taskId}`,
        task_id: taskId,
      })
    }),
  )
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 0 when everyone answered or was delivered to, 124 when the only shortfall is timeouts (the
 * coreutils convention hive already uses), 1 when anything errored. */
export function roomExitCode(replies: Reply[]): number {
  if (replies.some((r) => r.status === "error")) return 1
  if (replies.some((r) => r.status === "timeout")) return 124
  return 0
}

function describe(r: Row): string {
  return `${label(r.s)}  ${dim(`${r.s.session_id} · ${r.node?.name ?? "?"} · ${r.s.provider} · ${r.s.status} ${age(r.s.updated_at)}`)}`
}

const REASON: Record<string, string> = {
  not_found: "matches no running session",
  ambiguous: "matches more than one session — use a session id",
  stale: "only matches a stale session — it is unlikely to answer",
  empty: "is empty",
}

function printProblems(problems: Array<Extract<Resolution, { ok: false }>>) {
  for (const p of problems) {
    console.error(`  @${p.mention || "?"} ${REASON[p.reason]}`)
    const shown = p.candidates.slice(0, 12)
    if (shown.length) console.error(dim(p.reason === "not_found" ? "    running sessions:" : "    candidates:"))
    for (const c of shown) console.error(`      ${describe(c)}`)
    if (p.candidates.length > shown.length) console.error(dim(`      … ${p.candidates.length - shown.length} more — iris hive sessions`))
  }
}

const STATUS_STYLE: Record<ReplyStatus, (s: string) => string> = {
  replied: success,
  delivered: highlight,
  timeout: dim,
  error: (s) => s,
}

function indent(text: string, pad = "    "): string {
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n")
}

const RoomCommand = cmd({
  command: "room <message> [mentions..]",
  describe: "send one message to several running sessions (@name or session id) and collect every reply in one thread",
  builder: (yargs) =>
    yargs
      .positional("message", { describe: "what to send", type: "string", demandOption: true })
      .positional("mentions", {
        describe: "@name or session id, as shown in `iris hive sessions`",
        type: "string",
        array: true,
      })
      .option("timeout", { describe: "seconds to wait for each reply", type: "number", default: 240 })
      .option("dry-run", { describe: "resolve the names and stop — nothing is sent", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID", type: "number" })
      .example('$0 hive room "launch moved to 10am" @hermes @grokbot', "")
      .epilogue(
        "Every name is resolved before anything is sent. One unknown or ambiguous name refuses the\n" +
          "whole room, and lists the candidates. Use --dry-run to check who would receive it.",
      ),
  async handler(argv) {
    const message = String(argv.message ?? "")
    const mentions = ((argv.mentions as string[] | undefined) ?? []).map(String)

    if (!mentions.length) {
      console.error('Name at least one session:  iris hive room "<message>" @name @name')
      process.exit(1)
    }
    if (message.trim().startsWith("@") && mentions.every((m) => !m.startsWith("@"))) {
      // `iris hive room @a "msg"` would send "@a" as the message to a session called "msg".
      console.error('The message comes first:  iris hive room "<message>" @name @name')
      process.exit(1)
    }
    const timeoutS = Number(argv.timeout)
    if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
      console.error("--timeout must be a positive number of seconds")
      process.exit(1)
    }

    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const nodes = await fetchFleetNodes(userId)
    const { resolutions, targets, problems } = resolveRoom(nodes, mentions)

    const resolvedJson = targets.map((t) => ({
      mentions: t.mentions,
      by: t.by,
      session_id: t.s.session_id,
      label: label(t.s),
      node: t.node?.name ?? null,
      provider: t.s.provider,
      status: t.s.status,
    }))
    const problemsJson = problems.map((p) => ({
      mention: p.mention,
      reason: p.reason,
      candidates: p.candidates.map((c) => ({
        session_id: c.s.session_id,
        label: label(c.s),
        node: c.node?.name ?? null,
        status: c.s.status,
      })),
    }))

    if (problems.length) {
      if (argv.json) {
        await writeJson({ message, dry_run: !!argv["dry-run"], sent: false, targets: resolvedJson, problems: problemsJson })
      } else {
        console.error()
        console.error(`Nothing sent — ${problems.length} of ${resolutions.length} name(s) did not resolve to one session:`)
        printProblems(problems)
        console.error()
      }
      process.exit(1)
    }

    if (argv["dry-run"]) {
      if (argv.json) return void (await writeJson({ message, dry_run: true, sent: false, targets: resolvedJson, problems: [] }))
      console.log()
      console.log(dim(`  dry run — would send to ${targets.length} session(s), nothing sent:`))
      for (const t of targets) {
        console.log(`  ${bold(t.mentions.map((m) => "@" + m).join(" "))} ${dim(`(${t.by})`)} → ${describe(t)}`)
      }
      console.log()
      return
    }

    const transport: RoomTransport = {
      async send(t, msg) {
        const res = await createSessionMessageTask(userId, t.node, t.s, msg)
        if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`)
        const created = (await res.json()) as any
        const id = created?.task?.id
        if (!id) throw new Error("the hub accepted the task but returned no id")
        return String(id)
      },
      async getTask(id) {
        const res = await hiveFetch(`/api/v6/nodes/tasks/${id}?user_id=${userId}`)
        if (!res.ok) return null
        return ((await res.json()) as any)?.task ?? null
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    }

    if (!argv.json) {
      console.log()
      console.log(dim(`  room → ${targets.map((t) => label(t.s)).join(", ")}  ·  waiting up to ${timeoutS}s`))
    }

    const replies = await runRoom(targets, message, transport, { timeoutMs: timeoutS * 1000 })
    process.exitCode = roomExitCode(replies)

    if (argv.json) return void (await writeJson({ message, dry_run: false, sent: true, targets: resolvedJson, replies }))

    console.log()
    console.log(`  ${bold("you")}  ${message}`)
    for (const r of replies) {
      console.log()
      const who = `${bold(r.mentions.map((m) => "@" + m).join(" "))} ${dim(`${r.label} · ${r.node} · ${r.provider}`)}`
      console.log(`  ${who}  ${STATUS_STYLE[r.status](r.status)} ${dim(`${Math.round(r.elapsed_ms / 1000)}s`)}`)
      if (r.reply) console.log(indent(r.reply))
      else if (r.status === "delivered") console.log(dim("    delivered — this session type does not return a reply; read it in its own terminal"))
      if (r.error) console.log(dim(indent(r.error)))
    }
    console.log()
    const count = (s: ReplyStatus) => replies.filter((r) => r.status === s).length
    console.log(
      dim(
        `  ${count("replied")} replied · ${count("delivered")} delivered · ${count("timeout")} timeout · ${count("error")} error`,
      ),
    )
    console.log()
  },
})

export const HiveRoomCommand = RoomCommand
