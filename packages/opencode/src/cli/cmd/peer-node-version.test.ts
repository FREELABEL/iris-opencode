import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

/**
 * A peer's node listing must say what that machine is running.
 *
 * WHY THIS EXISTS. On 2026-09-12 the question "does my teammate need to update?" could not be
 * answered from the only view you get of someone else's fleet. `formatPeerNode` returned six
 * fields — id, name, connection_status, capabilities, active_tasks, last_heartbeat_at — and no
 * version, so the best available answer was inferring modernity from a capabilities flag.
 *
 * It is not cosmetic. Version skew is silent and consequential: three daemon generations were
 * caught writing inbox rows on ONE machine, and the only reason anyone noticed is that the older
 * one omitted a field the newer ones wrote (#184644). A peer on old code accepts your work and
 * handles it differently, and nothing said so.
 *
 * THE CASE THIS GUARDS IS THE EMPTY ONE. A node that is online and reports no version is running
 * a daemon too old to send one — which is precisely the machine an operator is hunting for.
 * Rendering that as blank would hide the answer in whitespace, the same failure as the old
 * "0 node(s) online" that meant both "never connected" and "asleep" (#184564). So the absence
 * must be spoken aloud, with the fix attached.
 *
 * Source assertions: the render path needs a live peer connection and a second machine, which a
 * unit test cannot conjure. The STRUCTURE is what would regress.
 */

const SRC = readFileSync(join(import.meta.dir, "platform-hive.ts"), "utf8")

/** The per-node loop inside the peers listing, where each machine is printed. */
function peerRenderBlock(): string {
  const start = SRC.indexOf("machine(s) online")
  expect(start).toBeGreaterThan(-1)
  const end = SRC.indexOf("const HiveChatCommand", start)
  expect(end).toBeGreaterThan(start)
  return SRC.slice(start, end)
}

describe("peer node listing — what is that machine running", () => {
  test("it reads daemon_version off the peer payload", () => {
    const block = peerRenderBlock()
    expect(block).toContain("daemon_version")
  })

  test("it prints the version when the peer reports one", () => {
    const block = peerRenderBlock()
    expect(block).toMatch(/dim\("daemon:"\)/)
  })

  /**
   * THE ONE THAT MATTERS. Online + no version = an old daemon, and that must be stated, not
   * silently skipped. A bare `if (peerVer)` with no else would pass every other test here.
   */
  test("an ONLINE peer reporting no version is called out, not left blank", () => {
    const block = peerRenderBlock()
    const verIdx = block.indexOf("peerVer")
    expect(verIdx).toBeGreaterThan(-1)
    const after = block.slice(verIdx)
    expect(after).toMatch(/else if \(isOnline\)/)
    expect(after.toLowerCase()).toContain("too old")
  })

  test("the callout tells them what to actually do about it", () => {
    const block = peerRenderBlock()
    expect(block).toContain("iris update")
  })

  /**
   * An OFFLINE peer must stay quiet about its version. A machine that has been dark for days
   * has nothing trustworthy to report, and printing "too old" for it would send an operator
   * chasing an upgrade when the real problem is that the machine is off.
   */
  test("it does not shout about versions for machines that are merely asleep", () => {
    const block = peerRenderBlock()
    const verIdx = block.indexOf("peerVer")
    const after = block.slice(verIdx)
    // The unknown-version branch is gated on isOnline, so an offline node prints nothing.
    const elseIdx = after.indexOf("else if (isOnline)")
    expect(elseIdx).toBeGreaterThan(-1)
  })
})
