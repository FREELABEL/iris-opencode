import { describe, test, expect } from "bun:test"
import { buildPostBody, publishRows, statusRows, resolveSubmitted, exitCodeFor, requestIds } from "./platform-post"
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

describe("the response can say success while a platform failed (#188875, live finding)", () => {
  // Real response, freelabel instagram+threads, instagram needing reauth: top level success=true,
  // summary 2/0 — and the inner instagram result failed.
  const LYING = {
    success: true, partial_success: false, summary: { successful: 2, failed: 0 },
    results: {
      instagram: { success: true, results: { instagram: { success: false, status: "failed", error_code: "account_reauth_required", error: "Please reconnect your Instagram account" } } },
      threads: { success: true, results: { threads: { success: true, post_url: "https://threads.net/@freelabelnet/post/1" } } },
    },
  }

  test("the innermost per-platform result wins over every outer success flag", () => {
    const rows = publishRows(LYING, ["instagram", "threads"])
    expect(rows[0]).toEqual({ platform: "instagram", profile: undefined, status: "failed", detail: "account_reauth_required: Please reconnect your Instagram account" })
    expect(rows[1]).toEqual({ platform: "threads", profile: undefined, status: "posted", detail: "https://threads.net/@freelabelnet/post/1" })
    expect(exitCodeFor(rows)).toBe(1)
  })

  // Real background answer: no `success` at all, a request_id, and the server's skips.
  const BACKGROUND = { message: "Upload initiated successfully in background", request_id: "req-42", job_id: "j1", skipped: { x: "No enabled x account connected for brand 'heyiris'" } }

  test("a background upload is 'submitted' per platform, with the skips named", () => {
    const rows = publishRows(BACKGROUND, ["instagram", "x"])
    expect(rows).toEqual([
      { platform: "instagram", status: "submitted", detail: "request req-42" },
      { platform: "x", status: "skipped", detail: "No enabled x account connected for brand 'heyiris'" },
    ])
    expect(requestIds(BACKGROUND)).toEqual(["req-42"])
    expect(exitCodeFor(rows)).toBe(3)
  })

  test("polling the status endpoint resolves each platform to its post url or its error", async () => {
    const answers = [
      { status: "processing", results: [] },
      { status: "completed", results: [
        { platform: "instagram", success: true, post_url: "https://instagram.com/reel/abc", error_message: null, error_code: null },
        { platform: "tiktok", success: false, post_url: null, error_message: "video too short", error_code: "invalid_media" },
      ] },
    ]
    let calls = 0
    const r = await resolveSubmitted(
      publishRows(BACKGROUND, ["instagram", "tiktok", "x"]), ["req-42"],
      async () => answers[Math.min(calls++, 1)],
      { timeoutMs: 60_000, intervalMs: 1, sleep: async () => {} },
    )
    expect(calls).toBe(2)
    expect(r.pending).toEqual([])
    expect(r.rows).toEqual([
      { platform: "instagram", status: "posted", detail: "https://instagram.com/reel/abc", profile: undefined },
      { platform: "tiktok", status: "failed", detail: "invalid_media: video too short", profile: undefined },
      { platform: "x", status: "skipped", detail: "No enabled x account connected for brand 'heyiris'" },
    ])
    expect(exitCodeFor(r.rows)).toBe(1)
  })

  test("a job still running at the timeout stays 'submitted' and is reported as pending (exit 3, not 0)", async () => {
    const r = await resolveSubmitted(publishRows(BACKGROUND, ["instagram"]), ["req-42"], async () => ({ status: "processing" }),
      { timeoutMs: 0, intervalMs: 1, sleep: async () => {} })
    expect(r.pending).toEqual(["req-42"])
    expect(exitCodeFor(r.rows)).toBe(3)
  })

  test("an unknown request id is a failure for `social status`, but polling keeps asking through it", async () => {
    const notFound = { success: false, error: "Client error: ... 404 Not Found\n{...}" }
    expect(statusRows(notFound)).toEqual([{ platform: "?", status: "failed", detail: "Client error: ... 404 Not Found" }])
    let calls = 0
    const r = await resolveSubmitted(publishRows({ request_id: "q", message: "bg" }, ["instagram"]), ["q"],
      async () => (calls++ === 0 ? notFound : { status: "completed", results: [{ platform: "instagram", success: true, post_url: "u" }] }),
      { timeoutMs: 60_000, intervalMs: 1, sleep: async () => {} })
    expect(r.rows[0].status).toBe("posted")
  })

  test("statusRows: null while running; rows once completed", () => {
    expect(statusRows({ status: "processing" })).toBeNull()
    expect(statusRows({ status: "completed", results: [{ platform: "x", success: true, post_url: "u" }] })).toEqual([{ platform: "x", profile: undefined, status: "posted", detail: "u" }])
  })

  test("all posted → exit 0; skips alone do not fail the run", () => {
    expect(exitCodeFor([{ platform: "instagram", status: "posted" }, { platform: "x", status: "skipped" }])).toBe(0)
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
