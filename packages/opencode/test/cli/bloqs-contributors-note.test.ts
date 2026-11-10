import { expect, test } from "bun:test"
import { contributorsNote } from "../../src/cli/cmd/platform-bloqs"

// #193064: asked "who can see board 297?", agents ran `bloqs contributors 297` three times out of three
// and read leads as access. The output itself now says what it is, and where access is.
test("the contributors note says these are leads, not access, and names the command that is", () => {
  const n = contributorsNote(297)
  expect(n).toContain("leads")
  expect(n).toContain("not who can see")
  expect(n).toContain("iris bloqs members 297")
})
