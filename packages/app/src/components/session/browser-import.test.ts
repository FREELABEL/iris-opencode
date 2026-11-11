import { describe, expect, test } from "bun:test"
import { loadSignedIn, parseSignedIn, primarySource, shouldRedo, signInWithChrome } from "./browser-import"

const src = (id: string, profile: string, sites: string[]) => ({
  id,
  browser: "Chrome",
  profile,
  sites: sites.map((site) => ({ site, cookies: 3 })),
})
const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as unknown as Storage
}

describe("Sign in with Chrome: one button", () => {
  test("uses the main profile and brings in every site it is signed into", async () => {
    let asked: { source: string; sites: string[] } | undefined
    const store = memory()
    const r = await signInWithChrome(
      {
        importSources: async () => [src("chrome:Default", "Work", ["a.com"]), src("chrome:Profile 1", "Alexander", ["youtube.com", "heb.com"])],
        importSignIns: async (source, sites) => ((asked = { source, sites }), { imported: 9, skipped: 0, sites, persistent: false }),
      },
      store,
    )
    expect(asked).toEqual({ source: "chrome:Profile 1", sites: ["youtube.com", "heb.com"] })
    expect(r).toEqual({ ok: true, sites: 2, from: "Chrome · Alexander" })
    expect(loadSignedIn(store)).toMatchObject({ from: "Chrome · Alexander", sites: 2, persistent: false })
  })
  test("no Chrome → none; a Deny at the Mac prompt → denied, and nothing is remembered", async () => {
    const store = memory()
    expect(await signInWithChrome({ importSources: async () => [], importSignIns: async () => ({ imported: 0, skipped: 0, sites: [], persistent: true }) }, store)).toEqual({ ok: false, reason: "none" })
    const denied = await signInWithChrome(
      {
        importSources: async () => [src("chrome:Default", "Default", ["x.com"])],
        importSignIns: async () => {
          throw "macOS didn't give IRIS the key to Chrome Safe Storage (Deny, or it isn't in your Keychain)"
        },
      },
      store,
    )
    expect(denied).toMatchObject({ ok: false, reason: "denied" })
    expect(loadSignedIn(store)).toBeUndefined()
    expect(await signInWithChrome({}, store)).toEqual({ ok: false, reason: "none" })
  })
})

test("the main profile is the one with the most sites", () => {
  expect(primarySource([src("a", "a", ["x.com"]), src("b", "b", ["x.com", "y.com"])])?.id).toBe("b")
})

test("redo at launch only where the Browser forgets (macOS 13); junk is ignored", () => {
  expect(shouldRedo({ from: "Chrome", sites: 3, persistent: false, at: 1 })).toBe(true)
  expect(shouldRedo({ from: "Chrome", sites: 3, persistent: true, at: 1 })).toBe(false)
  expect(shouldRedo(undefined)).toBe(false)
  expect(parseSignedIn("{")).toBeUndefined()
})
