/**
 * macOS Contacts (AddressBook) resolution — phone/email → saved contact name.
 *
 * The iMessage tools previously resolved names only via the leads CRM, so any
 * personal contact who isn't a lead showed up as a raw phone number. This reads
 * the local AddressBook SQLite databases (no network) to fill that gap.
 *
 * Contacts live in one or more per-source DBs:
 *   ~/Library/Application Support/AddressBook/Sources/<UUID>/AddressBook-v22.abcddb
 * Phones: ZABCDPHONENUMBER.ZFULLNUMBER → ZOWNER → ZABCDRECORD (name columns).
 * Emails: ZABCDEMAILADDRESS.ZADDRESS  → ZOWNER → ZABCDRECORD.
 *
 * The index is built once per process (lazy + memoized). Everything is wrapped
 * so a missing DB / no Full Disk Access / non-darwin never throws — callers just
 * get null and fall back to the CRM lookup.
 */

import { execFileSync } from "child_process"
import { existsSync, readdirSync } from "fs"
import { homedir } from "os"

const AB_ROOT = `${homedir()}/Library/Application Support/AddressBook`

interface AddressBookIndex {
  byPhone: Map<string, string> // last-10-digits → name
  byEmail: Map<string, string> // lowercased email → name
  // name (lowercased) → contact handles, for reverse "text by name" lookup.
  byName: Map<string, { name: string; phones: string[]; emails: string[] }>
}

export interface ContactMatch {
  name: string
  phones: string[]
  emails: string[]
}

let indexCache: AddressBookIndex | null = null

/** Normalize a phone handle to its last 10 digits (matches contacts.ts). */
function phoneKey(identifier: string): string | null {
  const digits = identifier.replace(/[^0-9]/g, "")
  if (digits.length >= 10) return digits.slice(-10)
  if (digits.length >= 7) return digits
  return null
}

/** Discover every AddressBook source DB that exists on disk. */
function sourceDbs(): string[] {
  const dbs: string[] = []
  const top = `${AB_ROOT}/AddressBook-v22.abcddb`
  if (existsSync(top)) dbs.push(top)
  const sources = `${AB_ROOT}/Sources`
  try {
    for (const dir of readdirSync(sources)) {
      const db = `${sources}/${dir}/AddressBook-v22.abcddb`
      if (existsSync(db)) dbs.push(db)
    }
  } catch {}
  return dbs
}

/**
 * Pick the best display name from a record's columns.
 * Prefers "First Last", then first or last alone, then nickname, then org.
 */
function pickName(first: string, last: string, nick: string, org: string): string | null {
  const full = `${first} ${last}`.trim()
  if (full) return full
  if (nick.trim()) return nick.trim()
  if (org.trim()) return org.trim()
  return null
}

/** Run a query against one DB, returning rows of pipe-split columns. */
function queryDb(db: string, sql: string): string[][] {
  try {
    const raw = execFileSync("sqlite3", ["-separator", "|", db, sql], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim()
    if (!raw) return []
    return raw.split("\n").map((line) => line.split("|"))
  } catch {
    return []
  }
}

/** Build (once) the phone/email → name index from all source DBs. */
function buildIndex(): AddressBookIndex {
  if (indexCache) return indexCache
  const byPhone = new Map<string, string>()
  const byEmail = new Map<string, string>()
  const byName = new Map<string, { name: string; phones: string[]; emails: string[] }>()

  const addName = (name: string, phone?: string, email?: string) => {
    const key = name.toLowerCase()
    const entry = byName.get(key) ?? { name, phones: [], emails: [] }
    if (phone && !entry.phones.includes(phone)) entry.phones.push(phone)
    if (email && !entry.emails.includes(email)) entry.emails.push(email)
    byName.set(key, entry)
  }

  if (process.platform === "darwin") {
    for (const db of sourceDbs()) {
      // Phones
      const phoneRows = queryDb(
        db,
        `SELECT COALESCE(r.ZFIRSTNAME,''), COALESCE(r.ZLASTNAME,''), COALESCE(r.ZNICKNAME,''), COALESCE(r.ZORGANIZATION,''), p.ZFULLNUMBER
         FROM ZABCDPHONENUMBER p JOIN ZABCDRECORD r ON p.ZOWNER = r.Z_PK
         WHERE p.ZFULLNUMBER IS NOT NULL`,
      )
      for (const [first, last, nick, org, number] of phoneRows) {
        const key = number ? phoneKey(number) : null
        const name = pickName(first || "", last || "", nick || "", org || "")
        if (key && name && !byPhone.has(key)) byPhone.set(key, name)
        if (key && name) addName(name, key)
      }
      // Emails
      const emailRows = queryDb(
        db,
        `SELECT COALESCE(r.ZFIRSTNAME,''), COALESCE(r.ZLASTNAME,''), COALESCE(r.ZNICKNAME,''), COALESCE(r.ZORGANIZATION,''), e.ZADDRESS
         FROM ZABCDEMAILADDRESS e JOIN ZABCDRECORD r ON e.ZOWNER = r.Z_PK
         WHERE e.ZADDRESS IS NOT NULL`,
      )
      for (const [first, last, nick, org, email] of emailRows) {
        const key = email ? email.trim().toLowerCase() : ""
        const name = pickName(first || "", last || "", nick || "", org || "")
        if (key && name && !byEmail.has(key)) byEmail.set(key, name)
        if (key && name) addName(name, undefined, key)
      }
    }
  }

  indexCache = { byPhone, byEmail, byName }
  return indexCache
}

/**
 * Resolve a phone number or email to a saved Contacts name.
 * Local, synchronous, never throws. Returns null if not a saved contact.
 */
export function resolveFromAddressBook(identifier: string): string | null {
  if (!identifier) return null
  const idx = buildIndex()
  if (identifier.includes("@")) {
    return idx.byEmail.get(identifier.trim().toLowerCase()) ?? null
  }
  const key = phoneKey(identifier)
  if (!key) return null
  return idx.byPhone.get(key) ?? null
}

/**
 * Reverse lookup — find saved contacts by (partial, case-insensitive) name.
 * Returns matches sorted exact-first, then by name length (tightest match first).
 * Lets `iris imessage read/send/search <name>` work for personal contacts.
 */
export function findContactsByName(name: string): ContactMatch[] {
  if (!name || !name.trim()) return []
  const idx = buildIndex()
  const q = name.trim().toLowerCase()
  const matches: ContactMatch[] = []
  for (const [key, entry] of idx.byName) {
    if (key === q || key.includes(q)) matches.push(entry)
  }
  matches.sort((a, b) => {
    const aExact = a.name.toLowerCase() === q ? 0 : 1
    const bExact = b.name.toLowerCase() === q ? 0 : 1
    if (aExact !== bExact) return aExact - bExact
    return a.name.length - b.name.length
  })
  return matches
}

/** True if any saved contacts were readable (Full Disk Access granted). */
export function addressBookAvailable(): boolean {
  const idx = buildIndex()
  return idx.byPhone.size > 0 || idx.byEmail.size > 0
}

/** Reset the in-memory index (testing / long-running sessions). */
export function clearAddressBookCache(): void {
  indexCache = null
}
