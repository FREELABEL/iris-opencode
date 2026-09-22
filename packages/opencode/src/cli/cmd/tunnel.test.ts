import { describe, test, expect } from "bun:test"
import { parseNgrokLine, parseCloudflaredLine, looksLikeIrisEngine, pickProvider } from "./tunnel"

describe("parseNgrokLine", () => {
  test("reads the public URL from the started-tunnel record (captured from ngrok 3.20)", () => {
    const line =
      '{"addr":"http://localhost:47811","lvl":"info","msg":"started tunnel","name":"command_line","obj":"tunnels","t":"2026-09-22T12:30:04.305666-05:00","url":"https://135c-104-202-243-97.ngrok-free.app"}'
    expect(parseNgrokLine(line)).toEqual({ url: "https://135c-104-202-243-97.ngrok-free.app" })
  })

  test("an info record carrying err <nil> is not an error", () => {
    const line = '{"err":"\\u003cnil\\u003e","lvl":"info","msg":"open config file","path":"/x/ngrok.yml"}'
    expect(parseNgrokLine(line)).toEqual({})
  })

  test("an eror record surfaces the provider's own message", () => {
    const line = '{"lvl":"eror","msg":"session closing","err":"authentication failed: ERR_NGROK_4018"}'
    expect(parseNgrokLine(line).error).toContain("ERR_NGROK_4018")
  })

  test("non-JSON noise is ignored", () => {
    expect(parseNgrokLine("t=2026 lvl=info msg=hello")).toEqual({})
  })
})

describe("parseCloudflaredLine", () => {
  test("picks the trycloudflare host out of the banner", () => {
    const line = "2026-09-22T17:00:00Z INF |  https://brave-otter-hello-world.trycloudflare.com                    |"
    expect(parseCloudflaredLine(line)).toEqual({ url: "https://brave-otter-hello-world.trycloudflare.com" })
  })

  test("ignores the other URLs cloudflared prints (docs, TOS)", () => {
    expect(parseCloudflaredLine("INF Read more at https://developers.cloudflare.com/cloudflare-one/")).toEqual({})
    expect(parseCloudflaredLine("INF see https://www.cloudflare.com/website-terms/")).toEqual({})
  })
})

describe("looksLikeIrisEngine", () => {
  test("the engine's /global/health shape is recognised", () => {
    expect(looksLikeIrisEngine({ healthy: true, version: "1.3.285" })).toBe(true)
  })
  test("an ordinary dev server's 404 body or HTML is not", () => {
    expect(looksLikeIrisEngine(null)).toBe(false)
    expect(looksLikeIrisEngine({ ok: true })).toBe(false)
    expect(looksLikeIrisEngine({ healthy: "yes" })).toBe(false)
  })
})

describe("pickProvider", () => {
  const only = (...bins: string[]) => (b: string) => bins.includes(b)
  test("auto prefers ngrok, falls back to cloudflared, else null", () => {
    expect(pickProvider("auto", only("ngrok", "cloudflared"))).toBe("ngrok")
    expect(pickProvider("auto", only("cloudflared"))).toBe("cloudflared")
    expect(pickProvider("auto", only())).toBeNull()
  })
  test("an explicit provider that is not installed is null, not a silent fallback", () => {
    expect(pickProvider("cloudflared", only("ngrok"))).toBeNull()
  })
})
