/**
 * `iris pages install <slug>` — an IRIS app in the Start menu, Dock or launcher, with ITS icon,
 * opening in its own window (#194356, epic #194350).
 *
 * Kristen's dashboard (#189085) sat on her Windows desktop as a .bat with the console icon. A
 * browser install works where the browser offers it; this is the same result from one command,
 * on every OS, for the cloud copy or the one served on this computer:
 *
 *   Windows  %APPDATA%\Microsoft\Windows\Start Menu\Programs\IRIS Apps\<Name>.lnk
 *            → Edge in app mode (Edge ships with Windows 10/11), icon: a real multi-size .ico
 *   macOS    ~/Applications/IRIS Apps/<Name>.app  (Chrome/Edge app mode, else the default browser)
 *   Linux    ~/.local/share/applications/iris-app-<slug>.desktop
 *
 * Icons are drawn by IRIS at each size (16/32/48/256 for Windows, 512 for macOS) — never a large
 * tile scaled down to 16 px. Everything that decides WHAT to write is pure and tested on any OS.
 */
import path from "path"

export interface IconPng {
  size: number
  data: Buffer
}

/** A Windows .ico holding PNG images (supported since Vista). Sizes ≥ 256 are written as 0. */
export function buildIco(images: IconPng[]): Buffer {
  const imgs = [...images].sort((a, b) => a.size - b.size)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // icon
  header.writeUInt16LE(imgs.length, 4)
  const dir = Buffer.alloc(16 * imgs.length)
  let offset = 6 + dir.length
  imgs.forEach((img, i) => {
    const o = i * 16
    const dim = img.size >= 256 ? 0 : img.size
    dir.writeUInt8(dim, o)
    dir.writeUInt8(dim, o + 1)
    dir.writeUInt8(0, o + 2) // no palette
    dir.writeUInt8(0, o + 3)
    dir.writeUInt16LE(1, o + 4) // planes
    dir.writeUInt16LE(32, o + 6) // bits per pixel
    dir.writeUInt32LE(img.data.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += img.data.length
  })
  return Buffer.concat([header, dir, ...imgs.map((i) => i.data)])
}

/** A macOS .icns with PNG entries: ic09 = 512, ic08 = 256, ic07 = 128, icp5 = 32, icp4 = 16. */
export function buildIcns(images: IconPng[]): Buffer {
  const TYPE: Record<number, string> = { 512: "ic09", 256: "ic08", 128: "ic07", 32: "icp5", 16: "icp4" }
  const entries = images
    .filter((i) => TYPE[i.size])
    .map((i) => {
      const h = Buffer.alloc(8)
      h.write(TYPE[i.size]!, 0, "ascii")
      h.writeUInt32BE(8 + i.data.length, 4)
      return Buffer.concat([h, i.data])
    })
  const body = Buffer.concat(entries)
  const head = Buffer.alloc(8)
  head.write("icns", 0, "ascii")
  head.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([head, body])
}

/** A file name every OS accepts: no path separators or reserved characters, ≤ 60 chars. */
export function safeName(name: string): string {
  const s = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60)
  return s && !/^\.+$/.test(s) ? s : "IRIS App"
}

const psQuote = (s: string) => "'" + s.replace(/'/g, "''") + "'"

/**
 * PowerShell that writes the Start-menu shortcut. Edge in app mode gives the app its own window
 * and taskbar icon; if Edge is not where Windows registers it, the shortcut opens the address in
 * the default browser instead — still with the app's icon.
 */
export function windowsShortcutScript(opts: { lnk: string; ico: string; url: string; name: string }): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$lnk = ${psQuote(opts.lnk)}`,
    "New-Item -ItemType Directory -Force -Path (Split-Path $lnk) | Out-Null",
    "$edge = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe' -ErrorAction SilentlyContinue).'(default)'",
    "if (-not $edge) { $edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\\Edge\\Application\\msedge.exe' }",
    "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)",
    `if (Test-Path $edge) { $s.TargetPath = $edge; $s.Arguments = ${psQuote(`--app=${opts.url}`)} } else { $s.TargetPath = ${psQuote(opts.url)} }`,
    `$s.IconLocation = ${psQuote(opts.ico + ",0")}`,
    `$s.Description = ${psQuote(opts.name)}`,
    "$s.Save()",
  ].join("\r\n")
}

/** The files of a macOS app shim. `launch` opens the app in Chrome/Edge app mode, else the default browser. */
export function macAppFiles(opts: { name: string; url: string; slug: string }): Record<string, { data: string | Buffer; mode?: number }> {
  const sh = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
  const launch = [
    "#!/bin/sh",
    `URL=${sh(opts.url)}`,
    'for APP in "Google Chrome" "Microsoft Edge" "Chromium" "Brave Browser"; do',
    '  if open -Ra "$APP" 2>/dev/null; then exec open -na "$APP" --args --app="$URL"; fi',
    "done",
    'exec open "$URL"',
    "",
  ].join("\n")
  const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>${xml(opts.name)}</string>
  <key>CFBundleDisplayName</key><string>${xml(opts.name)}</string>
  <key>CFBundleIdentifier</key><string>io.heyiris.app.${xml(opts.slug)}</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>app.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><false/>
</dict></plist>
`
  return {
    "Contents/Info.plist": { data: plist },
    "Contents/MacOS/launch": { data: launch, mode: 0o755 },
  }
}

/** A freedesktop launcher entry. Field values cannot carry a newline (it would start a new key). */
export function linuxDesktopEntry(opts: { name: string; url: string; icon: string; slug: string }): string {
  const one = (s: string) => s.replace(/[\r\n]+/g, " ")
  // Desktop-entry quoting: backslash-escape " ` $ \ inside a quoted argument, and double every %.
  const q = (s: string) => '"' + s.replace(/(["`$\\])/g, "\\$1").replace(/%/g, "%%") + '"'
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${one(opts.name)}`,
    `Exec=sh -c ${q(`for b in google-chrome chromium chromium-browser microsoft-edge brave-browser; do command -v $b >/dev/null && exec $b --app=${opts.url}; done; exec xdg-open ${opts.url}`)}`,
    `Icon=${one(opts.icon)}`,
    `StartupWMClass=iris-app-${opts.slug}`,
    "Terminal=false",
    "Categories=Office;",
    "",
  ].join("\n")
}

/** Where each OS keeps the shortcut. */
export function shortcutPaths(platform: string, home: string, name: string, slug: string, appData?: string) {
  const n = safeName(name)
  if (platform === "win32") {
    const programs = path.win32.join(appData ?? path.win32.join(home, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "IRIS Apps")
    return { shortcut: path.win32.join(programs, `${n}.lnk`), icon: path.win32.join(home, ".iris", "apps", slug, "app.ico") }
  }
  if (platform === "darwin") return { shortcut: path.posix.join(home, "Applications", "IRIS Apps", `${n}.app`), icon: "" }
  return {
    shortcut: path.posix.join(home, ".local", "share", "applications", `iris-app-${slug}.desktop`),
    icon: path.posix.join(home, ".iris", "apps", slug, "icon-256.png"),
  }
}
