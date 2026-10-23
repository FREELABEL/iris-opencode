import { fetchClaims } from "./platform-hive-claim"
import { cmd } from "./cmd"
import { requireAuth, requireUserId, writeJson, dim, bold, success, warn } from "./iris-api"
import { hiveFetch } from "./platform-hive-nodes"
import os from "os"
import { followStep, newFollowState, type TranscriptMessage } from "../lib/hive-chat-follow"

/**
 * `iris hive sessions` — what AI sessions are running across your fleet.
 *
 * This existed for AGENTS and not for people: MCP has exposed `hive_sessions` for a while and
 * the CLI had no equivalent, so an agent could enumerate your sessions and you could not.
 *
 * The data already flows — every node reports `active_sessions` on its heartbeat. This is a
 * door onto it, not new plumbing.
 */

type Session = {
  session_id: string
  provider: string
  name: string
  status: string
  model: string | null
  git_branch: string | null
  project_path: string | null
  updated_at: string | null
  /** The question a person is being waited on for (#188536) — set by iris-daemon from the transcript. */
  waiting?: Waiting | null
}

type Waiting = {
  kind: string
  asked_at?: string | null
  questions?: Array<{ question?: string; header?: string | null; options?: Array<{ label?: string }> }>
}

/**
 * The lines printed under a `needs_you` row: the question, then its options numbered the way the
 * agent will read them. Exported for the test; anything malformed prints nothing rather than a
 * half-question.
 */
export function waitingLines(w: Waiting | null | undefined): string[] {
  if (!w || w.kind !== "question" || !Array.isArray(w.questions)) return []
  const out: string[] = []
  for (const q of w.questions) {
    if (!q || typeof q.question !== "string" || !q.question.trim()) continue
    const text = q.question.replace(/\s+/g, " ").trim()
    out.push(`? ${text.length > 110 ? text.slice(0, 109) + "…" : text}`)
    const opts = Array.isArray(q.options) ? q.options : []
    opts.forEach((o, i) => {
      if (o && typeof o.label === "string" && o.label.trim()) out.push(`  ${i + 1}. ${o.label.trim().slice(0, 100)}`)
    })
  }
  return out
}

/** A node report older than this lists nothing — the server's SessionRows::REPORT_WINDOW_S (#190653). */
export const REPORT_WINDOW_MS = 7 * 86400 * 1000

/**
 * The sessions the fleet currently reports, one per provider + id (#190653).
 *
 * A machine that re-registered keeps its OLD node record, and that record keeps its last list
 * forever: the Mac had a live record plus two dead ones from 2026-09-13 with 50 frozen rows each,
 * all shown beside its real sessions — and any session in both made `send-input <full id>` refuse
 * as "matches 2 sessions". So: a report older than REPORT_WINDOW_MS contributes no rows (it is
 * returned in `retired`, never silently dropped), and a session reported by several records is
 * taken from the newest report. A node with no report time at all is kept: unknown is not old.
 */
export function reportedSessions(
  nodes: any[],
  now = Date.now(),
): { entries: Array<{ node: any; s: Session; at: number }>; retired: Array<{ node: any; name: string; rows: number; at: string }> } {
  const best = new Map<string, { node: any; s: Session; at: number }>()
  const retired: Array<{ node: any; name: string; rows: number; at: string }> = []
  for (const n of nodes || []) {
    const list = (n?.active_sessions || []) as Session[]
    const at = Date.parse(n?.sessions_updated_at ?? n?.last_heartbeat_at ?? "")
    if (!Number.isNaN(at) && now - at > REPORT_WINDOW_MS) {
      if (list.length) retired.push({ node: n, name: String(n.name), rows: list.length, at: n.sessions_updated_at ?? n.last_heartbeat_at })
      continue
    }
    const t = Number.isNaN(at) ? 0 : at
    for (const s of list) {
      if (!s || !s.session_id) continue
      const key = `${(s as any).provider ?? ""}|${s.session_id}`
      const prev = best.get(key)
      if (!prev || t > prev.at) best.set(key, { node: n, s, at: t })
    }
  }
  return { entries: [...best.values()], retired }
}

function age(iso: string | null): string {
  if (!iso) return "—"
  const ms = Date.now() - Date.parse(iso)
  if (Number.isNaN(ms)) return "—"
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

/**
 * A label derived from what the session IS, not from whatever its first message happened to be.
 *
 * Real names found on the live fleet: a raw tool-use id followed by a temp path, a line of
 * box-drawing rule, and private-use Unicode glyphs. Those are not identifiers. The provider
 * and project are, so an unusable name falls back to `project · last-8-of-id`.
 */
function label(s: Session): string {
  // Strip control characters, box drawing, and the private-use area — all three were
  // observed as session "names" on the live fleet.
  const clean = (s.name || "")
    .replace(/[\u0000-\u001f\u2500-\u257f\ue000-\uf8ff]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  const usable = clean.length >= 4 && /[a-z0-9]/i.test(clean) && !/^new session\b/i.test(clean)
  if (usable) return clean.length > 46 ? clean.slice(0, 45) + "…" : clean

  const proj = (s.project_path || "").split("/").filter(Boolean).pop() || "?"
  return `${proj} · ${s.session_id.slice(-8)}`
}

// needs_you first: a session blocked on a person is the one row on this screen worth acting on.
const STATUS_ORDER: Record<string, number> = { needs_you: -1, active: 0, idle: 1, unknown: 2, stale: 3 }

const SessionsCommand = cmd({
  command: "sessions",
  describe: "AI sessions running across your Hive — what, where, on which model",
  builder: (yargs) =>
    yargs
      .option("node", { describe: "only this node", type: "string" })
      .option("status", { describe: "needs_you | active | idle | stale | unknown", type: "string" })
      .option("all", { describe: "include stale sessions (hidden by default)", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID", type: "number" })
      .epilogue(
        "A node that has not confirmed its session list recently is flagged above the table.\n" +
          "Its rows are a last-known snapshot, not a live one — `iris hive doctor` says why.",
      ),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const res = await hiveFetch(`/api/v6/nodes/?user_id=${userId}&detailed=1`)
    const body = (await res.json().catch(() => ({}))) as any
    const nodes = (body.nodes || body.data || []) as any[]

    const rows: Array<Session & { node: string }> = []
    // A node that has STOPPED reporting keeps its last known list on the server, so the
    // sessions still appear. What changes is that `sessions_updated_at` freezes — and if
    // nothing surfaces that, a frozen list is indistinguishable from a current one, which
    // is the bug this whole area kept producing (#183538).
    const quiet: Array<{ name: string; ago: string }> = []
    // Five minutes. A healthy node confirms its list on every heartbeat and sits at 0m; the
    // degraded one measured while building this hovered at 7-8m, reporting only occasionally.
    // Ten minutes did not separate those two, which is the whole job of this number. Five is
    // still ten missed heartbeats, so it does not fire on a brief hiccup.
    const QUIET_MS = 5 * 60 * 1000

    const wantNode = (n: any) => !argv.node || String(n.name).toLowerCase() === String(argv.node).toLowerCase()
    const { entries, retired } = reportedSessions(nodes.filter(wantNode))
    const old = new Set(retired.map((r) => r.node))
    for (const n of nodes.filter(wantNode)) {
      if (old.has(n)) continue // named below as an older record, not as a quiet machine
      const reported = n.sessions_updated_at ? Date.parse(n.sessions_updated_at) : NaN
      if (Number.isNaN(reported) || Date.now() - reported > QUIET_MS) {
        quiet.push({ name: n.name, ago: n.sessions_updated_at ? age(n.sessions_updated_at) : "never" })
      }
    }
    for (const { node, s } of entries) rows.push({ ...s, node: node.name })

    // Stale is hidden by default but COUNTED and reported, never silently dropped — a list
    // quietly filtered cannot be told from one that is complete.
    const staleCount = rows.filter((r) => r.status === "stale").length
    let shown = rows
    if (argv.status) shown = shown.filter((r) => r.status === argv.status)
    else if (!argv.all) shown = shown.filter((r) => r.status !== "stale")

    shown.sort(
      (a, b) =>
        (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
        Date.parse(b.updated_at || "0") - Date.parse(a.updated_at || "0"),
    )

    // Who has each session (#188316). A claims fetch that fails leaves the column out rather
    // than showing everything as "unassigned", which would be a false statement.
    const claims = await fetchClaims(userId).catch(() => null)
    if (argv.json) return void (await writeJson(claims ? shown.map((r) => ({ ...r, claim: claims.get(r.session_id) ?? null })) : shown))

    console.log()
    // Printed BEFORE the table, and printed even when the table is empty. A node that cannot
    // report is the most important thing on this screen, because everything below it is then
    // a last-known snapshot rather than a current one.
    for (const q of quiet) {
      console.log(dim(`  ⚠ ${q.name} last reported its sessions ${q.ago} ago — what follows for it may be out of date.`))
    }
    if (quiet.length) console.log()
    // Old node records (a machine that re-registered) — named, with how much they hold, so a
    // reader knows rows are left out and why. `iris hive nodes` can remove them.
    for (const r of retired) {
      console.log(dim(`  ${r.name}: an older record last reported ${age(r.at)} ago — its ${r.rows} sessions are not shown.`))
    }
    if (retired.length) console.log()

    if (shown.length === 0) {
      console.log(dim("  No sessions." + (staleCount ? `  ${staleCount} stale hidden — see with --all` : "")))
      console.log()
      return
    }

    console.log(
      `  ${dim("node".padEnd(16))} ${dim("status".padEnd(9))} ${dim("age".padEnd(5))} ${dim("provider".padEnd(12))} ${dim("model".padEnd(20))} ${dim("session")}`,
    )
    for (const r of shown) {
      const st =
        r.status === "needs_you"
          ? warn("needs you")
          : r.status === "active"
            ? success(r.status.padEnd(9))
            : dim(r.status.padEnd(9))
      const branch = r.git_branch ? dim(` (${r.git_branch})`) : ""
      const model = r.model ? String(r.model).slice(0, 20).padEnd(20) : dim("—".padEnd(20))
      console.log(
        `  ${String(r.node).slice(0, 16).padEnd(16)} ${st} ${age(r.updated_at).padEnd(5)} ${String(r.provider).padEnd(12)} ${model} ${bold(label(r))}${branch}`,
      )
      if (r.status === "needs_you") for (const line of waitingLines(r.waiting)) console.log(`  ${" ".repeat(16)} ${" ".repeat(9)} ${warn(line)}`)
      if (claims) {
        const c = claims.get(r.session_id)
        const owner = c?.assignee ? `owner ${bold(c.assignee)}` : dim("unassigned — iris hive claim " + r.session_id.slice(-8))
        const hint = !c?.assignee && c?.suggested_owner ? dim(`  · suggested: ${c.suggested_owner}`) : ""
        console.log(`  ${" ".repeat(16)} ${" ".repeat(9)} ${owner}${hint}`)
      }
    }
    console.log()
    const live = shown.filter((r) => r.status === "active").length
    const waiting = shown.filter((r) => r.status === "needs_you").length
    console.log(
      dim(
        `  ${shown.length} shown · ${waiting ? `${waiting} need you · ` : ""}${live} active${staleCount && !argv.all ? ` · ${staleCount} stale hidden (--all)` : ""}`,
      ),
    )
    console.log()
  },
})

/**
 * The one session `wanted` names, and the node holding it — or exit with the reason. Shared by
 * send-input and ask so "which session did you mean" is answered one way.
 */
async function resolveSession(userId: number, wanted: string): Promise<{ node: any; s: Session }> {
  const res = await hiveFetch(`/api/v6/nodes/?user_id=${userId}&detailed=1`)
  const body = (await res.json().catch(() => ({}))) as any
  const nodes = (body.nodes || body.data || []) as any[]

  // Match the FULL id, or an unambiguous suffix. Never a prefix: session ids share leading
  // characters, and a truncated match is how a wrong diagnosis got filed on this project
  // once already (#182312).
  // From the current reports only, one per session (#190653): a session also listed by an old
  // record of the same machine used to count twice and refuse even a full id.
  const hits: Array<{ node: any; s: Session }> = reportedSessions(nodes).entries.filter(
    ({ s }) => s.session_id === wanted || (wanted.length >= 6 && s.session_id.endsWith(wanted)),
  )

  if (hits.length === 0) {
    console.error(`No session matching "${wanted}".`)
    console.error(dim("  List them:  iris hive sessions --all"))
    process.exit(1)
  }
  if (hits.length > 1) {
    // Refuse rather than guess which machine to type into.
    console.error(`"${wanted}" matches ${hits.length} sessions — use the full id:`)
    for (const h of hits) console.error(dim(`  ${h.s.session_id}  on ${h.node.name}`))
    process.exit(1)
  }

  const { node, s } = hits[0]
  if (s.status === "stale") {
    console.error(`That session is stale (last active ${age(s.updated_at)} ago) — it is unlikely to answer.`)
    console.error(dim("  Check with:  iris hive sessions --all"))
    process.exit(1)
  }
  return { node, s }
}

/**
 * `iris hive send-input` — put a message into a session that is already running, on whichever
 * machine holds it.
 *
 * Every layer of this existed except the door. The cloud has a `session_message` task type,
 * the bridge has POST /api/sessions/<provider>/:id/message, and MCP exposes `hive_send_input`.
 * So an agent could type into your sessions and you could not — the same asymmetry as
 * `hive sessions` itself.
 *
 * You do not name the machine. The session id is looked up across the fleet and the task is
 * pinned to the node that actually holds it, because "which machine is that session on" is
 * exactly the bookkeeping a person should not be doing.
 */
const SendInputCommand = cmd({
  command: "send-input <session-id> <message>",
  describe: "send a message into a running session on any node in your Hive",
  builder: (yargs) =>
    yargs
      .positional("session-id", { describe: "from `iris hive sessions`", type: "string", demandOption: true })
      .positional("message", { describe: "what to send", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const { node, s } = await resolveSession(userId, String(argv["session-id"]))

    const create = await hiveFetch(`/api/v6/nodes/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        node_id: node.id,
        type: "session_message",
        title: `send-input to ${label(s)}`,
        prompt: String(argv.message),
        // PROVENANCE (#182785): name the machine this came FROM. Without it the message lands
        // looking exactly like something the recipient typed, and the node id the daemon falls
        // back to is a UUID no human recognises.
        config: {
          session_id: s.session_id,
          provider: s.provider,
          message: String(argv.message),
          from: os.hostname().replace(/\.local$/, ""),
        },
      }),
    })

    if (!create.ok) {
      const t = await create.text()
      console.error(`Could not send: HTTP ${create.status} ${t.slice(0, 200)}`)
      process.exit(1)
    }

    const created = (await create.json()) as any
    if (argv.json) return void (await writeJson(created))

    console.log()
    console.log(success(`✓ sent to ${bold(label(s))}`) + dim(`  on ${node.name} · ${s.provider}`))
    console.log(dim(`  task ${created?.task?.id ?? "?"}`))
    console.log(dim(`  The session answers in its own terminal — this delivers the message, it does not read the reply.`))
    console.log()
  },
})

/**
 * `iris hive ask` — say something to a session on any machine and read its answer here (#190671).
 *
 * send-input delivers and walks away: the reply happens in a window on another machine. This sends
 * with `submit` (the session takes a turn — it spends THAT session's tokens, which is why send-input
 * does not) and then follows the transcript through the cloud until the reply settles. Polling, not a
 * stream: the transcript read is the one door to a session on another machine today, and a reply
 * that is still being written grows between polls, so it prints as it is written, a poll at a time.
 */
const AskCommand = cmd({
  command: "ask <session-id> <message>",
  describe: "talk to a session on any node in your Hive and print its reply as it is written",
  builder: (yargs) =>
    yargs
      .positional("session-id", { describe: "from `iris hive sessions`", type: "string", demandOption: true })
      .positional("message", { describe: "what to say", type: "string", demandOption: true })
      .option("timeout", { describe: "seconds to follow the reply", type: "number", default: 300 })
      .option("interval", { describe: "seconds between transcript reads", type: "number", default: 2 })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const { node, s } = await resolveSession(userId, String(argv["session-id"]))
    const message = String(argv.message)

    const create = await hiveFetch(`/api/v6/nodes/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        node_id: node.id,
        type: "session_message",
        title: `ask ${label(s)}`,
        prompt: message,
        config: {
          session_id: s.session_id,
          provider: s.provider,
          message,
          from: os.hostname().replace(/\.local$/, ""),
          submit: true,
        },
      }),
    })
    if (!create.ok) {
      const t = await create.text()
      console.error(`Could not send: HTTP ${create.status} ${t.slice(0, 200)}`)
      process.exit(1)
    }

    console.error(dim(`→ ${label(s)} on ${node.name} · ${s.provider}`))
    const state = newFollowState()
    const interval = Math.max(1, Number(argv.interval) || 2) * 1000
    const deadline = Date.now() + Math.max(10, Number(argv.timeout) || 300) * 1000
    // A reply that has not changed for this long is done. A model waiting on a slow tool looks the
    // same, so it is generous; --timeout bounds the whole thing either way.
    const QUIET_POLLS = 4
    let quiet = 0
    let lastError = ""
    const q = new URLSearchParams({ machine: String(node.name), provider: String(s.provider || ""), limit: "40" })
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval))
      const r = await hiveFetch(`/api/v6/nodes/sessions/${encodeURIComponent(s.session_id)}/transcript?${q}`)
      const body = (await r.json().catch(() => ({}))) as any
      if (!r.ok || !body.success) {
        lastError = body.error || `HTTP ${r.status}`
        continue
      }
      lastError = ""
      const { out, changed } = followStep(state, (body.messages || []) as TranscriptMessage[], message)
      if (out) process.stdout.write(out)
      quiet = changed ? 0 : quiet + 1
      if (state.answered && quiet >= QUIET_POLLS) {
        process.stdout.write("\n")
        return
      }
    }
    process.stdout.write("\n")
    if (!state.anchored) {
      console.error(warn(`The message did not show up in ${label(s)}'s transcript within the timeout.`))
      if (lastError) console.error(dim(`  last read: ${lastError}`))
      process.exit(1)
    }
    console.error(dim(`  Still going after ${argv.timeout}s — read it with: iris hive ask again, or open it on ${node.name}.`))
  },
})

export const HiveSessionsCommand = SessionsCommand
export const HiveSendInputCommand = SendInputCommand
export const HiveAskCommand = AskCommand
