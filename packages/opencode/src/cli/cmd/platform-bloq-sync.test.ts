import { test, expect } from "bun:test"
import { normalizeProvider, formatProviderConfig, CANONICAL_PROVIDERS } from "./platform-bloq-sync"

// ---------------------------------------------------------------------------
// normalizeProvider — the 422-avoidance guard
// ---------------------------------------------------------------------------

test("normalizeProvider: canonical ids pass through", () => {
  expect(normalizeProvider("google-drive")).toBe("google-drive")
  expect(normalizeProvider("dropbox")).toBe("dropbox")
})

test("normalizeProvider: friendly aliases map to canonical", () => {
  expect(normalizeProvider("gdrive")).toBe("google-drive")
  expect(normalizeProvider("drive")).toBe("google-drive")
  expect(normalizeProvider("google")).toBe("google-drive")
  expect(normalizeProvider("google_drive")).toBe("google-drive") // underscore → hyphen
  expect(normalizeProvider("GoogleDrive")).toBe("google-drive")
  expect(normalizeProvider("DB")).toBe("dropbox")
  expect(normalizeProvider(" Dropbox ")).toBe("dropbox")
})

test("normalizeProvider: unknown / empty → null (caller fails loudly, no 422)", () => {
  expect(normalizeProvider("onedrive")).toBeNull()
  expect(normalizeProvider("")).toBeNull()
  expect(normalizeProvider(undefined)).toBeNull()
})

test("normalizeProvider: 'all' only when allowAll is set (trigger)", () => {
  expect(normalizeProvider("all")).toBeNull()
  expect(normalizeProvider("all", true)).toBe("all")
  expect(normalizeProvider("dropbox", true)).toBe("dropbox")
})

test("CANONICAL_PROVIDERS matches the BloqSyncController validation set", () => {
  expect([...CANONICAL_PROVIDERS]).toEqual(["google-drive", "dropbox"])
})

// ---------------------------------------------------------------------------
// formatProviderConfig — display only; assert it surfaces the key facts
// ---------------------------------------------------------------------------

test("formatProviderConfig: shows folder name, auto-sync state, last export", () => {
  const out = formatProviderConfig("dropbox", {
    folder_name: "#42 - Acme",
    auto_sync: true,
    last_exported_at: "2026-06-29T10:00:00Z",
  })
  expect(out).toContain("dropbox")
  expect(out).toContain("#42 - Acme")
  expect(out).toContain("auto-sync on")
  expect(out).toContain("2026-06-29T10:00:00Z")
})

test("formatProviderConfig: degrades gracefully with no folder / never synced", () => {
  const out = formatProviderConfig("google-drive", { auto_sync: false })
  expect(out).toContain("google-drive")
  expect(out).toContain("auto-sync off")
  expect(out).toContain("never synced")
})
