import { describe, test, expect } from "bun:test"
import { OkfCommand } from "../../src/cli/cmd/platform-okf"

describe("iris okf command", () => {
  test("OkfCommand is exported with the expected command + describe", () => {
    expect(OkfCommand).toBeDefined()
    expect(OkfCommand.command).toBe("okf")
    expect(OkfCommand.describe).toBeTruthy()
    expect(typeof OkfCommand.builder).toBe("function")
  })

  test("registers the expected subcommands", () => {
    const registered: string[] = []
    const fakeYargs: any = {
      command: (c: any) => {
        if (c && c.command) registered.push(String(c.command).split(" ")[0])
        return fakeYargs
      },
      demandCommand: () => fakeYargs,
      positional: () => fakeYargs,
      option: () => fakeYargs,
    }
    ;(OkfCommand.builder as any)(fakeYargs)
    for (const sub of ["list", "register", "query", "export", "validate", "keys"]) {
      expect(registered).toContain(sub)
    }
  })
})
