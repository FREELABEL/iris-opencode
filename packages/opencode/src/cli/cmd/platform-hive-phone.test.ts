import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_PHONE_PORT,
  chooseTunnelName,
  desktopEngineRunning,
  phoneOnRefusal,
  phoneSettingsPath,
  phoneTunnelName,
  readPhoneSettings,
  remoteAccessAllowed,
  settingsAfterTunnel,
  settingsForOff,
  settingsForOn,
  writePhoneSettings,
} from "./platform-hive-phone"
import { validTunnelName } from "./platform-hive-relay"

// #194511 — `iris hive phone on|off|status`.

/**
 * The daemon's readers, COPIED verbatim (JS → TS types only) from FREELABEL/iris-daemon#120 at
 * c7c9ca9: daemon/phone-endpoint.js `readSettings` and the settings half of
 * daemon/tunnel-keepalive.js `decideTunnelRestart` + `tick` (what it reads to restart a tunnel).
 * If the daemon changes the shape it reads, change these copies and this test says what broke.
 */
const DAEMON_DEFAULTS = { enabled: false, port: 3291, url: null as string | null }
function daemonReadSettings(home: string): any {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, ".iris", "phone.json"), "utf8"))
    const s = { ...DAEMON_DEFAULTS, ...raw }
    s.enabled = raw.enabled === true
    s.port = Number.isInteger(s.port) && s.port > 1024 && s.port < 65536 ? s.port : DAEMON_DEFAULTS.port
    s.url = typeof s.url === "string" && /^https:\/\//.test(s.url) ? s.url.replace(/\/+$/, "") : null
    return s
  } catch {
    return { ...DAEMON_DEFAULTS }
  }
}
function daemonWouldRestart(settings: any): { restart: boolean; name?: string; node?: string; runner?: string; port?: number; zones?: string[] } {
  const tunnel = settings && settings.tunnel
  if (!settings || settings.enabled !== true) return { restart: false }
  if (!tunnel || typeof tunnel.name !== "string" || !tunnel.name) return { restart: false }
  return { restart: true, name: tunnel.name, node: settings.node, runner: tunnel.runner, port: settings.port, zones: tunnel.zones }
}

const tmpHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hp-"))
  fs.mkdirSync(path.join(home, ".iris"), { recursive: true })
  return home
}
const opened = {
  url: "https://iris-hive-002-phone.t.heyiris.io",
  node: "/Users/x/.iris/node20/bin/node",
  name: "iris-hive-002-phone",
  runner: "/Users/x/.iris/bridge/relay/tunnel.js",
  zones: ["t.heyiris.io"],
}

describe("iris hive phone", () => {
  describe("~/.iris/phone.json round-trips with the daemon's reader", () => {
    test("missing = off on port 3291, for both", () => {
      const home = tmpHome()
      expect(readPhoneSettings(home)).toEqual({ enabled: false, port: DEFAULT_PHONE_PORT, url: null })
      expect(daemonReadSettings(home)).toEqual({ enabled: false, port: 3291, url: null })
    })

    test("on: the daemon serves the port, reports the URL, and restarts the recorded tunnel", () => {
      const home = tmpHome()
      // step 1 — endpoint on, no tunnel record: the daemon serves but does not start a tunnel
      writePhoneSettings(settingsForOn(readPhoneSettings(home), 3291), home)
      expect(daemonReadSettings(home)).toMatchObject({ enabled: true, port: 3291, url: null })
      expect(daemonWouldRestart(daemonReadSettings(home)).restart).toBe(false)
      // step 2 — tunnel open and recorded
      writePhoneSettings(settingsAfterTunnel(readPhoneSettings(home), opened), home)
      const d = daemonReadSettings(home)
      expect(d).toEqual({
        enabled: true,
        port: 3291,
        url: opened.url,
        node: opened.node,
        tunnel: { name: opened.name, runner: opened.runner, zones: opened.zones },
      })
      // what the platform checks (fl-iris-api#471): phone.url is https://<name>.t.heyiris.io for the held name
      expect(d.url).toBe(`https://${d.tunnel.name}.t.heyiris.io`)
      expect(daemonWouldRestart(d)).toEqual({ restart: true, name: opened.name, node: opened.node, runner: opened.runner, port: 3291, zones: opened.zones })
      expect(readPhoneSettings(home)).toEqual(d)
      expect(fs.statSync(phoneSettingsPath(home)).mode & 0o777).toBe(0o600)
    })

    test("off: the daemon stops serving and restarting, the name is kept for the next on", () => {
      const home = tmpHome()
      writePhoneSettings(settingsAfterTunnel(settingsForOn(readPhoneSettings(home), 3291), opened), home)
      writePhoneSettings(settingsForOff(readPhoneSettings(home)), home)
      const d = daemonReadSettings(home)
      expect(d.enabled).toBe(false)
      expect(daemonWouldRestart(d).restart).toBe(false)
      expect(d.tunnel.name).toBe(opened.name)
      expect(chooseTunnelName({ settings: readPhoneSettings(home), nodeName: "something-else" })).toBe(opened.name)
    })

    test("on a non-default port, both read the same port", () => {
      const home = tmpHome()
      writePhoneSettings(settingsForOn(readPhoneSettings(home), 4555), home)
      expect(daemonReadSettings(home).port).toBe(4555)
      expect(readPhoneSettings(home).port).toBe(4555)
    })

    test("a file the daemon would correct reads the same corrected way here", () => {
      const home = tmpHome()
      for (const raw of [{ enabled: "true", port: 80, url: "http://x" }, { enabled: true, port: 3291.5, url: "https://a.t.heyiris.io//" }, "not json"]) {
        fs.writeFileSync(phoneSettingsPath(home), typeof raw === "string" ? raw : JSON.stringify(raw))
        expect(readPhoneSettings(home)).toEqual(daemonReadSettings(home))
      }
    })
  })

  describe("refuses to turn on", () => {
    test('when "Allow access to this computer" is off', () => {
      const home = tmpHome()
      expect(remoteAccessAllowed(home)).toBe(true) // absent = on, as the daemon reads it
      fs.writeFileSync(path.join(home, ".iris", "remote-access.json"), JSON.stringify({ allow: false }))
      expect(remoteAccessAllowed(home)).toBe(false)
      const why = phoneOnRefusal({ remoteAccess: remoteAccessAllowed(home), daemonRunning: true })
      expect(why).toContain("Allow access to this computer")
      // the switch wins even when the daemon is down too
      expect(phoneOnRefusal({ remoteAccess: false, daemonRunning: false })).toContain("Allow access to this computer")
      fs.writeFileSync(path.join(home, ".iris", "remote-access.json"), "{bad")
      expect(remoteAccessAllowed(home)).toBe(true)
    })

    test("when the daemon is not running", () => {
      expect(phoneOnRefusal({ remoteAccess: true, daemonRunning: false })).toContain("daemon is not running")
      expect(phoneOnRefusal({ remoteAccess: true, daemonRunning: true })).toBeNull()
    })
  })

  test("the tunnel name: --name, else the held one, else <node>-phone, always a valid relay label", () => {
    for (const h of ["iris-hive-002", "Alexs-MacBook-Pro.local", "MY_BOX", "x".repeat(80), "---", ""]) {
      const n = phoneTunnelName(h)
      expect(validTunnelName(n)).toBe(true)
      expect(n.endsWith("-phone")).toBe(true)
    }
    expect(phoneTunnelName("iris-hive-002")).toBe("iris-hive-002-phone")
    const none = { enabled: false, port: 3291, url: null }
    expect(chooseTunnelName({ settings: none, nodeName: "iris-hive-002" })).toBe("iris-hive-002-phone")
    expect(chooseTunnelName({ flag: "My-Phone", settings: { ...none, tunnel: { name: "held", runner: "", zones: [] } }, nodeName: "n" })).toBe("my-phone")
  })

  test("IRIS Desktop is running only with a usable engine record and a live pid", () => {
    const home = tmpHome()
    const file = path.join(home, ".iris", "desktop-engine.json")
    expect(desktopEngineRunning(home)).toBe(false)
    fs.writeFileSync(file, JSON.stringify({ version: 1, port: 49244, username: "opencode", password: "p", pid: 123 }))
    expect(desktopEngineRunning(home, () => true)).toBe(true)
    expect(desktopEngineRunning(home, () => false)).toBe(false)
    fs.writeFileSync(file, JSON.stringify([{ port: 1, password: "" }, { port: 49244, password: "p" }]))
    expect(desktopEngineRunning(home, () => false)).toBe(true)
  })
})
