/**
 * iMessage SQLite utility — single source of truth for Messages.app access.
 *
 * Used by: platform-imessage.ts, platform-atlas-comms.ts, platform-customer.ts, platform-doctor.ts
 */

import { execSync } from "child_process"
import { existsSync } from "fs"
import { homedir } from "os"

const MESSAGES_DB = `${homedir()}/Library/Messages/chat.db`

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
 */
export function searchByHandle(handle: string, days = 30, limit = 50): Message[] {
  const search = normalizeHandle(handle)
  const cutoffSeconds = days * 86400

  const sql = `SELECT
    m.rowid, m.text, m.is_from_me, m.date,
    datetime(m.date/1000000000 + strftime('%s','2001-01-01'), 'unixepoch', 'localtime') as sent_dt,
    c.chat_identifier
  FROM message m
  JOIN chat_message_join cmj ON m.rowid = cmj.message_id
  JOIN chat c ON cmj.chat_id = c.rowid
  WHERE c.chat_identifier LIKE '%${search}%'
  AND m.text IS NOT NULL AND m.text != ''
  AND m.date > (strftime('%s','now') - ${cutoffSeconds} - strftime('%s','2001-01-01')) * 1000000000
  ORDER BY m.date DESC LIMIT ${limit}`

  try {
    const raw = query(sql)
    if (!raw) return []

    return raw.split("\n").map((line) => {
      const parts = line.split("|")
      if (parts.length < 5) return null
      return {
        id: parts[0],
        text: parts[1],
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
