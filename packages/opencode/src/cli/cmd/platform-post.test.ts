import { describe, test, expect } from "bun:test"
import { buildPostBody, publishRows } from "./platform-post"
import { at, connectedTargets, findBrand, type AccountsMatrix } from "./platform-social"

// Shape of GET /api/v1/social-media/accounts, trimmed from a real response (2026-10-11).
const cell = (state: string, handle: string | null = null) => ({
  integration_id: handle ? 1 : null, profile: handle, handle, enabled: state === "connected",
  needs_reauth: state === "needs_reauth", state: state as any,
})
const MATRIX: AccountsMatrix = {
  success: true,
  platforms: ["instagram", "threads", "tiktok", "x"],
  brands: [
    { brand_slug: "heyiris", brand_name: "Heyiris", scope: "brand",
      platforms: { instagram: cell("connected", "heyiris.io"), threads: cell("not_connected"), tiktok: cell("disabled", "heyirisio"), x: cell("needs_reauth", "@heyirisio") } },
    { brand_slug: "freelabel", brand_name: "FREELABEL", scope: "brand",
      platforms: { instagram: cell("connected", "freelabelnet"), threads: cell("connected", "freelabelnet"), tiktok: cell("disabled", "freelabelnet"), x: cell("connected", "freelabelnet") } },
  ],
}

describe("iris post --brand (#188875)", () => {
  test("the body carries the brand, and no profile is required", () => {
    const r = buildPostBody({ platforms: ["instagram"], brand: "heyiris", video: "https://cdn/r.mp4", caption: "hi", mediaType: "reels" })
    expect("error" in r).toBe(false)
    if ("error" in r) return
    expect(r.kind).toBe("video")
    expect(r.body).toEqual({ platforms: ["instagram"], brand: "heyiris", media_type: "REELS", video_url: "https://cdn/r.mp4", title: "hi" })
    expect(r.body.user).toBeUndefined()
  })

  test("without a brand or a profile it refuses and says how to fix it", () => {
    const r = buildPostBody({ platforms: ["x"], text: "gm" })
    expect("error" in r && r.error).toContain("--brand")
  })

  test("the old --profile path is unchanged", () => {
    const r = buildPostBody({ platforms: ["x"], profile: "freelabelnet", text: "gm" })
    expect("error" in r ? null : r.body).toEqual({ platforms: ["x"], user: "freelabelnet", text: "gm" })
  })

  test("--to all = every connected platform; switched-off and needs-reauth ones are NAMED, not dropped", () => {
    const t = connectedTargets(findBrand(MATRIX, "heyiris")!)
    expect(t.platforms).toEqual(["instagram"])
    expect(t.skipped.map((s) => s.platform).sort()).toEqual(["tiktok", "x"])
    expect(t.skipped.find((s) => s.platform === "x")!.reason).toContain("reconnect")
    expect(t.skipped.find((s) => s.platform === "tiktok")!.reason).toContain("switched off")
    // not_connected is not a skip — there was never an account to post to
    expect(t.skipped.some((s) => s.platform === "threads")).toBe(false)
    expect(connectedTargets(findBrand(MATRIX, "freelabel")!).platforms.sort()).toEqual(["instagram", "threads", "x"])
  })

  test("brand lookup tolerates the hyphen/underscore drift between brand copies", () => {
    expect(findBrand({ ...MATRIX, brands: [{ ...MATRIX.brands[0], brand_slug: "emc_radio" }] }, "emc-radio")).toBeDefined()
  })

  test("server-side skips become rows, and per-platform results keep their urls and errors", () => {
    const rows = publishRows({
      success: true,
      results: { instagram: { success: true, url: "https://instagram.com/p/x" }, x: { success: false, error: "media too long" } },
      skipped: { tiktok: "No enabled tiktok account connected for brand 'heyiris'" },
    }, ["instagram", "x", "tiktok"])
    expect(rows).toEqual([
      { platform: "instagram", profile: undefined, status: "posted", detail: "https://instagram.com/p/x" },
      { platform: "x", profile: undefined, status: "failed", detail: "media too long" },
      { platform: "tiktok", status: "skipped", detail: "No enabled tiktok account connected for brand 'heyiris'" },
    ])
  })

  test("several profiles (by_profile) and an async job with no results yet", () => {
    const rows = publishRows({
      success: true,
      by_profile: {
        thebeatbox__: { success: true, results: { instagram: { success: true, url: "u1" } } },
        freelabelnet: { success: true, request_id: "req-9" },
      },
      skipped: {},
    }, ["instagram", "x"])
    expect(rows).toEqual([
      { platform: "instagram", profile: "thebeatbox__", status: "posted", detail: "u1" },
      { platform: "x", status: "submitted", detail: "request req-9" },
    ])
  })

  test("a single async job reports every requested platform as submitted", () => {
    const rows = publishRows({ success: true, request_id: "r1" }, ["instagram", "threads"])
    expect(rows.map((r) => `${r.platform}:${r.status}`)).toEqual(["instagram:submitted", "threads:submitted"])
  })
})

describe("handles (#188876)", () => {
  test("one @, whether or not the stored handle has one", () => {
    expect(at("heyiris.io")).toBe("@heyiris.io")
    expect(at("@freelabelnet")).toBe("@freelabelnet")
    expect(at("@@x")).toBe("@x")
    expect(at(null)).toBe("")
  })
})
