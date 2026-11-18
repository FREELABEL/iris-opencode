import { describe, expect, test } from "bun:test"
import { agentLabels } from "./agent-label"

// #192926 — the composer must call an IRIS agent by its name, not by the file the sync wrote.

describe("agentLabels", () => {
  test("a synced IRIS agent is called by the name in its description", () => {
    const labels = agentLabels([
      {
        name: "iris-aiai-newsroom-agent",
        description: "AIAI Newsroom Agent (IRIS agent #702) — Researches and drafts portfolio articles.",
      },
      { name: "iris-iris", description: "IRIS (IRIS agent #750)" },
    ])
    expect(labels["iris-aiai-newsroom-agent"]).toBe("AIAI Newsroom Agent")
    expect(labels["iris-iris"]).toBe("IRIS")
  })

  test("a built-in keeps its id, first letter capitalised", () => {
    const labels = agentLabels([{ name: "build" }, { name: "plan", description: "Plans before it builds" }])
    expect(labels).toEqual({ build: "Build", plan: "Plan" })
  })

  test("a description that only mentions IRIS is not a synced agent", () => {
    expect(agentLabels([{ name: "review", description: "Reviews code (not an IRIS agent #1)" }]).review).toBe("Review")
  })

  test("two agents with one name each carry their id", () => {
    const labels = agentLabels([
      { name: "iris-a", description: "brandingchampions@gmail.com (IRIS agent #12) — x" },
      { name: "iris-b", description: "brandingchampions@gmail.com (IRIS agent #34) — y" },
      { name: "iris-c", description: "Writer (IRIS agent #56)" },
    ])
    expect(labels).toEqual({
      "iris-a": "brandingchampions@gmail.com #12",
      "iris-b": "brandingchampions@gmail.com #34",
      "iris-c": "Writer",
    })
  })
})
