import { describe, expect, test } from "bun:test"
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { digest, pickMailConnection, slugify, toThreads, waiting, workspace, type MailThread } from "../../src/iris/onboarding"

// D4 #188245 — the pure halves of "Here's what I see". The network halves (mail, ground) return
// PlatformResult and are exercised against the live endpoints, not mocked here.

const t = (id: string, from: string, subject = `Subject ${id}`, snippet = `Snippet ${id}`): MailThread => ({
  id,
  from,
  subject,
  snippet,
})

describe("waiting", () => {
  test("skips mail the person sent themselves, keeps order, caps at three", () => {
    const threads = [
      t("1", "Me <me@clinic.test>"),
      t("2", "Patient A <a@x.test>"),
      t("3", "me@clinic.test"),
      t("4", "Supplier <s@y.test>"),
      t("5", "Patient B <b@x.test>"),
      t("6", "Patient C <c@x.test>"),
    ]
    expect(waiting(threads, "me@clinic.test").map((x) => x.id)).toEqual(["2", "4", "5"])
  })

  test("without a known account, nothing is filtered — better three threads than none", () => {
    expect(waiting([t("1", "a@x"), t("2", "b@x")]).map((x) => x.id)).toEqual(["1", "2"])
  })
})

describe("digest", () => {
  test("names the sender, not the address, and keeps subject and snippet", () => {
    const d = digest([t("1", '"Jane Doe" <jane@x.test>', "Invoice 42", "Can you   send\nthe invoice?")])
    expect(d).toBe('- From Jane Doe: "Invoice 42" — Can you send the invoice?\n')
  })

  test("stays under the endpoint's prompt limit however long the inbox is", () => {
    const many = Array.from({ length: 200 }, (_, i) => t(String(i), "x@y.test", "s".repeat(80), "n".repeat(400)))
    const d = digest(many)
    expect(d.length).toBeLessThanOrEqual(4500)
    expect(d.endsWith("\n")).toBe(true) // whole lines only, never a half-cut thread
  })
})

describe("workspace", () => {
  test("slugs a business name into one safe folder name", () => {
    expect(slugify("Bright Smile Dental — Austin")).toBe("bright-smile-dental-austin")
    expect(slugify("Café Señor")).toBe("cafe-senor")
    expect(slugify("../../etc/passwd")).toBe("etc-passwd") // never a path
    expect(slugify("   ")).toBe("workspace")
  })

  test("creates the folder under the root, and reuses it on a second run", () => {
    const root = mkdtempSync(path.join(tmpdir(), "iris-onb-"))
    const a = workspace("Bright Smile Dental", root)
    const b = workspace("Bright Smile Dental", root)
    expect(a.measured).toBe(true)
    expect(a.data.path).toBe(path.join(root, "bright-smile-dental"))
    expect(b.data.path).toBe(a.data.path)
    expect(statSync(a.data.path).isDirectory()).toBe(true)
  })
})

describe("toThreads", () => {
  test("Gmail and Outlook come out as the same thread shape", () => {
    const gmail = toThreads({ success: true, emails: [{ id: "g1", thread_id: "t1", subject: "Invoice", from: "Ann <a@x.test>", snippet: "Due Friday" }] })
    const outlook = toThreads({
      successful: true,
      data: { value: [{ id: "o1", conversationId: "c1", subject: "Invoice", from: { emailAddress: { name: "Ann", address: "a@x.test" } }, bodyPreview: "Due Friday", receivedDateTime: "2026-10-06T10:00:00Z" }] },
    })
    expect(outlook[0]).toEqual({ id: "o1", threadId: "c1", subject: "Invoice", from: "Ann <a@x.test>", date: "2026-10-06T10:00:00Z", snippet: "Due Friday" })
    expect(gmail[0].from).toBe(outlook[0].from)
    expect(gmail[0].snippet).toBe(outlook[0].snippet)
  })

  test("an empty or unexpected body is zero threads, not a crash", () => {
    expect(toThreads({ success: true, data: { value: [] } })).toEqual([])
    expect(toThreads(null)).toEqual([])
    expect(toThreads({ success: true, message: "ok" })).toEqual([])
  })
})

describe("pickMailConnection", () => {
  // iris-api's index: one row per registry type, isConnected from iris-api's own table.
  const row = (type: string, isConnected: boolean, extra: Record<string, unknown> = {}) => ({
    type,
    isConnected,
    status: isConnected ? "active" : "available",
    ...extra,
  })

  test("finds a readable Gmail", () => {
    expect(pickMailConnection([row("slack", true), row("gmail", true)])).toEqual({ type: "gmail", account: undefined })
  })

  test("prefers Gmail over Outlook, in MAIL_TYPES order", () => {
    expect(pickMailConnection([row("outlook", true), row("gmail", true)])?.type).toBe("gmail")
  })

  test("an available-but-unconnected Gmail is not connected", () => {
    expect(pickMailConnection([row("gmail", false), row("outlook", false)])).toBeUndefined()
  })

  test("garbage in, nothing out", () => {
    expect(pickMailConnection(null)).toBeUndefined()
    expect(pickMailConnection({ data: [] })).toBeUndefined()
  })
})
