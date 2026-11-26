import { describe, expect, test } from "bun:test"
import { irisCommandWrites, irisWritesKey } from "./iris-agent-writes"

describe("irisCommandWrites (#194361)", () => {
  test("the commands from the ticket write", () => {
    expect(irisCommandWrites(`iris bloqs create-list 952 "Call today"`)).toBe(true)
    expect(irisCommandWrites(`iris bloqs add-item 952 --list 12 --title "Dana"`)).toBe(true)
    expect(irisCommandWrites(`iris leads update 32349 --status Contacted`)).toBe(true)
    expect(irisCommandWrites(`cd /tmp && ~/.iris/bin/iris leads note 32345 "call back"`)).toBe(true)
  })

  test("reads do not", () => {
    expect(irisCommandWrites(`iris leads get 32345`)).toBe(false)
    expect(irisCommandWrites(`iris leads list --bloq 952 --json`)).toBe(false)
    expect(irisCommandWrites(`iris bloqs show 952 | head`)).toBe(false)
    expect(irisCommandWrites(`iris leads search "update"`)).toBe(false)
  })

  test("not an iris command", () => {
    expect(irisCommandWrites(`git commit -m "update iris"`)).toBe(false)
    expect(irisCommandWrites(`echo iris-create`)).toBe(false)
    expect(irisCommandWrites(undefined)).toBe(false)
  })
})

describe("irisWritesKey", () => {
  const bash = (callID: string, command: string, status = "completed") => ({ type: "tool", tool: "bash", callID, state: { status, input: { command } } })

  test("grows only when a writing call FINISHES", () => {
    expect(irisWritesKey([bash("a", "iris bloqs create-list 952 x", "running")])).toBe("")
    expect(irisWritesKey([bash("a", "iris bloqs create-list 952 x")])).toBe("a")
    expect(irisWritesKey([bash("a", "iris bloqs create-list 952 x"), bash("b", "iris leads get 1"), bash("c", "iris bloqs add-item 952")])).toBe("a,c")
  })

  test("IRIS tools and the MCP runner count", () => {
    expect(irisWritesKey([{ type: "tool", tool: "atlas_artifact", callID: "n", state: { status: "completed" } }])).toBe("n")
    expect(irisWritesKey([{ type: "tool", tool: "IRIS_OS_iris_run", callID: "m", state: { status: "completed", input: { command: "leads update 1 --status Won" } } }])).toBe("m")
    expect(irisWritesKey([{ type: "tool", tool: "IRIS_OS_iris_run", callID: "r", state: { status: "completed", input: { command: "leads list" } } }])).toBe("")
    expect(irisWritesKey([{ type: "text" }, { type: "tool", tool: "read", callID: "x", state: { status: "completed" } }])).toBe("")
  })
})
