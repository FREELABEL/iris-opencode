import { describe, test, expect } from "bun:test"
import * as Permissions from "../src/cli/lib/permissions"

/**
 * macOS permission detection (#178283).
 *
 * The deep links are the part that genuinely did not exist anywhere in the repo
 * before this — `x-apple.systempreferences` appeared zero times. A typo in one
 * of these opens nothing at all and fails silently, which is exactly the kind of
 * bug that survives review, so they are asserted literally.
 */

describe("permission panes", () => {
  test("every permission has a deep link into the right Privacy pane", () => {
    const expected: Record<Permissions.PermissionId, string> = {
      "full-disk-access": "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
      contacts: "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts",
      automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
    }

    for (const id of Permissions.ALL) {
      expect(Permissions.check(id).settingsUrl).toBe(expected[id])
    }
  })

  test("covers the three permissions the platform actually needs", () => {
    expect(Permissions.ALL).toEqual(["full-disk-access", "contacts", "automation"])
  })

  test("every check reports what it unlocks — a bare denial is not actionable", () => {
    for (const c of Permissions.checkAll()) {
      expect(c.name.length).toBeGreaterThan(0)
      expect(c.unlocks.length).toBeGreaterThan(0)
      expect(typeof c.granted).toBe("boolean")
      expect(c.settingsUrl).toStartWith("x-apple.systempreferences:")
    }
  })

  test("checkAll returns one result per declared permission", () => {
    const ids = Permissions.checkAll().map((c) => c.id)
    expect(ids.sort()).toEqual([...Permissions.ALL].sort())
  })
})

describe("host app resolution", () => {
  test("names a real app — macOS lists the terminal, never 'iris'", () => {
    const app = Permissions.hostApp()
    expect(typeof app).toBe("string")
    expect(app.length).toBeGreaterThan(0)
    // Ticking "iris" in System Settings does nothing; the whole point is to name
    // the host process instead.
    expect(app.toLowerCase()).not.toBe("iris")
  })
})

describe("platform gating", () => {
  test("isSupported tracks the platform, not a guess", () => {
    expect(Permissions.isSupported()).toBe(process.platform === "darwin")
  })

  test("openSettings is a no-op off macOS rather than throwing", () => {
    if (process.platform === "darwin") return // would actually open System Settings
    expect(Permissions.openSettings("full-disk-access")).toBe(false)
  })
})

describe("detection is a real probe", () => {
  test("a denied or missing database reports a reason, not a bare false", () => {
    // Every check must either succeed or explain itself — "not granted" with no
    // detail is what sent the reporter to System Settings guessing.
    for (const c of Permissions.checkAll()) {
      if (!c.granted) {
        expect(c.detail).toBeDefined()
        expect((c.detail ?? "").length).toBeGreaterThan(0)
      }
    }
  })

  test("never throws, whatever the machine's state", () => {
    expect(() => Permissions.checkAll()).not.toThrow()
    for (const id of Permissions.ALL) {
      expect(() => Permissions.check(id)).not.toThrow()
    }
  })
})
