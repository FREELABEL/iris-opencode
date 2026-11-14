import { describe, expect, test } from "bun:test"
import { buildListEnvelope, projectFields, LIST_FIELDS } from "../../src/cli/cmd/list-envelope"

/**
 * TDD for the two data-contract defects found on 2026-08-17.
 *
 * DEFECT 1 — truncation is invisible.
 *   `bloqs list --json` returns 20 records as a FLAT ARRAY. The account has 137.
 *   Nothing in the payload says so, so a model reading it concludes it has
 *   everything — and then confidently answers "your family project is #602",
 *   missing #200, #137, #544 and #584, all of which live in the other 117.
 *   The API DOES send pagination metadata; the CLI drops it on the floor.
 *
 * DEFECT 2 — `list` has no field contract.
 *   `bloqs list --json`  = 20 records x  4 fields =   2,290 bytes.
 *   `agents list --json` = 30 records x 72 fields = 145,395 bytes.
 *   Same verb, 63x apart. The second overflows every time, forcing a
 *   spill -> jq -> narrow round-trip to answer "what agents do I have".
 *
 * These are not model failures. A tool that returns 15% of the data while
 * looking complete will defeat any model, and one that returns 145KB for a
 * listing will make even a good one work hard for an easy answer.
 */

describe("buildListEnvelope — truncation must declare itself", () => {
  test("reports returned and total, and flags truncation", () => {
    const env = buildListEnvelope(new Array(20).fill({ id: 1 }), { total: 137, limit: 20 })
    expect(env.meta.returned).toBe(20)
    expect(env.meta.total).toBe(137)
    expect(env.meta.truncated).toBe(true)
  })

  test("is NOT truncated when everything fits", () => {
    const env = buildListEnvelope(new Array(11).fill({ id: 1 }), { total: 11, limit: 20 })
    expect(env.meta.truncated).toBe(false)
    expect(env.meta.hint).toBeUndefined()
  })

  test("infers truncation when the server sends no total but the page is full", () => {
    // A full page is the only evidence available that more may exist. Claiming
    // "complete" here is the exact failure being fixed, so assume more.
    const env = buildListEnvelope(new Array(20).fill({ id: 1 }), { limit: 20 })
    expect(env.meta.truncated).toBe(true)
    expect(env.meta.total).toBeUndefined()
  })

  test("a short page with no total is complete", () => {
    const env = buildListEnvelope(new Array(7).fill({ id: 1 }), { limit: 20 })
    expect(env.meta.truncated).toBe(false)
  })

  test("the hint names a REAL escape, not just the fact of truncation", () => {
    // "there is more" without "here is how to get it" still leaves the agent
    // guessing, and guessing is what produced the wrong answer.
    const env = buildListEnvelope(new Array(20).fill({ id: 1 }), { total: 137, limit: 20, resource: "bloqs" })
    expect(env.meta.hint).toContain("--limit")
    expect(env.meta.hint).toContain("search")
  })

  test("keeps the rows under `data`, unchanged", () => {
    const rows = [{ id: 602, name: "Mia Mayo — Life Atlas" }]
    const env = buildListEnvelope(rows, { total: 137, limit: 20 })
    expect(env.data).toEqual(rows)
  })

  test("handles an empty result without claiming truncation", () => {
    const env = buildListEnvelope([], { total: 0, limit: 20 })
    expect(env.meta.returned).toBe(0)
    expect(env.meta.truncated).toBe(false)
  })
})

describe("projectFields — `list` returns identity, not everything", () => {
  const agent = {
    id: 703, name: "MODEL BENCH", type: "assistant", active: true,
    config: { a: 1 }, settings: { b: 2 }, stats: { c: 3 },
    google_workspace_groups: [], initial_prompt: "x".repeat(4000),
    personality_traits: {}, v7_config: {}, updated_at: "2026-08-17",
  }

  test("keeps only the allowed fields", () => {
    const [out] = projectFields([agent], ["id", "name", "type", "active"])
    expect(Object.keys(out).sort()).toEqual(["active", "id", "name", "type"])
  })

  test("drops the heavy blobs that make a listing 145KB", () => {
    const [out] = projectFields([agent], LIST_FIELDS.agents)
    expect(out).not.toHaveProperty("initial_prompt")
    expect(out).not.toHaveProperty("config")
    expect(out).not.toHaveProperty("settings")
    expect(out).not.toHaveProperty("v7_config")
  })

  test("ALWAYS keeps id, even if the caller forgets it", () => {
    // Without an id the row cannot be followed up with `get`, which makes a
    // listing useless rather than merely lean.
    const [out] = projectFields([agent], ["name"])
    expect(out).toHaveProperty("id", 703)
  })

  test("ignores requested fields the record does not have", () => {
    const [out] = projectFields([agent], ["id", "name", "does_not_exist"])
    expect(out).not.toHaveProperty("does_not_exist")
    expect(out).toHaveProperty("name")
  })

  test("returns rows untouched when no field list is given", () => {
    // `get` must keep returning everything — the contract is about `list`.
    const [out] = projectFields([agent], undefined)
    expect(Object.keys(out).length).toBe(Object.keys(agent).length)
  })

  test("every LIST_FIELDS set is small enough to be a listing", () => {
    // The rule this encodes: identity + a few discriminators. If a set grows past
    // this, it has stopped being a listing and should be a `get`.
    for (const [resource, fields] of Object.entries(LIST_FIELDS)) {
      expect(fields.length).toBeLessThanOrEqual(8)
      expect(fields).toContain("id")
      expect(fields, `${resource} needs a human-readable label`).toSatisfy(
        (f: string[]) => f.includes("name") || f.includes("title"),
      )
    }
  })

  test("the agents projection actually collapses the payload", () => {
    // The measured defect: 30 agents x 72 fields = 145,395 bytes.
    const many = new Array(30).fill(agent)
    const before = JSON.stringify(many).length
    const after = JSON.stringify(projectFields(many, LIST_FIELDS.agents)).length
    expect(after).toBeLessThan(before / 10)
  })
})
