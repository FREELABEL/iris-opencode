import { describe, expect, test } from "bun:test"
import {
  parseAudience,
  parseCsv,
  parseSkipStatus,
  parseEmails,
  parsePersonalize,
  buildCreateBody,
  templateSource,
  sendGate,
  friendlyError,
  draftHeadline,
  droppedLine,
  totalReady,
  progressOf,
  isSettled,
  toCsv,
  placeholderNames,
  UsageError,
  REASON_DEFAULTS,
} from "./mailing-core"

describe("arg parsing", () => {
  test("--audience name=<number> is a dataset item", () => {
    expect(parseAudience("members=186974")).toEqual({ name: "members", dataset_item_id: 186974 })
  })

  test("--audience name=<file.csv> reads rows through the injected reader", () => {
    const a = parseAudience("guests=./g.csv", () => 'First Name,Email\n"Ann, Jr",ann@x.com\nBo,bo@y.org\n')
    expect(a).toEqual({
      name: "guests",
      rows: [
        { "First Name": "Ann, Jr", Email: "ann@x.com" },
        { "First Name": "Bo", Email: "bo@y.org" },
      ],
    })
  })

  test("--audience rejects a missing name, missing value or a bare word", () => {
    expect(() => parseAudience("186974")).toThrow(UsageError)
    expect(() => parseAudience("members=")).toThrow(UsageError)
    expect(() => parseAudience("=186974")).toThrow(UsageError)
    expect(() => parseAudience("members=everyone")).toThrow(/list number/)
  })

  test("csv handles doubled quotes, CRLF and a BOM", () => {
    expect(parseCsv('\uFEFFa,b\r\n"x ""y""",2\r\n')).toEqual([{ a: 'x "y"', b: "2" }])
  })

  test("--skip-status merges repeats and splits values", () => {
    expect(parseSkipStatus(["Email Status=Extrapolated, Unavailable", "Email Status=Unavailable", "Tier=Cold"])).toEqual({
      "Email Status": ["Extrapolated", "Unavailable"],
      Tier: ["Cold"],
    })
    expect(parseSkipStatus(undefined)).toBeUndefined()
    expect(() => parseSkipStatus("Extrapolated")).toThrow(UsageError)
  })

  test("emails are lower-cased, deduped, comma-split; 'me' survives; junk is refused", () => {
    expect(parseEmails(["A@B.com,c@d.org", "a@b.com", "me"], "--to")).toEqual(["a@b.com", "c@d.org", "me"])
    expect(() => parseEmails("not-an-email", "--exclude")).toThrow(/not an email/)
  })

  test("--personalize reason uses defaults, overrides, and nothing else is accepted", () => {
    expect(parsePersonalize("reason")).toEqual(REASON_DEFAULTS)
    expect(parsePersonalize("reason", { titleField: "Role", fallback: "Hi." })).toEqual({
      title_fields: ["Role"],
      company_fields: REASON_DEFAULTS.company_fields,
      fallback: "Hi.",
    })
    expect(parsePersonalize(undefined)).toBeUndefined()
    expect(() => parsePersonalize("vibes")).toThrow(UsageError)
  })

  test("--template: a number is an Atlas item, anything else a file", () => {
    expect(templateSource("189315")).toEqual({ kind: "item", id: 189315 })
    expect(templateSource("C:\\Users\\rodney\\invite.html")).toEqual({ kind: "file", path: "C:\\Users\\rodney\\invite.html" })
    expect(() => templateSource("")).toThrow(UsageError)
  })

  test("buildCreateBody maps every flag onto the API contract", () => {
    const body = buildCreateBody(
      {
        subject: " Invitation ",
        audience: ["members=186974", "prospects=189317"],
        exclude: ["X@Y.com"],
        "skip-status": ["Email Status=Extrapolated,Unavailable"],
        personalize: ["reason"],
        "from-email": "rodney@entropyconsulting.me",
        "from-name": "Rodney",
        "postal-address": "221 W Lancaster Ave",
        integration: 138,
        "email-field": "Email",
      },
      "<p>Hey {{First Name}}</p>",
    )
    expect(body).toEqual({
      subject: "Invitation",
      html: "<p>Hey {{First Name}}</p>",
      audiences: [
        { name: "members", dataset_item_id: 186974 },
        { name: "prospects", dataset_item_id: 189317 },
      ],
      exclude: ["x@y.com"],
      exclude_statuses: { "Email Status": ["Extrapolated", "Unavailable"] },
      reason: REASON_DEFAULTS,
      email_field: "Email",
      from_email: "rodney@entropyconsulting.me",
      from_name: "Rodney",
      footer: { postal_address: "221 W Lancaster Ave" },
      integration_id: 138,
    })
  })

  test("buildCreateBody refuses no subject, no audience, duplicate audience names, a bad sender", () => {
    const html = "<p>x</p>"
    expect(() => buildCreateBody({ audience: "a=1" }, html)).toThrow(/--subject/)
    expect(() => buildCreateBody({ subject: "s" }, html)).toThrow(/--audience/)
    expect(() => buildCreateBody({ subject: "s", audience: ["Members=1", "members=2"] }, html)).toThrow(/Two audiences/)
    expect(() => buildCreateBody({ subject: "s", audience: "a=1", "from-email": "rodney" }, html)).toThrow(/not an email/)
    expect(() => buildCreateBody({ subject: "s", audience: "a=1" }, "  ")).toThrow(/empty/)
  })
})

describe("the send gate", () => {
  const never = async () => {
    throw new Error("must not ask")
  }

  test("no terminal and no --yes: refuses, never asks", async () => {
    expect(await sendGate({ count: 171, yes: false, interactive: false, ask: never })).toEqual({ go: false, reason: "needs_yes" })
  })

  test("--yes goes without asking", async () => {
    expect(await sendGate({ count: 171, yes: true, interactive: false, ask: never })).toEqual({ go: true })
  })

  test("interactive: only an explicit yes sends; the question names the count", async () => {
    let asked = ""
    const yes = await sendGate({ count: 101, yes: false, interactive: true, ask: async (q) => ((asked = q), true) })
    expect(yes).toEqual({ go: true })
    expect(asked).toBe("Send to 101 people? (y/N)")
    expect(await sendGate({ count: 101, yes: false, interactive: true, ask: async () => false })).toEqual({ go: false, reason: "declined" })
    // a cancelled prompt (clack returns a symbol) is not a yes
    expect(await sendGate({ count: 1, yes: false, interactive: true, ask: async () => Symbol("cancel") as any })).toEqual({ go: false, reason: "declined" })
  })

  test("nobody to send to: refuses even with --yes", async () => {
    expect(await sendGate({ count: 0, yes: true, interactive: true, ask: never })).toEqual({ go: false, reason: "nobody" })
  })
})

describe("friendly errors", () => {
  test("no Mailjet → connect command", () => {
    const f = friendlyError(422, { success: false, reason: "no_mailjet", message: "No active Mailjet connection on your account." })
    expect(f.code).toBe("mailjet_not_connected")
    expect(f.fix?.[0]).toStartWith("iris integrations connect mailjet")
  })

  test("Mailjet recognised from prose alone", () => {
    expect(friendlyError(400, { message: "Connect a Mailjet account before creating a mailing." }).code).toBe("mailjet_not_connected")
  })

  test("a code wins over wording: a sender message carrying a Mailjet word is still a sender problem", () => {
    expect(friendlyError(422, { reason: "from_required", message: "No from_email given and no sender is saved on Mailjet connection #138." }).code).toBe("no_sender")
  })

  test("no sender → how to set one", () => {
    const f = friendlyError(422, { reason: "from_required", message: "No from_email given" })
    expect(f.code).toBe("no_sender")
    expect(f.fix?.join(" ")).toContain("--from-email")
  })

  test("placeholders left → names each one when the sample shows them, else the count", () => {
    const names = placeholderNames({ sample: [{ subject: "Hi {{ First Nme }}", html: "<p>{{Reason}} and {{Reason}}</p>" }] })
    expect(names).toEqual(["First Nme", "Reason"])
    const f = friendlyError(422, { reason: "placeholders_left", placeholders_left: 171 }, { names })
    expect(f.message).toBe("The email still has blanks that no column fills: {{First Nme}}, {{Reason}}.")
    expect(friendlyError(422, { reason: "placeholders_left", placeholders_left: 3 }).message).toStartWith("3 message(s)")
  })

  test("401, 404, 5xx speak plainly and point somewhere", () => {
    expect(friendlyError(401, {}).fix).toEqual(["iris auth login --force"])
    expect(friendlyError(404, { reason: "not_found", message: "Mailing #12 not found." }, { id: 12 }).message).toBe("There is no mailing #12 on your account.")
    expect(friendlyError(404, { reason: "dataset_not_found", message: "Dataset item #9 not found." }).message).toBe("List #9 not found. Check the number after the = in --audience.")
    expect(friendlyError(503, {}, { id: 12 }).fix?.[0]).toContain("iris mailing status 12")
  })

  test("422 field errors are kept as details", () => {
    const f = friendlyError(422, { message: "The given data was invalid.", errors: { subject: ["required"] } })
    expect(f.details).toEqual(["subject: required"])
  })
})

describe("reading the server", () => {
  // The shape MailingSender::summary() returns.
  const aud = (sendable: number, dropped: any, extra: any = {}) => ({ total: 0, sendable, dropped, sent: 0, failed: 0, pending: sendable, suppressed: 0, unknown: 0, ...extra })
  const draft = {
    id: 12,
    status: "draft",
    counts: {
      members: aud(101, { no_email: 1, duplicate: 0, excluded: 0, suppressed: 0 }),
      prospects: aud(70, { no_email: 22, duplicate: 0, excluded: 10, suppressed: 0 }),
    },
  }

  test("headline and dropped line read like the spec", () => {
    expect(draftHeadline(draft)).toBe("Draft #12 — 101 members, 70 prospects ready.")
    expect(droppedLine(draft)).toBe("23 no email, 10 held back by --exclude / --skip-status")
  })

  test("totalReady filters by audience name, case-insensitively", () => {
    expect(totalReady(draft)).toBe(171)
    expect(totalReady(draft, ["Members"])).toBe(101)
  })

  test("progress counts only the audiences this send covers", () => {
    const m = {
      status: "sending",
      send_audiences: ["members"],
      counts: { members: aud(101, {}, { sent: 40, failed: 1, pending: 60 }), prospects: aud(70, {}) },
    }
    expect(progressOf(m)).toEqual({ status: "sending", sent: 40, failed: 1, pending: 60, unknown: 0, total: 101 })
    expect(progressOf({ ...m, send_audiences: null }).pending).toBe(130)
    expect(isSettled(m)).toBe(false)
    expect(isSettled({ status: "sent" })).toBe(true)
    expect(isSettled({ status: "stopped" })).toBe(true)
    expect(isSettled({ status: "draft" })).toBe(false)
  })

  test("csv escapes commas, quotes and newlines", () => {
    expect(toCsv([{ email: "a@b.com", error: 'bad, "very"\nbad' }], ["email", "error"])).toBe('email,error\na@b.com,"bad, ""very""\nbad"\n')
  })
})
