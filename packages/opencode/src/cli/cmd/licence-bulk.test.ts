import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import yargs from "yargs"
import { UI } from "../ui"
import { LicenceCommand, bulkRowLine, leadToBulkRow, maskKey, parseBulkCsv } from "./licence"

/** #191971: preview by default, explicit --yes, keys never printed. Tests drive the real yargs tree. */
const realFetch = globalThis.fetch
const realWrite = process.stdout.write
const KEY = "IRIS-ABCD-EFGH-JKMN"
let requests: { url: string; body: any }[] = []
let posts: any[] = []
let printed: string[] = []
let stdout = ""
let spy: any
let leadPages: Record<string, unknown> = {}
const dir = mkdtempSync(join(tmpdir(), "licence-bulk-"))
let n = 0

const parse = (argv: string[]) =>
  yargs(argv)
    .command({ ...(LicenceCommand as any) })
    .demandCommand()
    .exitProcess(false)
    .fail((msg: string, err: Error) => {
      throw err ?? new Error(msg)
    })
    .parseAsync()

const file = (text: string) => {
  const p = join(dir, `people-${n++}.csv`)
  writeFileSync(p, text)
  return p
}
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const previewOk = { issued: false, counts: { would_issue: 1 }, rows: [{ row: 1, email: "a@x.test", status: "would_issue", lead_id: 7, seat_cap_cents: 500 }] }
const issuedOk = { issued: true, counts: { issued: 1 }, rows: [{ row: 1, email: "a@x.test", status: "issued", lead_id: 7, key: KEY }] }
let bulkReply: (confirm: boolean) => Response

beforeEach(() => {
  requests = []
  posts = []
  printed = []
  stdout = ""
  leadPages = {}
  process.exitCode = 0
  spy = spyOn(UI, "println").mockImplementation((...m: any[]) => void printed.push(m.join(" ")))
  process.stdout.write = ((chunk: any, ...rest: any[]) => {
    stdout += String(chunk)
    rest.find((r) => typeof r === "function")?.()
    return true
  }) as any
  bulkReply = (confirm) => (confirm ? reply(201, issuedOk) : reply(200, previewOk))
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url))
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ url: String(url), body })
    if (u.pathname.endsWith("/licences/bulk")) {
      posts.push(body)
      return bulkReply(body.confirm)
    }
    return reply(200, leadPages[u.searchParams.get("page") ?? "1"] ?? {})
  }) as any
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.IRIS_USER_ID
  process.stdout.write = realWrite
  spy.mockRestore()
  process.exitCode = 0
})

const person = () => file("email,lead\na@x.test,7\n")

test("without --yes it previews once and issues nothing", async () => {
  await parse(["licence", "issue-bulk", "--file", person(), "--seat-cap", "500"])
  expect(posts.map((p) => p.confirm)).toEqual([false])
  expect(posts[0].seat_cap_cents).toBe(500)
  expect(posts[0].rows).toEqual([{ email: "a@x.test", lead_id: 7 }])
  expect(printed.join("\n")).toContain("would issue")
})

test("--yes previews first, then issues", async () => {
  await parse(["licence", "issue-bulk", "--file", person(), "--yes"])
  expect(posts.map((p) => p.confirm)).toEqual([false, true])
})

test("a problem in the preview stops --yes before anything is issued, and exits non-zero", async () => {
  bulkReply = () => reply(422, { issued: false, counts: { problem: 1 }, rows: [{ row: 1, email: "x", status: "problem", problems: ["no lead"] }] })
  await parse(["licence", "issue-bulk", "--file", person(), "--yes"])
  expect(posts.map((p) => p.confirm)).toEqual([false])
  expect(process.exitCode).toBe(1)
  expect(printed.join("\n")).toContain("PROBLEM: no lead")
})

test("a refusal at issue, after a clean preview, exits non-zero", async () => {
  bulkReply = (confirm) => (confirm ? reply(409, { success: false, reason: "Another bulk issue is running." }) : reply(200, previewOk))
  await parse(["licence", "issue-bulk", "--file", person(), "--yes"])
  expect(process.exitCode).toBe(1)
})

test("a non-operator sees the usual not-found", async () => {
  bulkReply = () => reply(404, { error: "not_found" })
  await parse(["licence", "issue-bulk", "--file", person(), "--yes"])
  expect(posts.length).toBe(1)
  expect(process.exitCode).toBe(1)
})

test("the key is never printed, as text or as JSON", async () => {
  await parse(["licence", "issue-bulk", "--file", person(), "--yes"])
  expect(printed.join("\n")).not.toContain(KEY)
  expect(printed.join("\n")).toContain("IRIS-****-JKMN")
  printed = []
  await parse(["licence", "issue-bulk", "--file", person(), "--yes", "--json"])
  expect(stdout).not.toContain(KEY)
  expect(JSON.parse(stdout).rows[0].key).toBe("IRIS-****-JKMN")
})

test("--keys-file holds the keys, readable only by the owner", async () => {
  const out = join(dir, `keys-${n++}.csv`)
  await parse(["licence", "issue-bulk", "--file", person(), "--yes", "--keys-file", out])
  expect(readFileSync(out, "utf8")).toContain(`a@x.test,${KEY},issued`)
  expect(statSync(out).mode & 0o777).toBe(0o600)
})

test("a --keys-file that exists is refused before any request", async () => {
  await parse(["licence", "issue-bulk", "--file", person(), "--yes", "--keys-file", person()])
  expect(requests).toEqual([])
  expect(process.exitCode).toBe(1)
})

test("exactly one source is required, and a missing file is refused", async () => {
  await parse(["licence", "issue-bulk"])
  await parse(["licence", "issue-bulk", "--file", person(), "--tag", "x"])
  await parse(["licence", "issue-bulk", "--file", join(dir, "absent.csv")])
  expect(requests).toEqual([])
  expect(process.exitCode).toBe(1)
})

test("--tag reads every page and uses each lead's own address", async () => {
  leadPages = {
    "1": { data: { data: [{ id: 1, email: "a@x.test" }], last_page: 2 } },
    "2": { data: { data: [{ id: 2, contact_info: { email: "b@x.test" } }, { id: 3 }], last_page: 2 } },
  }
  await parse(["licence", "issue-bulk", "--tag", "vip list"])
  expect(new URL(requests[0].url).searchParams.get("tag")).toBe("vip list")
  expect(posts[0].rows).toEqual([{ email: "a@x.test", lead_id: 1 }, { email: "b@x.test", lead_id: 2 }, { email: "", lead_id: 3 }])
})

test("--segment reads the segment's leads, every page", async () => {
  process.env.IRIS_USER_ID = "42"
  leadPages = {
    "1": { leads: [{ id: 1, email: "a@x.test" }], pagination: { last_page: 2 } },
    "2": { leads: [{ id: 2, email: "b@x.test" }], pagination: { last_page: 2 } },
  }
  await parse(["licence", "issue-bulk", "--segment", "12"])
  expect(requests.some((r) => r.url.includes("/lead-segments/12/leads"))).toBe(true)
  expect(posts[0].rows.map((r: any) => r.lead_id)).toEqual([1, 2])
})

test("--tag with nobody matched issues nothing", async () => {
  leadPages = { "1": { data: { data: [], last_page: 1 } } }
  await parse(["licence", "issue-bulk", "--tag", "nobody", "--yes"])
  expect(posts).toEqual([])
  expect(process.exitCode).toBe(1)
})

test("parseBulkCsv reads columns, quotes and the allow list, and refuses a bad header", () => {
  expect(parseBulkCsv('Email,lead,seat_cap,allow,organization\r\na@x.test,7,500,b@x.test; c@x.test,"Acme, Inc"\r\n\r\n')).toEqual({
    rows: [{ email: "a@x.test", lead_id: 7, seat_cap_cents: 500, allow: ["b@x.test", "c@x.test"], organization: "Acme, Inc" }],
  })
  expect(parseBulkCsv("email\nb@x.test\n")).toEqual({ rows: [{ email: "b@x.test" }] })
  expect(parseBulkCsv("email,lead\nb@x.test,seven\n")).toEqual({ rows: [{ email: "b@x.test", lead_id: "seven" }] })
  expect(parseBulkCsv("mail\nb@x.test\n")).toHaveProperty("error")
  expect(parseBulkCsv("lead\n7\n")).toHaveProperty("error")
  expect(parseBulkCsv("email\n")).toHaveProperty("error")
})

test("each row says what happened to it", () => {
  expect(bulkRowLine({ row: 1, email: "a@x.test", status: "already_issued", key: KEY, differs: ["seat_cap"] })).toContain("already has IRIS-****-JKMN, skipped  differs from the list: seat_cap")
  expect(bulkRowLine({ row: 2, email: "", status: "problem", problems: ["no email", "no lead"] })).toContain("PROBLEM: no email; no lead")
  expect(maskKey(undefined)).toBe("—")
  expect(leadToBulkRow({ id: 9 })).toEqual({ email: "", lead_id: 9 })
})
