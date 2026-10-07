import { describe, expect, test } from "bun:test"
import { digest, waiting, type MailThread } from "../../src/iris/onboarding"

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
