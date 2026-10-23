/**
 * Hive › Inbox — the writes (#190917 epic: "Make the Hive inbox a place people work").
 *
 * The panel could read and mark read. A place people work also needs to mark unread, finish a
 * thing (done — separate from read: opening is not finishing), and answer it. Three rules carried
 * over from the reads:
 *
 *  - Lines this reader cannot parse are written back byte-for-byte. Changing one row never drops
 *    another.
 *  - Reply goes through `iris hive inbox send`, the CLI's own path (own node or a peer's, via the
 *    relay). argv only, never a shell — the text is something a person typed. The daemon's
 *    tailnet-exposed bridge still has no send route, on purpose (#184810).
 *  - "Sent" means the SERVER accepted it and handed back a task id. It never means delivered or
 *    read; the transport cannot prove either, and the panel must not claim it.
 */
import { execFile } from "child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs"
import path from "path"
import { inboxDir, locateInboxRow, readManifestLines, writeManifestLines, type ManifestRow } from "./platform"
import { irisCliPath } from "./playbook-install"

export type Exec = (file: string, args: string[], opts: { timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>

const realExec: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (err ? String(err.message) : "") })
    })
  })

export interface InboxStateResult {
  measured: boolean
  reason?: string
  read: boolean
  done: boolean
  /** Set when the caller asked to close the handoff's Atlas card: what happened to it. */
  card?: { item: string; ok: boolean; reason?: string }
}

/** `bloq:item:1234` / `atlas:item:1234` / `#1234` / `1234` → 1234. Null for anything else. */
export function cardIdOf(item: string | null | undefined): number | null {
  const m = String(item ?? "").trim().match(/^(?:(?:bloq|atlas):item:|#)?(\d+)$/)
  return m ? Number(m[1]) : null
}

/**
 * Set read and/or done on one row. Done implies read — a finished thing is not waiting on you —
 * but un-done does not make it unread again. `resolveCard` also moves the handoff's Atlas card to
 * done through the CLI; whether that worked is reported separately, because the local write
 * succeeding says nothing about the card.
 */
export async function setInboxState(
  index: number,
  change: { id?: string; read?: boolean; done?: boolean; resolveCard?: boolean },
  deps: { dir?: string; cli?: string | null; exec?: Exec; now?: () => Date } = {},
): Promise<InboxStateResult> {
  const dir = deps.dir ?? inboxDir()
  const lines = readManifestLines(dir)
  if (lines === null) return { measured: false, reason: "the inbox manifest could not be read", read: false, done: false }
  const at = locateInboxRow(lines, index, change.id)
  const row = at >= 0 ? lines[at].row : null
  if (!row) return { measured: false, reason: "that message is no longer in the inbox", read: false, done: false }

  const next: ManifestRow = { ...row }
  if (change.read !== undefined) next.read = change.read
  if (change.done !== undefined) {
    next.done = change.done
    next.done_at = change.done ? (deps.now?.() ?? new Date()).toISOString() : null
    if (change.done) next.read = true
  }
  try {
    writeManifestLines(
      dir,
      lines.map((l, i) => (i === at ? JSON.stringify(next) : l.raw)),
    )
  } catch (e) {
    return {
      measured: false,
      reason: `could not update the inbox: ${e instanceof Error ? e.message : String(e)}`,
      read: Boolean(row.read),
      done: row.done === true,
    }
  }

  const result: InboxStateResult = { measured: true, read: Boolean(next.read), done: next.done === true }
  if (change.done && change.resolveCard && row.item) {
    const id = cardIdOf(row.item)
    const cli = deps.cli === undefined ? irisCliPath() : deps.cli
    if (id === null) result.card = { item: row.item, ok: false, reason: "not an Atlas card id" }
    else if (!cli) result.card = { item: row.item, ok: false, reason: "the iris CLI is not installed on this computer" }
    else {
      const r = await (deps.exec ?? realExec)(cli, ["bloqs", "update-item", String(id), "--status", "done"], { timeoutMs: 20_000 })
      result.card = r.code === 0 ? { item: row.item, ok: true } : { item: row.item, ok: false, reason: lastLine(r.stderr || r.stdout) || "the card was not updated" }
    }
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Reply / send
// ─────────────────────────────────────────────────────────────────────────────

/** One message this computer sent from the panel. Kept locally so a thread shows both sides. */
export interface OutboxRow {
  id: string
  to: string
  text: string
  sentAt: string
  /** The server's task id. Proof the server accepted it — not that they received it. */
  taskId?: string
  /** The inbox row this answered, when it was a reply. */
  replyTo?: string
  /** "relay" when it went to a peer's node. */
  via?: string
}

export interface SendResult {
  measured: boolean
  ok: boolean
  reason?: string
  sent?: OutboxRow
  /** The recipient is offline; it is parked and delivers when they reconnect. */
  offline?: boolean
}

export const outboxPath = (dir = inboxDir()) => path.join(path.dirname(dir), "outbox.jsonl")

/** A reply is at most this long — the inbox carries messages, not documents. */
export const REPLY_CAP = 8000

/** Node names are what the CLI resolves; anything with a control character or a leading dash is refused. */
export function validTarget(to: string): boolean {
  return /^[^\s\-\u0000-\u001f][^\u0000-\u001f]{0,119}$/.test(to.trim())
}

function lastLine(s: string): string {
  return (
    s
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? ""
  )
}

/** Parse `iris hive inbox send --json`. The CLI prints its JSON last; anything before it is noise. */
export function parseSendJson(stdout: string): { ok: boolean; task_id?: string; node?: string; via?: string } | null {
  const lines = stdout.trim().split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim()
    if (!l.startsWith("{")) continue
    try {
      const j = JSON.parse(lines.slice(i).join("\n"))
      if (j && typeof j === "object" && "ok" in j) return j
    } catch {}
  }
  return null
}

export async function sendInboxMessage(
  input: { to: string; text: string; replyTo?: string },
  deps: { dir?: string; cli?: string | null; exec?: Exec; now?: () => Date; newId?: () => string } = {},
): Promise<SendResult> {
  const to = input.to.trim()
  const text = input.text.replace(/\r\n/g, "\n").trim()
  if (!text) return { measured: true, ok: false, reason: "the message is empty" }
  if (text.length > REPLY_CAP) return { measured: true, ok: false, reason: `the message is longer than ${REPLY_CAP} characters` }
  if (!validTarget(to)) return { measured: true, ok: false, reason: "that is not a computer name the inbox can send to" }
  const cli = deps.cli === undefined ? irisCliPath() : deps.cli
  if (!cli) return { measured: false, ok: false, reason: "the iris CLI is not installed on this computer, so it cannot send" }

  // `--` ends the options: a message that starts with "-" is text, not a flag.
  const r = await (deps.exec ?? realExec)(cli, ["hive", "inbox", "send", "--target", to, "--json", "--", text], { timeoutMs: 30_000 })
  const j = parseSendJson(r.stdout)
  if (r.code !== 0 || !j?.ok) {
    return { measured: true, ok: false, reason: lastLine(r.stderr) || lastLine(r.stdout) || "the send failed" }
  }

  const sent: OutboxRow = {
    id: deps.newId?.() ?? `out_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    to: j.node ?? to,
    text,
    sentAt: (deps.now?.() ?? new Date()).toISOString(),
    ...(j.task_id ? { taskId: String(j.task_id) } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(j.via === "peer" ? { via: "relay" } : {}),
  }
  // The send already happened. Failing to record it locally must not turn into "send failed" —
  // that is the message a person resends, and then it arrives twice.
  try {
    const file = outboxPath(deps.dir ?? inboxDir())
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(sent) + "\n")
  } catch {}
  return { measured: true, ok: true, sent }
}

/** The outbox, newest last (append order). Unparseable lines are skipped and counted. */
export function readOutbox(dir = inboxDir()): { rows: OutboxRow[]; unparsed: number } {
  const file = outboxPath(dir)
  if (!existsSync(file)) return { rows: [], unparsed: 0 }
  let unparsed = 0
  const rows: OutboxRow[] = []
  try {
    for (const l of readFileSync(file, "utf-8").split("\n")) {
      if (!l.trim()) continue
      try {
        const r = JSON.parse(l)
        if (r && typeof r.to === "string" && typeof r.text === "string") rows.push(r)
        else unparsed++
      } catch {
        unparsed++
      }
    }
  } catch {
    return { rows: [], unparsed: 0 }
  }
  return { rows, unparsed }
}
