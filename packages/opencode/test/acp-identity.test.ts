import { describe, expect, test } from "bun:test"
import { initializeResponse } from "../src/acp/agent"

/**
 * The ACP handshake is the only thing an ACP client (Buzz, Zed) knows about this agent before
 * the first prompt: it shows `agentInfo.name`, and when sign-in is needed it runs or prints the
 * auth method. Buzz, 2026-09-26: an IRIS agent announced itself as "OpenCode" and told a user to
 * run `opencode auth login` — a command for a different product and a different account. Pinned
 * here so an upstream sync cannot quietly bring it back.
 */
describe("ACP initialize identity", () => {
  test("announces IRIS, not OpenCode", () => {
    const res = initializeResponse({ protocolVersion: 1 }, "1.2.3")
    expect(res.agentInfo?.name).toBe("IRIS")
    expect(res.agentInfo?.version).toBe("1.2.3")
  })

  test("no auth method points at opencode, with or without terminal-auth", () => {
    for (const params of [
      { protocolVersion: 1 },
      { protocolVersion: 1, clientCapabilities: { _meta: { "terminal-auth": true } } },
    ]) {
      const text = JSON.stringify(initializeResponse(params as any, "1.2.3"))
      expect(text.toLowerCase()).not.toContain("opencode")
      expect(text).toContain("iris auth login")
    }
  })

  test("terminal-auth runs the iris binary", () => {
    const res = initializeResponse(
      { protocolVersion: 1, clientCapabilities: { _meta: { "terminal-auth": true } } } as any,
      "1.2.3",
    )
    const meta = res.authMethods?.[0]?._meta?.["terminal-auth"] as { command: string; args: string[] }
    expect(meta.command).toBe("iris")
    expect(meta.args).toEqual(["auth", "login"])
  })
})
