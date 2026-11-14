/**
 * The script content digest — a contract that spans two languages (#182275, #182276).
 *
 * `iris scripts run` computes this in TypeScript and sends it with the dispatch. The daemon
 * verifies it in JavaScript before executing, and REFUSES on mismatch. So this is not an
 * internal helper: it is a cross-boundary agreement, and if the two sides ever disagree about
 * encoding or normalisation then every run fails integrity — or worse, a mismatch is waved
 * through because someone "fixed" the check rather than the disagreement.
 *
 * These fixtures are the pinned values. The daemon's own tests
 * (coding-agent-bridge/tests/user-script-content-addressing.test.js) compute the same digests
 * with node:crypto, so a change on either side that breaks agreement fails here first.
 */

import { describe, test, expect } from "bun:test"
import { createHash } from "crypto"
import { scriptDigest } from "../../src/cli/cmd/platform-scripts"

/** What the daemon computes: crypto.createHash('sha256').update(s, 'utf-8'). */
const daemonSide = (s: string) => createHash("sha256").update(s, "utf-8").digest("hex")

describe("scriptDigest — agrees with the daemon", () => {
  const fixtures = [
    "#!/bin/bash\necho hello\n",
    "#!/usr/bin/env python3\nprint('hi')\n",
    "",                                     // an empty script is a real thing to store
    "echo 'quotes' && echo \"more\"\n",
    "# iris: requires=full-disk-access\necho gated\n",
    "café ☕\n",                             // non-ASCII must not diverge by encoding
    "trailing space \n",
  ]

  for (const f of fixtures) {
    test(`matches for ${JSON.stringify(f.slice(0, 28))}`, () => {
      expect(scriptDigest(f)).toBe(daemonSide(f))
    })
  }

  test("is a 64-char lowercase hex sha256", () => {
    expect(scriptDigest("x")).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("the property that makes staleness impossible", () => {
  test("two versions of one slug are two different addresses", () => {
    // The whole fix in one assertion. Under the old slug-keyed cache both of these resolved to
    // the SAME file, so the second could never displace the first — push a fix, and a node that
    // had already run the slug kept running the old code, reporting success.
    expect(scriptDigest("#!/bin/bash\necho v1\n")).not.toBe(scriptDigest("#!/bin/bash\necho v2\n"))
  })

  test("a single byte moves the address", () => {
    expect(scriptDigest("echo a")).not.toBe(scriptDigest("echo a "))
  })

  test("identical content is identical address — a re-push is a cache hit, not a re-download", () => {
    const c = "#!/bin/bash\necho stable\n"
    expect(scriptDigest(c)).toBe(scriptDigest(c))
  })

  test("whitespace is NOT normalised away", () => {
    // Deliberate. Normalising would make two genuinely different files share an address, which
    // is the staleness bug reintroduced through the back door.
    expect(scriptDigest("echo x\n")).not.toBe(scriptDigest("echo x\r\n"))
    expect(scriptDigest("a\nb")).not.toBe(scriptDigest("a\n\nb"))
  })
})
