import { describe, expect, test } from "bun:test"
import { routesToV2 } from "./iris-route"

describe("which engine answers", () => {
  test("v2 owns its commands, the TUI, root flags and a directory", () => {
    for (const a of [[], ["run", "x"], ["serve"], ["models"], ["session", "list"], ["acp"], ["acp", "--cwd", "/x"], ["-c"], ["--prompt", "hi"], ["./repo"], ["~/code/app"]])
      expect(routesToV2(a)).toBe(true)
  })

  test("platform commands, help and uninstall go to the v1 layer", () => {
    for (const a of [["atlas", "list"], ["hive", "models"], ["leads"], ["help"], ["--help"], ["uninstall"], ["atlas:list"]])
      expect(routesToV2(a)).toBe(false)
  })

  test("the ACP client (#191163) goes to v1; the ACP server stays v2", () => {
    expect(routesToV2(["acp", "run", "--agent", "claude", "hi"])).toBe(false)
    expect(routesToV2(["acp", "agents"])).toBe(false)
    expect(routesToV2(["acp", "sessions", "--json"])).toBe(false)
    expect(routesToV2(["acp"])).toBe(true)
    expect(routesToV2(["acp", "--port", "4000"])).toBe(true)
    expect(routesToV2(["acp", "runner"])).toBe(true)
  })
})
