import { describe, expect, test } from "bun:test"
import { buildIcns, buildIco, linuxDesktopEntry, macAppFiles, safeName, shortcutPaths, windowsShortcutScript } from "./shortcut"

/**
 * #194356 — an IRIS app in the Start menu / Dock / launcher with its own icon. Kristen's console
 * sat on her desktop as a .bat with the console icon; these pin what replaces it.
 */
const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(n, n % 255)])

describe("the Windows icon", () => {
  test("is a real .ico: one entry per size, 256 written as 0, offsets pointing at each PNG", () => {
    const imgs = [256, 16, 48, 32].map((size) => ({ size, data: png(size) }))
    const ico = buildIco(imgs)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(4)
    const entries = [0, 1, 2, 3].map((i) => {
      const o = 6 + i * 16
      return { w: ico.readUInt8(o), len: ico.readUInt32LE(o + 8), off: ico.readUInt32LE(o + 12) }
    })
    expect(entries.map((e) => e.w)).toEqual([16, 32, 48, 0])
    for (const [i, e] of entries.entries()) {
      const size = [16, 32, 48, 256][i]!
      expect(ico.subarray(e.off, e.off + e.len).equals(png(size))).toBe(true)
    }
    expect(entries.at(-1)!.off + entries.at(-1)!.len).toBe(ico.length)
  })
})

describe("the Mac icon and app", () => {
  test("is a real .icns with the sizes macOS reads", () => {
    const icns = buildIcns([512, 256, 32, 16, 48].map((size) => ({ size, data: png(size) })))
    expect(icns.subarray(0, 4).toString("ascii")).toBe("icns")
    expect(icns.readUInt32BE(4)).toBe(icns.length)
    const types: string[] = []
    for (let o = 8; o < icns.length; o += icns.readUInt32BE(o + 4)) types.push(icns.subarray(o, o + 4).toString("ascii"))
    expect(types).toEqual(["ic09", "ic08", "icp5", "icp4"]) // 48 has no PNG type: skipped, not mislabelled
  })

  test("the app opens the page in its own window, and a hostile name cannot break the script or plist", () => {
    const f = macAppFiles({ name: 'Q3 <b>&</b>', url: "https://heyiris.io/p/x?source=pwa'; rm -rf ~; '", slug: "x" })
    const launch = String(f["Contents/MacOS/launch"]!.data)
    expect(f["Contents/MacOS/launch"]!.mode).toBe(0o755)
    expect(launch).toContain('--app="$URL"')
    expect(launch).toContain(`URL='https://heyiris.io/p/x?source=pwa'\\''; rm -rf ~; '\\'''`)
    const plist = String(f["Contents/Info.plist"]!.data)
    expect(plist).toContain("<string>Q3 &lt;b&gt;&amp;&lt;/b&gt;</string>")
    expect(plist).toContain("<string>app.icns</string>")
  })
})

describe("the Windows shortcut", () => {
  test("opens in Edge app mode with the .ico, and quotes survive", () => {
    const s = windowsShortcutScript({ lnk: "C:\\Users\\k\\Start\\It's mine.lnk", ico: "C:\\Users\\k\\.iris\\apps\\x\\app.ico", url: "https://heyiris.io/p/x?source=pwa", name: "Kristen's Console" })
    expect(s).toContain("$lnk = 'C:\\Users\\k\\Start\\It''s mine.lnk'")
    expect(s).toContain("$s.Arguments = '--app=https://heyiris.io/p/x?source=pwa'")
    expect(s).toContain("$s.IconLocation = 'C:\\Users\\k\\.iris\\apps\\x\\app.ico,0'")
    expect(s).toContain("$s.Description = 'Kristen''s Console'")
    expect(s).not.toContain("cmd.exe")
  })

  test("goes in the Start menu under IRIS Apps, with a name Windows accepts", () => {
    const p = shortcutPaths("win32", "C:\\Users\\k", 'My: "Console"?', "my-console", "C:\\Users\\k\\AppData\\Roaming")
    expect(p.shortcut).toBe("C:\\Users\\k\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\IRIS Apps\\My Console.lnk")
    expect(p.icon).toBe("C:\\Users\\k\\.iris\\apps\\my-console\\app.ico")
    expect(safeName("..")).toBe("IRIS App")
    expect(safeName("a/b\\c")).toBe("a b c")
  })
})

describe("the Linux launcher", () => {
  test("a name cannot add a key, and the command is escaped the way the spec says", () => {
    const e = linuxDesktopEntry({ name: "X\nExec=rm -rf ~", url: "https://heyiris.io/p/x?a=1%20", icon: "/h/.iris/apps/x/icon-256.png", slug: "x" })
    expect(e.split("\n").filter((l) => l.startsWith("Exec=")).length).toBe(1)
    expect(e).toContain("Name=X Exec=rm -rf ~")
    expect(e).toContain("%%20")
    expect(e).toContain("\\$b --app=")
    expect(e).toContain("Terminal=false")
  })
})
