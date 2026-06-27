import { describe, test, expect } from "bun:test"
import { PlatformLearnCommand } from "../../src/cli/cmd/platform-learn"

describe("iris learn command", () => {
  test("is exported with the expected command + describe", () => {
    expect(PlatformLearnCommand).toBeDefined()
    expect(PlatformLearnCommand.command).toMatch(/^learn /)
    expect(PlatformLearnCommand.describe).toBeTruthy()
    expect(typeof PlatformLearnCommand.builder).toBe("function")
  })

  test("registers the target options", () => {
    const opts: string[] = []
    const fake: any = {
      positional: () => fake,
      option: (name: string) => { opts.push(name); return fake },
    }
    ;(PlatformLearnCommand.builder as any)(fake)
    for (const o of ["bloq", "create-playbook", "playbook", "create-skill"]) {
      expect(opts).toContain(o)
    }
  })
})
