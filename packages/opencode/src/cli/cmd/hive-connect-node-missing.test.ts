import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

/**
 * #184597 — "install it" must not point back at the thing that skipped it.
 *
 * THE LOOP, measured on a client's Windows machine 2026-09-11:
 *
 *   1. install.ps1 finds no Node.js, so it SKIPS Step 5 (Agent Bridge) and prints
 *      "IRIS Code installed successfully!" anyway.
 *   2. The user runs `iris hive connect`.
 *   3. daemonCtl() finds no iris-daemon binary (it was never installed) and the command says
 *      "Daemon binary not found. Install it: irm https://heyiris.io/install-code.ps1 | iex"
 *      — which is the installer from step 1.
 *   4. The installer skips Step 5 again, for the same reason, and reports success again.
 *
 * Nothing anywhere in that circle names Node.js, so the user has no way to exit it. It cost
 * about two hours. The rest of `hive connect` is careful — it catches a failed start and then
 * polls the API to confirm the node actually reached the cloud, with the comment "'Started'
 * and 'connected' are different claims" — which is exactly why this one branch stood out: the
 * command verifies everything except the prerequisite that was actually missing.
 *
 * Source assertions: reproducing this needs a machine with no Node.js, which is not something
 * the suite can create.
 */

const SRC = readFileSync(join(import.meta.dir, "platform-hive-connect.ts"), "utf8")

/**
 * The EXECUTABLE body of the `if (!ctl) { … }` branch, where the misleading advice lived.
 *
 * Two things this has to get right, both learned by getting them wrong:
 *
 *  - Bound the slice by the block's real end, not a guessed character count. A fixed 1800-char
 *    window stopped before the `else`, so the only `installHint()` in range was the one inside
 *    a comment — the test could not see the call it was written to reason about.
 *  - Strip `//` comments. This branch's own comment explains the loop by NAMING installHint(),
 *    so an ordering assertion over raw source measures prose rather than behaviour.
 */
function ctlMissingBranch(): string {
  const start = SRC.indexOf("if (!ctl)")
  expect(start).toBeGreaterThan(-1)
  const end = SRC.indexOf("const sp2 = prompts.spinner()", start)
  expect(end).toBeGreaterThan(start)
  return SRC.slice(start, end).replace(/^\s*\/\/.*$/gm, "")
}

describe("#184597 — a missing daemon must name the real cause", () => {
  test("the branch checks whether Node.js is present", () => {
    const branch = ctlMissingBranch()
    expect(branch).toMatch(/where node|command -v node/)
  })

  test("it tells a Node-less machine to install Node.js, by name", () => {
    const branch = ctlMissingBranch()
    expect(branch).toContain("Node.js is not installed")
    expect(branch).toContain("nodejs.org")
  })

  test("it does NOT send a Node-less machine back to the installer", () => {
    const branch = ctlMissingBranch()
    // installHint() is still correct advice when the binary is missing for any OTHER reason,
    // so it may remain — but it must no longer be the ONLY thing said, unguarded.
    const hintIdx = branch.indexOf("installHint()")
    const nodeIdx = branch.indexOf("Node.js is not installed")
    expect(nodeIdx).toBeGreaterThan(-1)
    if (hintIdx > -1) {
      // The Node branch must come first, so the common cause is reported before the generic one.
      expect(nodeIdx).toBeLessThan(hintIdx)
    }
  })

  test("the rest of the command keeps verifying that the node actually came online", () => {
    // Guard against someone "simplifying" the confirmation loop away while touching this file.
    expect(SRC).toContain("Waiting for the node to come online")
    expect(SRC).toMatch(/connection_status === "online"/)
  })
})
