import { describe, expect, test } from "bun:test"
import { friendlyDate, recordDetail } from "./iris-record-detail"

const t = (k: string, p?: Record<string, string>) => (p ? `${k}(${Object.values(p).join(",")})` : k)
const NOW = new Date("2026-11-26T18:00:00")

describe("friendlyDate", () => {
  test("today, yesterday, this year, another year", () => {
    expect(friendlyDate("2026-11-26T09:54:00", NOW)).toBe("Today, 9:54 AM")
    expect(friendlyDate("2026-11-25T14:02:00", NOW)).toBe("Yesterday, 2:02 PM")
    expect(friendlyDate("2026-11-03T10:00:00", NOW)).toBe("Nov 3")
    expect(friendlyDate("2025-11-03T10:00:00", NOW)).toBe("Nov 3, 2025")
    expect(friendlyDate("nope", NOW)).toBeUndefined()
  })
})

describe("lead", () => {
  const lead = {
    id: 32345,
    name: "Ethan Okafor",
    company: "Blue Mesa Yoga",
    status: "Qualified",
    email: "ethan@example.test",
    hot: false,
    score: 0,
    type: "unknown",
    bid: 40000,
    noteCount: 1,
    latestNote: { text: "Budget approved.", createdAt: "2026-11-26T09:54:00" },
    createdAt: "2026-11-24T10:00:00",
  }
  const d = recordDetail("leads", lead, t, NOW)!
  test("header: name, company, stage badge", () => {
    expect(d.title).toBe("Ethan Okafor")
    expect(d.subtitle).toBe("Blue Mesa Yoga")
    expect(d.badge).toEqual({ label: "Qualified", tone: "accent" })
  })
  test("value and latest note first; no internal fields", () => {
    expect(d.facts[0]).toMatchObject({ label: "iris.detail.value", value: "$40,000" })
    expect(d.facts[1]!.value).toBe("Budget approved. — Today, 9:54 AM")
    const labels = d.facts.map((f) => f.label).join(" ")
    expect(labels).not.toMatch(/score|hot|type|\bid\b/)
  })
})

describe("agent", () => {
  test("a healthy on-demand agent with no failures shows none", () => {
    const d = recordDetail("agents", { name: "Proposal writer", status: "healthy", active: true, heartbeat: false, failures: 0, model: "GPT-4o Mini" }, t, NOW)!
    expect(d.badge).toEqual({ label: "Healthy", tone: "success" })
    expect(d.facts.find((f) => f.label === "iris.detail.failures")?.value).toBeUndefined()
    expect(d.facts.find((f) => f.label === "iris.detail.runs")?.value).toBe("iris.detail.onDemand")
  })
  test("a scheduled one says how often", () => {
    const d = recordDetail("agents", { name: "Lead follow-up", status: "healthy", heartbeat: true, schedule: "60m" }, t, NOW)!
    expect(d.facts.find((f) => f.label === "iris.detail.runs")?.value).toBe("iris.detail.onSchedule(60m)")
  })
})

test("other panes keep the generic record view", () => {
  expect(recordDetail("hive", { name: "x" }, t)).toBeUndefined()
})
