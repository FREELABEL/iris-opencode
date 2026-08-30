import { describe, expect, test } from "bun:test"
import { withParamSynonyms } from "../src/cli/cmd/platform-run"

/**
 * #182866 — `exec gmail read_emails limit=3` returned ONE message; max_results=3 returned three.
 *
 * The two Gmail services disagree on the parameter's name (fl-api reads `max_results`, iris-api
 * reads `limit`), and a name the backend does not recognise is dropped in silence — the caller
 * gets a 200 and a result that ignored what they asked for.
 *
 * Broadcasting every spelling is what survives not knowing which backend answers. The tests that
 * matter are the ones about NOT overreaching: an explicit value must win, and two different
 * values for the same idea must be left alone rather than silently reconciled.
 */
describe("withParamSynonyms", () => {
  test("limit reaches a backend that only reads max_results", () => {
    expect(withParamSynonyms({ limit: 3 })).toEqual({ limit: 3, max_results: 3, maxResults: 3 })
  })

  test("and the reverse — max_results reaches one that only reads limit", () => {
    expect(withParamSynonyms({ max_results: 3 })).toEqual({ limit: 3, max_results: 3, maxResults: 3 })
  })

  test("a conflict is left ALONE, never reconciled", () => {
    // Two different values for the same idea is the caller being explicit, or the caller being
    // confused. Picking one silently would be this bug again, pointed the other way.
    const out = withParamSynonyms({ limit: 3, max_results: 9 })
    expect(out.limit).toBe(3)
    expect(out.max_results).toBe(9)
    expect(out.maxResults).toBeUndefined()
  })

  test("nothing is invented when the caller supplied nothing", () => {
    expect(withParamSynonyms({})).toEqual({})
  })

  test("unrelated params are untouched", () => {
    const out = withParamSynonyms({ include_body: false, limit: 1 })
    expect(out.include_body).toBe(false)
  })

  test("query broadcasts to q", () => {
    expect(withParamSynonyms({ query: "is:unread" })).toEqual({ query: "is:unread", q: "is:unread" })
  })

  test("an explicit falsy value is respected, not treated as absent", () => {
    // 0 is a legitimate limit. `?? ` semantics would have overwritten it.
    const out = withParamSynonyms({ limit: 0 })
    expect(out.max_results).toBe(0)
  })

  test("does not mutate the caller's object", () => {
    const input = { limit: 2 }
    withParamSynonyms(input)
    expect(input).toEqual({ limit: 2 })
  })
})
