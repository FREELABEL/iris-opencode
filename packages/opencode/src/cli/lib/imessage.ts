/**
 * iMessage SQLite utility — single source of truth for Messages.app access.
 *
 * Used by: platform-imessage.ts, platform-atlas-comms.ts, platform-customer.ts, platform-doctor.ts
 */

import { execSync, execFileSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { matchPhoneCandidates, parsePhoneIdentity, phoneSuffix } from "./phone-identity"

const MESSAGES_DB = `${homedir()}/Library/Messages/chat.db`
const SELF_CONFIG_PATH = join(homedir(), ".iris", "imessage-self.json")

// ── Types ──

export interface Message {
  id: string
  date: string
  from_me: boolean
  text: string
  chat_identifier?: string
}

export interface Chat {
  identifier: string
  message_count: number
  last_message: string
}

// ── Core ──

/**
 * Check if iMessage SQLite is accessible (macOS only + Full Disk Access).
 */
export function isAvailable(): boolean {
  if (queryOverride) return true
  if (process.platform !== "darwin") return false
  if (!existsSync(MESSAGES_DB)) return false
  try {
    execSync(`sqlite3 "${MESSAGES_DB}" "SELECT 1 FROM message LIMIT 1"`, {
      encoding: "utf-8",
      timeout: 3000,
      // #193251: inherited stderr printed sqlite3's error — with the chat.db path — on every
      // access probe. Capture it; diagnoseAccess() turns it into one clean sentence.
      stdio: ["ignore", "pipe", "pipe"],
    })
    return true
  } catch {
    return false
  }
}

/**
 * Diagnose why iMessage access failed — returns a user-friendly reason string.
 */
export function diagnoseAccess(): string {
  if (process.platform !== "darwin") return "iMessage is only available on macOS."
  if (!existsSync(MESSAGES_DB)) return "Messages database not found (~/Library/Messages/chat.db). Is Messages.app installed?"
  try {
    execSync(`sqlite3 "${MESSAGES_DB}" "SELECT 1 FROM message LIMIT 1"`, {
      encoding: "utf-8",
      timeout: 3000,
      // #193251: inherited stderr printed sqlite3's error — with the chat.db path — on every
      // access probe. Capture it; diagnoseAccess() turns it into one clean sentence.
      stdio: ["ignore", "pipe", "pipe"],
    })
    return "accessible" // shouldn't reach here if isAvailable() returned false
  } catch (err: any) {
    const msg = (err.stderr || err.message || "").toString()
    if (msg.includes("authorization denied") || msg.includes("not permitted")) {
      return "Full Disk Access required. Go to System Settings > Privacy & Security > Full Disk Access and enable your terminal app, then restart it."
    }
    return `Cannot read Messages database: ${describeQueryFailure(err).replace(/^iMessage database query failed:?\s*/, "") || "unknown error"}`
  }
}

/**
 * Run a raw SQL query against the Messages database.
 * Escapes double quotes in the SQL string.
 */
/** Tests run real SQL against a fixture chat.db through this. Production never sets it. */
let queryOverride: ((sql: string) => string) | null = null
export function setQueryForTests(fn: ((sql: string) => string) | null): void {
  queryOverride = fn
}

export function query(sql: string): string {
  if (queryOverride) return queryOverride(sql).trim()
  const escaped = sql.replace(/"/g, '\\"')
  try {
    return execSync(`sqlite3 "${MESSAGES_DB}" "${escaped}"`, {
      encoding: "utf-8",
      timeout: 10000,
      // #193251: stderr used to be inherited, so a failing query printed sqlite3's raw error, the
      // full SQL and the user's chat.db path straight onto the terminal. Capture it instead.
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch (err: any) {
    throw new Error(describeQueryFailure(err))
  }
}

/**
 * One clean line saying why sqlite3 failed — never the SQL, never the database path.
 * execSync's own message is `Command failed: sqlite3 "/Users/<you>/Library/Messages/chat.db" …`
 * followed by the whole query, which is what leaked in #193251.
 */
export function describeQueryFailure(err: any): string {
  if (err?.code === "ETIMEDOUT" || err?.signal === "SIGTERM") return "iMessage database query timed out"
  const stderr = String(err?.stderr ?? "")
  const line = stderr.split("\n").map((l) => l.trim()).find(Boolean) ?? ""
  const clean = line
    .split(MESSAGES_DB).join("chat.db")
    .split(homedir()).join("~")
    .replace(/^(Parse error|Runtime error|Error)( near line \d+)?:\s*/i, "")
    .slice(0, 160)
  return clean ? `iMessage database query failed: ${clean}` : "iMessage database query failed"
}

// ── Self handle ("me" / "self" target) ──

export interface SelfConfig {
  email?: string
  phone?: string
}

/** Read the persisted self-handle config (`~/.iris/imessage-self.json`). */
export function readSelfConfig(): SelfConfig {
  try {
    if (!existsSync(SELF_CONFIG_PATH)) return {}
    return JSON.parse(readFileSync(SELF_CONFIG_PATH, "utf-8")) as SelfConfig
  } catch {
    return {}
  }
}

/** Merge-write the self-handle config. Pass undefined values to leave a field unchanged. */
export function writeSelfConfig(patch: SelfConfig): SelfConfig {
  const current = readSelfConfig()
  const next: SelfConfig = { ...current }
  if (patch.email !== undefined) next.email = patch.email || undefined
  if (patch.phone !== undefined) next.phone = patch.phone || undefined
  mkdirSync(join(homedir(), ".iris"), { recursive: true })
  writeFileSync(SELF_CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf-8")
  return next
}

/** Delete the persisted self-handle config. */
export function clearSelfConfig(): void {
  try {
    rmSync(SELF_CONFIG_PATH, { force: true })
  } catch {
    /* ignore */
  }
}

/**
 * Auto-detect the user's own handles from chat.db.
 * Every chat row carries `account_login` = the local account that owns it,
 * prefixed `E:` (email/iMessage) or `P:` (phone/SMS). We pick the most-used of each.
 */
export function detectSelfHandle(): SelfConfig {
  const out: SelfConfig = {}
  if (!isAvailable()) return out
  try {
    const rows = query(
      "SELECT account_login, COUNT(*) c FROM chat WHERE account_login != '' GROUP BY account_login ORDER BY c DESC",
    )
    for (const line of rows.split("\n")) {
      const login = line.split("|")[0]?.trim()
      if (!login) continue
      if (!out.email && login.startsWith("E:")) out.email = login.slice(2)
      else if (!out.phone && login.startsWith("P:")) out.phone = login.slice(2)
    }
  } catch {
    /* ignore */
  }
  return out
}

/**
 * Resolve the handle to send to when the user targets "me"/"self".
 * Order: env override → persisted config → chat.db auto-detect.
 * `prefer` picks which to return first ("email" for iMessage, "phone" for SMS);
 * falls back to the other if the preferred one is unset.
 * Returns null if nothing can be resolved.
 */
export function resolveSelfHandle(prefer: "email" | "phone" = "email"): string | null {
  const env = process.env.IRIS_SELF_HANDLE?.trim()
  if (env) return env
  const cfg = readSelfConfig()
  const detected = detectSelfHandle()
  const email = cfg.email || detected.email
  const phone = cfg.phone || detected.phone
  const primary = prefer === "phone" ? phone : email
  const secondary = prefer === "phone" ? email : phone
  return primary || secondary || null
}

/** True if the given handle string is a "me"/"self" alias. */
export function isSelfAlias(handle: string): boolean {
  return ["me", "self", "myself", ":me", ":self"].includes(handle.trim().toLowerCase())
}

/**
 * Parse NSAttributedString binary blob to extract plain text.
 * Modern macOS Messages.app stores content in attributedBody (BLOB) instead of text.
 * The plain text string is embedded after the NSString type marker in the binary.
 */
export function parseAttributedBody(hexStr: string): string {
  if (!hexStr) return ""
  try {
    const buf = Buffer.from(hexStr, "hex")
    // Find NSString marker followed by a length byte and the text content.
    // The pattern is: ...NSString\x01\x95\x84\x01\x2B<length><text>\x86...
    // We look for the \x2B byte ('+') which precedes the length+text.
    const text = buf.toString("utf-8", 0, buf.length)
    // Strategy: find the text between the NSString length marker and the next control sequence.
    // The attributedBody contains the raw string after a specific byte pattern.
    const nsStringMarker = "NSString"
    const markerIdx = text.indexOf(nsStringMarker)
    if (markerIdx === -1) return ""

    // After NSString, skip to the '+' marker which precedes the length byte + text
    const afterMarker = buf.indexOf(0x2b, markerIdx + nsStringMarker.length)
    if (afterMarker === -1) return ""

    // The byte after '+' is the string length
    const strLen = buf[afterMarker + 1]
    if (!strLen || strLen === 0) return ""

    // Extract the text
    const start = afterMarker + 2
    const end = start + strLen
    if (end > buf.length) return ""

    const extracted = buf.subarray(start, end).toString("utf-8")
    // Clean up: remove trailing binary garbage
    return extracted.replace(/[\x00-\x08\x0e-\x1f\x80-\xff]/g, "").trim()
  } catch {
    return ""
  }
}

/**
 * Query messages with attributedBody fallback.
 * Returns messages even when text column is NULL (modern macOS Messages.app).
 */
export function queryMessagesWithBody(whereClause: string, cutoffSeconds: number, limit: number): Message[] {
  // Query both text and hex-encoded attributedBody, plus sender handle for group chats
  const sql = `SELECT
    m.rowid,
    datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') as msg_date,
    m.is_from_me,
    REPLACE(REPLACE(m.text, char(10), ' '), char(13), ' ') as text,
    hex(m.attributedBody) as body_hex,
    COALESCE(h.id, '') as sender_handle
  FROM message m
  JOIN chat_message_join cmj ON m.rowid = cmj.message_id
  JOIN chat c ON cmj.chat_id = c.rowid
  LEFT JOIN handle h ON m.handle_id = h.rowid
  WHERE ${whereClause}
    AND m.date/1000000000 + 978307200 > unixepoch('now') - ${cutoffSeconds}
    AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
  ORDER BY m.date DESC
  LIMIT ${limit};`.replace(/\n/g, " ").trim()

  try {
    const raw = query(sql)
    if (!raw) return []

    return raw.split("\n").map((line) => {
      const [id, date, fromMe, textCol, bodyHex, senderHandle] = line.split("|")
      // Prefer text column, fall back to parsing attributedBody
      let msgText = textCol?.trim() || ""
      if (!msgText && bodyHex) {
        msgText = parseAttributedBody(bodyHex)
      }
      if (!msgText) return null
      return {
        id,
        date,
        from_me: fromMe === "1",
        text: msgText.replace(/\n/g, " ").trim(),
        chat_identifier: senderHandle || undefined,
      } satisfies Message
    }).filter(Boolean) as Message[]
  } catch (err) {
    // #193251: this used to `return []`, so a query that FAILED read as "no messages" and the
    // command exited 0. Callers (search / read / read-group) report it and exit non-zero.
    throw err
  }
}

/**
 * Normalize a phone/email/handle to a search-friendly format.
 * Phones: strip non-digits, take last 10 digits.
 */
export function normalizeHandle(handle: string): string {
  const digits = handle.replace(/[^0-9]/g, "")
  if (digits.length >= 10) return digits.slice(-10)
  return handle
}

/**
 * Search messages by phone number, email, or chat identifier.
 * Falls back to attributedBody when text column is NULL (modern macOS).
 */
export function searchByHandle(handle: string, days = 30, limit = 50): Message[] {
  const search = normalizeHandle(handle)
  const cutoffSeconds = days * 86400

  const sql = `SELECT
    m.rowid, m.text, m.is_from_me, m.date,
    datetime(m.date/1000000000 + strftime('%s','2001-01-01'), 'unixepoch', 'localtime') as sent_dt,
    c.chat_identifier,
    hex(m.attributedBody) as body_hex
  FROM message m
  JOIN chat_message_join cmj ON m.rowid = cmj.message_id
  JOIN chat c ON cmj.chat_id = c.rowid
  WHERE c.chat_identifier LIKE '%${search}%'
  AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
  AND m.date > (strftime('%s','now') - ${cutoffSeconds} - strftime('%s','2001-01-01')) * 1000000000
  ORDER BY m.date DESC LIMIT ${limit}`

  try {
    const raw = query(sql)
    if (!raw) return []

    return raw.split("\n").map((line) => {
      const parts = line.split("|")
      if (parts.length < 5) return null
      let text = parts[1]?.trim() || ""
      if (!text && parts[6]) {
        text = parseAttributedBody(parts[6])
      }
      if (!text) return null
      return {
        id: parts[0],
        text,
        from_me: parts[2] === "1",
        date: parts[4],
        chat_identifier: parts[5] || search,
      } satisfies Message
    }).filter(Boolean) as Message[]
  } catch {
    return []
  }
}

export type HandleMatch =
  | { status: "matched"; identifiers: string[]; messages: Message[] }
  | { status: "ambiguous"; identifiers: string[] }
  | { status: "none" }
  | { status: "invalid"; reason: string }

/**
 * Messages for the conversation that IS this handle — for anything that WRITES what it finds to a
 * person's record (#183513). searchByHandle() is a substring search (fine for a person browsing
 * their own messages, wrong for attribution): a 7-digit number matched every chat ending in those
 * digits, and an email matched any longer address containing it.
 *   - email: the chat identifier must equal the address (case-insensitive).
 *   - phone: whole-number identity (phone-identity.ts); SQL prefilters on an anchored suffix,
 *     each candidate is then confirmed in full. Rows for the SAME number (SMS + iMessage threads)
 *     are one person; two DIFFERENT numbers is ambiguous and returns no messages.
 */
export function searchByHandleExact(handle: string, days = 30, limit = 50): HandleMatch {
  const h = String(handle ?? "").trim()
  if (!h) return { status: "invalid", reason: "empty handle" }
  const cutoffSeconds = days * 86400

  let identifiers: string[]
  if (h.includes("@")) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(h)) return { status: "invalid", reason: `"${h}" is not an email address` }
    const esc = h.toLowerCase().replace(/'/g, "''")
    const raw = query(`SELECT DISTINCT chat_identifier FROM chat WHERE lower(chat_identifier) = '${esc}';`)
    identifiers = raw ? raw.split("\n").filter(Boolean) : []
    if (identifiers.length === 0) return { status: "none" }
  } else {
    const p = parsePhoneIdentity(h)
    if (!p.ok) return { status: "invalid", reason: p.reason }
    const raw = query(`SELECT DISTINCT chat_identifier FROM chat WHERE chat_identifier LIKE '%${phoneSuffix(p)}';`)
    const rows = raw ? raw.split("\n").filter(Boolean) : []
    const m = matchPhoneCandidates(h, rows, (r) => r)
    if (m.status === "invalid" || m.status === "none") return m
    if (m.status === "ambiguous") return { status: "ambiguous", identifiers: m.keys }
    identifiers = m.candidates
  }

  const inList = identifiers.map((i) => `'${i.replace(/'/g, "''")}'`).join(",")
  const sql = `SELECT
    m.rowid, m.text, m.is_from_me, m.date,
    datetime(m.date/1000000000 + strftime('%s','2001-01-01'), 'unixepoch', 'localtime') as sent_dt,
    c.chat_identifier,
    hex(m.attributedBody) as body_hex
  FROM message m
  JOIN chat_message_join cmj ON m.rowid = cmj.message_id
  JOIN chat c ON cmj.chat_id = c.rowid
  WHERE c.chat_identifier IN (${inList})
  AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
  AND m.date > (strftime('%s','now') - ${cutoffSeconds} - strftime('%s','2001-01-01')) * 1000000000
  ORDER BY m.date DESC LIMIT ${limit}`
  const raw = query(sql)
  const messages = (raw ? raw.split("\n") : [])
    .map((line) => {
      const parts = line.split("|")
      if (parts.length < 5) return null
      let text = parts[1]?.trim() || ""
      if (!text && parts[6]) text = parseAttributedBody(parts[6])
      if (!text) return null
      return { id: parts[0], text, from_me: parts[2] === "1", date: parts[4], chat_identifier: parts[5] || identifiers[0] } satisfies Message
    })
    .filter(Boolean) as Message[]
  return { status: "matched", identifiers, messages }
}

/**
 * List recent conversations with message counts.
 */
export function listChats(days = 30, limit = 50): Chat[] {
  const cutoffSeconds = days * 86400

  const sql = `SELECT
    c.chat_identifier,
    COUNT(m.rowid) as msg_count,
    MAX(datetime(m.date/1000000000 + strftime('%s','2001-01-01'), 'unixepoch', 'localtime')) as last_msg
  FROM chat c
  JOIN chat_message_join cmj ON c.rowid = cmj.chat_id
  JOIN message m ON cmj.message_id = m.rowid
  WHERE m.date > (strftime('%s','now') - ${cutoffSeconds} - strftime('%s','2001-01-01')) * 1000000000
  GROUP BY c.chat_identifier
  ORDER BY last_msg DESC
  LIMIT ${limit}`

  try {
    const raw = query(sql)
    if (!raw) return []

    return raw.split("\n").map((line) => {
      const parts = line.split("|")
      if (parts.length < 3) return null
      return {
        identifier: parts[0],
        message_count: parseInt(parts[1], 10),
        last_message: parts[2],
      } satisfies Chat
    }).filter(Boolean) as Chat[]
  } catch {
    return []
  }
}

// ── Group Chat Support (#106514) ──

export interface GroupChat {
  guid: string
  display_name: string
  chat_identifier: string
  participants: number
  message_count: number
  last_message: string
}

/**
 * List group chats with names, participant counts, and message counts.
 */
export function listGroupChats(days = 90, limit = 30): GroupChat[] {
  const cutoffSeconds = days * 86400

  const sql = `SELECT
    c.guid,
    COALESCE(c.display_name, c.room_name, '') as display_name,
    c.chat_identifier,
    (SELECT COUNT(*) FROM chat_handle_join chj WHERE chj.chat_id = c.rowid) as participants,
    COUNT(m.rowid) as msg_count,
    MAX(datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime')) as last_msg
  FROM chat c
  JOIN chat_message_join cmj ON c.rowid = cmj.chat_id
  JOIN message m ON cmj.message_id = m.rowid
  WHERE (SELECT COUNT(*) FROM chat_handle_join chj2 WHERE chj2.chat_id = c.rowid) > 1
  AND m.date/1000000000 + 978307200 > unixepoch('now') - ${cutoffSeconds}
  GROUP BY c.guid
  ORDER BY MAX(m.date) DESC
  LIMIT ${limit}`

  try {
    const raw = query(sql)
    if (!raw) return []
    return raw.split("\n").map((line) => {
      const parts = line.split("|")
      if (parts.length < 6) return null
      return {
        guid: parts[0],
        display_name: parts[1] || "(unnamed group)",
        chat_identifier: parts[2],
        participants: parseInt(parts[3], 10),
        message_count: parseInt(parts[4], 10),
        last_message: parts[5],
      } satisfies GroupChat
    }).filter(Boolean) as GroupChat[]
  } catch {
    return []
  }
}

/**
 * Get participants of a group chat by guid or chat_identifier.
 */
export function getGroupParticipants(chatId: string): string[] {
  const escaped = chatId.replace(/'/g, "''")
  const sql = `SELECT h.id FROM chat_handle_join chj
    JOIN handle h ON chj.handle_id = h.rowid
    WHERE chj.chat_id = (
      SELECT rowid FROM chat WHERE guid = '${escaped}'
      OR chat_identifier = '${escaped}'
      LIMIT 1
    )`

  try {
    const raw = query(sql)
    if (!raw) return []
    return raw.split("\n").filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Read messages from a group chat by guid or chat_identifier.
 * Falls back to attributedBody when text is NULL.
 */
export function readGroupMessages(chatId: string, cutoffSeconds: number, limit: number): Message[] {
  const escaped = chatId.replace(/'/g, "''")
  const whereClause = `(c.guid = '${escaped}' OR c.chat_identifier = '${escaped}')`
  return queryMessagesWithBody(whereClause, cutoffSeconds, limit)
}

/**
 * Resolve a group chat by partial name match or chat ID.
 * Returns the guid if found.
 */
export function resolveGroupChat(search: string): GroupChat | null {
  const escaped = search.replace(/'/g, "''")
  const sql = `SELECT
    c.guid,
    COALESCE(c.display_name, c.room_name, '') as display_name,
    c.chat_identifier,
    (SELECT COUNT(*) FROM chat_handle_join chj WHERE chj.chat_id = c.rowid) as participants,
    (SELECT COUNT(*) FROM chat_message_join cmj WHERE cmj.chat_id = c.rowid) as msg_count
  FROM chat c
  WHERE (c.display_name LIKE '%${escaped}%'
    OR c.room_name LIKE '%${escaped}%'
    OR c.guid LIKE '%${escaped}%'
    OR c.chat_identifier LIKE '%${escaped}%')
  AND (SELECT COUNT(*) FROM chat_handle_join chj2 WHERE chj2.chat_id = c.rowid) > 1
  ORDER BY msg_count DESC
  LIMIT 1`

  try {
    const raw = query(sql)
    if (!raw) return null
    const parts = raw.split("|")
    if (parts.length < 5) return null
    return {
      guid: parts[0],
      display_name: parts[1] || "(unnamed group)",
      chat_identifier: parts[2],
      participants: parseInt(parts[3], 10),
      message_count: parseInt(parts[4], 10),
      last_message: "",
    }
  } catch {
    return null
  }
}

// ── Contact Card (vCard) Support (#58893) ──

export interface ContactCard {
  filename: string
  full_name: string
  phones: string[]
  emails: string[]
  company?: string
  sent_by: string
  date: string
  raw_vcard: string
}

/**
 * Find contact cards (vCards) shared via iMessage.
 * Reads attachment metadata from SQLite + parses the .vcf files.
 */
export function getContactCards(options: { days?: number; limit?: number; chat?: string } = {}): ContactCard[] {
  if (!isAvailable()) return []
  const days = options.days ?? 90
  const limit = options.limit ?? 20
  const cutoff = days * 86400

  try {
    let where = `(a.mime_type LIKE '%vcard%' OR a.uti LIKE '%vcard%' OR a.filename LIKE '%.vcf')
      AND m.date/1000000000 + 978307200 > unixepoch('now') - ${cutoff}`
    if (options.chat) {
      where += ` AND c.chat_identifier LIKE '%${options.chat.replace(/'/g, "''")}%'`
    }

    const sql = `SELECT a.filename, a.transfer_name,
        datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') as msg_date,
        c.chat_identifier
      FROM attachment a
      JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
      JOIN message m ON maj.message_id = m.ROWID
      JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      JOIN chat c ON cmj.chat_id = c.ROWID
      WHERE ${where}
      ORDER BY m.date DESC LIMIT ${limit};`.replace(/\n/g, " ").trim()

    const raw = query(sql)
    if (!raw) return []

    const { readFileSync } = require("fs")
    return raw.split("\n").map((line): ContactCard | null => {
      const [filepath, transferName, date, chatId] = line.split("|")
      if (!filepath) return null

      const fullPath = filepath.replace(/^~/, homedir())
      let rawVcard = ""
      try { rawVcard = readFileSync(fullPath, "utf-8") } catch { return null }

      const getName = (vc: string) => vc.match(/^FN:(.+)$/m)?.[1]?.trim() ?? transferName?.replace(".vcf", "") ?? "Unknown"
      const getPhones = (vc: string) => [...vc.matchAll(/TEL[^:]*:([+\d() -]+)/gm)].map(m => m[1].replace(/[^+\d]/g, ""))
      const getEmails = (vc: string) => [...vc.matchAll(/EMAIL[^:]*:(.+)$/gm)].map(m => m[1].trim())
      const getOrg = (vc: string) => vc.match(/^ORG:(.+)$/m)?.[1]?.trim()

      return {
        filename: transferName ?? filepath.split("/").pop() ?? "",
        full_name: getName(rawVcard),
        phones: getPhones(rawVcard),
        emails: getEmails(rawVcard),
        company: getOrg(rawVcard),
        sent_by: chatId,
        date,
        raw_vcard: rawVcard,
      }
    }).filter(Boolean) as ContactCard[]
  } catch {
    return []
  }
}

// ── Attachments ─────────────────────────────────────────────────────────────

/**
 * Files people actually sent you.
 *
 * This table was already being read — but only ever through a vcard filter, to
 * harvest contact cards. Nothing exposed it as "what documents do I have from
 * this person", so a 1.4MB `RevOps-SaveLifeAI.pdf` sat on the disk for a day
 * while every search surface reported the topic had left no trail. The bytes
 * were never missing; there was simply no verb that looked at them.
 */
export interface Attachment {
  /** Name as sent — what a person would call the file. */
  name: string
  /** Absolute path on this Mac, or "" when Messages never stored one. */
  path: string
  /** Whether the bytes are on disk RIGHT NOW. A row here is not a file there. */
  onDisk: boolean
  mime: string
  bytes: number
  /** ISO timestamp of the message that carried it. */
  date: string
  from_me: boolean
  /** The other party's handle — phone or Apple ID. */
  handle: string
}

/**
 * Apple's rich-link previews are rows in this table too. They are plumbing —
 * an opaque UUID payload for a URL that is already in the message text — and
 * including them buries the real documents under noise, so they are off by
 * default and behind a flag rather than silently dropped.
 */
const PLUGIN_PAYLOAD = "%.pluginPayloadAttachment"

/** Shell-safe query: SQL over stdin, because callers pass user input. */
function queryStdin(sql: string, maxBuffer = 16 * 1024 * 1024): string {
  return execFileSync("sqlite3", [MESSAGES_DB], {
    input: sql,
    encoding: "utf-8",
    timeout: 20000,
    maxBuffer,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim()
}

export function listAttachments(
  options: {
    days?: number
    limit?: number
    /** Substring match on the sent filename, case-insensitive. */
    search?: string
    /** Restrict to one correspondent (phone or Apple ID); matched loosely. */
    handle?: string
    /** Include Apple's rich-link payload rows. */
    includePluginPayloads?: boolean
  } = {},
): Attachment[] {
  if (!isAvailable()) return []
  const days = options.days ?? 90
  const limit = Math.min(options.limit ?? 100, 2000)
  const SEP = String.fromCharCode(31)
  const lit = (v: string) => "'" + v.replace(/'/g, "''") + "'"
  const like = (v: string) => "'%" + v.replace(/'/g, "''").replace(/[%_\\]/g, (c) => "\\" + c) + "%'"

  const where = [`(m.date/1000000000 + 978307200) > unixepoch('now') - ${days * 86400}`]
  if (!options.includePluginPayloads)
    where.push(`COALESCE(a.transfer_name,'') NOT LIKE ${lit(PLUGIN_PAYLOAD)}`)
  if (options.search)
    where.push(
      `(lower(COALESCE(a.transfer_name,'')) LIKE ${like(options.search.toLowerCase())} ESCAPE '\\'` +
        ` OR lower(COALESCE(a.filename,'')) LIKE ${like(options.search.toLowerCase())} ESCAPE '\\')`,
    )
  if (options.handle) {
    // Phones are stored in several shapes; the last ten digits are the stable part.
    const digits = options.handle.replace(/\D/g, "")
    where.push(
      digits.length >= 10
        ? `REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(h.id,''),'+',''),'-',''),' ',''),'()','') LIKE ${like(digits.slice(-10))} ESCAPE '\\'`
        : `lower(COALESCE(h.id,'')) LIKE ${like(options.handle.toLowerCase())} ESCAPE '\\'`,
    )
  }

  const clean = (x: string) => `REPLACE(REPLACE(REPLACE(${x}, char(31),' '), char(10),' '), char(13),' ')`
  const sql = `SELECT (m.date/1000000000 + 978307200) || '${SEP}' || COALESCE(h.id,'unknown') || '${SEP}' || m.is_from_me || '${SEP}'
    || ${clean("COALESCE(a.transfer_name,'')")} || '${SEP}'
    || ${clean("COALESCE(a.filename,'')")} || '${SEP}'
    || COALESCE(a.mime_type,'') || '${SEP}' || COALESCE(a.total_bytes,0)
  FROM attachment a
  JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
  JOIN message m ON maj.message_id = m.ROWID
  LEFT JOIN handle h ON m.handle_id = h.ROWID
  WHERE ${where.join(" AND ")}
  ORDER BY m.date DESC LIMIT ${limit};`

  let raw: string
  try {
    raw = queryStdin(sql)
  } catch {
    return []
  }
  if (!raw) return []

  return raw
    .split("\n")
    .filter(Boolean)
    .map((line): Attachment | null => {
      const [ts, handle, fromMe, name, filename, mime, bytes] = line.split(SEP)
      const at = Number(ts)
      if (!Number.isFinite(at)) return null
      const path = (filename ?? "").trim().replace(/^~/, homedir())
      return {
        name: (name ?? "").trim() || (path ? path.split("/").pop()! : "(unnamed)"),
        path,
        // Checked, not assumed: a purged or iCloud-offloaded attachment still
        // has its row, and telling someone a file is there when it is not is
        // the same failure as telling them it is not there when it is.
        onDisk: path ? existsSync(path) : false,
        mime: (mime ?? "").trim(),
        bytes: Number(bytes) || 0,
        date: new Date(at * 1000).toISOString(),
        from_me: fromMe === "1",
        handle: (handle ?? "unknown").trim(),
      }
    })
    .filter((a): a is Attachment => a !== null)
}

// ── Send confirmation (#193288) ──

/**
 * What chat.db says about a message we just handed to Messages.
 *
 * `osascript … send` returning without error only means Messages ACCEPTED the command. It says
 * nothing about whether the message went out: an unregistered handle, a signed-out account or a
 * network failure all return cleanly and leave a red "Not Delivered" row — or no row at all. The
 * CLI used to print "Sent" on that return alone (#193288). These are the only honest outcomes:
 */
export type SendConfirmation =
  | { state: "sent"; rowid: string; delivered: boolean }
  | { state: "failed"; rowid: string; error: number }
  | { state: "pending"; rowid: string }
  | { state: "missing" }
  | { state: "unknown"; reason: string }

export interface OutgoingRow {
  rowid: string
  text: string
  is_sent: boolean
  is_delivered: boolean
  error: number
}

/** Pure: decide from the candidate rows. Exported for tests. */
export function classifyOutgoing(rows: OutgoingRow[], text: string): SendConfirmation | null {
  const want = text.replace(/\s+/g, " ").trim()
  // Prefer an exact text match; a row with unreadable text (attributedBody only) still counts,
  // since it is from us, to this handle, inside the window.
  const row = rows.find((r) => r.text.replace(/\s+/g, " ").trim() === want) ?? rows.find((r) => !r.text)
  if (!row) return null
  if (row.error !== 0) return { state: "failed", rowid: row.rowid, error: row.error }
  if (row.is_sent || row.is_delivered) return { state: "sent", rowid: row.rowid, delivered: row.is_delivered }
  return { state: "pending", rowid: row.rowid }
}

function outgoingRows(handle: string, sinceUnixSeconds: number): OutgoingRow[] {
  const esc = (s: string) => s.replace(/'/g, "''")
  const digits = handle.includes("@") ? "" : handle.replace(/\D/g, "")
  const handleMatch = digits.length >= 7
    ? `(h.id LIKE '%${digits.slice(-10)}' OR c.chat_identifier LIKE '%${digits.slice(-10)}')`
    : `(lower(h.id) = lower('${esc(handle)}') OR lower(c.chat_identifier) = lower('${esc(handle)}'))`
  const sql = `SELECT m.rowid, COALESCE(REPLACE(REPLACE(m.text, char(10), ' '), char(13), ' '), ''),
      COALESCE(m.is_sent, 0), COALESCE(m.is_delivered, 0), COALESCE(m.error, 0)
    FROM message m
    JOIN chat_message_join cmj ON m.rowid = cmj.message_id
    JOIN chat c ON cmj.chat_id = c.rowid
    LEFT JOIN handle h ON m.handle_id = h.rowid
    WHERE m.is_from_me = 1
      AND m.date/1000000000 + 978307200 >= ${Math.floor(sinceUnixSeconds) - 5}
      AND ${handleMatch}
    ORDER BY m.date DESC LIMIT 10;`.replace(/\n/g, " ")
  const raw = query(sql)
  if (!raw) return []
  return raw.split("\n").map((line) => {
    const [rowid, text, isSent, isDelivered, error] = line.split("|")
    return { rowid, text: text ?? "", is_sent: isSent === "1", is_delivered: isDelivered === "1", error: Number(error) || 0 }
  })
}

/**
 * Poll chat.db until Messages records the outgoing message as sent or failed, or time runs out.
 * A row that appears but is neither sent nor failed by the deadline is "pending" — NOT sent.
 */
export async function confirmOutgoing(
  handle: string,
  text: string,
  sinceUnixSeconds: number,
  opts: { timeoutMs?: number; intervalMs?: number; canRead?: () => boolean } = {},
): Promise<SendConfirmation> {
  const timeoutMs = opts.timeoutMs ?? 15000
  const intervalMs = opts.intervalMs ?? 500
  const canRead = opts.canRead ?? (() => queryOverride !== null || isAvailable())
  if (!canRead()) return { state: "unknown", reason: "chat.db is not readable (Full Disk Access not granted)" }

  const deadline = Date.now() + timeoutMs
  let last: SendConfirmation | null = null
  while (true) {
    try {
      last = classifyOutgoing(outgoingRows(handle, sinceUnixSeconds), text)
    } catch (err: any) {
      return { state: "unknown", reason: String(err?.message ?? err) }
    }
    if (last && last.state !== "pending") return last
    if (Date.now() >= deadline) return last ?? { state: "missing" }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
