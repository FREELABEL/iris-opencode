import { describe, expect, test } from "bun:test"
import { bridgeErrorText, fleetArgs, parseFleet } from "../../src/cli/cmd/mcp-hive"

describe("hive_sessions reads the fleet the way the CLI does (#191981)", () => {
  test("runs iris hive sessions --json, with a status or --all", () => {
    expect(fleetArgs({})).toEqual(["hive", "sessions", "--json"])
    expect(fleetArgs({ status: "needs_you" })).toEqual(["hive", "sessions", "--json", "--status", "needs_you"])
    expect(fleetArgs({ all: true })).toEqual(["hive", "sessions", "--json", "--all"])
  })
  test("a status that is not one of the CLI's is dropped, never passed through as argv", () => {
    expect(fleetArgs({ status: "active; rm -rf /" })).toEqual(["hive", "sessions", "--json"])
    expect(fleetArgs({ status: 3, all: "yes" })).toEqual(["hive", "sessions", "--json"])
  })
  test("parses the CLI's JSON, even after a warning line", () => {
    const rows = [{ session_id: "a", provider: "claude_code", node: "iris-hive-001", status: "active" }]
    expect(parseFleet(JSON.stringify(rows))).toEqual({ rows })
    expect(parseFleet("iris: the local daemon is not running\n" + JSON.stringify(rows))).toEqual({ rows })
  })
  test("anything else is an error that says what came back, not an empty fleet", () => {
    expect(parseFleet("")).toEqual({ error: "iris hive sessions printed nothing" })
    expect(parseFleet("Not signed in")).toEqual({ error: "Not signed in" })
    expect(parseFleet("[not json")).toEqual({ error: "iris hive sessions returned output that is not JSON" })
  })
})

describe("a failed bridge call says why (#191981)", () => {
  test("no tmux reads as no tmux, and points at the fleet command — not as a dead bridge", () => {
    const text = bridgeErrorText(503, "Service Unavailable", { error: "tmux not available" }, "does-not-exist")
    expect(text).toContain("tmux is not installed on this machine")
    expect(text).toContain("hive send-input")
    expect(text).not.toContain("503")
  })
  test("a missing session says so", () => {
    expect(bridgeErrorText(404, "Not Found", { error: "session not found" }, "x")).toBe(
      'No tmux session named "x" on this machine. (session not found)',
    )
  })
  test("anything else keeps the status and adds the bridge's own words", () => {
    expect(bridgeErrorText(500, "Internal Server Error", { error: "boom" })).toBe("Bridge error: 500 Internal Server Error — boom")
    expect(bridgeErrorText(502, "Bad Gateway", null)).toBe("Bridge error: 502 Bad Gateway")
  })
  test("401 keeps the rotated-key advice", () => {
    expect(bridgeErrorText(401, "Unauthorized", null)).toContain("bridge-token rotates on restart")
  })
})
