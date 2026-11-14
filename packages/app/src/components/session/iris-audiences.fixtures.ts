/**
 * Audiences fixtures (#193533): the ENGINE's normalized output (packages/opencode/src/iris/segments.ts)
 * for responses RECORDED 2026-11-14 from fl-api PR #308 (wt/193484-segments @ 33f406dd6) served
 * locally on a copy of fl_testing seeded with board 38's 849 real De9Uw8Ilhne leads + 60 others:
 * POST /api/v1/bloqs/<bloq>/segments/preview {"filters":{"source_post":"De9Uw8Ilhne",
 * "comment_contains":"roadmap","followers_min":1000}}. Raw recordings:
 * packages/opencode/test/iris/fixtures/fl-api-segment-preview*.json. Members are invented (public repo).
 */
import type { Draft, Preview } from "./iris-audiences-model"

export const DRAFT_ROADMAP: Draft = {
  bloq: 38,
  segment_id: null,
  name: "",
  filters: [
    { key: "source_post", value: "De9Uw8Ilhne" },
    { key: "comment_contains", value: "roadmap" },
    { key: "followers_min", value: 1000 },
  ],
  rev: 3,
  saved: null,
  by: "agent",
  updated_at: "2026-11-14T18:00:00.000Z",
}

export const PREVIEW_ROADMAP: Preview = {
  total: 0,
  of: 909,
  breakdown: [
    { key: "source_post", before: 909, known: 909, unknown: 0, matched: 849, of: 909, always_known: false },
    { key: "comment_contains", before: 849, known: 849, unknown: 0, matched: 788, of: 909, always_known: false },
    { key: "followers_min", before: 788, known: 0, unknown: 788, matched: 0, of: 909, always_known: false },
  ],
  members: {
    data: [
      { id: 1, handle: "@example.one", name: "@example.one", status: "Prospected", comment: "Roadmap", niche: null, role: null, city: null, followers: null },
      { id: 2, handle: "@example.two", name: "Example Two", status: "Contacted", comment: "roadmap 🙌", niche: "Course creator", role: "Founder", city: "Austin", followers: 12400 },
      { id: 3, handle: null, name: "Lead 3", status: "Prospected", comment: "", niche: null, role: null, city: null, followers: null },
    ],
    total: 788,
    page: 1,
    last_page: 32,
  },
}
