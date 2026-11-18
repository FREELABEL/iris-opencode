import { describe, test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, chmodSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawnSync } from "child_process"

import {
  buildHiveSearchScript,
  parseHiveSearchOutput,
  discoverBusinesses,
  HiveSearchError,
  RESULT_MARKER,
} from "./hive-maps-search"
import { dispatchHiveSearchDetailed } from "./platform-venues"

const ctx = { node: "fake-node", query: "coffee shops in Austin TX" }

// The exact output iris-hive-002 returned on 2026-10-29 (task 01a18599-6fd) for the field audit's
// query. The CLI read this as "found 0 business(es)".
const FIELD_OUTPUT = [
  "[stderr] [eval]:4",
  '[stderr]   try { r = JSON.parse(s); } catch (e) { process.stderr.write("[venue-search] unparseable eval output',
  "[stderr]                                                               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^",
  "[stderr] SyntaxError: Invalid or unexpected token",
  "[stderr] Node.js v22.11.0",
].join("\n")

/**
 * Run the REAL generated script with a fake `npx` first on PATH that plays agent-browser. This is
 * the only kind of check that sees the script as bash and node see it — the original bug was an
 * escape that a TypeScript template literal turned into a newline, invisible to reading the code.
 */
function runScript(fake: { open?: "ok" | "fail"; eval?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "hive-maps-"))
  const evalOut = join(dir, "eval.json")
  writeFileSync(evalOut, fake.eval ?? "")
  writeFileSync(
    join(dir, "npx"),
    `#!/bin/bash
# npx --yes agent-browser <cmd> ...
shift; shift
case "$1" in
  open) ${fake.open === "fail" ? 'echo "✗ Auto-launch failed: Chrome exited early — No usable sandbox!" >&2; exit 1' : 'echo "✓ Google Maps"; exit 0'} ;;
  eval) cat > "${dir}/page.js"; cat "${evalOut}" ;;
  *) exit 0 ;;
esac
`,
  )
  chmodSync(join(dir, "npx"), 0o755)
  writeFileSync(join(dir, "s.sh"), buildHiveSearchScript(ctx.query, 5))
  const r = spawnSync("bash", [join(dir, "s.sh")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  })
  const page = (() => {
    try {
      return require("fs").readFileSync(join(dir, "page.js"), "utf8") as string
    } catch {
      return ""
    }
  })()
  return { out: r.stdout + r.stderr.split("\n").map((l) => (l ? `[stderr] ${l}` : l)).join("\n"), code: r.status, page }
}

const okEval = (feed: number, rows: any[]) =>
  JSON.stringify({ success: true, data: { result: { feed, rows, title: "coffee shops in Austin TX - Google Maps", url: "https://www.google.com/maps/search/x" } }, error: null })

describe("the Google Maps script, run for real with a fake agent-browser", () => {
  test("its result reader parses (the field bug: a SyntaxError on every node) and returns the rows", () => {
    const rows = [{ name: "Epoch Coffee", rating: "4.5", address: "221 W N Loop Blvd", source: "google-maps" }]
    const { out } = runScript({ eval: okEval(7, rows) })
    expect(out).not.toContain("SyntaxError")
    const r = parseHiveSearchOutput(out, ctx)
    expect(r.rows.map((x) => x.name)).toEqual(["Epoch Coffee"])
    expect(r.feed).toBe(7)
  })

  test("the page-side extractor it sends is valid JavaScript (a split('\\n') must not become a raw newline)", () => {
    const { page } = runScript({ eval: okEval(0, []) })
    expect(page).toContain("split('\\n')")
    expect(() => new Function(`return ${page}`)).not.toThrow()
  })

  test("a browser that cannot open is named, with the install command — not 0 results", () => {
    const { out } = runScript({ open: "fail" })
    expect(() => parseHiveSearchOutput(out, ctx)).toThrow(/agent-browser.*No usable sandbox.*npx --yes agent-browser install/s)
  })

  test("agent-browser reporting an eval failure is named, not read as an empty page", () => {
    const { out } = runScript({ eval: JSON.stringify({ success: false, data: null, error: "Auto-launch failed" }) })
    expect(() => parseHiveSearchOutput(out, ctx)).toThrow(/could not drive a browser.*Auto-launch failed/)
  })

  test("a node without npx says so", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-maps-nonode-"))
    writeFileSync(join(dir, "s.sh"), buildHiveSearchScript(ctx.query, 5))
    // bash and nothing else: no node, no npx
    const r = spawnSync("/bin/bash", [join(dir, "s.sh")], { encoding: "utf8", env: { PATH: "/nonexistent", HOME: dir } })
    expect(() => parseHiveSearchOutput(r.stdout, ctx)).toThrow(/missing node.*Install/)
  })
})

describe("parseHiveSearchOutput never turns 'could not tell' into []", () => {
  test("the exact field output (crashed reader, no result line) throws instead of returning []", () => {
    expect(() => parseHiveSearchOutput(FIELD_OUTPUT, ctx)).toThrow(HiveSearchError)
    expect(() => parseHiveSearchOutput(FIELD_OUTPUT, ctx)).toThrow(/reported no result.*SyntaxError/)
  })
  test("a rendered feed with no extracted rows is stale selectors, not an empty market", () => {
    const line = `${RESULT_MARKER}${JSON.stringify({ ok: true, feed: 12, rows: [] })}`
    expect(() => parseHiveSearchOutput(line, ctx)).toThrow(/selectors changed/)
  })
  test("a Google consent/robot page is reported as such", () => {
    const line = `${RESULT_MARKER}${JSON.stringify({ ok: true, feed: 0, rows: [], url: "https://consent.google.com/m?continue=x" })}`
    expect(() => parseHiveSearchOutput(line, ctx)).toThrow(/consent\/robot-check/)
  })
})

describe("discover with a fake provider: 0 results are explained", () => {
  test("an empty provider answer comes back with the provider and the query named", async () => {
    const r = await discoverBusinesses(async () => ({ rows: [], feed: 0, title: "Google Maps" }), { ...ctx, limit: 10 })
    expect(r.businesses).toEqual([])
    expect(r.empty_reason).toMatch(/No results from Google Maps \(via Hive node fake-node\) for "coffee shops in Austin TX"/)
  })
  test("results come back without an empty reason, capped at the limit", async () => {
    const r = await discoverBusinesses(async () => ({ rows: [{ name: "a" }, { name: "b" }, { name: "c" }] }), { ...ctx, limit: 2 })
    expect(r.businesses.length).toBe(2)
    expect(r.empty_reason).toBeNull()
  })
  test("a provider failure propagates — it is never laundered into an empty list", async () => {
    await expect(
      discoverBusinesses(async () => parseHiveSearchOutput(FIELD_OUTPUT, ctx), { ...ctx, limit: 10 }),
    ).rejects.toThrow(/reported no result/)
  })

  test("the real dispatcher, given the field task output by a fake API, throws instead of returning []", async () => {
    const fakeFetch = (async (url: string) => {
      if (url.endsWith("/api/v6/nodes/tasks")) return new Response(JSON.stringify({ task: { id: "t1", status: "pending" } }))
      return new Response(JSON.stringify({ task: { id: "t1", status: "completed", output: FIELD_OUTPUT } }))
    }) as any
    await expect(
      dispatchHiveSearchDetailed({ id: "n1", name: "fake-node" }, ctx.query, 5, { fetch: fakeFetch, userId: 1, pollMs: 1 }),
    ).rejects.toThrow(/reported no result/)
  })

  test("a WORKING scrape whose task result is an object {output, metadata} returns its rows (the old reader made this [])", async () => {
    const line = `${RESULT_MARKER}${JSON.stringify({ ok: true, feed: 2, rows: [{ name: "Epoch Coffee" }, { name: "Mozart's Coffee Roasters" }] })}`
    const fakeFetch = (async (url: string) => {
      if (url.endsWith("/api/v6/nodes/tasks")) return new Response(JSON.stringify({ task: { id: "t1", status: "pending" } }))
      return new Response(
        JSON.stringify({ task: { id: "t1", status: "completed", output: null, result: { output: line, metadata: { exit_code: 0 }, duration_ms: 16063 } } }),
      )
    }) as any
    const r = await dispatchHiveSearchDetailed({ id: "n1", name: "fake-node" }, ctx.query, 5, { fetch: fakeFetch, userId: 1, pollMs: 1 })
    expect(r.rows.map((x) => x.name)).toEqual(["Epoch Coffee", "Mozart's Coffee Roasters"])
  })

  test("a FAILED task that carries a named missing dependency surfaces that dependency", async () => {
    const out = `${RESULT_MARKER}{"ok":false,"error":"missing_dependency","dependency":"npx","install":"install Node.js 20+"}`
    const fakeFetch = (async (url: string) => {
      if (url.endsWith("/api/v6/nodes/tasks")) return new Response(JSON.stringify({ task: { id: "t1", status: "pending" } }))
      return new Response(JSON.stringify({ task: { id: "t1", status: "failed", output: out } }))
    }) as any
    await expect(
      dispatchHiveSearchDetailed({ id: "n1", name: "fake-node" }, ctx.query, 5, { fetch: fakeFetch, userId: 1, pollMs: 1 }),
    ).rejects.toThrow(/missing npx.*Install: install Node.js 20\+/)
  })
})
