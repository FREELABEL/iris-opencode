import { describe, expect, test } from "bun:test"
import { irisShareTarget, ShareNeedsSignIn } from "./iris-target"

// #191488 — Share in IRIS uploaded chats to opencode's servers (opncd.ai). Now it goes to IRIS.
describe("irisShareTarget", () => {
  test("goes to IRIS's own share server, signed with the person's IRIS key", () => {
    const t = irisShareTarget({ irisApi: "https://heyiris.io/", irisKey: "iris_live_abc" })
    expect(t.baseUrl).toBe("https://heyiris.io")
    expect(t.headers).toEqual({ authorization: "Bearer iris_live_abc" })
    expect(t.api.create).toBe("/api/v6/shares")
    expect(t.api.sync("01k8")).toBe("/api/v6/shares/01k8/sync")
    expect(t.api.remove("01k8")).toBe("/api/v6/shares/01k8")
    expect(t.api.data("01k8")).toBe("/api/v6/shares/01k8/data")
  })

  test("never falls back to opncd.ai: without an IRIS sign-in, Share refuses and says why", () => {
    expect(() => irisShareTarget({ irisApi: "https://heyiris.io", irisKey: "" })).toThrow(ShareNeedsSignIn)
    expect(() => irisShareTarget({ irisApi: "https://heyiris.io" })).toThrow(/IRIS sign-in/)
  })

  test("a share server someone configured on purpose is still honoured", () => {
    const t = irisShareTarget({ enterpriseUrl: "https://share.example.com", irisApi: "https://heyiris.io", irisKey: "k" })
    expect(t.baseUrl).toBe("https://share.example.com")
    expect(t.headers).toEqual({})
  })

  test("the share client no longer names a third-party host", async () => {
    const src = await Bun.file(new URL("./share-next.ts", import.meta.url)).text()
    expect(src).not.toContain("https://opncd.ai")
    expect(src).not.toContain("active_org_id")
  })
})

describe("import of an IRIS share (#191488)", () => {
  test("regroups the server's flat list into a session with its messages and parts", async () => {
    const { groupShareItems } = await import("../cli/cmd/import")
    const g = groupShareItems([
      { type: "session", data: { id: "ses_a", title: "Hive chat fixes" } },
      { type: "message", data: { id: "m1", role: "user" } },
      { type: "message", data: { id: "m2", role: "assistant" } },
      { type: "part", data: { id: "p1", messageID: "m1", text: "hi" } },
      { type: "part", data: { id: "p2", messageID: "m2", text: "hello" } },
      { type: "model", data: [] },
    ])
    expect(g?.info.id).toBe("ses_a")
    expect(g?.messages.map((m) => [m.info.id, m.parts.map((p) => p.id)])).toEqual([["m1", ["p1"]], ["m2", ["p2"]]])
  })
  test("no messages means nothing to import", async () => {
    const { groupShareItems } = await import("../cli/cmd/import")
    expect(groupShareItems([{ type: "session", data: { id: "s" } }])).toBeUndefined()
  })
})

describe("the old opencode uploader (#191488)", () => {
  test("is not started: it streamed old-style shares to api.opencode.ai", async () => {
    const src = await Bun.file(new URL("./share.ts", import.meta.url)).text()
    const init = src.slice(src.indexOf("export function init()"), src.indexOf("export function initOpencodeUploader()"))
    expect(init).not.toContain("Bus.subscribe")
  })
})
