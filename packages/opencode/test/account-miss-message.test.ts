import { describe, expect, test } from "bun:test"
import { describeAccountMiss } from "../src/cli/cmd/platform-run"

/**
 * #182862 — `--account=<email>` "fails to resolve existing connections".
 *
 * It resolved correctly. alex@freelabel.net is a GOOGLE-DRIVE account; the two gmail connections
 * are one with a different address and one with no account_email at all. The defect was the
 * SENTENCE: "No connection ... Run: iris integrations list" sends the user to a listing that
 * plainly shows Gmail connected, so they conclude the flag is broken.
 *
 * 21 of 25 connections on the reporting account carry no account_email, so an email match can
 * never succeed against them. That is the fact the message has to surface.
 */
const GMAIL = [
  { id: 3, account_email: null, name: "Gmail" },
  { id: 14, account_email: "admin@vanguardhcs.com", name: "Gmail" },
]

describe("describeAccountMiss", () => {
  test("says the type IS connected, and to what", () => {
    const m = describeAccountMiss("gmail", "alex@freelabel.net", GMAIL)
    expect(m).toContain("2 'gmail' connections exist")
    expect(m).toContain("#3")
    expect(m).toContain("#14")
    expect(m).toContain("admin@vanguardhcs.com")
  })

  test("names the rows that can never match, and why", () => {
    const m = describeAccountMiss("gmail", "alex@freelabel.net", GMAIL)
    expect(m).toContain("no account email recorded")
    expect(m).toContain("can never succeed")
    expect(m).toContain("--integration-id")
  })

  test("nothing connected is a DIFFERENT message with a different fix", () => {
    const m = describeAccountMiss("slack", "x@y.com", [])
    expect(m).toContain("No 'slack' connection exists")
    expect(m).toContain("iris connect slack")
    expect(m).not.toContain("--integration-id")
  })

  test("when every row has an email, it does not claim otherwise", () => {
    const m = describeAccountMiss("google-drive", "nobody@x.com", [
      { id: 4, account_email: "alex@freelabel.net", name: "Google Drive" },
    ])
    expect(m).toContain("1 'google-drive' connection exists")
    expect(m).not.toContain("no account email")
    expect(m).toContain("--integration-id")
  })

  test("singular and plural read correctly", () => {
    expect(describeAccountMiss("gmail", "a@b.c", [{ id: 3, account_email: null, name: "G" }]))
      .toContain("1 'gmail' connection exists")
    expect(describeAccountMiss("gmail", "a@b.c", GMAIL)).toContain("2 'gmail' connections exist")
  })
})
