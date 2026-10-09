import { describe, expect, test } from "bun:test"
import { IRIS_OPENAI_BASE, upgradeIrisBaseURL } from "../../src/provider/provider"

describe("IRIS talks to heyiris.io, not freelabel.net (#188508)", () => {
  test("installs seeded with our old default are upgraded; a user's own URL is kept", () => {
    expect(IRIS_OPENAI_BASE).toBe("https://heyiris.io/api/v6/openai")
    expect(upgradeIrisBaseURL("https://freelabel.net/api/v6/openai")).toBe(IRIS_OPENAI_BASE)
    expect(upgradeIrisBaseURL("https://freelabel.net/api/v6/openai/")).toBe(IRIS_OPENAI_BASE)
    expect(upgradeIrisBaseURL("https://my-proxy.example/v1")).toBe("https://my-proxy.example/v1")
    expect(upgradeIrisBaseURL(undefined)).toBe(undefined)
  })

  test("nothing in the shipped seed or the API default points at freelabel.net", async () => {
    const seed = await Bun.file(new URL("../../../desktop/src-tauri/resources/iris-provider.json", import.meta.url)).text()
    expect(seed).not.toContain("freelabel.net")
    const platform = await Bun.file(new URL("../../src/iris/platform.ts", import.meta.url)).text()
    expect(platform).toContain('process.env.IRIS_API_URL ?? "https://heyiris.io"')
  })
})
