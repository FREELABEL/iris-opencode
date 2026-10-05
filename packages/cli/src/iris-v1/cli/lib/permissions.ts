/**
 * macOS permission detection + repair (#178283).
 *
 * The detection already existed, scattered across six call sites — platform-doctor,
 * platform-channels, platform-imessage, platform-leads, lib/address-book — each
 * with its own copy of the "System Settings → Privacy → Full Disk Access" string
 * and no way to actually get there. This is the single source of truth, and it
 * adds the two things that genuinely did not exist anywhere in the repo:
 * a deep link that OPENS the right pane, and a re-check after the user grants.
 *
 * Design note: macOS has no API to *request* TCC permissions for a terminal
 * process — that is a deliberate OS restriction, not a gap we can code around.
 * The honest best is: detect by attempting the real read, open the exact pane,
 * and re-verify. Anything claiming to "grant" a permission from the CLI is lying.
 */

import { execSync } from "child_process"
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"

export type PermissionId = "full-disk-access" | "contacts" | "automation"

export interface PermissionCheck {
  id: PermissionId
  name: string
  granted: boolean
  /** What stops working without it. */
  unlocks: string
  /** Deep link that opens the exact System Settings pane. */
  settingsUrl: string
  /** Why the probe failed, when we can tell. */
  detail?: string
}

/**
 * Deep links into System Settings → Privacy & Security.
 * These are the anchors macOS itself uses; they work on Ventura and later and
 * degrade to opening System Settings on older versions.
 */
const PANES: Record<PermissionId, string> = {
  "full-disk-access": "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  contacts: "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
}

const MESSAGES_DB = join(homedir(), "Library", "Messages", "chat.db")
const ADDRESS_BOOK = join(homedir(), "Library", "Application Support", "AddressBook", "AddressBook-v22.abcddb")

/** True only on macOS — every permission here is a macOS TCC concept. */
export function isSupported(): boolean {
  return process.platform === "darwin"
}

/**
 * Probe by doing the real read, not by asking macOS. TCC only reveals a denial
 * at the moment of access, so a probe that does not actually touch the file
 * cannot tell "granted" from "never asked".
 */
function canReadSqlite(path: string, query: string): { ok: boolean; detail?: string } {
  if (!existsSync(path)) {
    return { ok: false, detail: "database not present (app may never have been used)" }
  }
  try {
    execSync(`sqlite3 "${path}" "${query}"`, { encoding: "utf-8", timeout: 3000, stdio: "pipe" })
    return { ok: true }
  } catch (e: any) {
    const msg = String(e?.stderr ?? e?.message ?? "")
    if (/authoriz|denied|not permitted/i.test(msg)) {
      return { ok: false, detail: "access denied by macOS privacy protection" }
    }
    return { ok: false, detail: msg.trim().slice(0, 120) || "unreadable" }
  }
}

export function check(id: PermissionId): PermissionCheck {
  const base = { id, settingsUrl: PANES[id] }

  switch (id) {
    case "full-disk-access": {
      const r = canReadSqlite(MESSAGES_DB, "SELECT 1 FROM message LIMIT 1")
      return {
        ...base,
        name: "Full Disk Access",
        unlocks: "iMessage, WhatsApp, Apple Mail",
        granted: r.ok,
        detail: r.detail,
      }
    }
    case "contacts": {
      const r = canReadSqlite(ADDRESS_BOOK, "SELECT count(*) FROM ZABCDRECORD LIMIT 1")
      return {
        ...base,
        name: "Contacts",
        unlocks: "matching phone numbers and emails to names",
        granted: r.ok,
        detail: r.detail,
      }
    }
    case "automation": {
      // Driving Messages.app to SEND (as opposed to reading the DB) needs
      // Automation, which is a separate grant from Full Disk Access.
      try {
        execSync(`osascript -e 'tell application "System Events" to return name of first process'`, {
          encoding: "utf-8",
          timeout: 3000,
          stdio: "pipe",
        })
        return { ...base, name: "Automation", unlocks: "sending iMessages, controlling apps", granted: true }
      } catch (e: any) {
        return {
          ...base,
          name: "Automation",
          unlocks: "sending iMessages, controlling apps",
          granted: false,
          detail: String(e?.stderr ?? e?.message ?? "").trim().slice(0, 120) || "not permitted",
        }
      }
    }
  }
}

export const ALL: PermissionId[] = ["full-disk-access", "contacts", "automation"]

export function checkAll(): PermissionCheck[] {
  return ALL.map(check)
}

/**
 * Open the System Settings pane for a permission. Returns false if `open`
 * failed — never throws, because a failure here is not worth aborting a repair
 * flow that can still tell the user where to click.
 */
export function openSettings(id: PermissionId): boolean {
  if (!isSupported()) return false
  try {
    execSync(`open "${PANES[id]}"`, { timeout: 5000, stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

/**
 * The terminal app macOS will actually list in the permission pane — that is
 * the process the user has to tick, and it is NOT "iris". Getting this wrong is
 * the single most common reason a grant appears not to work.
 */
export function hostApp(): string {
  return (
    process.env.TERM_PROGRAM ||
    process.env.__CFBundleIdentifier ||
    "your terminal app"
  )
}
