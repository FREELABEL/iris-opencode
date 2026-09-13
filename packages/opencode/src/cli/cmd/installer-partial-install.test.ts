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

/**
 * #184597 FIX 3 — a Windows node used to die at every reboot.
 *
 * macOS registers a real LaunchAgent (RunAtLoad + KeepAlive). install.ps1 registered
 * NOTHING — zero references to schtasks, Register-ScheduledTask, the Startup folder or
 * the Run key — so a Windows node worked until the first reboot and was then silently
 * gone. That reads as an unreliable product rather than as "nothing ever asked it to
 * start", which is the same misdirection as the skipped-bridge banner above.
 *
 * The BEHAVIOUR is tested by `script/test-install-autostart.ps1`, which runs the real
 * function out of install.ps1 under pwsh with the Windows-only cmdlets mocked, and is
 * mutation-checked (adding `-RunLevel Highest` makes it fail). These are the structural
 * assertions that run everywhere, including machines with no pwsh.
 */
describe("#184597 FIX 3 — install.ps1 must register autostart", () => {
  test("it registers autostart at all — the whole gap was that it did not", () => {
    expect(PS1).toContain("Register-IrisAutostart")
    expect(PS1).toMatch(/Register-ScheduledTask/)
  })

  test("at logon, and restarting if it stops — the LaunchAgent's two properties", () => {
    expect(PS1).toMatch(/New-ScheduledTaskTrigger\s+-AtLogOn/)
    expect(PS1).toMatch(/-RestartCount\s+\d/)
  })

  /**
   * The plist this mirrors carries the rule in a comment: user-level ONLY, never
   * /Library/LaunchDaemons. An installer that needs admin for an optional convenience
   * is one clients stop running.
   */
  test("NEVER elevates and NEVER writes machine-wide state", () => {
    // Assert on CODE, not prose. The first version of this matched the comment that
    // STATES the rule — "no -RunLevel Highest, no HKLM" — and failed against a file
    // that obeys it. A check that cannot tell a rule from its violation would have
    // been switched off within a week, and then it would catch nothing.
    const code = PS1.split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n")
    expect(code).not.toMatch(/-RunLevel\s+Highest/)
    expect(code).not.toMatch(/HKLM:/)
  })

  test("re-running the installer replaces the task instead of duplicating it", () => {
    expect(PS1).toMatch(/Unregister-ScheduledTask/)
  })

  test("a failure is recorded for the summary, not swallowed", () => {
    expect(PS1).toContain("$AutostartFailedReason")
    // The summary must actually READ it — recording a reason nobody prints is the
    // original defect with an extra variable.
    expect(PS1).toMatch(/if\s*\(\s*\$AutostartFailedReason\s*\)/)
    expect(PS1).toMatch(/will NOT restart automatically after a reboot/)
  })

  test("the weaker fallback is named as weaker, not reported as equivalent", () => {
    // The Run key starts at logon but cannot restart a crashed process. Saying
    // "autostart registered" for both would promise something one of them cannot do.
    expect(PS1).toMatch(/will NOT restart if it stops/)
  })
})
