/**
 * `iris mail audit --sent --backfill` — #194235.
 *
 * The backfill read the BODY of every sent message in the window. 14 days of alex@freelabel.net
 * (62 messages) passed the 120 s timeout, and the error printed the start of the JXA script, cut
 * at 240 characters, so the cause never showed. Now headers are read for the window and bodies
 * only for the gaps: on the same Mac, 11 s for 62 headers and 9.5 s for the 3 missing bodies.
 */
import { describe, expect, test } from "bun:test"
import { sentReaderArgs, describeMailReadFailure, MAIL_SENT_READER_JXA } from "../src/cli/cmd/comms-mail-applescript"

describe("sentReaderArgs (#194235)", () => {
  test("headers only: no body flag, no id list", () => {
    const a = sentReaderArgs("alex@freelabel.net", 14, false)
    expect(a.slice(4)).toEqual(["14", "alex@freelabel.net", ""])
  })

  test("bodies for named messages only, rfc822_ prefix stripped", () => {
    const a = sentReaderArgs("alex@freelabel.net", 14, true, ["rfc822_abc@x", "def@y"])
    expect(a.slice(4)).toEqual(["14", "alex@freelabel.net", "body", JSON.stringify(["abc@x", "def@y"])])
  })

  test("an empty id list is not 'every message'", () => {
    expect(sentReaderArgs("a@b.c", 2, true, []).length).toBe(7)
  })

  test("the reader script honours the id list", () => {
    expect(MAIL_SENT_READER_JXA).toContain("if (only && !wanted[ids[i]]) continue")
  })
})

describe("describeMailReadFailure (#194235)", () => {
  const scriptEcho = { message: "Command failed: osascript -l JavaScript -e function run(argv) { const days = Number(argv[0] || 2) const acctName" }

  test("a timeout says it timed out, not the start of the script", () => {
    const r = describeMailReadFailure({ ...scriptEcho, killed: true, signal: "SIGTERM" }, "", 120000)
    expect(r).toBe("timed out after 120 s — try a smaller --days")
  })

  test("Mail.app's own error line wins when there is one", () => {
    expect(describeMailReadFailure(scriptEcho, "execution error: Can't get account \"x\". (-1728)\n", 120000)).toContain("Can't get account")
  })

  test("never echoes the script", () => {
    expect(describeMailReadFailure(scriptEcho, "", 120000)).not.toContain("function run")
  })
})
