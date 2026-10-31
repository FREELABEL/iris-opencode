import { describe, expect, test } from "bun:test"
import path from "path"
import { ITEMS_MAX_PER_PAGE, paginationErrors } from "./platform-bloqs"

/**
 * #191846 — `iris bloqs items <bloq> --limit 0|-1 --page 0|-1 --json` all succeeded with the
 * pagination silently changed (limit 0 → 50 items, limit -1 → per_page 1, page 0|-1 → page 1).
 * A script paging that way got duplicated or missed records while believing it had paged
 * correctly. Bad values are now refused before the request is made.
 */
describe("paginationErrors", () => {
  test("accepts positive whole numbers within the cap", () => {
    expect(paginationErrors({ limit: 1, page: 1 }, { maxLimit: ITEMS_MAX_PER_PAGE })).toBeNull()
    expect(paginationErrors({ limit: ITEMS_MAX_PER_PAGE, page: 7 }, { maxLimit: ITEMS_MAX_PER_PAGE })).toBeNull()
    expect(paginationErrors({})).toBeNull()
  })

  for (const limit of [0, -1, 1.5, Number.NaN, ITEMS_MAX_PER_PAGE + 1]) {
    test(`refuses --limit ${limit}`, () => {
      const errors = paginationErrors({ limit, page: 1 }, { maxLimit: ITEMS_MAX_PER_PAGE })
      expect(errors?.limit?.[0]).toContain("--limit")
      expect(errors?.page).toBeUndefined()
    })
  }

  for (const page of [0, -1, 2.5, Number.NaN]) {
    test(`refuses --page ${page}`, () => {
      const errors = paginationErrors({ limit: 1, page }, { maxLimit: ITEMS_MAX_PER_PAGE })
      expect(errors?.page?.[0]).toContain("--page")
      expect(errors?.limit).toBeUndefined()
    })
  }

  test("no cap when none is given", () => {
    expect(paginationErrors({ limit: 5000 })).toBeNull()
    expect(paginationErrors({ limit: 0 })?.limit).toBeDefined()
  })
})

describe("iris bloqs items refuses bad pagination before any request", () => {
  const entry = path.join(import.meta.dir, "../../index.ts")
  // No network is touched: validation runs before auth, so an unreachable API proves it.
  const run = (...argv: string[]) => {
    const p = Bun.spawnSync([process.execPath, "run", entry, ...argv], {
      env: { ...process.env, NO_COLOR: "1", IRIS_API_URL: "http://127.0.0.1:9", FL_API_URL: "http://127.0.0.1:9" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    return { code: p.exitCode, stdout: p.stdout.toString() }
  }

  const cases: Array<[string[], "limit" | "page"]> = [
    // The helper above covers every bad value; these prove the command is wired to it.
    [["--limit", "0"], "limit"],
    [["--page", "-1", "--limit", "1"], "page"],
  ]
  for (const [flags, field] of cases) {
    test(`${flags.join(" ")} --json → JSON error on stdout, non-zero exit`, () => {
      const { code, stdout } = run("bloqs", "items", "754", ...flags, "--json")
      expect(code).not.toBe(0)
      const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? ""
      const body = JSON.parse(line)
      expect(body.success).toBe(false)
      expect(body.errors[field][0]).toContain(`--${field}`)
    }, 120_000)
  }
})
