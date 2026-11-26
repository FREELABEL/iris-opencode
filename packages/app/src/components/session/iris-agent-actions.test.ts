import { describe, expect, test } from "bun:test"
import { describeAgentAction, describeIrisCommand, irisWords, shellWords } from "./iris-agent-actions"

const names = {
  lead: (id: number) => ({ 32349: "Mia Novak" })[id],
  list: (id: number) => ({ 3405: "Call today" })[id],
  board: (id: number) => ({ 952: "demo-studio" })[id],
}

describe("shellWords", () => {
  test("double quotes keep escaped dollars as dollars", () => {
    expect(shellWords(`iris bloqs add-item 952 3405 "Ethan Okafor — Blue Mesa Yoga (\\$40k)" --type task`)).toEqual([
      "iris",
      "bloqs",
      "add-item",
      "952",
      "3405",
      "Ethan Okafor — Blue Mesa Yoga ($40k)",
      "--type",
      "task",
    ])
  })
  test("single quotes are literal; a pipe ends the command", () => {
    expect(shellWords(`iris leads note 1 'a $b' | head`)).toEqual(["iris", "leads", "note", "1", "a $b"])
  })
  test("the iris segment of a compound line", () => {
    expect(irisWords(`cd ~/x && ./iris leads update 7 --status Won`)).toEqual(["leads", "update", "7", "--status", "Won"])
  })
})

describe("describeIrisCommand", () => {
  test("an item added to a list, by name", () => {
    expect(describeIrisCommand(`iris bloqs add-item 952 3405 "Ethan Okafor — Blue Mesa Yoga (\\$40k)"`, names)).toMatchObject({
      icon: "plus",
      title: "Added Ethan Okafor — Blue Mesa Yoga ($40k)",
      target: "Atlas › Call today",
    })
  })
  test("a list created on a board", () => {
    expect(describeIrisCommand(`iris bloqs create-list 952 "Call today"`, names)).toMatchObject({
      title: "Created the list Call today",
      target: "Atlas › demo-studio",
    })
  })
  test("a lead moved to a stage", () => {
    expect(describeIrisCommand(`iris leads update 32349 --status Contacted`, names)?.title).toBe("Moved Mia Novak to Contacted")
    expect(describeIrisCommand(`iris leads update 5 --status=Won`)?.title).toBe("Moved lead #5 to Won")
  })
  test("reads are not actions", () => {
    expect(describeIrisCommand(`iris leads list --status New`)).toBeUndefined()
    expect(describeIrisCommand(`iris bloqs show 952`)).toBeUndefined()
    expect(describeIrisCommand(`ls -la`)).toBeUndefined()
  })
  test("the raw command is kept for the disclosure", () => {
    const line = `iris leads update 32349 --status Contacted`
    expect(describeIrisCommand(line)?.command).toBe(line)
  })
})

describe("describeAgentAction", () => {
  test("shell and the IRIS MCP tool", () => {
    const done = { status: "completed" }
    expect(describeAgentAction({ type: "tool", tool: "bash", state: { ...done, input: { command: "iris leads update 32349 --status Won" } } }, names)?.title).toBe(
      "Moved Mia Novak to Won",
    )
    expect(
      describeAgentAction({ type: "tool", tool: "IRIS_OS_iris_run", state: { ...done, input: { command: "bloqs add-item 952 3405 Hello" } } }, names)?.target,
    ).toBe("Atlas › Call today")
    expect(describeAgentAction({ type: "tool", tool: "read", state: { ...done, input: {} } })).toBeUndefined()
  })
})
