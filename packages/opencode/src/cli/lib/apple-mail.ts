/**
 * Apple Mail — read local mail from the CLI process, without the bridge.
 *
 * WHY NOT THE BRIDGE. The bridge has an Apple Mail driver and the CLI's `iris mail` uses it.
 * But the bridge daemon runs under launchd and has NOT been granted Full Disk Access, so
 * every mail call through it 500s today (#180412). The CLI runs in the user's terminal and
 * inherits that app's grant, which is why this path works when the other does not. The
 * daemon's driver (~/.iris/bridge/drivers/apple-mail-body.js) is the sibling of this file;
 * they are deliberately duplicated because they run in different processes with different
 * TCC grants, and the whole point is not to depend on the one that is blocked.
 *
 * Mail keeps ENVELOPES in a SQLite catalogue (sender, subject, date, mailbox) and BODIES in
 * .emlx files on disk. Reading the catalogue's `summaries` column instead of the file is the
 * mistake that produced #183189 — it is capped at 1000 characters and looks like a body.
 * So: envelopes from SQLite, bodies from disk, and never the preview.
 */

import { execFileSync } from "child_process"
import { accessSync, constants, existsSync, readdirSync, readFileSync } from "fs"
import { homedir } from "os"
import { join, dirname, sep } from "path"

export interface MailMessage {
  rowid: number
  subject: string
  sender: string
  senderName: string
  sentAt: Date
  mailbox: string
}

const MAIL_BASE = join(homedir(), "Library", "Mail")

/** Newest Mail version directory that actually has an index — V10 today, V9 before it. */
function mailRoot(): string | null {
  try {
    const versions = readdirSync(MAIL_BASE)
      .filter((d) => /^V\d+$/.test(d))
      .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))
    for (const v of versions) {
      if (existsSync(join(MAIL_BASE, v, "MailData", "Envelope Index"))) return join(MAIL_BASE, v)
    }
  } catch {}
  return null
}

function indexPath(): string | null {
  const root = mailRoot()
  return root ? join(root, "MailData", "Envelope Index") : null
}

export type Availability = { ok: true } | { ok: false; reason: string }

/**
 * Three states, not two: no Mail on this Mac, Mail present but unreadable, or fine.
 * "Unreadable" is a permission problem the user can fix; reporting it as "no mail" would
 * send them looking for the wrong thing.
 */
export function availability(): Availability {
  if (process.platform !== "darwin") return { ok: false, reason: "Apple Mail is macOS-only" }
  const db = indexPath()
  if (!db) return { ok: false, reason: `No Mail index under ${MAIL_BASE} — is Mail.app set up on this Mac?` }
  try {
    accessSync(db, constants.R_OK)
  } catch (e: any) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      return {
        ok: false,
        reason:
          "No permission to read Apple Mail. Grant Full Disk Access to your terminal in " +
          "System Settings › Privacy & Security › Full Disk Access, then reopen it.",
      }
    }
    return { ok: false, reason: `Cannot read the Mail index: ${e?.message ?? e}` }
  }
  return { ok: true }
}

/**
 * How fresh the local mail index is (#183477).
 *
 * The index is a CACHE. Mail.app fills it, and when Mail is quit new messages sit on the
 * server and never appear here — so a reader gets fewer results with no indication that
 * anything is missing. That is indistinguishable from a genuinely quiet week, and it is
 * the difference between "you have no new meetings" and "I cannot see your new meetings".
 *
 * Observed: 5 meetings listed while 8 sat unsynced, Mail having been quit for seven hours
 * after receiving 3-11 messages an hour all morning.
 */
export function syncStatus(): { newest: Date | null; staleHours: number | null; mailRunning: boolean } {
  let mailRunning = false
  try {
    execFileSync("/usr/bin/pgrep", ["-x", "Mail"], { stdio: ["ignore", "pipe", "ignore"] })
    mailRunning = true
  } catch {
    mailRunning = false
  }

  try {
    const rows = query("SELECT MAX(date_received) AS newest FROM messages;")
    const raw = rows?.[0]?.newest
    if (!raw) return { newest: null, staleHours: null, mailRunning }
    const newest = new Date(Number(raw) * 1000)
    return { newest, staleHours: (Date.now() - newest.getTime()) / 3_600_000, mailRunning }
  } catch {
    return { newest: null, staleHours: null, mailRunning }
  }
}

/**
 * One sentence when the index may be behind, or null when there is nothing to say.
 * Deliberately does NOT claim meetings are missing — only that we cannot rule it out.
 */
export function stalenessNote(thresholdHours = 3): string | null {
  const { staleHours, mailRunning } = syncStatus()
  if (staleHours === null) return null
  const h = staleHours < 1 ? `${Math.round(staleHours * 60)}m` : `${staleHours.toFixed(1)}h`
  if (!mailRunning && staleHours >= 0.5) {
    return `Mail.app is not running and the local index is ${h} old — newer messages may not be here yet.`
  }
  if (staleHours >= thresholdHours) {
    return `Mail last synced ${h} ago — newer messages may not be here yet.`
  }
  return null
}

function query(sql: string): any[] {
  const db = indexPath()
  if (!db) throw new Error("No Apple Mail index on this Mac")
  // `immutable=1` so a running Mail.app cannot block us, and read-only so we cannot
  // corrupt someone's mailbox by existing.
  const out = execFileSync("/usr/bin/sqlite3", ["-readonly", "-json", `file:${db}?immutable=1`, sql], {
    encoding: "utf-8",
    timeout: 20000,
    maxBuffer: 32 * 1024 * 1024,
  })
  return out.trim() ? JSON.parse(out) : []
}

/** Messages from one sender address, newest first. Envelopes only — call readBody for text. */
export function searchBySender(address: string, opts: { days?: number; limit?: number } = {}): MailMessage[] {
  const days = Math.max(1, Math.min(3650, Math.floor(opts.days ?? 30)))
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50)))
  const esc = String(address).replace(/'/g, "''")

  const rows = query(`
    SELECT m.ROWID     AS rowid,
           s.subject   AS subject,
           a.address   AS sender,
           a.comment   AS sender_name,
           m.date_sent AS date_sent,
           mb.url      AS mailbox
      FROM messages m
      LEFT JOIN subjects  s  ON s.ROWID  = m.subject
      LEFT JOIN addresses a  ON a.ROWID  = m.sender
      LEFT JOIN mailboxes mb ON mb.ROWID = m.mailbox
     WHERE a.address LIKE '%${esc}%'
       AND m.date_sent > strftime('%s','now') - ${days} * 86400
     ORDER BY m.date_sent DESC
     LIMIT ${limit};
  `)

  // The same message can appear in several mailboxes (Gmail's All Mail plus a label).
  // Deduplicate on subject+timestamp so one meeting is one meeting.
  const seen = new Set<string>()
  const out: MailMessage[] = []
  for (const r of rows) {
    const key = `${r.subject ?? ""}|${r.date_sent ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      rowid: Number(r.rowid),
      subject: r.subject == null ? "(no subject)" : String(r.subject),
      sender: String(r.sender ?? ""),
      senderName: String(r.sender_name ?? ""),
      sentAt: r.date_sent ? new Date(Number(r.date_sent) * 1000) : new Date(0),
      mailbox: String(r.mailbox ?? ""),
    })
  }
  return out
}

// ── Bodies: the .emlx files ────────────────────────────────────────────────────────────

/** Mail's fan-out: floor(rowid/1000), digits REVERSED. 380098 → Data/0/8/3/Messages. */
function shardSegments(rowid: number): string[] {
  return String(Math.floor(rowid / 1000)).split("").reverse()
}

/** `imap://<UUID>/%5BGmail%5D/All%20Mail` → `<root>/<UUID>/[Gmail].mbox/All Mail.mbox` */
function mailboxDir(mailboxUrl: string): string | null {
  const root = mailRoot()
  if (!root) return null
  const m = String(mailboxUrl || "").match(/^[a-z0-9+.-]+:\/\/([^/]+)\/?(.*)$/i)
  if (!m) return null
  const account = m[1]
  if (!/^[0-9A-F-]{36}$/i.test(account)) return null
  const segs = (m[2] ? m[2].split("/") : [])
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
    .filter((s) => s !== "." && s !== ".." && !s.includes(sep))
  return join(root, account, ...segs.map((s) => `${s}.mbox`))
}

function locate(rowid: number, mailboxUrl: string): string | null {
  const dir = mailboxDir(mailboxUrl)
  if (!dir) return null
  const bases = [dir]
  try {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && /^[0-9A-F-]{36}$/i.test(d.name)) bases.push(join(dir, d.name))
    }
  } catch {}

  const tail = join("Data", ...shardSegments(rowid), "Messages")
  for (const b of bases) {
    // `.partial.emlx` is a partly-downloaded body; second choice, but it is what we have.
    for (const name of [`${rowid}.emlx`, `${rowid}.partial.emlx`]) {
      const p = join(b, tail, name)
      if (existsSync(p)) return p
    }
  }

  // Derivation missed — fall back to a bounded scan of this one account rather than
  // reporting a message that plainly exists as missing.
  try {
    const found = execFileSync(
      "/usr/bin/find",
      [dir, "-name", `${rowid}.emlx`, "-o", "-name", `${rowid}.partial.emlx`],
      { encoding: "utf-8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
    )
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
    return found[0] ?? null
  } catch {
    return null
  }
}

/** .emlx = `<byte-count>\n<rfc822 message><plist>`. */
function stripEmlxEnvelope(raw: Buffer): Buffer {
  const nl = raw.indexOf(0x0a)
  if (nl > 0 && nl < 32) {
    const n = parseInt(raw.subarray(0, nl).toString("ascii").trim(), 10)
    if (Number.isFinite(n) && n > 0 && nl + 1 + n <= raw.length) return raw.subarray(nl + 1, nl + 1 + n)
  }
  const plist = raw.indexOf(Buffer.from("\n<?xml"))
  return plist > 0 ? raw.subarray(nl + 1, plist) : raw.subarray(nl + 1)
}

function splitEntity(buf: Buffer): { headers: Record<string, string>; body: Buffer } {
  let idx = buf.indexOf(Buffer.from("\r\n\r\n"))
  let gap = 4
  const alt = buf.indexOf(Buffer.from("\n\n"))
  if (idx === -1 || (alt !== -1 && alt < idx)) {
    idx = alt
    gap = 2
  }
  if (idx === -1) return { headers: {}, body: buf }

  const headers: Record<string, string> = {}
  const raw = buf.subarray(0, idx).toString("latin1").replace(/\r?\n[ \t]+/g, " ")
  for (const line of raw.split(/\r?\n/)) {
    const c = line.indexOf(":")
    if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim()
  }
  return { headers, body: buf.subarray(idx + gap) }
}

function decodePart(body: Buffer, headers: Record<string, string>, charset?: string): string {
  const cte = String(headers["content-transfer-encoding"] ?? "").trim().toLowerCase()
  let bytes = body
  if (cte === "quoted-printable") {
    bytes = Buffer.from(
      body
        .toString("latin1")
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))),
      "latin1",
    )
  } else if (cte === "base64") {
    bytes = Buffer.from(body.toString("ascii").replace(/\s+/g, ""), "base64")
  }
  // us-ascii is routinely a lie on real mail; utf-8 decodes true ascii identically and
  // survives the smart quotes that actually turn up.
  const cs = String(charset || "utf-8").toLowerCase().replace(/^us-ascii$/, "utf-8")
  try {
    return new TextDecoder(cs, { fatal: false }).decode(bytes)
  } catch {}
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  } catch {
    return bytes.toString("latin1")
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
}

export function htmlToText(html: string): string {
  return String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|blockquote|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[String(n).toLowerCase()] ?? m)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

const looksLikeHtml = (s: string) => /<(!doctype|html|body|div|p|table|h[1-6])[\s>]/i.test(s.slice(0, 2000))

type Part = { isHtml: boolean; text: string }

function collectParts(buf: Buffer, depth = 0): Part[] {
  if (depth > 8) return []
  const { headers, body } = splitEntity(buf)
  const ct = String(headers["content-type"] ?? "text/plain")
  const type = ct.split(";")[0].trim().toLowerCase()
  const boundary = (ct.match(/boundary\s*=\s*"?([^";]+)"?/i) ?? [])[1]
  const charset = (ct.match(/charset\s*=\s*"?([^";]+)"?/i) ?? [])[1]

  if (type.startsWith("multipart/") && boundary) {
    const out: Part[] = []
    for (const chunk of body.toString("latin1").split(`--${boundary}`).slice(1)) {
      if (chunk.startsWith("--")) break
      out.push(...collectParts(Buffer.from(chunk.replace(/^\r?\n/, ""), "latin1"), depth + 1))
    }
    return out
  }

  if (/^attachment/i.test(String(headers["content-disposition"] ?? ""))) return []
  if (type && !type.startsWith("text/") && depth > 0) return []

  const text = decodePart(body, headers, charset)
  if (!text.trim()) return []
  // Content-Type is not evidence: rabbit's ONLY part declares text/plain and contains HTML.
  return [{ isHtml: type === "text/html" || looksLikeHtml(text), text }]
}

export interface MailBody {
  path: string
  text: string
  html: string | null
  partial: boolean
}

/** Read one message's real body off disk. Throws if the .emlx is missing or unreadable. */
export function readBody(rowid: number, mailboxUrl: string): MailBody {
  const file = locate(rowid, mailboxUrl)
  if (!file) throw new Error(`No .emlx on disk for message ${rowid}`)
  let raw: Buffer
  try {
    raw = readFileSync(file)
  } catch (e: any) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      throw new Error("No permission to read Apple Mail — grant Full Disk Access to your terminal")
    }
    throw e
  }
  const parts = collectParts(stripEmlxEnvelope(raw))
  const plain = parts.find((p) => !p.isHtml)
  const markup = parts.find((p) => p.isHtml)
  return {
    path: file,
    text: plain ? plain.text.trim() : markup ? htmlToText(markup.text) : "",
    html: markup ? markup.text : null,
    partial: /\.partial\.emlx$/.test(file),
  }
}

export const __test = { shardSegments, mailboxDir, stripEmlxEnvelope, collectParts }
