// IRIS Desktop's chat sessions, read from this machine for the CLI (#190641).
//
// Desktop runs an engine per signed-in account with XDG_DATA_HOME set to that account's own folder
// (~/.iris/accounts/<id>, the first account ~/.iris/accounts/default — desktop accounts.rs and
// history_home.rs). Its sessions live in <data home>/opencode/opencode[-<channel>].db. This reads
// that database READ-ONLY: it works whether or not Desktop is running and never writes to it.
//
// Access is the machine's own: only files this OS user owns are opened, and every text that leaves
// here passes through redact(). accounts.json holds each account's API key — it is read for the
// folder names only, and no key is ever returned.
import { Database } from "bun:sqlite"
import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { homedir } from "os"
import { join } from "path"

export type DesktopAccount = { id: string; label: string; dataHome: string; db: string | null }

export type DesktopSession = {
  id: string
  title: string
  directory: string
  parentId: string | null
  created: number
  updated: number
  archived: number | null
  messages: number
}

export type DesktopTurn = { role: string; time: number; text: string }

export class DesktopSessionsError extends Error {}

const REQUIRED = {
  session: ["id", "title", "directory", "parent_id", "time_created", "time_updated", "time_archived"],
  message: ["id", "session_id", "time_created", "data"],
  part: ["id", "message_id", "session_id", "data"],
}

/** Every account Desktop has a history folder for. No API keys leave this function. */
export function desktopAccounts(home = homedir()): DesktopAccount[] {
  const out: DesktopAccount[] = []
  const seen = new Set<string>()
  const add = (id: string, label: string, dataHome: string) => {
    if (seen.has(dataHome)) return
    seen.add(dataHome)
    out.push({ id, label, dataHome, db: findDb(dataHome) })
  }

  // The first account: its own folder once Desktop has copied it there, else the shared folder it
  // used before (#189477 — the copy is skipped when space or time is short, so both are real).
  const isolated = join(home, ".iris", "accounts", "default")
  const legacy = process.env.XDG_DATA_HOME || join(home, ".local", "share")
  if (findDb(isolated) || !findDb(legacy)) add("default", "first account (default)", isolated)
  else add("default", "first account (default, shared folder)", legacy)
  const store = join(home, ".iris", "accounts.json")
  if (existsSync(store)) {
    try {
      const parsed = JSON.parse(readFileSync(store, "utf8")) as {
        accounts?: { user_id?: number | null; email?: string | null; name?: string | null; data_dir?: string | null }[]
      }
      for (const a of parsed.accounts ?? []) {
        if (!a.data_dir) continue
        const id = a.user_id != null ? String(a.user_id) : a.data_dir.split(/[\\/]/).filter(Boolean).pop()!
        add(id, a.email || a.name || `account ${id}`, a.data_dir)
      }
    } catch {
      // Unreadable store: the default folder is still listed; nothing here is worth failing for.
    }
  }
  return out
}

/**
 * The engine's database in a data home. Released Desktop (channels latest/beta/prod) writes
 * opencode.db; preview and dev builds write opencode-<channel>.db beside it — one machine had 21 of
 * them. So: the named channel when asked, else opencode.db, else the newest channel file.
 */
export function findDb(dataHome: string, channel?: string): string | null {
  const dir = join(dataHome, "opencode")
  if (!existsSync(dir)) return null
  if (channel) {
    const named = join(dir, `opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
    return existsSync(named) ? named : null
  }
  const release = join(dir, "opencode.db")
  if (existsSync(release)) return release
  const dbs = channelsIn(dataHome).map((c) => join(dir, `opencode-${c}.db`))
  return dbs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null
}

/** The preview/dev channels that left a database in this data home. */
export function channelsIn(dataHome: string): string[] {
  const dir = join(dataHome, "opencode")
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((f) => /^opencode-([a-zA-Z0-9._-]+)\.db$/.exec(f)?.[1])
    .filter((c): c is string => !!c)
    .sort()
}

/** Pick an account: an explicit id/email, else the only one with a database, else the default. */
export function pickAccount(accounts: DesktopAccount[], want?: string): DesktopAccount {
  if (want) {
    const hit = accounts.find((a) => a.id === want || a.label === want)
    if (!hit) throw new DesktopSessionsError(`No Desktop account "${want}" on this machine. Accounts: ${accounts.map((a) => a.id).join(", ")}`)
    return hit
  }
  const withDb = accounts.filter((a) => a.db)
  if (withDb.length === 0)
    throw new DesktopSessionsError("No IRIS Desktop history on this machine yet — open IRIS Desktop and start a chat first.")
  return withDb.find((a) => a.id === "default") ?? withDb[0]
}

/** Open read-only, refusing a database another OS user owns and one from an engine we cannot read. */
export function openDesktopDb(path: string, uid = process.getuid?.()): Database {
  if (uid !== undefined && statSync(path).uid !== uid)
    throw new DesktopSessionsError(`${path} belongs to another user on this machine — not opening it.`)
  const db = new Database(path, { readonly: true })
  db.exec("PRAGMA busy_timeout = 3000") // Desktop may be writing (WAL); wait rather than fail
  for (const [table, cols] of Object.entries(REQUIRED)) {
    const have = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name))
    const missing = cols.filter((c) => !have.has(c))
    if (missing.length) {
      db.close()
      throw new DesktopSessionsError(
        `This Desktop history uses a format this CLI does not know (${table} lacks ${missing.join(", ")}). ` +
          "Update the CLI (iris update) or Desktop so both are current.",
      )
    }
  }
  return db
}

export type ListOptions = { limit?: number; offset?: number; archived?: boolean; since?: number; query?: string }

/** Sessions, newest activity first. `query` matches the title or any text said in the session. */
export function listSessions(db: Database, o: ListOptions = {}): DesktopSession[] {
  const where = [o.archived ? "1=1" : "s.time_archived IS NULL"]
  const params: (string | number)[] = []
  if (o.since) {
    where.push("s.time_updated >= ?")
    params.push(o.since)
  }
  if (o.query) {
    const like = `%${o.query.replace(/[\\%_]/g, (c) => "\\" + c)}%`
    where.push(
      "(s.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM part p WHERE p.session_id = s.id " +
        "AND json_extract(p.data, '$.type') = 'text' AND json_extract(p.data, '$.text') LIKE ? ESCAPE '\\'))",
    )
    params.push(like, like)
  }
  params.push(Math.max(1, Math.min(o.limit ?? 20, 200)), Math.max(0, o.offset ?? 0))
  const rows = db
    .query(
      `SELECT s.id, s.title, s.directory, s.parent_id, s.time_created, s.time_updated, s.time_archived,
              (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messages
         FROM session s WHERE ${where.join(" AND ")}
        ORDER BY s.time_updated DESC, s.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params) as Record<string, any>[]
  return rows.map((r) => ({
    id: r.id,
    title: redact(r.title),
    directory: r.directory,
    parentId: r.parent_id ?? null,
    created: r.time_created,
    updated: r.time_updated,
    archived: r.time_archived ?? null,
    messages: r.messages,
  }))
}

/** One session's header, or null. */
export function getSession(db: Database, id: string): Pick<DesktopSession, "id" | "title" | "directory"> | null {
  const r = db.query("SELECT id, title, directory FROM session WHERE id = ?").get(id) as Record<string, string> | null
  return r ? { id: r.id, title: redact(r.title), directory: r.directory } : null
}

/** What was said in a session: user and assistant text, oldest first, redacted. Tool output is left out. */
export function readTranscript(db: Database, sessionId: string, o: { limit?: number } = {}): DesktopTurn[] {
  const exists = db.query("SELECT 1 FROM session WHERE id = ?").get(sessionId)
  if (!exists) throw new DesktopSessionsError(`No Desktop session ${sessionId} in this account's history.`)
  const rows = db
    .query(
      `SELECT json_extract(m.data, '$.role') AS role, m.time_created AS time,
              group_concat(json_extract(p.data, '$.text'), char(10)) AS text
         FROM message m JOIN part p ON p.message_id = m.id
        WHERE m.session_id = ? AND json_extract(p.data, '$.type') = 'text'
          AND COALESCE(json_extract(p.data, '$.synthetic'), 0) = 0
        GROUP BY m.id ORDER BY m.time_created, m.id`,
    )
    .all(sessionId) as { role: string; time: number; text: string | null }[]
  const turns = rows.filter((r) => r.text && r.text.trim()).map((r) => ({ role: r.role, time: r.time, text: redact(r.text!) }))
  return o.limit ? turns.slice(-o.limit) : turns
}

/** A transcript as Markdown an agent can be handed as context. */
export function asContext(session: Pick<DesktopSession, "id" | "title" | "directory">, turns: DesktopTurn[]): string {
  const head = `# IRIS Desktop session: ${session.title}\n\n_session ${session.id} · folder ${session.directory}_\n`
  return head + turns.map((t) => `\n## ${t.role}\n\n${t.text.trim()}\n`).join("")
}

const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  [/\b(sk|rk|pk)-(live|test|proj|ant)?-?[A-Za-z0-9_-]{16,}\b/g, "[redacted key]"],
  [/\b(ghp|gho|ghu|ghs|github_pat|xox[abpors]|glpat)[-_][A-Za-z0-9_-]{16,}\b/g, "[redacted token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted AWS key]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted JWT]"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{20,}/gi, "$1 [redacted]"],
  [/\b(api[_-]?key|secret|password|passwd|token)(["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi, "$1$2[redacted]"],
]

/** Strip what looks like a credential from text before it leaves the machine's history. */
export function redact(text: string): string {
  return SECRETS.reduce((t, [re, to]) => t.replace(re, to), text ?? "")
}
