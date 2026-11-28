import { describe, expect, test } from "bun:test"
import { recordDetail } from "./iris-record-detail"
import {
  fieldTypeWord,
  integrationState,
  mcpRowLine,
  mcpStatusWord,
  paneDetail,
  peerInviteText,
  peerPermissionWords,
  plainIntegrationError,
  schemaFieldRows,
  schemaRecordWords,
  siteAddress,
  siteOpenUrl,
} from "./iris-detail-models"
import { addRecordLine } from "./iris-detail-panes"
import { parseIrisLine } from "@/utils/iris-run"

const t = (k: string, p?: Record<string, string>) => (p ? `${k}(${Object.values(p).join(",")})` : k)
const ID = /int-\d|c0a8f2e4|\b4[12]\b|#\d/

describe("integrations (#194582)", () => {
  test("four states, failing first", () => {
    expect(integrationState({ status: "error", connected: true })).toBe("attention")
    expect(integrationState({ status: "active", connected: true, lastError: "boom" })).toBe("attention")
    expect(integrationState({ status: "active", connected: false })).toBe("off")
    expect(integrationState({ status: "active", connected: true, needsTesting: true })).toBe("untested")
    expect(integrationState({ status: "active", connected: true })).toBe("connected")
  })
  test("why it failed, in words; unknown text passes through", () => {
    expect(plainIntegrationError("invalid_grant: Token has been expired or revoked.", t)).toBe("iris.dv.int.why.expired")
    expect(plainIntegrationError("HTTP 403 Forbidden", t)).toBe("iris.dv.int.why.forbidden")
    expect(plainIntegrationError("429 Too Many Requests", t)).toBe("iris.dv.int.why.rateLimited")
    expect(plainIntegrationError("ETIMEDOUT", t)).toBe("iris.dv.int.why.unreachable")
    expect(plainIntegrationError("Workspace archived", t)).toBe("Workspace archived")
    expect(plainIntegrationError(undefined, t)).toBeUndefined()
  })
  test("the detail: badge, the reason, the provider's words kept, last tested as a time, no id", () => {
    const d = paneDetail("integrations", { id: "int-102", name: "Slack", status: "error", connected: true, lastError: "invalid_grant", lastTested: "2026-11-27T10:00:00Z", scope: "project" }, t)!
    expect(d.badge).toEqual({ label: "iris.dv.int.state.attention", tone: "critical" })
    expect(d.facts.find((f) => f.label === "iris.dv.int.why")?.value).toBe("iris.dv.int.why.expired")
    expect(d.facts.find((f) => f.label === "iris.dv.int.details")?.value).toBe("invalid_grant")
    expect(d.facts.find((f) => f.label === "iris.dv.int.lastTested")?.time).toBe("2026-11-27T10:00:00Z")
    expect(JSON.stringify(d)).not.toMatch(ID)
  })
})

describe("sites (#194582)", () => {
  const site = { id: 8, name: "Spring Lookbook", slug: "spring", status: "draft", pagesCount: 3, requiresAuth: true, updatedAt: "2026-11-28T10:00:00Z", navItems: [{ label: "Cover", url: "https://example.test/p/cover" }] }
  test("badge, pages, address, sign-in, edited", () => {
    const d = paneDetail("sites", site, t)!
    expect(d.badge?.label).toBe("iris.sites.status.draft")
    expect(d.facts.map((f) => f.value ?? f.time)).toEqual(["iris.dv.site.pagesN(3)", "https://example.test/p/cover", "iris.dv.site.signIn.yes", "2026-11-28T10:00:00Z"])
    expect(paneDetail("sites", { ...site, status: "published" }, t)!.badge).toEqual({ label: "iris.sites.status.published", tone: "success" })
  })
  test("Open needs a real link; a bare path is an address, not a link", () => {
    expect(siteOpenUrl(site)).toBe("https://example.test/p/cover")
    expect(siteAddress({ slug: "s", navItems: [] })).toBe("/s")
    expect(siteOpenUrl({ slug: "s", navItems: [] })).toBeUndefined()
  })
})

describe("mcp (#194582)", () => {
  test("status words and the row line", () => {
    expect(mcpStatusWord("needs_auth", t)).toEqual({ label: "iris.dv.mcp.state.needs_auth", tone: "warning" })
    expect(mcpStatusWord("weird", t).label).toBe("iris.dv.mcp.state.disabled")
    expect(mcpRowLine({ status: "connected" }, 12, t)).toBe("iris.dv.mcp.tools.other(12)")
    expect(mcpRowLine({ status: "connected" }, 1, t)).toBe("iris.dv.mcp.tools.one")
    expect(mcpRowLine({ status: "failed", error: "spawn ENOENT" }, undefined, t)).toBe("spawn ENOENT")
    expect(mcpRowLine({ status: "needs_auth" }, undefined, t)).toBe("iris.dv.mcp.line.needsAuth")
  })
  test("the detail says the tool count and the last error", () => {
    const d = paneDetail("mcp", { name: "docs", type: "remote", target: "https://x.test/mcp", status: "failed", error: "401" }, t, { tools: 0 })!
    expect(d.facts.find((f) => f.label === "iris.dv.mcp.lastError")?.value).toBe("401")
    expect(d.facts.find((f) => f.label === "iris.dv.mcp.tools")?.value).toBe("0")
  })
})

describe("peers (#194582)", () => {
  const pending = { id: "c0a8f2e4-3333", name: "Pending invite", status: "pending", inviter: true, inviteCode: "K7QX2M9PLA4D", permissions: ["files", "chat", "x-new"], expiresAt: "2026-12-03T10:00:00Z" }
  test("permissions in words; unknown ones keep their name", () => {
    expect(peerPermissionWords(pending.permissions, t)).toEqual(["iris.dv.peer.can.files", "iris.dv.peer.can.chat", "x-new"])
  })
  test("pending: code and expiry; never the connection id", () => {
    const d = paneDetail("peers", pending, t)!
    expect(d.badge?.tone).toBe("warning")
    expect(d.facts.find((f) => f.label === "iris.dv.peer.inviteCode")?.value).toBe("K7QX2M9PLA4D")
    expect(d.facts.find((f) => f.label === "iris.dv.peer.expires")?.time).toBe(pending.expiresAt)
    expect(JSON.stringify(d)).not.toMatch(ID)
    expect(peerInviteText(pending, t)).toContain("K7QX2M9PLA4D")
    expect(peerInviteText({ status: "active" }, t)).toBeUndefined()
  })
})

describe("schemas (#194582)", () => {
  const sc = { name: "Clients", slug: "clients", scope: "board", displayField: "name", recordCount: 1240, updatedAt: "2026-11-25T10:00:00Z",
    fields: [{ key: "name", label: "Name", type: "string", required: true }, { key: "vip", label: "VIP", type: "boolean" }, { key: "x", label: "X", type: "geo" }, { key: "allergies", label: "Allergies", type: "text", visibility: "phi" }] }
  test("a fields table: name, type in words, required, PHI marked", () => {
    expect(schemaFieldRows(sc, t)).toEqual([
      { name: "Name", key: "name", type: "iris.dv.schema.type.string", required: true, phi: false },
      { name: "VIP", key: "vip", type: "iris.dv.schema.type.boolean", required: false, phi: false },
      { name: "X", key: "x", type: "geo", required: false, phi: false },
      { name: "Allergies", key: "allergies", type: "iris.dv.schema.type.text", required: false, phi: true },
    ])
    expect(fieldTypeWord(undefined, t)).toBe("")
  })
  test("record count in words, and an unmeasured count is not a zero", () => {
    expect(schemaRecordWords(sc, t)).toBe("iris.dv.schema.records.other(1,240)")
    expect(schemaRecordWords({ recordCount: 1 }, t)).toBe("iris.dv.schema.records.one")
    expect(schemaRecordWords({}, t)).toBeUndefined()
    const d = paneDetail("schemas", { ...sc, recordCount: undefined }, t)!
    expect(d.facts.find((f) => f.label === "iris.dv.schema.recordsLabel")?.value).toBeUndefined()
  })
  test("Add record opens a line that parses, with required fields first", () => {
    const line = addRecordLine({ ...sc, fields: [...sc.fields].reverse() }, 41)
    const p = parseIrisLine(line)
    expect("argv" in p).toBe(true)
    const argv = (p as { argv: string[] }).argv
    expect(argv.slice(0, 7)).toEqual(["atlas:datasets", "records", "add", "--schema", "clients", "--bloq", "41"])
    expect(Object.keys(JSON.parse(argv[8]!))[0]).toBe("name")
  })
})

describe("recordDetail answers for the five, so the raw list stays hidden", () => {
  test("each pane", () => {
    for (const pane of ["integrations", "sites", "mcp", "peers", "schemas"]) expect(recordDetail(pane, { name: "x" }, t)).toBeDefined()
  })
})
