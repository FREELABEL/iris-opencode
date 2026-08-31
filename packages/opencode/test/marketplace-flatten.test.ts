import { describe, expect, test } from "bun:test"
import { registerCommand, getRegistry } from "../src/cli/cmd/command-groups"

/**
 * #182938 — two surfaces both called a marketplace, both holding things both called skills.
 *
 * `playbook` is IRIS-native; `platform-marketplace` is the Claude Code skills catalog. Someone
 * who publishes a playbook and then does not find it in the other one reasonably concludes the
 * publish failed. Decision: playbooks are IRIS's, skills are Claude Code's, and only one is
 * advertised.
 *
 * Hidden, NOT removed — every existing invocation and script has to keep working. So the tests
 * that matter are the pair: gone from discovery, still callable.
 */
describe("hidden commands (#182938)", () => {
  test("a command with describe:false is not registered for discovery", () => {
    const before = getRegistry().length
    registerCommand({ command: "some-hidden-thing", describe: false, aliases: [] })
    expect(getRegistry().length).toBe(before)
    expect(getRegistry().some((c) => c.name === "some-hidden-thing")).toBe(false)
  })

  test("an ordinary command still registers", () => {
    registerCommand({ command: "some-visible-thing", describe: "does a thing", aliases: [] })
    expect(getRegistry().some((c) => c.name === "some-visible-thing")).toBe(true)
  })

  test("platform-marketplace is hidden from discovery", async () => {
    const { PlatformMarketplaceCommand } = await import("../src/cli/cmd/platform-marketplace")
    expect(PlatformMarketplaceCommand.describe).toBe(false as any)

    registerCommand(PlatformMarketplaceCommand)
    expect(getRegistry().some((c) => c.name === "platform-marketplace")).toBe(false)
  })

  test("...but is still a real, runnable command", async () => {
    // The half that must NOT change. Hiding is a discovery decision, not a removal.
    const { PlatformMarketplaceCommand } = await import("../src/cli/cmd/platform-marketplace")
    expect(PlatformMarketplaceCommand.command).toBe("platform-marketplace")
    expect(PlatformMarketplaceCommand.aliases).toContain("iris-marketplace")
    expect(typeof PlatformMarketplaceCommand.builder).toBe("function")
  })

  test("it is no longer claimed by a command group", async () => {
    const src = await Bun.file(
      new URL("../src/cli/cmd/command-groups.ts", import.meta.url).pathname,
    ).text()
    expect(src).not.toContain('"platform-marketplace": "integrations"')
  })
})
