import { describe, expect, test } from "bun:test"
import { sessionHitLines } from "./platform-recall"

// #191223 — recall now returns Desktop + CLI sessions from every machine the caller owns.
describe("sessionHitLines", () => {
  test("names the machine, folder, app and id so the session can be opened where it lives", () => {
    const [title, where, open] = sessionHitLines({
      title: "Hive chat fixes verified under load and tickets closed",
      session_id: "ses_e86cbbba0ffehvLcmCXNPrnsR3",
      provider: "opencode",
      node: "Alexs-MacBook-Pro-11711",
      project: "freelabel",
    })
    expect(title).toBe("Hive chat fixes verified under load and tickets closed")
    expect(where).toBe("    Alexs-MacBook-Pro-11711 · freelabel · IRIS · ses_e86cbbba0ffehvLcmCXNPrnsR3")
    expect(open).toBe('    read: iris sessions read ses_e86cbbba0ffehvLcmCXNPrnsR3 --machine "Alexs-MacBook-Pro-11711"')
  })

  test("a hit missing optional fields still renders, and says when the machine is unknown", () => {
    const [title, where, open] = sessionHitLines({ session_id: "abc", provider: "codex" })
    expect(title).toBe("Session")
    expect(where).toBe("    unknown machine · codex · abc")
    expect(open).toBe("    read: iris sessions read abc")   // no machine known: the server asks each one
  })
})
