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

export const HiveSessionsCommand = SessionsCommand
