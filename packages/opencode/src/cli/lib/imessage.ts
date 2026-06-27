/**
 * iMessage SQLite utility — single source of truth for Messages.app access.
 *
 * Used by: platform-imessage.ts, platform-atlas-comms.ts, platform-customer.ts, platform-doctor.ts
 */

import { execSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs"
import { homedir } from "os"
import { join } from "path"

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
  if (process.platform !== "darwin") return false
  if (!existsSync(MESSAGES_DB)) return false
  try {
    execSync(`sqlite3 "${MESSAGES_DB}" "SELECT 1 FROM message LIMIT 1"`, {
      encoding: "utf-8",
      timeout: 3000,
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
  if (!existsSync(MESSAGES_DB)) return `Messages database not found at ${MESSAGES_DB}. Is Messages.app installed?`
  try {
    execSync(`sqlite3 "${MESSAGES_DB}" "SELECT 1 FROM message LIMIT 1"`, {
      encoding: "utf-8",
      timeout: 3000,
    })
    return "accessible" // shouldn't reach here if isAvailable() returned false
  } catch (err: any) {
    const msg = (err.stderr || err.message || "").toString()
    if (msg.includes("authorization denied") || msg.includes("not permitted")) {
      return "Full Disk Access required. Go to System Settings > Privacy & Security > Full Disk Access and enable your terminal app, then restart it."
    }
    return `Cannot read Messages database: ${msg.slice(0, 200)}`
  }
}

/**
 * Run a raw SQL query against the Messages database.
 * Escapes double quotes in the SQL string.
 */
export function query(sql: string): string {
  const escaped = sql.replace(/"/g, '\\"')
  return execSync(`sqlite3 "${MESSAGES_DB}" "${escaped}"`, {
    encoding: "utf-8",
    timeout: 10000,
  }).trim()
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
  } catch {
    return []
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
