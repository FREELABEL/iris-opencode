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
import {
  shq,
  shqPath,
  nameMatches,
  classifyRemoteError,
  parseAvailableBytes,
  destinationSpaceError,
  localRegularFileSize,
  describeSshFailure,
  pushFile,
  pushStream,
  pullFile,
  streamNameError,
  ensureSshUser,
  PUSH_FREE_SPACE_RESERVE_BYTES,
} from "../../src/cli/cmd/hive-tailscale"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { createHash } from "crypto"
import { Readable } from "stream"
import { userInfo } from "os"
import { tmpdir } from "os"
import { join } from "path"
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

describe("parseAvailableBytes — destination free-space preflight", () => {
  test("parses POSIX df blocks as bytes", () => {
    expect(parseAvailableBytes("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk1 1000000 200000 800000 20% /tmp")).toBe(819_200_000)
  })

  test("uses the final row and refuses malformed or unsafe values", () => {
    expect(parseAvailableBytes("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/a 100 50 50 50% /\n/dev/b 200 20 180 10% /tmp")).toBe(184_320)
    expect(parseAvailableBytes("Filesystem Used Available\n/dev/a x")).toBeNull()
    expect(parseAvailableBytes("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/a 100 50 9007199254740992 1% /")).toBeNull()
  })

  test("a filesystem name with spaces does not shift the column read", () => {
    // macOS autofs; read as field 4 this reported Used (0) as Available.
    expect(parseAvailableBytes("Filesystem 1024-blocks Used Available Capacity Mounted on\nmap auto_home 500 0 400 0% /System/Volumes/Data/home")).toBe(409_600)
    expect(parseAvailableBytes("Filesystem 1024-blocks Used Available Capacity Mounted on\n//me@nas/My Share 1000 100 900 10% /Volumes/My Share")).toBe(921_600)
  })

  test("allows a push that fits and refuses low or unknown space", () => {
    const adequate = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk1 1000000 200000 800000 20% /tmp"
    const low = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk1 1000000 200000 2 99% /tmp"
    expect(destinationSpaceError(1024, adequate)).toBeNull()
    expect(destinationSpaceError(4096, low)).toContain("not enough free space")
    expect(destinationSpaceError(1, null)).toContain("refusing to push")
  })

  test("a push may not take the destination below the reserve", () => {
    const kb = (PUSH_FREE_SPACE_RESERVE_BYTES + 4096) / 1024
    const exact = `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/d 99999999 1 ${kb} 99% /tmp`
    expect(destinationSpaceError(4096, exact)).toBeNull()
    expect(destinationSpaceError(4097, exact)).toContain("kept free")
  })
})

describe("localRegularFileSize — reject unsupported directory pushes", () => {
  test("accepts files and rejects directories and missing paths cleanly", () => {
    const root = mkdtempSync(join(tmpdir(), "hive-fs-test-"))
    try {
      const file = join(root, "file.txt")
      writeFileSync(file, "hello")
      expect(localRegularFileSize(file)).toEqual({ size: 5 })
      expect(localRegularFileSize(root)).toEqual({ error: `not a regular file: ${root} (directory pushes are not supported)` })
      const missing = localRegularFileSize(join(root, "missing"))
      expect("error" in missing && missing.error).toContain("cannot inspect local path")
      expect("error" in missing && missing.error).toContain("ENOENT")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// A fake ssh/scp/df on PATH that runs the "remote" side on THIS filesystem, so cat >, mv,
// sha256sum and df really run and a test can see exactly what was left behind. Knobs:
// DF_OUT (remote df answer), LOCAL_DF_OUT (this machine's df), SCP_CORRUPT (flip the copy),
// SCP_FAIL, STREAM_FAIL (cat > fails like a full disk), SSH_DENY (every login refused).
function harness() {
  const root = mkdtempSync(join(tmpdir(), "hive-xfer-test-"))
  const bin = join(root, "bin")
  mkdirSync(bin)
  const scpLog = join(root, "scp.log")
  const realDf = ["/bin/df", "/usr/bin/df"].find((p) => existsSync(p))!
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  script(
    "ssh",
    `for a; do last="$a"; done
case "$1" in -G) [ -n "$SSH_G_USER" ] && echo "user $SSH_G_USER"; exit 0;; esac
if [ -n "$SSH_DENY" ]; then echo "Permission denied (publickey)." >&2; exit 255; fi
case "$last" in *"df -Pk"*) if [ -n "$DF_OUT" ]; then printf '%s\\n' "$DF_OUT"; exit 0; fi;; esac
case "$last" in "cat > "*) if [ -n "$STREAM_FAIL" ]; then cat >/dev/null; echo "cat: write error: No space left on device" >&2; exit 1; fi;; esac
unset LOCAL_DF_OUT
exec sh -c "$last"`,
  )
  script(
    "scp",
    `echo "$@" >> "${scpLog}"
[ -n "$SCP_FAIL" ] && { echo "lost connection" >&2; exit 1; }
for a; do src="$dst"; dst="$a"; done
cp "\${src#*:}" "\${dst#*:}" || exit 1
[ -n "$SCP_CORRUPT" ] && printf 'X' >> "\${dst#*:}"
exit 0`,
  )
  script("df", `if [ -n "$LOCAL_DF_OUT" ]; then printf '%s\\n' "$LOCAL_DF_OUT"; exit 0; fi\nexec ${realDf} "$@"`)

  const keys = ["PATH", "DF_OUT", "LOCAL_DF_OUT", "SCP_CORRUPT", "SCP_FAIL", "STREAM_FAIL", "SSH_DENY", "SSH_G_USER"]
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  process.env.PATH = `${bin}:${process.env.PATH}`
  const remote = join(root, "remote")
  const local = join(root, "local")
  mkdirSync(remote)
  mkdirSync(local)
  return {
    root,
    remote,
    local,
    file(name: string, content: string | Buffer) {
      const p = join(local, name)
      writeFileSync(p, content)
      return p
    },
    set(env: Record<string, string>) {
      Object.assign(process.env, env)
    },
    scpRan: () => existsSync(scpLog) && readFileSync(scpLog, "utf8").length > 0,
    leftovers: (dir: string) => readdirSync(dir).filter((f) => f.includes(".iris-partial-")),
    done() {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
}
const FULL = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/d 1000 999 1 100% /tmp"
const ROOMY = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/d 99999999 1 99999999 1% /tmp"
const target = { host: "node.test", user: "me", via: "explicit" as const }
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex")
async function withHarness(fn: (h: ReturnType<typeof harness>) => Promise<void>) {
  const h = harness()
  try {
    await fn(h)
  } finally {
    h.done()
  }
}

describe("pushFile — preflights run before any byte is copied", () => {
  test("a full destination is refused and scp never runs", () =>
    withHarness(async (h) => {
      h.set({ DF_OUT: FULL })
      const r = await pushFile(target, h.file("a.bin", "x".repeat(4096)), h.remote)
      expect(r.error).toContain("not enough free space")
      expect(h.scpRan()).toBe(false)
    }))

  test("unreadable free space is refused and scp never runs", () =>
    withHarness(async (h) => {
      h.set({ DF_OUT: "garbage" })
      const r = await pushFile(target, h.file("a.bin", "x"), h.remote)
      expect(r.error).toContain("could not verify free space")
      expect(h.scpRan()).toBe(false)
    }))

  test("a directory is refused with a clear error before hashing or ssh", () =>
    withHarness(async (h) => {
      const r = await pushFile(target, h.local, h.remote)
      expect(r.error).toContain("not a regular file")
      expect(h.scpRan()).toBe(false)
    }))
})

describe("pushFile — only a verified file ever appears under its real name (#187956)", () => {
  test("a verified push lands under its name and leaves no partial behind", () =>
    withHarness(async (h) => {
      h.set({ DF_OUT: ROOMY })
      const r = await pushFile(target, h.file("a.bin", "hello world"), h.remote)
      expect(r.ok).toBe(true)
      expect(readFileSync(join(h.remote, "a.bin"), "utf8")).toBe("hello world")
      expect(h.leftovers(h.remote)).toEqual([])
    }))

  test("a corrupted copy is deleted — nothing under the real name, no partial", () =>
    withHarness(async (h) => {
      h.set({ DF_OUT: ROOMY, SCP_CORRUPT: "1" })
      const r = await pushFile(target, h.file("a.bin", "hello world"), h.remote)
      expect(r.ok).toBe(false)
      expect(r.error).toContain("CHECKSUM MISMATCH")
      expect(existsSync(join(h.remote, "a.bin"))).toBe(false)
      expect(h.leftovers(h.remote)).toEqual([])
    }))

  test("a failed copy leaves nothing behind", () =>
    withHarness(async (h) => {
      h.set({ DF_OUT: ROOMY, SCP_FAIL: "1" })
      const r = await pushFile(target, h.file("a.bin", "hello"), h.remote)
      expect(r.error).toContain("scp failed")
      expect(readdirSync(h.remote)).toEqual([])
    }))

  test("a failed re-push does not destroy the good copy already there", () =>
    withHarness(async (h) => {
      h.set({ DF_OUT: ROOMY })
      writeFileSync(join(h.remote, "a.bin"), "the good copy")
      h.set({ SCP_CORRUPT: "1" })
      await pushFile(target, h.file("a.bin", "new version"), h.remote)
      expect(readFileSync(join(h.remote, "a.bin"), "utf8")).toBe("the good copy")
    }))
})

describe("pushStream — stdin straight to a node, still verified (#187956)", () => {
  test("a stream lands verified under --name, hashed as it passed", () =>
    withHarness(async (h) => {
      h.set({ DF_OUT: ROOMY })
      const parts = [Buffer.from("part one "), Buffer.alloc(200_000, 7), Buffer.from(" end")]
      const r = await pushStream(target, Readable.from(parts), h.remote, "dump.sql.gz")
      const all = Buffer.concat(parts)
      expect(r.ok).toBe(true)
      expect(r.bytes).toBe(all.length)
      expect(r.sha256).toBe(sha(all))
      expect(readFileSync(join(h.remote, "dump.sql.gz")).equals(all)).toBe(true)
      expect(h.leftovers(h.remote)).toEqual([])
    }))

  test("a node that fills up mid-stream says so and keeps nothing", () =>
    withHarness(async (h) => {
      h.set({ DF_OUT: ROOMY, STREAM_FAIL: "1" })
      const r = await pushStream(target, Readable.from([Buffer.alloc(50_000, 1)]), h.remote, "dump.sql.gz")
      expect(r.ok).toBe(false)
      expect(r.error).toContain("ran out of disk space mid-stream")
      expect(readdirSync(h.remote)).toEqual([])
    }))

  test("--size is checked against free space before the stream starts", () =>
    withHarness(async (h) => {
      // 200 MiB free: room for the reserve alone, not for a 150 MiB stream on top of it.
      h.set({ DF_OUT: `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/d 999999 1 ${200 * 1024} 50% /tmp` })
      const r = await pushStream(target, Readable.from([Buffer.from("x")]), h.remote, "d", { expectBytes: 150 * 1024 * 1024 })
      expect(r.error).toContain("not enough free space")
      expect(readdirSync(h.remote)).toEqual([])
      const unsized = await pushStream(target, Readable.from([Buffer.from("x")]), h.remote, "d")
      expect(unsized.ok).toBe(true)
    }))

  test("a name that is a path is refused — a stream cannot write outside --to", async () => {
    for (const bad of ["../x", "a/b", "..", "", undefined]) expect(streamNameError(bad as any)).not.toBeNull()
    expect(streamNameError("db.sql.gz")).toBeNull()
  })
})

describe("pullFile — fits in both places, and only a verified copy is kept (#187787)", () => {
  test("a verified pull lands under its name with no partial, and a pull of a folder is refused", () =>
    withHarness(async (h) => {
      writeFileSync(join(h.remote, "notes.txt"), "remote notes")
      const r = await pullFile(target, join(h.remote, "notes.txt"), h.local)
      expect(r.ok).toBe(true)
      expect(readFileSync(join(h.local, "notes.txt"), "utf8")).toBe("remote notes")
      expect(h.leftovers(h.local)).toEqual([])

      const d = await pullFile(target, h.remote, h.local)
      expect(d.error).toContain("is a directory")
    }))

  test("no room on THIS machine is refused before anything is staged or copied", () =>
    withHarness(async (h) => {
      writeFileSync(join(h.remote, "big.bin"), "x".repeat(4096))
      h.set({ LOCAL_DF_OUT: FULL })
      const r = await pullFile(target, join(h.remote, "big.bin"), h.local)
      expect(r.error).toContain("on this machine")
      expect(h.scpRan()).toBe(false)
    }))

  test("no room in the node's /tmp staging area is refused before staging", () =>
    withHarness(async (h) => {
      writeFileSync(join(h.remote, "big.bin"), "x".repeat(4096))
      h.set({ DF_OUT: FULL })
      const r = await pullFile(target, join(h.remote, "big.bin"), h.local)
      expect(r.error).toContain("node's /tmp")
      expect(h.scpRan()).toBe(false)
    }))

  test("a corrupted pull is deleted — the local name stays free", () =>
    withHarness(async (h) => {
      writeFileSync(join(h.remote, "notes.txt"), "remote notes")
      h.set({ SCP_CORRUPT: "1" })
      const r = await pullFile(target, join(h.remote, "notes.txt"), h.local)
      expect(r.error).toContain("CHECKSUM MISMATCH")
      expect(readdirSync(h.local)).toEqual([])
    }))
})

describe("ensureSshUser — one account is tried once", () => {
  test("the local login is not retried when it IS ssh's default", () =>
    withHarness(async (h) => {
      const me = userInfo().username
      h.set({ SSH_DENY: "1", SSH_G_USER: me })
      const r = await ensureSshUser("node-id", { host: "node.test", user: null, via: "explicit" })
      expect("error" in r && r.error).toContain(`${me} (ssh default)`)
      expect("error" in r && r.error.split(me).length - 1).toBe(1)
    }))
})

describe("describeSshFailure — name the cause that was established (#187786, #187954)", () => {
  const denied = "me@h: Permission denied (publickey)."
  test("a route failure is called a network problem, not a username or key problem", () => {
    const m = describeSshFailure("h", [{ user: null, stderr: "ssh: connect to host h port 22: Connection timed out" }], { defaultUser: "me", keyFound: true })
    expect(m).toContain("network problem")
    expect(m).not.toContain("--user")
  })
  test("no key on this machine says so, and says no username can work", () => {
    const m = describeSshFailure("h", [{ user: "bob", stderr: denied }], { defaultUser: "me", keyFound: false })
    expect(m).toContain("No SSH key was found on this machine")
    expect(m).toContain("ssh-keygen")
    expect(m).toContain("iris hive ssh-setup bob@h")
  })
  test("refusals with a key present name every user tried, including the ssh default", () => {
    const m = describeSshFailure("h", [{ user: "bob", stderr: denied }, { user: null, stderr: denied }], { defaultUser: "me", keyFound: true })
    expect(m).toContain("bob, me (ssh default)")
    expect(m).toContain("--user")
    expect(m).not.toContain("No SSH key")
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
    // A running daemon writes a log. Without one, "0 denials" means "not measured", which
    // judge() reports as a problem (#184929) — so a healthy fixture must carry a log.
    daemon_log_bytes: "4096",
    daemon_log_scanned: "~/.iris/bridge/daemon.log",
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

  test("no daemon log is UNKNOWN, not clean — a problem while the daemon runs, a note when it is down (#184929)", () => {
    const up = judge("n", {}, { ...healthy, daemon_log_bytes: "" })
    expect(up.degraded).toBe(true)
    expect(up.problems.join(" ")).toContain("UNKNOWN, not clean")
    expect(up.problems.join(" ")).toContain("~/.iris/bridge/daemon.log")

    const down = judge("n", {}, { ...healthy, daemon_pid: "", daemon_log_bytes: "" })
    expect(down.notes.join(" ")).toContain("UNKNOWN, not clean")
  })

  test("empty readings do not throw and do not silently pass", () => {
    const v = judge("n", {}, {})
    expect(v.degraded).toBe(true)
  })
})
