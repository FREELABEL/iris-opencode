/**
 * `iris hive fs` / `iris hive doctor` — the pure decisions (#182013, #182019).
 *
 * These are the parts that decide WHAT a reading means, and every one of them was got wrong
 * at least once while building the commands:
 *
 *   - shqPath: quoting '~/x' blocks tilde expansion, so the remote shell looks for a literal
 *     directory called "~". Every path a person types starts with ~.
 *   - nameMatches: the Hive calls a machine "MacBookPro" and Tailscale calls the same machine
 *     "alexs-macbook-pro-2". A fuzzy match that is never tested is a guess.
 *   - classifyRemoteError: reporting a TCC refusal as "not found" sends someone hunting for a
 *     file that is sitting right there (#182007).
 *   - judge: the tmux reading was WRONG in the first live run — `command -v tmux` returns
 *     nothing over ssh because a non-interactive session gets
 *     PATH=/usr/bin:/bin:/usr/sbin:/sbin, which excludes Homebrew. It reported "no tmux" for
 *     a machine whose daemon was demonstrably using tmux, and then emitted a note asserting
 *     the opposite of the truth.
 */

import { describe, test, expect } from "bun:test"
import { shq, shqPath, nameMatches, classifyRemoteError } from "../../src/cli/cmd/hive-tailscale"
import { judge } from "../../src/cli/cmd/platform-hive-doctor"

describe("shq / shqPath", () => {
  test("quotes a path with spaces as ONE argument", () => {
    // The file this whole epic started from is literally named with a space.
    expect(shq("Pioneer DDJ-T1.midi.xml")).toBe("'Pioneer DDJ-T1.midi.xml'")
  })

  test("survives an embedded single quote", () => {
    expect(shq("it's")).toBe("'it'\\''s'")
  })

  test("shqPath keeps ~ expandable instead of quoting it into a literal directory", () => {
    expect(shqPath("~/notes/a b.txt")).toBe('"$HOME"/\'notes/a b.txt\'')
    expect(shqPath("~")).toBe('"$HOME"')
    expect(shqPath("~/")).toBe('"$HOME"')
  })

  test("shqPath leaves absolute and relative paths fully quoted", () => {
    expect(shqPath("/tmp/a b")).toBe("'/tmp/a b'")
    expect(shqPath("rel/path")).toBe("'rel/path'")
    // A ~ that is not a home reference must NOT be expanded.
    expect(shqPath("./~weird")).toBe("'./~weird'")
  })
})

describe("nameMatches — Hive node name vs Tailscale hostname", () => {
  test("matches the real pair from this mesh", () => {
    expect(nameMatches("MacBookPro", "alexs-macbook-pro-2")).toBe(true)
    expect(nameMatches("MacBookPro", "Alexs-MacBook-Pro-11711")).toBe(true)
  })

  test("matches exactly and case-insensitively", () => {
    expect(nameMatches("qb-host-vanguard", "QB-Host-Vanguar")).toBe(true)
  })

  test("does not match unrelated peers", () => {
    expect(nameMatches("MacBookPro", "robyn-laptop")).toBe(false)
    expect(nameMatches("MacBookPro", "iphone172")).toBe(false)
  })

  test("an empty name never matches — better to ask than to guess a machine", () => {
    expect(nameMatches("", "anything")).toBe(false)
    expect(nameMatches("anything", "")).toBe(false)
    expect(nameMatches("---", "anything")).toBe(false)
  })
})

describe("classifyRemoteError — a permission refusal is not a missing file", () => {
  test("'Operation not permitted' is TCC, and says the file may well exist", () => {
    const c = classifyRemoteError("ls: /Users/x/Library/Containers/org.mixxx.mixxx: Operation not permitted")
    expect(c.kind).toBe("tcc")
    expect(c.hint).toContain("TCC")
    expect(c.hint.toLowerCase()).toContain("may well exist")
  })

  test("a genuinely missing path is 'missing', not TCC", () => {
    expect(classifyRemoteError("ls: /nope: No such file or directory").kind).toBe("missing")
  })

  test("unix permissions are 'denied' — a different fix from TCC", () => {
    expect(classifyRemoteError("cp: /root/x: Permission denied").kind).toBe("denied")
  })

  test("anything else is 'other' and carries the raw text rather than a guess", () => {
    const c = classifyRemoteError("kex_exchange_identification: read: Connection reset")
    expect(c.kind).toBe("other")
    expect(c.hint).toContain("Connection reset")
  })
})

describe("judge — hive doctor verdicts", () => {
  const healthy = {
    daemon_pid: "44855",
    daemon_sha: "33b2f01",
    daemon_dirty: "0",
    tmux: "no",
    disk_pct: "40%",
    disk_avail: "300Gi",
    ssh_fda: "granted",
    daemon_denials: "0",
  }

  test("a healthy node is not degraded", () => {
    expect(judge("n", {}, healthy).degraded).toBe(false)
  })

  test("a dead daemon is a PROBLEM", () => {
    const v = judge("n", {}, { ...healthy, daemon_pid: "" })
    expect(v.degraded).toBe(true)
    expect(v.problems.join(" ")).toContain("NOT running")
  })

  test("logged privacy denials are a PROBLEM, and say the capability set hides it", () => {
    // The measured state of MacBookPro on 2026-08-23.
    const v = judge("n", {}, { ...healthy, daemon_denials: "69" })
    expect(v.degraded).toBe(true)
    expect(v.problems.join(" ")).toContain("69")
    expect(v.problems.join(" ")).toContain("capability set")
  })

  test("a commit mismatch is a PROBLEM, but only when an expectation was given", () => {
    expect(judge("n", {}, healthy, "deadbee").degraded).toBe(true)
    expect(judge("n", {}, healthy, "33b2f01").degraded).toBe(false)
    // Unknown is not a failure — the absence of an expectation is not evidence of drift.
    expect(judge("n", {}, healthy, null).degraded).toBe(false)
  })

  test("a short SHA matching the long one is not drift", () => {
    expect(judge("n", {}, healthy, "33b2f01abcdef").degraded).toBe(false)
  })

  test("tmux PRESENT warns about the PTY scrape; absent says direct spawn is cleaner", () => {
    const withTmux = judge("n", {}, { ...healthy, tmux: "yes", tmux_path: "/opt/homebrew/bin/tmux" })
    expect(withTmux.notes.join(" ")).toContain("/opt/homebrew/bin/tmux")
    expect(withTmux.notes.join(" ")).toContain("PTY scrape")
    // Presence of tmux is not itself a failure — it is how the fleet is configured.
    expect(withTmux.degraded).toBe(false)

    expect(judge("n", {}, healthy).notes.join(" ")).toContain("CLEANER")
  })

  test("surfaces the presence-vs-access contradiction that IS #182007", () => {
    const v = judge("n", {}, { ...healthy, ssh_fda: "denied", ssh_fda_presence: "true" })
    expect(v.notes.join(" ")).toContain("#182007")
    expect(v.notes.join(" ")).toContain("EXISTS")
  })

  test("disk: 90%+ is a problem, 80-89% only a note", () => {
    expect(judge("n", {}, { ...healthy, disk_pct: "98%" }).degraded).toBe(true)
    const warn = judge("n", {}, { ...healthy, disk_pct: "85%" })
    expect(warn.degraded).toBe(false)
    expect(warn.notes.join(" ")).toContain("85%")
  })

  test("an uncommitted daemon checkout is flagged — the SHA does not describe what runs", () => {
    const v = judge("n", {}, { ...healthy, daemon_dirty: "8" })
    expect(v.notes.join(" ")).toContain("uncommitted")
  })

  test("empty readings do not throw and do not silently pass", () => {
    const v = judge("n", {}, {})
    expect(v.degraded).toBe(true)
  })
})
