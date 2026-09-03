import { cmd } from "./cmd"
import { requireAuth, requireUserId, writeJson, dim, bold, success } from "./iris-api"
import { hiveFetch } from "./platform-hive-nodes"

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

const STATUS_ORDER: Record<string, number> = { active: 0, idle: 1, unknown: 2, stale: 3 }

const SessionsCommand = cmd({
  command: "sessions",
  describe: "AI sessions running across your Hive — what, where, on which model",
  builder: (yargs) =>
    yargs
      .option("node", { describe: "only this node", type: "string" })
      .option("status", { describe: "active | idle | stale | unknown", type: "string" })
      .option("all", { describe: "include stale sessions (hidden by default)", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const res = await hiveFetch(`/api/v6/nodes/?user_id=${userId}&detailed=1`)
    const body = (await res.json().catch(() => ({}))) as any
    const nodes = (body.nodes || body.data || []) as any[]

    const rows: Array<Session & { node: string }> = []
    for (const n of nodes) {
      if (argv.node && String(n.name).toLowerCase() !== String(argv.node).toLowerCase()) continue
      for (const s of (n.active_sessions || []) as Session[]) {
        rows.push({ ...s, node: n.name })
      }
    }

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

    if (argv.json) return void (await writeJson(shown))

    console.log()
    if (shown.length === 0) {
      console.log(dim("  No sessions." + (staleCount ? `  ${staleCount} stale hidden — see with --all` : "")))
      console.log()
      return
    }

    console.log(
      `  ${dim("node".padEnd(16))} ${dim("status".padEnd(8))} ${dim("age".padEnd(5))} ${dim("provider".padEnd(12))} ${dim("model".padEnd(20))} ${dim("session")}`,
    )
    for (const r of shown) {
      const st = r.status === "active" ? success(r.status.padEnd(8)) : dim(r.status.padEnd(8))
      const branch = r.git_branch ? dim(` (${r.git_branch})`) : ""
      const model = r.model ? String(r.model).slice(0, 20).padEnd(20) : dim("—".padEnd(20))
      console.log(
        `  ${String(r.node).slice(0, 16).padEnd(16)} ${st} ${age(r.updated_at).padEnd(5)} ${String(r.provider).padEnd(12)} ${model} ${bold(label(r))}${branch}`,
      )
    }
    console.log()
    const live = shown.filter((r) => r.status === "active").length
    console.log(
      dim(`  ${shown.length} shown · ${live} active${staleCount && !argv.all ? ` · ${staleCount} stale hidden (--all)` : ""}`),
    )
    console.log()
  },
})

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

    const wanted = String(argv["session-id"])

    const res = await hiveFetch(`/api/v6/nodes/?user_id=${userId}&detailed=1`)
    const body = (await res.json().catch(() => ({}))) as any
    const nodes = (body.nodes || body.data || []) as any[]

    // Match the FULL id, or an unambiguous suffix. Never a prefix: session ids share leading
    // characters, and a truncated match is how a wrong diagnosis got filed on this project
    // once already (#182312).
    const hits: Array<{ node: any; s: Session }> = []
    for (const n of nodes) {
      for (const s of (n.active_sessions || []) as Session[]) {
        if (s.session_id === wanted || (wanted.length >= 6 && s.session_id.endsWith(wanted))) {
          hits.push({ node: n, s })
        }
      }
    }

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

    const create = await hiveFetch(`/api/v6/nodes/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        node_id: node.id,
        type: "session_message",
        title: `send-input to ${label(s)}`,
        prompt: String(argv.message),
        config: { session_id: s.session_id, provider: s.provider, message: String(argv.message) },
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

export const HiveSessionsCommand = SessionsCommand
export const HiveSendInputCommand = SendInputCommand
