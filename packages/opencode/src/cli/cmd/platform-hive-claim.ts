// `iris hive claim <session>` — who has a Hive session, and who probably should (#188316).
//
// Sessions are reported by nodes on every heartbeat; the claim lives on the server
// (hive_session_claims). --suggest runs one read-only `git log` ON THE NODE that holds the repo:
// the last author of the files the session has changed (or of the last commit, if none), and
// records it beside the claim. A suggestion never assigns anyone.

import { cmd } from "./cmd"
import { requireAuth, requireUserId, dim, bold, success, warn } from "./iris-api"
import { hiveFetch } from "./platform-hive-nodes"
import { buildTaskPayload, pickResultPayload, TERMINAL_STATUSES } from "./hive-task-create"

export type ReportedSession = { session_id: string; project_path?: string | null; provider?: string; node: string; node_id: string }
export type Claim = { session_id: string; assignee: string | null; suggested_owner: string | null; suggested_from?: string | null }

/** A session named by its full id, or by the last/first characters people see in `hive sessions`. */
export function findSession(sessions: ReportedSession[], wanted: string): ReportedSession | { ambiguous: ReportedSession[] } | null {
  const w = wanted.trim()
  const exact = sessions.find((s) => s.session_id === w)
  if (exact) return exact
  const hits = sessions.filter((s) => s.session_id.endsWith(w) || s.session_id.startsWith(w))
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) return { ambiguous: hits }
  return null
}

/** Single-quote for POSIX sh. A path is data, never code. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * The read-only command run on the node: files the session changed vs HEAD (else the last
 * commit's files), the last author of each, and the most frequent one. Prints `author<TAB>paths`.
 */
export function suggestCommand(projectPath: string): string {
  return [
    `cd ${shq(projectPath)} || exit 3`,
    `f=$(git diff --name-only HEAD 2>/dev/null | head -20)`,
    `[ -z "$f" ] && f=$(git log -1 --name-only --format= 2>/dev/null | head -20)`,
    `[ -z "$f" ] && exit 4`,
    `a=$(for p in $f; do git log -1 --format='%an <%ae>' -- "$p"; done | sort | uniq -c | sort -rn | head -1 | sed 's/^ *[0-9]* //')`,
    `printf '%s\\t%s\\n' "$a" "$(echo $f | tr ' ' ',' | cut -c1-400)"`,
  ].join("; ")
}

export function parseSuggestion(out: string): { owner: string; from: string } | null {
  const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.includes("\t"))
  if (!line) return null
  const [owner, from] = line.split("\t")
  return owner && owner.includes("<") ? { owner: owner.trim(), from: (from ?? "").trim() } : null
}

export async function fetchClaims(userId: number): Promise<Map<string, Claim>> {
  const res = await hiveFetch(`/api/v6/nodes/session-claims?user_id=${userId}`).catch(() => null)
  const rows: Claim[] = res && res.ok ? (((await res.json()) as any)?.data ?? []) : []
  return new Map(rows.map((c) => [c.session_id, c]))
}

async function runOnNode(userId: number, nodeId: string, command: string, timeoutSec = 60): Promise<{ ok: boolean; text: string }> {
  const created = await hiveFetch("/api/v6/nodes/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildTaskPayload({ userId, type: "sandbox_execute", nodeId, prompt: command, title: "hive claim: suggest owner", config: {}, timeoutSec })),
  })
  if (!created.ok) return { ok: false, text: `HTTP ${created.status}` }
  const id = ((await created.json()) as any)?.task?.id
  const deadline = Date.now() + (timeoutSec + 30) * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const r = await hiveFetch(`/api/v6/nodes/tasks/${id}?user_id=${userId}`)
    if (!r.ok) continue
    const t = ((await r.json()) as any)?.task ?? {}
    if (TERMINAL_STATUSES.has(String(t.status))) return { ok: t.status === "completed", text: pickResultPayload(t).text }
  }
  return { ok: false, text: "timed out" }
}

export const HiveClaimCommand = cmd({
  command: "claim <session>",
  describe: "take a Hive session (or give it to someone with --to); --release puts it back; --suggest names who last touched its files",
  builder: (y) =>
    y
      .positional("session", { type: "string", demandOption: true, describe: "session id, or the characters shown in `iris hive sessions`" })
      .option("to", { type: "string", describe: "who gets it (name or email); default: you" })
      .option("release", { type: "boolean", default: false, describe: "put it back up for grabs" })
      .option("suggest", { type: "boolean", default: false, describe: "run git log on its node and record the likely owner (does not assign)" }),
  async handler(args) {
    if (!(await requireAuth())) { process.exitCode = 1; return }
    const userId = await requireUserId(undefined)
    if (!userId) { process.exitCode = 1; return }

    const res = await hiveFetch(`/api/v6/nodes/?user_id=${userId}&detailed=1`)
    const body = (await res.json().catch(() => ({}))) as any
    const sessions: ReportedSession[] = []
    for (const n of (body.nodes || body.data || []) as any[])
      for (const s of (n.active_sessions || []) as any[]) sessions.push({ ...s, node: n.name, node_id: n.id })

    const found = findSession(sessions, String(args.session))
    if (!found) { console.error(`No session matching "${args.session}" is being reported. See: iris hive sessions --all`); process.exitCode = 2; return }
    if ("ambiguous" in found) {
      console.error(`"${args.session}" matches ${found.ambiguous.length} sessions — use more characters:`)
      for (const s of found.ambiguous) console.error(`  ${s.session_id}  ${dim(s.node)}`)
      process.exitCode = 2
      return
    }
    const sid = encodeURIComponent(found.session_id)

    if (args.suggest) {
      if (!found.project_path) { console.error("That session reports no project path, so there is no repo to read."); process.exitCode = 2; return }
      console.log(dim(`→ reading git history on ${found.node} (read-only)…`))
      const out = await runOnNode(userId, found.node_id, suggestCommand(found.project_path))
      const s = out.ok ? parseSuggestion(out.text) : null
      if (!s) { console.error(`No suggestion: ${out.ok ? "no changed or committed files found" : out.text}`); process.exitCode = 1; return }
      const r = await hiveFetch(`/api/v6/nodes/sessions/${sid}/suggestion`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, suggested_owner: s.owner, suggested_from: s.from, node_id: found.node_id }),
      })
      if (!r.ok) { console.error(`Could not record it (HTTP ${r.status})`); process.exitCode = 1; return }
      console.log(`${success("Suggested")} ${bold(s.owner)}  ${dim(`last author of ${s.from}`)}`)
      console.log(dim(`  give it to them: iris hive claim ${args.session} --to "${s.owner}"`))
      return
    }

    if (args.release) {
      const r = await hiveFetch(`/api/v6/nodes/sessions/${sid}/claim?user_id=${userId}`, { method: "DELETE" })
      if (!r.ok) { console.error(r.status === 404 ? "That session is not claimed." : `HTTP ${r.status}`); process.exitCode = 1; return }
      console.log(success(`Released — ${found.session_id.slice(-8)} is up for grabs.`))
      return
    }

    const assignee = String(args.to ?? `user #${userId}`)
    const r = await hiveFetch(`/api/v6/nodes/sessions/${sid}/claim`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, assignee, node_id: found.node_id }),
    })
    if (!r.ok) { console.error(`Could not claim it (HTTP ${r.status})`); process.exitCode = 1; return }
    const prev = ((await r.json()) as any)?.previous_assignee
    console.log(`${success("Claimed")} ${found.session_id.slice(-8)} on ${found.node} → ${bold(assignee)}${prev && prev !== assignee ? warn(`  (was ${prev})`) : ""}`)
  },
})
