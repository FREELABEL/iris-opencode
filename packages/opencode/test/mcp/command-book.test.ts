import { describe, expect, test } from "bun:test"
import capabilities from "../../capabilities.json"
import book from "../../command-book.json"
import { canonical, commandName, effectOf } from "../../src/cli/cmd/command-book"

// The book (#193064) lives in fl-iris-api (config/cli-commands.yaml). This repo carries a generated
// copy — script/sync-command-book.ts — and these tests stop the two from drifting.
const EFFECTS = ["read", "own_write", "shared_write", "shared_overwrite", "egress", "payment", "unclassified"]

describe("the CLI ships a copy of the book that covers every command", () => {
  test("every command in capabilities.json has an entry in the book", () => {
    const cli = [...new Set((capabilities as any).entries.filter((e: any) => e.kind === "command").map((e: any) => commandName(e.run)).filter(Boolean))]
    const missing = cli.filter((n) => !(n in (book as any).commands))
    expect(missing).toEqual([]) // a new command needs its effect declared in fl-iris-api first, then: bun script/sync-command-book.ts
  })
  test("every effect is from the book's vocabulary", () => {
    const bad = Object.entries((book as any).commands).filter(([, e]) => !EFFECTS.includes(e as string))
    expect(bad).toEqual([])
  })
})

describe("effectOf finds a command's entry by its longest known prefix", () => {
  test("names as a person types them, arguments ignored", () => {
    expect(commandName("iris hive schedule pause <id>")).toBe("hive schedule pause")
    expect(effectOf("hive nodes --json")).toBe("read")
  })
  test("an alias resolves to the command it names (agents type `bloqs …`; the book says `atlas …`)", () => {
    expect(canonical("bloqs create-list 297 Benchmarks")).toBe("atlas create-list 297 Benchmarks")
    expect(canonical("kb items 297")).toBe("atlas items 297")
    expect(effectOf("iris bloqs create-list 297 Benchmarks")).toBe((book as any).commands["atlas create-list"])
    expect(effectOf("bloqs items 297")).toBe((book as any).commands["atlas items"])
  })
  test("an unknown command is unclassified, never read", () => {
    expect(effectOf("definitely not a command")).toBe("unclassified")
    expect(effectOf("")).toBe("unclassified")
  })
})

describe("an action taken as an argument decides the effect (#193064 book actions:)", () => {
  test("hive tasks lists by default, reads get/logs, and dispatches on create/rerun", () => {
    expect(effectOf("hive tasks")).toBe("read")
    expect(effectOf("hive tasks --limit 5 --json")).toBe("read")
    expect(effectOf("hive tasks get 12")).toBe("read")
    expect(effectOf("hive tasks create --type code --node x")).toBe("egress")
    expect(effectOf("hive tasks rerun 12")).toBe("egress")
  })
  test("hive sessions, reviewed, is a read including follow", () => {
    expect(effectOf("hive sessions --status needs_you")).toBe("read")
    expect(effectOf("hive sessions follow abc")).toBe("read")
  })
})

