/**
 * Keeps an ACP session reachable after its first turn (#191170). `iris acp run --keep` holds the
 * agent process and serves it on 127.0.0.1 with a token made for this launch, and writes where to
 * find it to ~/.iris/acp/<session>.json (0600). The Hive bridge reads that folder to list the
 * session fleet-wide and forwards `send-input` / `answer` here.
 *
 * Only this machine's user can reach it: loopback only, and the token is in a file only they can
 * read. A request without the token is refused before anything else is looked at.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomBytes, timingSafeEqual } from "node:crypto"
import type { AcpSession } from "./client"

export const registryDir = (home = os.homedir()) => path.join(home, ".iris", "acp")

export interface HolderRecord {
  session_id: string
  provider: "acp"
  agent: string
  agent_name?: string
  name: string
  project_path: string
  pid: number
  port: number
  token: string
  status: "idle" | "working" | "waiting"
  waiting: unknown
  created_at: string
  updated_at: string | null
  message_count: number
}

export function recordOf(session: AcpSession, h: { agent: string; port: number; token: string; cwd: string }): HolderRecord {
  const firstUser = session.transcript.find((t) => t.role === "user")?.text
  return {
    session_id: session.sessionId,
    provider: "acp",
    agent: h.agent,
    agent_name: session.agentName,
    name: firstUser ? firstUser.slice(0, 80) : `${session.agentName ?? h.agent} (waiting for a first message)`,
    project_path: h.cwd,
    pid: process.pid,
    port: h.port,
    token: h.token,
    status: session.status,
    waiting: session.waiting,
    created_at: session.startedAt,
    updated_at: session.lastMessageAt,
    message_count: session.transcript.length,
  }
}

function writeRecord(file: string, rec: HolderRecord) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function tokenOk(given: string | null, token: string) {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** The HTTP side, separate from the server so tests can call it directly. */
export function holderHandler(session: AcpSession, token: string) {
  return async (req: Request): Promise<Response> => {
    if (!tokenOk(req.headers.get("x-acp-token"), token)) return json(401, { error: "missing or wrong x-acp-token" })
    const url = new URL(req.url)
    const sid = session.sessionId

    if (req.method === "GET" && url.pathname === "/status")
      return json(200, { session_id: sid, status: session.status, waiting: session.waiting, agent: session.agentName })

    if (req.method === "GET" && url.pathname === "/history") {
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 60, 200))
      const all = session.transcript
      const messages = all.slice(-limit).map(({ role, type, text, tool }) => ({ role, type, text, tool: tool ?? null }))
      return json(200, {
        session_id: sid,
        messages,
        messages_total: all.length,
        messages_returned: messages.length,
        messages_omitted: all.length - messages.length,
      })
    }

    if (req.method === "POST" && url.pathname === "/message") {
      const body = (await req.json().catch(() => ({}))) as { message?: unknown; from?: unknown }
      const message = typeof body.message === "string" ? body.message.trim() : ""
      if (!message) return json(400, { error: "message is required", session_id: sid })
      if (session.busy)
        return json(409, { error: "The agent is still on its last turn; send again when it is idle.", session_id: sid, status: session.status })
      const from = typeof body.from === "string" && body.from ? body.from : "hive"
      // Queued, not awaited: the turn can take minutes, and the caller follows it through /history.
      session.prompt(message, from).catch((err) => console.error(`✗ turn failed: ${err instanceof Error ? err.message : err}`))
      // ACP has no "deliver without a turn", so every message is a turn (unlike opencode's notify).
      return json(202, { session_id: sid, status: "delivered", via: "live", turn: true, response: null, model: null, tokens_used: 0 })
    }

    if (req.method === "POST" && url.pathname === "/answer") {
      const body = (await req.json().catch(() => ({}))) as { answers?: unknown }
      const r = session.answer(body.answers)
      if (!r.ok) return json(r.status, { error: r.error, session_id: sid })
      return json(200, { session_id: sid, status: "delivered", delivered: "acp", answers: { Permission: r.chose } })
    }

    return json(404, { error: "not found" })
  }
}

export interface Holder {
  port: number
  file: string
  stop(): void
}

/** Serve the session and register it. Returns once it is reachable. */
export function startHolder(session: AcpSession, opts: { agent: string; cwd: string; home?: string }): Holder {
  const token = randomBytes(24).toString("hex")
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: holderHandler(session, token) })
  const port = server.port!
  const dir = registryDir(opts.home)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `${session.sessionId}.json`)
  const save = () => {
    try {
      writeRecord(file, recordOf(session, { agent: opts.agent, port, token, cwd: opts.cwd }))
    } catch {}
  }
  save()
  session.onChanged(save)
  return {
    port,
    file,
    stop() {
      server.stop(true)
      try {
        fs.unlinkSync(file)
      } catch {}
    },
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Live holders on this machine. A record whose process is gone is removed, not listed. */
export function listHolders(home?: string, alive: (pid: number) => boolean = pidAlive): HolderRecord[] {
  const dir = registryDir(home)
  let names: string[] = []
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"))
  } catch {
    return []
  }
  const out: HolderRecord[] = []
  for (const n of names) {
    const file = path.join(dir, n)
    try {
      const rec = JSON.parse(fs.readFileSync(file, "utf8")) as HolderRecord
      if (alive(rec.pid)) out.push(rec)
      else fs.unlinkSync(file)
    } catch {}
  }
  return out
}
