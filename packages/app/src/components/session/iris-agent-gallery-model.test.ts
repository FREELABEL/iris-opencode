import { describe, expect, test } from "bun:test"
import {
  capabilities,
  description,
  galleryAgents,
  icon,
  integrationChips,
  lastActivity,
  modelName,
  theme,
  typeLabel,
  type GalleryAgent,
} from "./iris-agent-gallery-model"

// #192619 — the Desktop gallery must describe an agent the way ELON's does, and its filters must
// keep the same people and agents ELON keeps.

const A = (o: Partial<GalleryAgent> & { id: number }): GalleryAgent => ({ name: `agent ${o.id}`, ...o })
const F = { kind: "all" as const, workspace: "all" as const, sort: "name_asc" as const, lastOpened: {} }

describe("filters", () => {
  const roster = [
    A({ id: 1, name: "Coder" }),
    A({ id: 2, name: "Dana", isHuman: true }),
    A({ id: 3, name: "Linked", linkedUserId: 9 }),
    A({ id: 4, name: "System", isVirtual: true }),
    A({ id: 5, name: "Synced", workspaceMatch: "matched", workspaceId: 2 }),
  ]

  test("Agents = not human, not virtual; People = human or linked to a user", () => {
    expect(galleryAgents(roster, { ...F, kind: "ai" }).map((a) => a.id)).toEqual([1, 3, 5])
    expect(galleryAgents(roster, { ...F, kind: "human" }).map((a) => a.id)).toEqual([2, 3])
  })

  test("Google-synced = matched; No workspace = no workspace and not virtual", () => {
    expect(galleryAgents(roster, { ...F, workspace: "synced" }).map((a) => a.id)).toEqual([5])
    expect(galleryAgents(roster, { ...F, workspace: "orphaned" }).map((a) => a.id)).toEqual([1, 2, 3])
  })

  test("search covers name, description and capabilities", () => {
    const r = [A({ id: 1, name: "X", flags: ["webAccess"] }), A({ id: 2, name: "Y", description: "Writes copy" }), A({ id: 3, name: "Z" })]
    expect(galleryAgents(r, { ...F, query: "web search" }).map((a) => a.id)).toEqual([1])
    expect(galleryAgents(r, { ...F, query: "copy" }).map((a) => a.id)).toEqual([2])
  })

  test("Recent = last opened here, never-opened last; Newest = created; A-Z = name", () => {
    const r = [A({ id: 1, name: "b", createdAt: "2026-01-01" }), A({ id: 2, name: "a", createdAt: "2026-03-01" }), A({ id: 3, name: "c" })]
    expect(galleryAgents(r, { ...F, sort: "last_opened_desc", lastOpened: { "3": "2026-11-05T10:00:00Z", "1": "2026-11-01T10:00:00Z" } }).map((a) => a.id)).toEqual([3, 1, 2])
    expect(galleryAgents(r, { ...F, sort: "created_at_desc" }).map((a) => a.id)).toEqual([2, 1, 3])
    expect(galleryAgents(r, { ...F, sort: "name_asc" }).map((a) => a.id)).toEqual([2, 1, 3])
  })
})

describe("the card says what ELON says", () => {
  test("type, theme and icon", () => {
    expect([typeLabel(A({ id: 1 })), theme(A({ id: 1 })), icon(A({ id: 1 }))]).toEqual(["AI", "yellow", "robot"])
    expect([typeLabel(A({ id: 1, isHuman: true })), theme(A({ id: 1, isHuman: true })), icon(A({ id: 1, isHuman: true }))]).toEqual(["Human", "gray", "user"])
    expect([theme(A({ id: 1, type: "content" })), icon(A({ id: 1, type: "content" }))]).toEqual(["orange", "pen"])
  })

  test("model names: mapped, provider-prefixed, title-cased, the gpt-4o-mini fallback, none for people", () => {
    expect(modelName(A({ id: 1, model: "gpt-4o-mini" }))).toBe("GPT-4o Mini")
    expect(modelName(A({ id: 1, model: "anthropic/claude-sonnet-4-5" }))).toBe("Claude Sonnet 4 5")
    expect(modelName(A({ id: 1, model: "openai/gpt-oss-20b:free" }))).toBe("GPT OSS 20B")
    expect(modelName(A({ id: 1 }))).toBe("GPT-4o Mini")
    expect(modelName(A({ id: 1, isHuman: true, model: "gpt-4o" }))).toBe("")
  })

  test("capabilities: functions, flags, then at most three integrations, no repeats", () => {
    const a = A({ id: 1, functions: ["lookup"], flags: ["webAccess", "memoryPersistence"], integrations: ["gmail", "slack", "github", "trello"] })
    expect(capabilities(a)).toEqual(["lookup", "Web Search", "Memory & Context", "Gmail", "Slack", "GitHub"])
  })

  test("integration chips: every integration, then the flag chips", () => {
    const a = A({ id: 1, flags: ["useKnowledgeBase"], integrations: ["google-drive", "customThing"] })
    expect(integrationChips(a).map((c) => c.name)).toEqual(["Google Drive", "Custom Thing", "Knowledge Base"])
  })

  test("a missing description is generated the way ELON generates it", () => {
    expect(description(A({ id: 1, flags: ["webAccess", "canCreateContent"] }))).toBe("AI assistant specialized in web search and content creation")
    expect(description(A({ id: 1, type: "research" }))).toBe("Research and data analysis specialist")
    expect(description(A({ id: 1, isHuman: true, type: "human" }))).toBe("Human team member specializing in collaboration and oversight")
    expect(description(A({ id: 1, description: "Mine" }))).toBe("Mine")
  })

  test("last activity reads like ELON's", () => {
    const now = Date.parse("2026-11-05T12:00:00Z")
    expect(lastActivity(undefined, now)).toBe("Never used")
    expect(lastActivity("2026-11-05T11:59:30Z", now)).toBe("just now")
    expect(lastActivity("2026-11-05T09:00:00Z", now)).toBe("3h ago")
    expect(lastActivity("2026-10-01T12:00:00Z", now)).toBe("1mo ago")
  })
})
