/**
 * `iris dashboard` — end-to-end against a stub API.
 *
 * WHY A SUBPROCESS AND NOT UNIT TESTS. The bug this suite exists to prevent was invisible to
 * inspection: `irisFetch()` defaults its base URL to FL_API (raichu), and these routes live in
 * IRIS-API. Omitting the third argument sent every request to the wrong service, which returned
 * 404 — indistinguishable from "the route is not deployed yet". Reading the code did not catch it;
 * running the command against a stub caught it in one go.
 *
 * So these tests spawn the REAL CLI, with the REAL argument parser and the REAL fetch path, and
 * point it at a local server. Everything between the shell and the HTTP request is exercised.
 *
 * The base-URL regression is pinned deliberately: IRIS_FL_API_URL is set to a dead port, so if the
 * command ever drifts back to the fl-api default, every test here fails with a connection error
 * rather than passing against the wrong host.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { createServer, type Server } from "node:http"
import { join } from "path"

const CLI = join(import.meta.dir, "../../src/index.ts")

let server: Server
let port = 0
let seen: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req.url ?? "")
    const u = new URL(req.url ?? "/", "http://x")
    res.setHeader("content-type", "application/json")

    if (/\/api\/v1\/dashboard\/[^/]+\/rules$/.test(u.pathname)) {
      return res.end(
        JSON.stringify({
          success: true,
          slug: "pathways-dashboard",
          rules: [
            { rule: "stats", title: "Case Stats", answers: "Total case counts and headline totals.", filters: ["days"] },
            { rule: "ar-ap-aging", title: "AR / AP Aging", answers: "Receivable and payable aging buckets.", filters: ["days"] },
          ],
          catalogue: u.searchParams.get("all")
            ? [
                { rule: "stats", phi: false, exposed: true },
                { rule: "denial-risk", phi: true, exposed: false },
              ]
            : null,
        }),
      )
    }

    const m = u.pathname.match(/\/api\/v1\/dashboard\/([^/]+)\/rules\/([^/]+)$/)
    if (m) {
      if (m[2] === "denial-risk") {
        res.statusCode = 403
        return res.end(JSON.stringify({
          success: false, code: "rule_not_exposed",
          error: "The rule 'denial-risk' exists but it returns patient-identifiable data and is not cleared for this surface.",
        }))
      }
      if (m[2] === "nope") {
        res.statusCode = 404
        return res.end(JSON.stringify({ success: false, code: "unknown_rule", error: "No dashboard rule 'nope'." }))
      }
      return res.end(JSON.stringify({
        success: true,
        data: [{ title: "AR / AP Aging", subtitle: "Aging buckets", summary: { current: "$12,000" }, entries: [1, 2, 3] }],
        meta: { source: "atlas", query: u.search },
      }))
    }

    res.statusCode = 404
    res.end(JSON.stringify({ error: "no route" }))
  })

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  port = (server.address() as any).port
})

afterAll(() => server?.close())

async function iris(args: string[]) {
  seen = []
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: {
      ...process.env,
      IRIS_API_URL: `http://127.0.0.1:${port}`,
      // Dead port. If the command regresses to irisFetch's FL_API default, it lands here and
      // fails loudly instead of silently 404ing against the wrong service.
      IRIS_FL_API_URL: "http://127.0.0.1:1",
      IRIS_API_KEY: "test-key",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  // Strip ANSI so assertions are about content, not colour.
  const clean = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")
  return { exitCode, out: clean(stdout + stderr), requests: [...seen] }
}

describe("iris dashboard rules", () => {
  test("lists the rules with the descriptions a model routes on", async () => {
    const r = await iris(["dashboard", "rules", "pathways-dashboard"])

    expect(r.exitCode).toBe(0)
    expect(r.out).toContain("stats")
    expect(r.out).toContain("ar-ap-aging")
    // The description is what a model reads when deciding whether to call a rule. A listing
    // without it is a listing nothing can route on.
    expect(r.out).toContain("Receivable and payable aging buckets")
    expect(r.out).toContain("filters:")
  })

  test("hits IRIS-API, not fl-api — the base-URL regression", async () => {
    // The whole reason this suite spawns a subprocess. irisFetch defaults to FL_API; these routes
    // are on IRIS_API. With IRIS_FL_API_URL pointed at a dead port, a regression cannot pass.
    const r = await iris(["dashboard", "rules", "pathways-dashboard"])

    expect(r.requests.length).toBeGreaterThan(0)
    expect(r.requests[0]).toBe("/api/v1/dashboard/pathways-dashboard/rules")
  })

  test("defaults the slug so the common case needs no argument", async () => {
    const r = await iris(["dashboard", "rules"])
    expect(r.requests[0]).toBe("/api/v1/dashboard/pathways-dashboard/rules")
  })

  test("--all asks for the closed rules too", async () => {
    const r = await iris(["dashboard", "rules", "pathways-dashboard", "--all"])

    expect(r.requests[0]).toContain("all=1")
    // "That rule exists but is not cleared" is actionable. Silence sends people hunting a typo.
    expect(r.out).toContain("denial-risk")
    expect(r.out).toContain("patient-identifiable")
  })

  test("--json emits parseable JSON", async () => {
    const r = await iris(["dashboard", "rules", "pathways-dashboard", "--json"])
    const start = r.out.indexOf("{")
    expect(start).toBeGreaterThanOrEqual(0)
    const parsed = JSON.parse(r.out.slice(start, r.out.lastIndexOf("}") + 1))
    expect(parsed.rules).toHaveLength(2)
  })
})

describe("iris dashboard get", () => {
  test("renders a rule and exits 0", async () => {
    const r = await iris(["dashboard", "get", "pathways-dashboard", "ar-ap-aging"])

    expect(r.exitCode).toBe(0)
    expect(r.out).toContain("AR / AP Aging")
    expect(r.out).toContain("$12,000")
  })

  test("passes --filter through as query parameters", async () => {
    const r = await iris(["dashboard", "get", "pathways-dashboard", "ar-ap-aging", "--filter", "days=90"])

    expect(r.requests[0]).toContain("days=90")
  })

  test("supports repeated --filter", async () => {
    const r = await iris([
      "dashboard", "get", "pathways-dashboard", "ar-ap-aging",
      "--filter", "days=90", "--filter", "search=acme",
    ])

    expect(r.requests[0]).toContain("days=90")
    expect(r.requests[0]).toContain("search=acme")
  })

  test("splits a filter on the FIRST = so values may contain one", async () => {
    // Assert the RAW query string, not the decoded one. Decoding is what made the first version
    // of this test vacuous: splitting on the last '=' yields key "q=a" value "b" -> "q%3Da=b",
    // and splitting on the first yields key "q" value "a=b" -> "q=a%3Db". Both decode to the
    // identical "q=a=b", so a decoded assertion cannot tell the correct behaviour from the bug.
    const r = await iris(["dashboard", "get", "pathways-dashboard", "ar-ap-aging", "--filter", "q=a=b"])

    expect(r.requests[0]).toContain("q=a%3Db")
    expect(r.requests[0]).not.toContain("q%3Da=b")
  })

  test("EXITS NON-ZERO when a PHI rule is refused", async () => {
    // The refusal must be a failure at the shell level too, or `iris dashboard get … && next`
    // runs `next` on a rule that returned nothing.
    const r = await iris(["dashboard", "get", "pathways-dashboard", "denial-risk"])

    expect(r.exitCode).not.toBe(0)
    // And the server's reason is surfaced verbatim, not collapsed into a generic failure.
    expect(r.out).toContain("patient-identifiable")
    expect(r.out).toContain("rule_not_exposed")
  })

  test("EXITS NON-ZERO on an unknown rule, and says which", async () => {
    const r = await iris(["dashboard", "get", "pathways-dashboard", "nope"])

    expect(r.exitCode).not.toBe(0)
    expect(r.out).toContain("unknown_rule")
  })

  test("distinguishes a refusal from a not-found — different codes, both non-zero", async () => {
    // Collapsing these is how somebody spends an afternoon looking for a typo in a rule name that
    // is spelled correctly and simply not cleared.
    const refused = await iris(["dashboard", "get", "pathways-dashboard", "denial-risk"])
    const missing = await iris(["dashboard", "get", "pathways-dashboard", "nope"])

    expect(refused.out).toContain("rule_not_exposed")
    expect(missing.out).toContain("unknown_rule")
    expect(refused.out).not.toContain("unknown_rule")
  })

  test("--json emits parseable JSON on success", async () => {
    const r = await iris(["dashboard", "get", "pathways-dashboard", "ar-ap-aging", "--json"])
    const parsed = JSON.parse(r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1))
    expect(parsed.success).toBe(true)
    expect(parsed.data[0].title).toBe("AR / AP Aging")
  })
})

/**
 * summaryPairs — the 44 rules do not agree on a shape.
 *
 * Found on the FIRST live run against production: `stats` returns summary as an ARRAY of
 * { label, value, icon, color } tiles, while `ar-ap-aging` returns a flat map. Object.entries()
 * on the array form yields index -> object and printed "[object Object]" four times where the
 * real answer was 2,143 active cases and $16,396,106 of pipeline.
 *
 * No amount of stub-testing would have caught this; only real data has the other shape.
 */
import { summaryPairs } from "../../src/cli/cmd/platform-dashboard-rules"

describe("summaryPairs", () => {
  test("renders the ARRAY-of-tiles shape that `stats` actually returns", () => {
    const real = [
      { label: "Active Cases", value: 2143, icon: "folder", color: "blue" },
      { label: "Pipeline Value", value: "$16,396,106", icon: "currency-dollar", color: "emerald" },
    ]
    expect(summaryPairs(real)).toEqual([
      ["Active Cases", "2143"],
      ["Pipeline Value", "$16,396,106"],
    ])
  })

  test("renders the FLAT-MAP shape too", () => {
    expect(summaryPairs({ current: "$12,000", "30d": "$4,500" })).toEqual([
      ["current", "$12,000"],
      ["30d", "$4,500"],
    ])
  })

  test("NEVER emits [object Object] — the bug this exists to prevent", () => {
    const nasty: unknown[] = [
      [{ label: "Nested", value: { a: 1 } }],
      { top: { deep: true } },
      [{ label: "Missing" }],
      [null, undefined, 5],
      {},
      [],
      null,
      "not an object",
    ]
    for (const s of nasty) {
      for (const [k, v] of summaryPairs(s)) {
        expect(k).not.toContain("[object")
        expect(v).not.toContain("[object")
      }
    }
  })

  test("falls back across label/title/key and value/amount/count", () => {
    expect(summaryPairs([{ title: "T", amount: 7 }])).toEqual([["T", "7"]])
    expect(summaryPairs([{ key: "K", count: 3 }])).toEqual([["K", "3"]])
  })

  test("marks a nested value rather than rendering noise", () => {
    expect(summaryPairs([{ label: "L", value: { a: 1 } }])).toEqual([["L", "(nested — use --json)"]])
  })

  test("survives null, undefined and non-objects without throwing", () => {
    expect(summaryPairs(null)).toEqual([])
    expect(summaryPairs(undefined)).toEqual([])
    expect(summaryPairs("x")).toEqual([])
    expect(summaryPairs(42)).toEqual([])
  })
})
