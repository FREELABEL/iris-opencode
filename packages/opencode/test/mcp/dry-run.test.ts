import { describe, expect, test } from "bun:test"
import { dryRunAllows, isDryRun } from "../../src/cli/cmd/mcp-dry-run"

describe("dry-run lets only known reads through (#193064 benchmark)", () => {
  test("off unless IRIS_MCP_DRY_RUN=1", () => {
    expect(isDryRun({})).toBe(false)
    expect(isDryRun({ IRIS_MCP_DRY_RUN: "1" })).toBe(true)
  })
  test("reads run", () => {
    for (const command of ["hive nodes", "hive tasks --json", "bloqs items 297", "bloqs search lexicon", "bug show 193064", "bloqs get-item 5", "help hive"])
      expect([command, dryRunAllows("iris_run", { command })]).toEqual([command, true])
    expect(dryRunAllows("hive_sessions", {})).toBe(true)
    expect(dryRunAllows("hive_wait", { timeout_s: 5 })).toBe(true)
    expect(dryRunAllows("hive_inventory", {})).toBe(true)
    expect(dryRunAllows("iris_memory", { action: "search" })).toBe(true)
  })
  test("a read verb with a write subcommand after it is a write (hive tasks create, hive nodes remove…)", () => {
    for (const command of ["hive tasks create --node x --prompt y", "hive tasks rerun 12", "hive nodes remove abc", "bloqs items 297 delete 5", "hive sessions answer x 1", "schedules list --then toggle", "hive tasks cancel 9"])
      expect([command, dryRunAllows("iris_run", { command })]).toEqual([command, false])
    for (const command of ["hive tasks 12", "hive tasks --limit 5", "hive nodes --json", "hive sessions --status needs_you"])
      expect([command, dryRunAllows("iris_run", { command })]).toEqual([command, true])
  })
  test("writes, sends and anything unknown do not", () => {
    for (const command of ["hive run iris-hive-001 uptime", "bloqs add-item 297 x", "bug report --title x", "leads delete 3", "pages publish x", "bloqs items 297 --apply", "hive", ""])
      expect([command, dryRunAllows("iris_run", { command })]).toEqual([command, false])
    for (const tool of ["hive_answer", "hive_send_input", "hive_panes", "playbook_run", "something_new"]) expect(dryRunAllows(tool, {})).toBe(false)
    expect(dryRunAllows("iris_memory", { action: "add" })).toBe(false)
    expect(dryRunAllows("iris_agent", { action: "ask" })).toBe(false)
  })
})
