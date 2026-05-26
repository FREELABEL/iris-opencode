/**
 * WhatsApp SQLite utility — local macOS ChatStorage.sqlite access.
 *
 * Used by: platform-whatsapp.ts, platform-atlas-comms.ts, platform-inbox.ts
 *
 * DB: ~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite
 * Schema: Core Data (ZWACHATSESSION, ZWAMESSAGE, ZWAGROUPMEMBER)
 * Timestamps: Core Data epoch — add 978307200 to get unix epoch
 */

import { execSync } from "child_process"
import { existsSync } from "fs"
import { homedir } from "os"

const WA_DB = `${homedir()}/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite`

// ── Types ──

export interface WAMessage {
  id: string
  date: string
  from_me: boolean
  text: string
  from_jid: string
  push_name: string
  chat_session: number
}

export interface WAChat {
  pk: number
  jid: string
  name: string
  session_type: number // 0=1:1, 1=group
  last_message_date: string
  unread_count: number
  message_count: number
}

export interface WAGroupChat {
  pk: number
  jid: string
  name: string
  member_count: number
  message_count: number
  last_message_date: string
}

export interface WAGroupMember {
  jid: string
  name: string
  is_admin: boolean
}

// ── Core ──

export function isAvailable(): boolean {
  if (process.platform !== "darwin") return false
  if (!existsSync(WA_DB)) return false
  try {
    execSync(`sqlite3 "${WA_DB}" "SELECT 1 FROM ZWACHATSESSION LIMIT 1"`, {
      encoding: "utf-8",
      timeout: 3000,
    })
    return true
  } catch {
    return false
  }
}

export function diagnoseAccess(): string {
  if (process.platform !== "darwin") return "WhatsApp local database is only available on macOS."
  if (!existsSync(WA_DB)) return `WhatsApp database not found at ${WA_DB}. Is WhatsApp desktop installed?`
  try {
    execSync(`sqlite3 "${WA_DB}" "SELECT 1 FROM ZWACHATSESSION LIMIT 1"`, {
      encoding: "utf-8",
      timeout: 3000,
    })
    return "accessible"
  } catch (err: any) {
    const msg = (err.stderr || err.message || "").toString()
    if (msg.includes("authorization denied") || msg.includes("not permitted")) {
      return "Full Disk Access required. Go to System Settings > Privacy & Security > Full Disk Access and enable your terminal app, then restart it."
    }
    return `Cannot read WhatsApp database: ${msg.slice(0, 200)}`
  }
}

export function query(sql: string): string {
  const escaped = sql.replace(/"/g, '\\"')
  return execSync(`sqlite3 "${WA_DB}" "${escaped}"`, {
    encoding: "utf-8",
    timeout: 10000,
  }).trim()
}

// ── Helpers ──

/**
 * Normalize a phone number to WhatsApp JID format for searching.
 * "+1 (469) 955-3570" -> "14699553570"
 */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "")
  // If 10 digits (US), prepend 1
  if (digits.length === 10) return `1${digits}`
  return digits
}

/**
 * Extract a displayable phone number from a JID.
 * "14699553570@s.whatsapp.net" -> "+14699553570"
 */
export function extractPhone(jid: string): string {
  if (!jid) return ""
  const num = jid.split("@")[0]
  if (!num || !/^\d+$/.test(num)) return jid
  return `+${num}`
}

/**
 * Check if a JID is a group chat.
 */
export function isGroupJid(jid: string): boolean {
  return jid.includes("@g.us")
}

// ── Chat Functions ──

export function listChats(days = 30, limit = 50): WAChat[] {
  const cutoff = days * 86400
  // Use actual last message date from ZWAMESSAGE (ZLASTMESSAGEDATE can be corrupted)
  const sql = `SELECT
    cs.Z_PK,
    cs.ZCONTACTJID,
    cs.ZPARTNERNAME,
    cs.ZSESSIONTYPE,
    datetime(COALESCE(last_msg.actual_last, cs.ZLASTMESSAGEDATE) + 978307200, 'unixepoch', 'localtime') as last_dt,
    cs.ZUNREADCOUNT,
    COALESCE(last_msg.msg_count, 0) as msg_count
  FROM ZWACHATSESSION cs
  LEFT JOIN (
    SELECT ZCHATSESSION, MAX(ZMESSAGEDATE) as actual_last, COUNT(*) as msg_count
    FROM ZWAMESSAGE GROUP BY ZCHATSESSION
  ) last_msg ON last_msg.ZCHATSESSION = cs.Z_PK
  WHERE cs.ZREMOVED = 0
    AND cs.ZSESSIONTYPE = 0
    AND cs.ZCONTACTJID != '0@s.whatsapp.net'
    AND COALESCE(last_msg.actual_last, cs.ZLASTMESSAGEDATE) + 978307200 > strftime('%s','now') - ${cutoff}
  ORDER BY COALESCE(last_msg.actual_last, cs.ZLASTMESSAGEDATE) DESC
  LIMIT ${limit};`.replace(/\n/g, " ").trim()

  try {
    const raw = query(sql)
    if (!raw) return []
    return raw.split("\n").map((line) => {
      const [pk, jid, name, sessionType, lastDt, unread, msgCount] = line.split("|")
      if (!jid) return null
      return {
        pk: parseInt(pk, 10),
        jid,
        name: name || extractPhone(jid),
        session_type: parseInt(sessionType, 10),
        last_message_date: lastDt,
        unread_count: parseInt(unread, 10) || 0,
        message_count: parseInt(msgCount, 10) || 0,
      } satisfies WAChat
    }).filter(Boolean) as WAChat[]
  } catch {
    return []
  }
}

export function searchChats(searchQuery: string, days = 90, limit = 20): WAChat[] {
  const cutoff = days * 86400
  const digits = normalizePhone(searchQuery)
  const escaped = searchQuery.replace(/'/g, "''")

  const sql = `SELECT
    cs.Z_PK,
    cs.ZCONTACTJID,
    cs.ZPARTNERNAME,
    cs.ZSESSIONTYPE,
    datetime(COALESCE(last_msg.actual_last, cs.ZLASTMESSAGEDATE) + 978307200, 'unixepoch', 'localtime') as last_dt,
    cs.ZUNREADCOUNT,
    COALESCE(last_msg.msg_count, 0) as msg_count
  FROM ZWACHATSESSION cs
  LEFT JOIN (
    SELECT ZCHATSESSION, MAX(ZMESSAGEDATE) as actual_last, COUNT(*) as msg_count
    FROM ZWAMESSAGE GROUP BY ZCHATSESSION
  ) last_msg ON last_msg.ZCHATSESSION = cs.Z_PK
  WHERE cs.ZREMOVED = 0
    AND cs.ZCONTACTJID != '0@s.whatsapp.net'
    AND COALESCE(last_msg.actual_last, cs.ZLASTMESSAGEDATE) + 978307200 > strftime('%s','now') - ${cutoff}
    AND (cs.ZPARTNERNAME LIKE '%${escaped}%'${digits.length >= 7 ? ` OR cs.ZCONTACTJID LIKE '%${digits}%'` : ""})
  ORDER BY COALESCE(last_msg.actual_last, cs.ZLASTMESSAGEDATE) DESC
  LIMIT ${limit};`.replace(/\n/g, " ").trim()

  try {
    const raw = query(sql)
    if (!raw) return []
    return raw.split("\n").map((line) => {
      const [pk, jid, name, sessionType, lastDt, unread, msgCount] = line.split("|")
      if (!jid) return null
      return {
        pk: parseInt(pk, 10),
        jid,
        name: name || extractPhone(jid),
        session_type: parseInt(sessionType, 10),
        last_message_date: lastDt,
        unread_count: parseInt(unread, 10) || 0,
        message_count: parseInt(msgCount, 10) || 0,
      } satisfies WAChat
    }).filter(Boolean) as WAChat[]
  } catch {
    return []
  }
}

// ── Message Functions ──

export function readMessages(chatSessionPk: number, days = 30, limit = 50): WAMessage[] {
  const cutoff = days * 86400
  // Join ZGROUPMEMBER + ZWACHATSESSION to resolve sender names in group chats
  const sql = `SELECT
    m.Z_PK,
    datetime(m.ZMESSAGEDATE + 978307200, 'unixepoch', 'localtime') as msg_dt,
    m.ZISFROMME,
    REPLACE(REPLACE(m.ZTEXT, char(10), ' '), char(13), ' ') as text,
    COALESCE(gm.ZMEMBERJID, m.ZFROMJID, '') as from_jid,
    COALESCE(NULLIF(gm.ZCONTACTNAME, ''), NULLIF(gm.ZFIRSTNAME, ''), cs2.ZPARTNERNAME, cs.ZPARTNERNAME, '') as push_name,
    m.ZCHATSESSION
  FROM ZWAMESSAGE m
  LEFT JOIN ZWACHATSESSION cs ON cs.Z_PK = m.ZCHATSESSION
  LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER
  LEFT JOIN ZWACHATSESSION cs2 ON cs2.ZCONTACTJID = gm.ZMEMBERJID
  WHERE m.ZCHATSESSION = ${chatSessionPk}
    AND m.ZTEXT IS NOT NULL
    AND m.ZMESSAGETYPE IN (0, 7)
    AND length(m.ZTEXT) > 1
    AND m.ZMESSAGEDATE + 978307200 > strftime('%s','now') - ${cutoff}
  ORDER BY m.ZMESSAGEDATE DESC
  LIMIT ${limit};`.replace(/\n/g, " ").trim()

  try {
    const raw = query(sql)
    if (!raw) return []
    return raw.split("\n").map((line) => {
      const [id, date, fromMe, text, fromJid, pushName, chatSession] = line.split("|")
      const trimmed = text?.trim()
      if (!trimmed) return null
      // Skip numeric-only strings (media references, reactions) and base64 fragments
      if (/^\d+$/.test(trimmed) && trimmed.length < 20) return null
      return {
        id,
        date,
        from_me: fromMe === "1",
        text: trimmed,
        from_jid: fromJid,
        push_name: pushName,
        chat_session: parseInt(chatSession, 10),
      } satisfies WAMessage
    }).filter(Boolean) as WAMessage[]
  } catch {
    return []
  }
}

export function searchByPhone(phone: string, days = 90, limit = 50): WAMessage[] {
  const digits = normalizePhone(phone)
  const cutoff = days * 86400

  // Find chat session PK by phone digits in JID
  const chatSql = `SELECT Z_PK FROM ZWACHATSESSION
    WHERE ZCONTACTJID LIKE '%${digits}%'
    AND ZREMOVED = 0
    LIMIT 1;`.replace(/\n/g, " ").trim()

  try {
    const chatPk = query(chatSql)
    if (!chatPk) return []
    return readMessages(parseInt(chatPk, 10), days, limit)
  } catch {
    return []
  }
}

export function searchByName(name: string, days = 90, limit = 50): WAMessage[] {
  const escaped = name.replace(/'/g, "''")
  const cutoff = days * 86400

  // Find chat session PK by partner name
  const chatSql = `SELECT Z_PK FROM ZWACHATSESSION
    WHERE ZPARTNERNAME LIKE '%${escaped}%'
    AND ZREMOVED = 0
    ORDER BY ZLASTMESSAGEDATE DESC
    LIMIT 1;`.replace(/\n/g, " ").trim()

  try {
    const chatPk = query(chatSql)
    if (!chatPk) return []
    return readMessages(parseInt(chatPk, 10), days, limit)
  } catch {
    return []
  }
}

// ── Group Functions ──

export function listGroups(days = 90, limit = 30): WAGroupChat[] {
  const cutoff = days * 86400
  const sql = `SELECT
    cs.Z_PK,
    cs.ZCONTACTJID,
    cs.ZPARTNERNAME,
    (SELECT COUNT(*) FROM ZWAGROUPMEMBER gm WHERE gm.ZCHATSESSION = cs.Z_PK AND gm.ZISACTIVE = 1) as members,
    COALESCE(last_msg.msg_count, 0) as msg_count,
    datetime(COALESCE(last_msg.actual_last, cs.ZLASTMESSAGEDATE) + 978307200, 'unixepoch', 'localtime') as last_dt
  FROM ZWACHATSESSION cs
  LEFT JOIN (
    SELECT ZCHATSESSION, MAX(ZMESSAGEDATE) as actual_last, COUNT(*) as msg_count
    FROM ZWAMESSAGE GROUP BY ZCHATSESSION
  ) last_msg ON last_msg.ZCHATSESSION = cs.Z_PK
  WHERE cs.ZREMOVED = 0
    AND cs.ZSESSIONTYPE = 1
    AND COALESCE(last_msg.actual_last, cs.ZLASTMESSAGEDATE) + 978307200 > strftime('%s','now') - ${cutoff}
  ORDER BY COALESCE(last_msg.actual_last, cs.ZLASTMESSAGEDATE) DESC
  LIMIT ${limit};`.replace(/\n/g, " ").trim()

  try {
    const raw = query(sql)
    if (!raw) return []
    return raw.split("\n").map((line) => {
      const [pk, jid, name, members, msgCount, lastDt] = line.split("|")
      if (!jid) return null
      return {
        pk: parseInt(pk, 10),
        jid,
        name: name || "(unnamed group)",
        member_count: parseInt(members, 10) || 0,
        message_count: parseInt(msgCount, 10) || 0,
        last_message_date: lastDt,
      } satisfies WAGroupChat
    }).filter(Boolean) as WAGroupChat[]
  } catch {
    return []
  }
}

export function getGroupMembers(chatSessionPk: number): WAGroupMember[] {
  // Join against ZWACHATSESSION to get partner names (ZCONTACTNAME is often empty)
  const sql = `SELECT
    gm.ZMEMBERJID,
    COALESCE(NULLIF(gm.ZCONTACTNAME, ''), NULLIF(gm.ZFIRSTNAME, ''), cs.ZPARTNERNAME, '') as name,
    gm.ZISADMIN
  FROM ZWAGROUPMEMBER gm
  LEFT JOIN ZWACHATSESSION cs ON cs.ZCONTACTJID = gm.ZMEMBERJID
  WHERE gm.ZCHATSESSION = ${chatSessionPk}
    AND gm.ZISACTIVE = 1
  ORDER BY gm.ZISADMIN DESC, name ASC;`.replace(/\n/g, " ").trim()

  try {
    const raw = query(sql)
    if (!raw) return []
    return raw.split("\n").map((line) => {
      const [jid, name, isAdmin] = line.split("|")
      if (!jid) return null
      return {
        jid,
        name: name || extractPhone(jid),
        is_admin: isAdmin === "1",
      } satisfies WAGroupMember
    }).filter(Boolean) as WAGroupMember[]
  } catch {
    return []
  }
}

/**
 * Resolve a group chat by partial name match.
 */
export function resolveGroupChat(search: string): WAGroupChat | null {
  const escaped = search.replace(/'/g, "''")
  const sql = `SELECT
    cs.Z_PK,
    cs.ZCONTACTJID,
    cs.ZPARTNERNAME,
    (SELECT COUNT(*) FROM ZWAGROUPMEMBER gm WHERE gm.ZCHATSESSION = cs.Z_PK AND gm.ZISACTIVE = 1) as members,
    (SELECT COUNT(*) FROM ZWAMESSAGE m WHERE m.ZCHATSESSION = cs.Z_PK) as msg_count,
    datetime(cs.ZLASTMESSAGEDATE + 978307200, 'unixepoch', 'localtime') as last_dt
  FROM ZWACHATSESSION cs
  WHERE cs.ZREMOVED = 0
    AND cs.ZSESSIONTYPE = 1
    AND (cs.ZPARTNERNAME LIKE '%${escaped}%' OR cs.ZCONTACTJID LIKE '%${escaped}%')
  ORDER BY msg_count DESC
  LIMIT 1;`.replace(/\n/g, " ").trim()

  try {
    const raw = query(sql)
    if (!raw) return null
    const [pk, jid, name, members, msgCount, lastDt] = raw.split("|")
    if (!jid) return null
    return {
      pk: parseInt(pk, 10),
      jid,
      name: name || "(unnamed group)",
      member_count: parseInt(members, 10) || 0,
      message_count: parseInt(msgCount, 10) || 0,
      last_message_date: lastDt,
    }
  } catch {
    return null
  }
}
