import { describe, expect, test } from "bun:test"
import { Egress } from "../../src/permission/egress"
import { Permission } from "../../src/permission"

const allowAll: Parameters<typeof Permission.merge>[0] = [{ permission: "*", pattern: "*", action: "allow" }]
const action = (ruleset: Parameters<typeof Permission.merge>[0], permission: string, pattern = "x") =>
  Permission.evaluate(permission, pattern, ruleset).action
const tighten = (mode: Egress.Mode, permission: string, explicit: Parameters<typeof Permission.merge>[0] = [], ruleset = allowAll) =>
  Egress.tighten({ mode, permission, patterns: ["x"], ruleset, explicit })

describe("what counts as a local model", () => {
  test.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234",
    "http://[::1]:8080",
    "http://192.168.1.5/v1",
    "http://10.0.0.2",
    "http://172.16.3.1",
    "http://100.80.1.1",
    "http://mybox.local:8000",
    "http://mybox.tailnet.ts.net",
  ])("%s is local", (url) => expect(Egress.isLocalUrl(url)).toBe(true))

  test.each([
    "https://api.openai.com/v1",
    "https://heyiris.io/api/v6/openai",
    "http://172.32.0.1",
    "http://100.128.0.1",
    "http://localhost.evil.example",
    "not a url",
    undefined,
  ])("%s is not", (url) => expect(Egress.isLocalUrl(url)).toBe(false))
})

describe("mode", () => {
  test("a hosted model is normal, a local one local, and the private bit beats both", () => {
    expect(Egress.mode({ modelUrl: "https://api.openai.com", env: {} })).toBe("normal")
    expect(Egress.mode({ modelUrl: "http://127.0.0.1:1", env: {} })).toBe("local")
    expect(Egress.mode({ modelUrl: "https://api.openai.com", env: { IRIS_PRIVATE: "1" } })).toBe("private")
    expect(Egress.mode({ modelUrl: "https://api.openai.com", env: { IRIS_PRIVATE: "0" } })).toBe("normal")
  })
})

describe("which tools", () => {
  test.each(["webfetch", "websearch", "codesearch", "bash", "subagent_model", "my_mcp_tool", "some_new_plugin_tool"])(
    "%s may send data out",
    (name) => expect(Egress.sendsDataOut(name)).toBe(true),
  )
  test.each(["read", "grep", "glob", "edit", "todowrite", "external_directory", "doom_loop"])("%s stays here", (name) =>
    expect(Egress.sendsDataOut(name)).toBe(false),
  )
})

describe("tighten", () => {
  test("normal sessions are untouched", () => {
    expect(action(tighten("normal", "webfetch"), "webfetch")).toBe("allow")
  })
  test("local: the default allow no longer covers it", () => {
    expect(action(tighten("local", "webfetch"), "webfetch")).toBe("ask")
  })
  test("local: a tool that stays here is untouched", () => {
    expect(action(tighten("local", "read"), "read")).toBe("allow")
  })
  test("local: a rule the person wrote counts", () => {
    const written: Parameters<typeof Permission.merge>[0] = [{ permission: "webfetch", pattern: "*", action: "allow" }]
    expect(action(tighten("local", "webfetch", written), "webfetch")).toBe("allow")
  })
  test("local: a written rule for another pattern does not", () => {
    const written: Parameters<typeof Permission.merge>[0] = [{ permission: "webfetch", pattern: "https://docs.*", action: "allow" }]
    expect(action(tighten("local", "webfetch", written), "webfetch")).toBe("ask")
  })
  test("private: not even a written rule", () => {
    const written: Parameters<typeof Permission.merge>[0] = [{ permission: "webfetch", pattern: "*", action: "allow" }]
    expect(action(tighten("private", "webfetch", written), "webfetch")).toBe("ask")
  })
  test("a deny is never loosened", () => {
    const denied: Parameters<typeof Permission.merge>[0] = [...allowAll, { permission: "webfetch", pattern: "*", action: "deny" }]
    expect(action(tighten("private", "webfetch", [], denied), "webfetch")).toBe("deny")
  })
})

