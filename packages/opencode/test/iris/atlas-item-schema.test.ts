import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { AtlasItem } from "../../src/server/routes/instance/httpapi/groups/iris"
import { cardFace } from "../../src/iris/platform"

// The /iris/atlas route ENCODES its answer through this schema, and a schema drops every field
// it does not declare. #190231 0d added `preview` to the sidecar's items and every unit test
// passed — then the panel showed no preview at all, because the route had silently removed it.
// So: every field the sidecar can put on an item must survive the route.
describe("IrisAtlasItem keeps what the sidecar sends", () => {
  test("a card face from a light read, preview included, survives encoding", () => {
    const fromFlApi = {
      id: 7,
      title: "Card",
      due_date: "2026-11-01",
      priority: "high",
      card_type: "task",
      summary: {
        labels: ["a"],
        tasks: { open: 1, done: 2, total: 3 },
        attachments: 1,
        cover: "https://cdn.example/x.png",
        assignees: [{ id: 1, type: "user", user_id: 9, name: "A" }],
        preview: "The start of the body",
      },
    }
    const item = { id: 7, title: "Card", ...cardFace(fromFlApi) }
    const out = Schema.encodeUnknownSync(AtlasItem)(item) as Record<string, unknown>
    for (const k of Object.keys(item)) expect(out).toHaveProperty(k)
    expect(out.preview).toBe("The start of the body")
  })
})

// #190231 phase 1: the panel decides "copy or live, offline or not" from these three fields.
// A route schema that drops them shows a stale copy as if it were live.
import { AtlasResponse } from "../../src/server/routes/instance/httpapi/groups/iris"
describe("IrisAtlasResponse keeps where the board came from", () => {
  test("source, copiedAt and offline survive encoding", () => {
    const answer = {
      measured: true,
      reason: "fetch failed",
      page: 1,
      perPage: 25,
      total: 1,
      totalIsExact: true,
      hasMore: false,
      lists: [],
      source: "copy",
      copiedAt: "2026-10-21T03:00:00.000Z",
      offline: true,
    }
    const out = Schema.encodeUnknownSync(AtlasResponse)(answer) as Record<string, unknown>
    expect(out).toMatchObject({ source: "copy", copiedAt: answer.copiedAt, offline: true })
  })
})

import { BloqsResponse } from "../../src/server/routes/instance/httpapi/groups/iris"
describe("IrisBloqsResponse keeps offline", () => {
  test("offline and copiedAt survive encoding", () => {
    const a = { measured: true, page: 1, perPage: 5, total: 1, totalIsExact: true, hasMore: false, bloqs: [{ id: 1, name: "b" }], offline: true, copiedAt: "2026-10-21T03:00:00.000Z" }
    expect(Schema.encodeUnknownSync(BloqsResponse)(a)).toMatchObject({ offline: true, copiedAt: a.copiedAt })
  })
})
