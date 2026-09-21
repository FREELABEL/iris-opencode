import { describe, expect, test } from "bun:test"
import { FL_API, IRIS_API } from "./platform"
import * as Platform from "./platform"

/**
 * These do not call the network. The live check is `probe.ts`, run by hand against a signed-in
 * machine — a unit test that needs an account is a test that fails in CI for the wrong reason.
 *
 * What IS worth locking down is the thing that silently breaks: the two backends are different
 * services and a call to the wrong one 404s rather than erroring, so a base URL swapped by a
 * careless edit looks like missing data.
 */
describe("platform base urls", () => {
  test("fl-api and iris-api are different hosts", () => {
    expect(FL_API).not.toBe(IRIS_API)
  })

  test("neither base ends in a slash — paths are joined raw", () => {
    expect(FL_API.endsWith("/")).toBe(false)
    expect(IRIS_API.endsWith("/")).toBe(false)
  })
})

import { flattenTasks, itemPatchBody, readItemDoc, readItemTask } from "./platform"

describe("card editor — the wire mapping (#185485)", () => {
  test("cardType reaches fl-api as card_type, never as the type enum", () => {
    // Elon's "Type" pill is the card_type column. `type` is a different, six-value enum
    // (default/research/content/diary/vehicle/task) and writing "bug" to it 422s.
    const body = itemPatchBody({ cardType: "bug", priority: "high", listId: 1776, dueDate: null, status: "todo" })
    expect(body).toEqual({ card_type: "bug", priority: "high", bloq_list_id: 1776, due_date: null, status: "todo" })
    expect(body).not.toHaveProperty("type")
  })

  test("a structured body is MERGED; a markdown body is replaced", () => {
    expect(itemPatchBody({ body: "hi", bodyMode: "merge" })).toEqual({ content_merge: { text: "hi", body: "hi" } })
    expect(itemPatchBody({ body: "hi", bodyMode: "replace" })).toEqual({ content: "hi" })
    expect(itemPatchBody({ body: "hi" })).toEqual({ content: "hi" })
  })

  test("only fields present are sent — a title save cannot blank a body", () => {
    expect(itemPatchBody({ title: "T" })).toEqual({ title: "T" })
    expect(itemPatchBody({})).toEqual({})
  })

  test("a JSON-object content string reads as structured, with its text and labels", () => {
    const doc = readItemDoc({
      id: 1,
      title: "x",
      content: JSON.stringify({ text: "the body", labels: [{ id: "bug", name: "Bug" }, "custom"], assignedAgents: [701] }),
      card_type: "bug",
      bloq_list_id: "1776",
      due_date: "2026-09-20T00:00:00.000000Z",
    })
    expect(doc.contentKind).toBe("structured")
    expect(doc.content).toBe("the body")
    expect(doc.labels).toEqual(["Bug", "custom"])
    expect(doc.cardType).toBe("bug")
    expect(doc.listId).toBe(1776)
    expect(doc.dueDate).toBe("2026-09-20")
  })

  test("a markdown string — even one containing braces — reads as markdown, untouched", () => {
    const md = "# Title\n\nSome `{code}` here"
    const doc = readItemDoc({ id: 2, title: "y", content: md })
    expect(doc.contentKind).toBe("markdown")
    expect(doc.content).toBe(md)
    expect(doc.labels).toEqual([])
  })

  test("a task keeps its agent's id and name and drops the rest of the agent", () => {
    const t = readItemTask({
      id: 1234,
      title: "Define goals",
      is_completed: true,
      agent_id: 701,
      agent: { id: 701, name: "XArt Chief of Staff", config: { system_prompt: "SECRET" } },
    })
    expect(t).toMatchObject({ id: 1234, done: true, agentId: 701, agentName: "XArt Chief of Staff", depth: 0 })
    expect(JSON.stringify(t)).not.toContain("SECRET")
  })

  test("getTasks' tree flattens in reading order with depth", () => {
    const flat = flattenTasks([
      { id: 1, title: "a", children: [{ id: 2, title: "a.1", children: [] }] },
      { id: 3, title: "b" },
    ])
    expect(flat.map((t) => [t.id, t.depth])).toEqual([
      [1, 0],
      [2, 1],
      [3, 0],
    ])
  })
})

describe("allowance — the client holds no policy (#186457)", () => {
  const withFetch = async (impl: typeof fetch, fn: () => Promise<void>) => {
    const real = globalThis.fetch
    globalThis.fetch = impl
    try {
      await fn()
    } finally {
      globalThis.fetch = real
    }
  }
  const ok = (body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch

  test("every number comes off the wire, including the thresholds", async () => {
    await withFetch(
      ok({
        window: "week",
        cap_usd: 5,
        uncapped: false,
        spend_usd: 4.6,
        fraction: 0.92,
        resets_at: "2026-09-28T00:00:00+00:00",
        thresholds: [0.9],
        once_per_window: true,
        surface: "chat",
        upgrade_url: "https://web.heyiris.io/pricing?source=desktop-limit",
        notice: null,
      }),
      async () => {
        const r = await Platform.fetchAllowance()
        expect(r.measured).toBe(true)
        expect(r.data.window).toBe("week")
        expect(r.data.capUsd).toBe(5)
        expect(r.data.fraction).toBe(0.92)
        // The rung list is DATA. If this ever becomes a constant in the client, a policy
        // change needs a desktop release, which is the bug this whole shape avoids.
        expect(r.data.thresholds).toEqual([0.9])
      },
    )
  })

  test("a DIFFERENT rung list comes through unchanged — the client cannot be holding one", async () => {
    // This test exists because the obvious version of it is vacuous. Asserting [0.9] arrives
    // when the server sent [0.9] passes just as happily against a client that hardcodes 0.9,
    // which is the exact defect the design is built to prevent. Mutation-checked: replacing
    // the wire read with `thresholds: [0.9]` fails HERE and nowhere else.
    await withFetch(ok({ window: "month", cap_usd: 40, fraction: 0.3, thresholds: [0.25, 0.5, 0.75] }), async () => {
      const r = await Platform.fetchAllowance()
      expect(r.data.thresholds).toEqual([0.25, 0.5, 0.75])
      expect(r.data.window).toBe("month")
      expect(r.data.capUsd).toBe(40)
    })
  })

  test("a pending notice is carried through with its own numbers", async () => {
    await withFetch(
      ok({
        window: "week",
        cap_usd: 5,
        fraction: 0.92,
        thresholds: [0.9],
        notice: {
          threshold: 0.9,
          fraction: 0.92,
          spend_usd: 4.6,
          cap_usd: 5,
          window: "week",
          resets_at: "2026-09-28T00:00:00+00:00",
          upgrade_url: "https://web.heyiris.io/pricing?source=desktop-limit",
        },
      }),
      async () => {
        const r = await Platform.fetchAllowance()
        expect(r.data.notice?.threshold).toBe(0.9)
        expect(r.data.notice?.spendUsd).toBe(4.6)
        expect(r.data.notice?.resetsAt).toBe("2026-09-28T00:00:00+00:00")
      },
    )
  })

  test("uncapped is a flag, not a zero", async () => {
    // A UI that renders a null fraction as an empty bar tells an unlimited account it has
    // spent nothing of nothing. The distinction has to survive the wire.
    await withFetch(ok({ window: "week", cap_usd: null, uncapped: true, fraction: null, thresholds: [0.9] }), async () => {
      const r = await Platform.fetchAllowance()
      expect(r.data.uncapped).toBe(true)
      expect(r.data.fraction).toBeNull()
      expect(r.data.capUsd).toBeNull()
    })
  })

  test("an unreachable server is NOT an account at zero percent", async () => {
    await withFetch((async () => new Response("nope", { status: 503 })) as unknown as typeof fetch, async () => {
      const r = await Platform.fetchAllowance()
      expect(r.measured).toBe(false)
      expect(r.reason).toContain("503")
      expect(r.data.fraction).toBeNull()
      expect(r.data.notice).toBeNull()
    })
  })
})
