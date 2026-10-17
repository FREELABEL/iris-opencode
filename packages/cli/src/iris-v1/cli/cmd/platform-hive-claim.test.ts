import { describe, expect, test } from "bun:test"
import { findSession, parseSuggestion, shq, suggestCommand } from "./platform-hive-claim"

const S = (id: string) => ({ session_id: id, node: "n", node_id: "1" })

describe("iris hive claim (#188316)", () => {
  test("a session is found by full id, or by the characters shown in the list; ambiguity is reported", () => {
    const list = [S("ses_aaaa11112222"), S("ses_bbbb33334444"), S("ses_cccc11112222")]
    expect(findSession(list, "ses_bbbb33334444")).toEqual(list[1])
    expect(findSession(list, "33334444")).toEqual(list[1])
    expect(findSession(list, "11112222")).toEqual({ ambiguous: [list[0], list[2]] })
    expect(findSession(list, "zzzz")).toBeNull()
  })
  test("the project path is quoted as data — a quote in it cannot break out", () => {
    expect(shq("/srv/it's here")).toBe(`'/srv/it'\\''s here'`)
    expect(suggestCommand("/srv/x; rm -rf ~")).toContain(`cd '/srv/x; rm -rf ~' || exit 3`)
  })
  test("the suggestion is the author line before the tab; anything else is no suggestion", () => {
    expect(parseSuggestion("Dana <dana@acme.dev>\tapp/Billing.php,app/Invoice.php\n")).toEqual({ owner: "Dana <dana@acme.dev>", from: "app/Billing.php,app/Invoice.php" })
    expect(parseSuggestion("fatal: not a git repository")).toBeNull()
  })
})
