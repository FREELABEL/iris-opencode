import { describe, test, expect } from "bun:test"
import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import {
  normalizeScanArg, driveLetterOf, isDriveRoot, formatSerial, parseVolOutput, bitlockerFromShellProperty,
  bitlockerFromManageBde, parseLogicalDisks, windowsDisk, windowsMountOf, serialKey, sameDriveId, findDriveRecord,
  encryptionState, encryptionWord, unreadableHint, lsblkMountsFor, type Run,
} from "./drives-windows"
import { Rollup } from "./drives-core"
import { scanSummary } from "./platform-drives"

/**
 * #193360 — `iris drives` on Windows, tested from captured command output (drives-windows.fixture.json),
 * the way macOS is tested from drives-diskutil.fixture.plist. The samples are hand-written in the
 * shapes Windows prints; none was recorded on a real PC.
 */
const FX: Record<string, string> = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "drives-windows.fixture.json"), "utf8"))

/** A fake Windows: PowerShell answers from `ps`, `vol` and `manage-bde` from the other two. Logs every call. */
function fakeWindows(o: { ps?: string; vol?: string; bde?: string }) {
  const calls: string[][] = []
  const run: Run = (...cmd) => {
    calls.push(cmd)
    if (cmd[0] === "powershell.exe") return o.ps ?? ""
    if (cmd[0] === "cmd.exe") return o.vol ?? ""
    if (cmd[0] === "manage-bde.exe") return o.bde ?? ""
    return ""
  }
  return { run, calls }
}

describe("BitLocker (#193360 gap 1): on / off / unknown, never 'not encrypted' on a guess", () => {
  test("on: the shell property says 1 — no admin needed, manage-bde never run", () => {
    const w = fakeWindows({ ps: FX.identify_E_bitlocker_on })
    expect(windowsDisk("E", w.run)).toEqual({ letter: "E", serial: "1A2B-3C4D", label: "Footage", filesystem: "exfat", bitlocker: true })
    expect(w.calls.map((c) => c[0])).toEqual(["powershell.exe"])
  })

  test("off: the shell property says 2", () => {
    expect(windowsDisk("F", fakeWindows({ ps: FX.identify_F_bitlocker_off }).run).bitlocker).toBe(false)
  })

  test("unknown: no shell answer and manage-bde refused (not elevated) → null, not false", () => {
    const w = fakeWindows({ ps: FX.identify_G_no_answer, bde: FX.manage_bde_not_admin })
    expect(windowsDisk("G", w.run).bitlocker).toBeNull()
    expect(w.calls.find((c) => c[0] === "manage-bde.exe")).toEqual(["manage-bde.exe", "-status", "G:"])
  })

  test("unknown: PowerShell missing entirely, manage-bde silent → serial from `vol`, encryption null", () => {
    expect(windowsDisk("E", fakeWindows({ vol: FX.vol_E }).run)).toEqual({ letter: "E", serial: "1A2B-3C4D", label: null, filesystem: null, bitlocker: null })
  })

  test("an elevated terminal: manage-bde answers when the shell property cannot", () => {
    expect(windowsDisk("G", fakeWindows({ ps: FX.identify_G_no_answer, bde: FX.manage_bde_on }).run).bitlocker).toBe(true)
  })

  test("manage-bde -status: on, off, suspended, access denied", () => {
    expect(bitlockerFromManageBde(FX.manage_bde_on)).toBe(true)
    expect(bitlockerFromManageBde(FX.manage_bde_off)).toBe(false)
    expect(bitlockerFromManageBde(FX.manage_bde_suspended)).toBe(false) // key in the clear: anyone can read it
    expect(bitlockerFromManageBde(FX.manage_bde_not_admin)).toBeNull()
    expect(bitlockerFromManageBde("")).toBeNull()
  })

  test("System.Volume.BitLockerProtection values", () => {
    expect([1, 6, "1"].map(bitlockerFromShellProperty)).toEqual([true, true, true])
    expect([2, 5].map(bitlockerFromShellProperty)).toEqual([false, false])
    expect([0, 3, 4, 8, null, undefined, ""].map(bitlockerFromShellProperty)).toEqual([null, null, null, null, null, null, null])
  })

  test("unknown flows through: findings get no status (not 'exposed'), the summary and list say so", () => {
    const r = new Rollup(2)
    r.add({ rel: "Site/.env", bytes: 10, mtime: 0, kind: "credential" } as any)
    expect(r.findingRows("fs:5C3E-91AF", "SanDisk", null, "2026-11-13")[0]).toMatchObject({ status: null, drive_encrypted: null })
    expect(r.findingRows("fs:5C3E-91AF", "SanDisk", true, "2026-11-13")[0].status).toBe("contained")
    expect(r.findingRows("fs:5C3E-91AF", "SanDisk", false, "2026-11-13")[0].status).toBe("exposed")
    expect(scanSummary({ label: "SanDisk", files: 1, bytes: 10, folders: 1, sensitive: 1, encrypted: null })).toContain(
      "(could not tell whether the drive is encrypted — run: iris drives list to review)",
    )
    expect([true, "1", false, "0", null, "", undefined].map(encryptionWord)).toEqual([
      "encrypted", "encrypted", "NOT encrypted", "NOT encrypted", "encryption ?", "encryption ?", "encryption ?",
    ])
    expect(encryptionState(0)).toBe(false)
  })
})

describe("identity (#193360 gap 2): the volume serial, not PC + letter", () => {
  test("E: today and F: tomorrow are the same drive id", () => {
    const e = windowsDisk("E", fakeWindows({ ps: FX.identify_E_bitlocker_on }).run)
    const f = windowsDisk("F", fakeWindows({ ps: FX.identify_F_same_drive_as_E }).run)
    expect(`fs:${e.serial}`).toBe("fs:1A2B-3C4D")
    expect(`fs:${f.serial}`).toBe(`fs:${e.serial}`)
  })

  test("path/get find it under its new letter", () => {
    const w = fakeWindows({ ps: FX.list_after_letter_change })
    expect(windowsMountOf("fs:1A2B-3C4D", w.run)).toBe("F:\\")
    expect(windowsMountOf("fs:FFFF-0000", w.run)).toBeNull()
    expect(windowsMountOf("fs:7a1c3e55-9b2d-4f60-8e41-2d7c5b9a0f13", w.run)).toBeNull() // a Mac APFS drive: not on Windows
    expect(parseLogicalDisks(FX.list_one_disk).map((d) => d.letter)).toEqual(["C"]) // one disk = one object, not an array
  })

  test("a FAT/exFAT drive cataloged on Linux keeps its record: lsblk prints the same XXXX-XXXX", () => {
    const records = [{ external_id: "fs:1A2B-3C4D", label: "Footage" }, { external_id: "fs:7a1c3e55-9b2d-4f60-8e41-2d7c5b9a0f13" }]
    expect(findDriveRecord(records, "fs:1A2B-3C4D")).toBe(records[0])
  })

  test("an NTFS drive cataloged on Linux (64-bit serial) is the same drive as Windows' 32-bit serial", () => {
    const linux = { external_id: "fs:5E0A9D7A0A9D4FBB", label: "BACKUP" }
    const f = windowsDisk("F", fakeWindows({ ps: FX.identify_F_bitlocker_off }).run)
    expect(findDriveRecord([{ external_id: "dir:STUDIO-PC:F:\\" }, linux], `fs:${f.serial}`)).toBe(linux)
    expect(sameDriveId("fs:0a9d-4fbb", "fs:5E0A9D7A0A9D4FBB")).toBe(true)
    // ...and back on Linux, a Windows-written id is found by its low 32 bits; \x20 is a space
    expect(lsblkMountsFor("fs:0A9D-4FBB", FX.lsblk_linux_ntfs)).toEqual(["/media/alex/BACKUP DRIVE"])
    expect(lsblkMountsFor("fs:1A2B-3C4D", FX.lsblk_linux_ntfs)).toEqual(["/media/alex/Footage"])
  })

  test("an exact id always wins; Mac UUIDs, ext4 UUIDs and folders never alias", () => {
    const exact = { external_id: "fs:0A9D-4FBB" }
    expect(findDriveRecord([{ external_id: "fs:5E0A9D7A0A9D4FBB" }, exact], "fs:0A9D-4FBB")).toBe(exact)
    expect(serialKey("fs:7a1c3e55-9b2d-4f60-8e41-2d7c5b9a0f13")).toBeNull()
    expect(serialKey("dir:host:E:\\")).toBeNull()
    expect(sameDriveId("fs:1A2B-3C4D", "fs:1A2B-3C4E")).toBe(false)
    expect(sameDriveId("dir:a:/x", "dir:a:/x")).toBe(true)
  })

  test("serial formats", () => {
    expect(formatSerial("1A2B3C4D")).toBe("1A2B-3C4D")
    expect(formatSerial("a9d4fbb")).toBe("0A9D-4FBB")
    expect(formatSerial(439041101)).toBe("1A2B-3C4D") // Win32_Volume prints it as a decimal
    expect([null, "", "00000000", "xyz", 0].map(formatSerial)).toEqual([null, null, null, null, null])
    expect(parseVolOutput(FX.vol_E)).toBe("1A2B-3C4D")
  })

  test("drive roots vs folders", () => {
    expect(["E:\\", "E:", "e:/"].map(isDriveRoot)).toEqual([true, true, true])
    expect(["E:\\Projects", "\\\\nas\\share", "/Volumes/X"].map(isDriveRoot)).toEqual([false, false, false])
    expect(driveLetterOf("e:\\Projects\\x")).toBe("E")
    expect(driveLetterOf("\\\\nas\\share")).toBeNull()
  })
})

describe('the scan argument (#193360 gap 3): Command Prompt turns "E:\\" into E:"', () => {
  test("normalised on Windows", () => {
    expect(normalizeScanArg('E:"', "win32")).toBe("E:\\")
    expect(normalizeScanArg("e:", "win32")).toBe("E:\\") // bare E: = the current folder on E:, not the drive
    expect(normalizeScanArg("E:/", "win32")).toBe("E:\\")
    expect(normalizeScanArg('"E:\\"', "win32")).toBe("E:\\") // PowerShell passes it intact
    expect(normalizeScanArg('D:\\My Drive"', "win32")).toBe("D:\\My Drive")
    expect(normalizeScanArg("D:\\Footage\\Shoot 12", "win32")).toBe("D:\\Footage\\Shoot 12")
  })

  test("left alone elsewhere", () => {
    expect(normalizeScanArg('/Volumes/odd"name', "darwin")).toBe('/Volumes/odd"name')
    expect(normalizeScanArg("E:", "linux")).toBe("E:")
  })

  test("help shows the example without quotes", () => {
    const entry = path.join(import.meta.dir, "..", "..", "index.ts")
    for (const args of [["drives", "scan", "--help"], ["drives", "--help"]]) {
      const r = spawnSync(process.execPath, ["run", entry, ...args], { encoding: "utf8", timeout: 120_000, env: { ...process.env, NO_COLOR: "1" } })
      const out = `${r.stdout}\n${r.stderr}`
      expect(out).toContain("drives scan E:\\ ")
      expect(out).not.toContain('"E:\\"')
    }
  }, 120_000)
})

describe("unreadable folders (#193360 gap 4): Windows advice, not sudo", () => {
  test("win32", () => {
    const h = unreadableHint("win32")
    expect(h).not.toMatch(/sudo/)
    expect(h).toContain("Run as administrator")
    expect(h).toContain("Properties → Security")
  })
  test("macOS and Linux unchanged", () => {
    expect(unreadableHint("darwin")).toContain("Full Disk Access")
    expect(unreadableHint("linux")).toContain("sudo")
  })
})
