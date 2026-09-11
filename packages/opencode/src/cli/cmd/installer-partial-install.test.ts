import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

/**
 * #184597 — a partial install must not report itself as a complete one.
 *
 * MEASURED on a real client's Windows machine, 2026-09-11. Node.js was not installed, so
 * install.ps1 skipped Step 5 (Agent Bridge). What she then saw was:
 *
 *   [5/5] Agent Bridge ... skipped (Node.js not found)     <- DarkGray, the dimmest colour
 *   IRIS Code installed successfully!                      <- Green
 *       iris-daemon start   Join the Hive compute network  <- Cyan, an instruction that
 *                                                             CANNOT work: the daemon it
 *                                                             starts was just skipped
 *
 * The failure was whispered and the success was shouted, and the closing instruction pointed
 * at the missing thing. She reasonably concluded the product was broken rather than that a
 * prerequisite was absent, and it cost about two hours.
 *
 * There is no pwsh on the machines that run this suite, so install.ps1 cannot be EXECUTED
 * here. These are source assertions on the structure that regressed — which is the same
 * approach HiveRelayDeadlineTest takes for a constant that cannot be exercised without a
 * live peer. They will fail if someone restores the unconditional success banner.
 */

const PS1 = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "install.ps1"), "utf8")

describe("#184597 — install.ps1 must not claim success after skipping the bridge", () => {
  test("the skip records a reason the summary can read", () => {
    expect(PS1).toContain("$BridgeSkippedReason")
    // Both skip branches must set it, or one of them silently keeps the old behaviour.
    const assignments = PS1.match(/\$BridgeSkippedReason\s*=\s*"/g) ?? []
    expect(assignments.length).toBeGreaterThanOrEqual(2)
  })

  test("the success banner is conditional, not unconditional", () => {
    // The exact failing shape: a bare success line with nothing guarding it.
    const bannerIdx = PS1.indexOf('Write-Host "IRIS Code installed successfully!"')
    expect(bannerIdx).toBeGreaterThan(-1)

    // Walk back a little; a guard must appear between the "Final output" marker and the banner.
    const finalIdx = PS1.indexOf("Final output")
    expect(finalIdx).toBeGreaterThan(-1)
    const between = PS1.slice(finalIdx, bannerIdx)
    expect(between).toContain("$BridgeSkippedReason")
  })

  test("a skipped bridge says so, and names the reason", () => {
    expect(PS1).toContain("Agent Bridge was SKIPPED")
    expect(PS1).toContain("Reason: $BridgeSkippedReason")
  })

  test("a partial install is not beaconed as a plain success", () => {
    expect(PS1).toContain("install_success_partial")
  })

  test("it does not tell a bridge-less machine to run the daemon as if it will work", () => {
    // `iris-daemon start` may still be listed, but only outside the skipped branch --
    // the warning block must appear before the command list so the reader hits it first.
    const warnIdx = PS1.indexOf("The Hive daemon will NOT run on this machine yet")
    const cmdIdx = PS1.indexOf('Write-Host "    iris-daemon start"')
    expect(warnIdx).toBeGreaterThan(-1)
    expect(cmdIdx).toBeGreaterThan(-1)
    expect(warnIdx).toBeLessThan(cmdIdx)
  })
})
