import { describe, expect, test } from "bun:test"
import { Egress } from "@opencode/core/permission/egress"

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

test("mode: hosted is normal, local is local, the private bit beats both", () => {
  expect(Egress.mode({ modelUrl: "https://api.openai.com", env: {} })).toBe("normal")
  expect(Egress.mode({ modelUrl: "http://127.0.0.1:1", env: {} })).toBe("local")
  expect(Egress.mode({ modelUrl: "https://api.openai.com", env: { IRIS_PRIVATE: "1" } })).toBe("private")
})

describe("which tools", () => {
  test.each(["webfetch", "websearch", "shell", "iris_os_some_tool", "some_new_plugin_tool"])("%s may send data out", (n) =>
    expect(Egress.sendsDataOut(n)).toBe(true),
  )
  test.each(["read", "grep", "glob", "edit", "write", "external_directory"])("%s stays here", (n) =>
    expect(Egress.sendsDataOut(n)).toBe(false),
  )
})
