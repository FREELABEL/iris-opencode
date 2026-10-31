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
