import { describe, expect, test } from "bun:test"
import {
  normalizeEntry, normalizeCatalog, findEntry, isOAuthEntry,
  requiredFields, missingRequired, parseFieldFlags, connectCommandHint, groupByCategory,
} from "./integration-catalog"

/** The real shape returned by /api/v1/integrations-temp/registry on 2026-08-28. */
const WIX = {
  type: "wix",
  name: "Wix",
  description: "Manage Wix CMS collections and data items via native REST API.",
  category: "website",
  functions: ["list_collections", "query_items", "insert_item"],
  isLive: true,
  isConnected: false,
  source: "yml",
  auth: {
    type: "api_key",
    fields: [
      { name: "api_key", label: "Wix API Key", description: "Generate at manage.wix.com/account/api-keys.", required: true },
      { name: "site_id", label: "Wix Site ID", description: "Found in your Wix dashboard URL after /dashboard/.", required: true },
    ],
  },
}

const GMAIL = { type: "gmail", name: "Gmail", category: "communication", isLive: true, auth: { type: "oauth2" } }

describe("normalizeEntry", () => {
  test("keeps the declared credential fields, labels and help text", () => {
    const e = normalizeEntry(WIX)!
    expect(e.type).toBe("wix")
    expect(e.authType).toBe("api_key")
    expect(e.fields.map((f) => f.name)).toEqual(["api_key", "site_id"])
    expect(e.fields[1].description).toContain("/dashboard/")
  })

  test("a missing auth block defaults to oauth2 rather than inventing a prompt", () => {
    expect(normalizeEntry({ type: "x" })!.authType).toBe("oauth2")
  })

  test("only an explicit required:false makes a field optional", () => {
    const e = normalizeEntry({ type: "x", auth: { type: "api_key", fields: [{ name: "a" }, { name: "b", required: false }] } })!
    expect(requiredFields(e).map((f) => f.name)).toEqual(["a"])
  })

  test("a row with no type is not an integration", () => {
    expect(normalizeEntry({ name: "Nameless" })).toBeNull()
    expect(normalizeEntry(null)).toBeNull()
  })

  test("type is lowercased so lookups cannot miss on case", () => {
    expect(normalizeEntry({ type: "Wix" })!.type).toBe("wix")
  })
})

describe("normalizeCatalog", () => {
  test("reads the registry envelope", () => {
    expect(normalizeCatalog({ success: true, data: [WIX, GMAIL], count: 2 })).toHaveLength(2)
  })

  test("accepts a bare array and an integrations key too", () => {
    expect(normalizeCatalog([WIX])).toHaveLength(1)
    expect(normalizeCatalog({ integrations: [WIX] })).toHaveLength(1)
  })

  test("dedupes by type — the registry merges yml and composio sources", () => {
    expect(normalizeCatalog({ data: [WIX, { ...WIX, source: "composio-appmap" }] })).toHaveLength(1)
  })

  test("junk yields an empty catalog, never a crash", () => {
    expect(normalizeCatalog(null)).toEqual([])
    expect(normalizeCatalog({ data: "nope" })).toEqual([])
  })
})

describe("isOAuthEntry", () => {
  test("gmail authorises in a browser", () => {
    expect(isOAuthEntry(normalizeEntry(GMAIL)!)).toBe(true)
  })

  test("WIX DOES NOT — this is the bug. It is api_key with two fields", () => {
    expect(isOAuthEntry(normalizeEntry(WIX)!)).toBe(false)
  })

  test("declared fields beat the auth label — anything with fields is answered by collecting them", () => {
    const odd = normalizeEntry({ type: "odd", auth: { type: "oauth2", fields: [{ name: "token" }] } })!
    expect(isOAuthEntry(odd)).toBe(false)
  })
})

describe("missingRequired + parseFieldFlags", () => {
  test("names exactly what is still needed", () => {
    const e = normalizeEntry(WIX)!
    expect(missingRequired(e, {}).map((f) => f.name)).toEqual(["api_key", "site_id"])
    expect(missingRequired(e, { api_key: "k" }).map((f) => f.name)).toEqual(["site_id"])
    expect(missingRequired(e, { api_key: "k", site_id: "s" })).toEqual([])
  })

  test("blank and whitespace are not values", () => {
    expect(missingRequired(normalizeEntry(WIX)!, { api_key: "  ", site_id: "" })).toHaveLength(2)
  })

  test("parses repeated --field flags, keeping = inside the value", () => {
    expect(parseFieldFlags(["api_key=abc=123", "site_id=99"])).toEqual({ api_key: "abc=123", site_id: "99" })
  })

  test("ignores malformed pairs instead of inventing keys", () => {
    expect(parseFieldFlags(["nonsense", "=novalue", ""])).toEqual({})
    expect(parseFieldFlags(undefined)).toEqual({})
  })
})

describe("connectCommandHint", () => {
  test("gives the command that actually works, not --api-key/--token/--webhook-url", () => {
    expect(connectCommandHint(normalizeEntry(WIX)!)).toBe(
      "iris integrations connect wix --field api_key=<api_key> --field site_id=<site_id>",
    )
  })

  test("an OAuth integration needs no flags", () => {
    expect(connectCommandHint(normalizeEntry(GMAIL)!)).toBe("iris integrations connect gmail")
  })
})

describe("groupByCategory", () => {
  test("groups and sorts so a browsable catalog is browsable", () => {
    const g = groupByCategory(normalizeCatalog({ data: [WIX, GMAIL] }))
    expect(g.map(([k]) => k)).toEqual(["communication", "website"])
  })

  test("an entry with no category is not dropped", () => {
    const g = groupByCategory(normalizeCatalog({ data: [{ type: "lonely" }] }))
    expect(g[0][0]).toBe("other")
  })
})
