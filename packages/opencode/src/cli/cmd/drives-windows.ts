/**
 * `iris drives` on Windows (#193360). Pure parsers plus the two commands that feed them, so the
 * tests run on any machine from captured output (drives-windows.fixture.json), the way macOS is
 * tested from drives-diskutil.fixture.plist.
 *
 * IDENTITY — the volume SERIAL NUMBER, as fs:XXXX-XXXX. It lives in the filesystem's boot sector,
 * so it does not change with the drive letter (E: today, F: tomorrow) or the PC, and Linux reads
 * the same number: lsblk prints a FAT/exFAT volume's UUID as exactly "XXXX-XXXX", so a drive
 * cataloged on Linux keeps its record. NTFS is the one twist: lsblk prints the full 64-bit serial
 * (16 hex digits) while Windows reports its low 32 bits — sameDriveId() treats those as one drive.
 * The volume GUID (\\?\Volume{…}) was rejected: Windows assigns it per PC for MBR disks (most
 * USB drives), so the same drive gets a new GUID on every PC, and no other OS can read it.
 *
 * ENCRYPTION — BitLocker, read WITHOUT administrator rights from the Explorer shell property
 * System.Volume.BitLockerProtection. Get-BitLockerVolume, manage-bde and WMI
 * Win32_EncryptableVolume all need an elevated terminal; manage-bde is tried second, for people
 * who do run elevated. If neither answers, encryption is UNKNOWN (null) — never "not encrypted".
 *
 * Nothing here has run on a real Windows PC yet; the captured outputs are realistic samples.
 */

export type WinDisk = {
  letter: string // "E"
  serial: string | null // "1A2B-3C4D"
  label: string | null
  filesystem: string | null
  bitlocker: boolean | null
}

/** "E:\", "E:", "e:/" or "E:\Projects\x" → "E". UNC paths and anything else → null. */
export function driveLetterOf(p: string): string | null {
  const m = /^([A-Za-z]):(?:[\\/]|$)/.exec(p)
  return m ? m[1].toUpperCase() : null
}

/** Is this path the ROOT of a drive letter (a mount), not a folder on it? */
export function isDriveRoot(p: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(p)
}

/**
 * The scan argument as the user meant it. In Command Prompt `"E:\"` arrives as `E:"` (backslash
 * before a quote escapes it), and `"D:\My Drive\"` as `D:\My Drive"`. A bare `E:` means "the
 * current folder on E:" to Windows, not the drive. Only applied on Windows.
 */
export function normalizeScanArg(raw: string, platform: string = process.platform): string {
  if (platform !== "win32") return raw
  let s = raw.trim().replace(/^"+/, "").replace(/"+$/, "")
  if (/^[A-Za-z]:[\\/]?$/.test(s)) s = `${s[0].toUpperCase()}:\\`
  return s
}

/** "1A2B3C4D" (Win32_LogicalDisk) or 439041101 (Win32_Volume, decimal) → "1A2B-3C4D". */
export function formatSerial(v: unknown): string | null {
  let hex: string
  if (typeof v === "number" && Number.isInteger(v) && v > 0) hex = (v >>> 0).toString(16)
  else if (typeof v === "string" && /^[0-9A-Fa-f]{1,8}$/.test(v.trim())) hex = v.trim()
  else if (typeof v === "string" && /^[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$/.test(v.trim())) hex = v.trim().replace("-", "")
  else return null
  hex = hex.toUpperCase().padStart(8, "0")
  return hex === "00000000" ? null : `${hex.slice(0, 4)}-${hex.slice(4)}`
}

/** `vol E:` → "1A2B-3C4D". The fallback when PowerShell is unavailable or blocked. */
export function parseVolOutput(out: string): string | null {
  const m = /Serial Number is ([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4})/.exec(out)
  return m ? m[1].toUpperCase() : null
}

/**
 * System.Volume.BitLockerProtection → encrypted? 1 = on, 6 = on and locked → true;
 * 2 = off, 5 = suspended (key stored in the clear, so anyone can read it) → false;
 * 3/4 (encrypting/decrypting: part of the drive is plain), 0, 8, empty → null (cannot tell).
 */
export function bitlockerFromShellProperty(v: unknown): boolean | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN
  if (n === 1 || n === 6) return true
  if (n === 2 || n === 5) return false
  return null
}

/** `manage-bde -status E:` (elevated only) → encrypted? An access-denied error → null. */
export function bitlockerFromManageBde(out: string): boolean | null {
  const prot = /Protection Status:\s*Protection (On|Off)/i.exec(out)?.[1]?.toLowerCase()
  const conv = /Conversion Status:\s*([^\r\n]+)/i.exec(out)?.[1]?.trim().toLowerCase() ?? ""
  if (prot === "on") return true
  if (prot === "off") {
    // Off + fully decrypted = plain drive. Off + still encrypted = suspended: readable by anyone.
    if (conv.startsWith("fully decrypted") || conv.startsWith("fully encrypted")) return false
    return null // mid-conversion
  }
  return null
}

/** One PowerShell call: the drive letter's serial, label, filesystem and BitLocker state as JSON. */
export function identifyScript(letter: string): string {
  const L = letter.toUpperCase()
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${L}:'"`,
    `$b=(New-Object -ComObject Shell.Application).NameSpace(17).ParseName('${L}:').ExtendedProperty('System.Volume.BitLockerProtection')`,
    "@{DeviceID=$d.DeviceID;VolumeSerialNumber=$d.VolumeSerialNumber;VolumeName=$d.VolumeName;FileSystem=$d.FileSystem;BitLockerProtection=$b}|ConvertTo-Json -Compress",
  ].join(";")
}

/** Every drive letter on this PC and its serial (resolveMount: which letter is that drive on now?). */
export const LIST_SCRIPT =
  "Get-CimInstance Win32_LogicalDisk|Select-Object DeviceID,VolumeSerialNumber,VolumeName,FileSystem|ConvertTo-Json -Compress"

function parseJson(out: string): any {
  try {
    return JSON.parse(out.trim())
  } catch {
    return null
  }
}

function diskFromRow(r: any): WinDisk | null {
  const letter = driveLetterOf(String(r?.DeviceID ?? ""))
  if (!letter) return null
  return {
    letter,
    serial: formatSerial(r?.VolumeSerialNumber),
    label: r?.VolumeName ? String(r.VolumeName) : null,
    filesystem: r?.FileSystem ? String(r.FileSystem).toLowerCase() : null,
    bitlocker: bitlockerFromShellProperty(r?.BitLockerProtection),
  }
}

/** ConvertTo-Json prints one object for one disk and an array for several. */
export function parseLogicalDisks(out: string): WinDisk[] {
  const j = parseJson(out)
  const rows = Array.isArray(j) ? j : j ? [j] : []
  return rows.map(diskFromRow).filter((d): d is WinDisk => d != null)
}

export type Run = (...cmdline: string[]) => string
const ps = (run: Run, script: string) => run("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)

/** Facts for the drive letter holding `p`. Every step degrades to null, never to a guess. */
export function windowsDisk(letter: string, run: Run): WinDisk {
  const d = parseLogicalDisks(ps(run, identifyScript(letter)))[0] ?? { letter, serial: null, label: null, filesystem: null, bitlocker: null }
  if (!d.serial) d.serial = parseVolOutput(run("cmd.exe", "/d", "/c", `vol ${letter}:`))
  if (d.bitlocker == null) d.bitlocker = bitlockerFromManageBde(run("manage-bde.exe", "-status", `${letter}:`))
  return d
}

/** "fs:1A2B-3C4D" → the drive letter root it is on right now ("F:\"), or null. */
export function windowsMountOf(driveId: string, run: Run): string | null {
  if (!serialKey(driveId)) return null
  const hit = parseLogicalDisks(ps(run, LIST_SCRIPT)).find((d) => d.serial && sameDriveId(`fs:${d.serial}`, driveId))
  return hit ? `${hit.letter}:\\` : null
}

/**
 * The low 32 bits of a volume serial id, uppercase: "fs:1A2B-3C4D" (Windows, or FAT/exFAT on
 * Linux) and "fs:5E0A9D7A1A2B3C4D" (NTFS on Linux, lsblk) both → "1A2B3C4D". Anything else → null.
 */
export function serialKey(driveId: string): string | null {
  const m = /^fs:(?:([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})|[0-9A-Fa-f]{8}([0-9A-Fa-f]{8}))$/.exec(driveId)
  if (!m) return null
  return (m[3] ?? m[1] + m[2]).toUpperCase()
}

/** Same drive? Equal ids, or the same volume serial written by two OSes (see serialKey). */
export function sameDriveId(a: string, b: string): boolean {
  if (a === b) return true
  const ka = serialKey(a)
  return ka != null && ka === serialKey(b)
}

/** The Atlas record for this drive: an exact id first, else one another OS wrote for the same serial. */
export function findDriveRecord<T extends { external_id?: unknown }>(records: T[], driveId: string): T | undefined {
  return (
    records.find((d) => d.external_id === driveId) ??
    records.find((d) => typeof d.external_id === "string" && sameDriveId(d.external_id, driveId))
  )
}

/** A drive record's `encrypted` as true / false / null (unknown, or never determined). */
export function encryptionState(v: unknown): boolean | null {
  if (v === true || v === 1 || v === "1" || v === "true") return true
  if (v === false || v === 0 || v === "0" || v === "false") return false
  return null
}

export function encryptionWord(v: unknown): string {
  const e = encryptionState(v)
  return e === true ? "encrypted" : e === false ? "NOT encrypted" : "encryption ?"
}

/** What to tell someone whose scan could not open some folders. */
export function unreadableHint(platform: string = process.platform): string {
  if (platform === "darwin")
    return "macOS refused access. The usual cause: the app running this command (Terminal, iTerm, VS Code or IRIS) does not have Full Disk Access.\n" +
      "     Open System Settings → Privacy & Security → Full Disk Access, switch it on for that app, quit and reopen the app, then scan again."
  if (platform === "win32")
    return "Windows refused access. Open the terminal with Run as administrator (right-click it in the Start menu) and scan again,\n" +
      "     or give your account Read access to those folders: right-click the folder → Properties → Security → Edit."
  return "re-run as a user that can read them (sudo for a drive formatted on a Mac)"
}

/**
 * Linux: where is a drive whose id a Windows PC wrote? `lsblk -rno UUID,MOUNTPOINT` prints an NTFS
 * volume's full 64-bit serial, so "fs:1A2B-3C4D" is found by its low 32 bits. Raw mode escapes
 * spaces in the mount point as \x20.
 */
export function lsblkMountsFor(driveId: string, lsblkOut: string): string[] {
  const out: string[] = []
  for (const line of lsblkOut.split("\n")) {
    const [uuid, mount] = line.trim().split(/\s+/, 2)
    if (uuid && mount && sameDriveId(`fs:${uuid}`, driveId))
      out.push(mount.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))))
  }
  return out
}
