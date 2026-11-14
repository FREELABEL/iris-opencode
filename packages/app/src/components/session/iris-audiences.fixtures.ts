/**
 * Audiences fixtures (#193533).
 *
 * TYPED, NOT RECORDED: fl-api's segments API (D3 #193484) was not deployed when this was written,
 * so the SHAPES below follow the engine's normalized output (packages/opencode/src/iris/segments.ts)
 * for the D3 contract as briefed. The COUNTS are measured: board 38's lead list read on 2026-11-14
 * with `curl https://raichu.heyiris.io/api/v1/leads?bloq_id=38&custom_field_key=source_post_url&
 * custom_field_value=https://www.instagram.com/p/De9Uw8Ilhne/` (all pages): 11,341 leads on the
 * board, 849 from that post, 788 whose comment contains "roadmap", 0 with an audience niche yet.
 * Member names and handles are invented (the repo is public).
 */
import type { Draft, Preview } from "./iris-audiences-model"

export const DRAFT_ROADMAP: Draft = {
  bloq: 38,
  segment_id: null,
  name: "",
  filters: [
    { key: "source_post", value: "De9Uw8Ilhne" },
    { key: "comment_contains", value: "roadmap" },
    { key: "niche_in", value: ["Course creator"] },
  ],
  rev: 3,
  saved: null,
  by: "agent",
  updated_at: "2026-11-14T18:00:00.000Z",
}

export const PREVIEW_ROADMAP: Preview = {
  total: 0,
  of: 11341,
  breakdown: [
    { key: "source_post", matched: 849, known: 849, of: 11341 },
    { key: "comment_contains", matched: 788, known: 849, of: 849 },
    { key: "niche_in", matched: 0, known: 0, of: 788 },
  ],
  members: {
    data: [
      { id: 1, handle: "@example.one", name: "Example One", status: "Prospected", comment: "Roadmap", niche: null, role: null, city: null, followers: 0 },
      { id: 2, handle: "@example.two", name: "Example Two", status: "Contacted", comment: "roadmap 🙌", niche: "Course creator", role: "Founder", city: "Austin", followers: 12400 },
      { id: 3, handle: null, name: "Lead 3", status: "Prospected", comment: "", niche: null, role: null, city: null, followers: null },
    ],
    total: 788,
    page: 1,
    last_page: 32,
  },
}
