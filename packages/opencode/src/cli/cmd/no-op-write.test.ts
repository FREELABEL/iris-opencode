import { describe, expect, test } from "bun:test"
import { join } from "path"

/**
 * A write that would change nothing must EXIT NON-ZERO. (Tracker item 11.)
 *
 * 23 commands already detected the no-op case. Twenty-one of them warned and returned — exit
 * code ZERO. So `iris brands update 5` with no flags printed "Nothing to update" and told every
 * script, CI job and agent that the write SUCCEEDED. A human reads the warning; automation
 * reads the exit code, and the two disagreed.
 *
 * clig.dev states it plainly: non-zero exit on failure. A write the caller asked for and did
 * not get is a failure.
 *
 * WHY THIS IS BEHAVIOURAL AND NOT A SOURCE SCAN. The first version of this check counted
 * commands that "have a guard" — which would have scored all 23 as compliant while 21 still
 * silently no-opped. What matters is not that a guard exists, it is what the process returns.
 * So this runs the real CLI and reads the real exit code.
 *
 * It also asserts the guard fires BEFORE auth: these run with no credential, and a command that
 * authenticated first would fail for the wrong reason and pass this test dishonestly. Requiring
 * the "Nothing to update" text is what distinguishes the two.
 */
describe("no-op writes exit non-zero", () => {
  const ROOT = join(import.meta.dir, "..", "..", "..")
  const ENTRY = join(ROOT, "src", "index.ts")

  // Verified by hand before being pinned here. Each is an update/set with NO field flags.
  const CASES = [
    ["brands", "update", "5"],
    ["venues", "update", "5"],
    ["services", "update", "5"],
    ["products", "update", "5"],
    ["workflows", "update", "5"],
    ["boards", "update", "5"],
    ["programs", "update", "5"],
    ["schedules", "update", "5"],
    ["atlas:staff", "update", "5"],
    ["atlas:inventory", "update", "5"],
  ]

  for (const argv of CASES) {
    test(`iris ${argv.join(" ")} (no flags) fails loudly`, async () => {
      const proc = Bun.spawn(["bun", ENTRY, ...argv], {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
        // No credential on purpose: the guard must not need one to say "you passed no fields".
        env: { ...process.env, IRIS_NON_INTERACTIVE: "1" },
      })

      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
      const clean = stderr.replace(/\x1b?\[[0-9;]*m/g, "")

      // The exit code is the assertion that matters — it is what every caller except a human
      // actually reads.
      expect(exitCode).not.toBe(0)

      // And it must be OUR failure, not an auth or parse failure that happens to be non-zero.
      // Without this, the test would pass even if the guard were deleted.
      expect(clean).toMatch(/Nothing to (update|set)/i)
    }, 30_000)
  }
})
