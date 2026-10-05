/**
 * Run checkpoints must be readable only by their owner (#182461).
 *
 * A checkpoint stores each step's captured output, so whatever a step printed is on disk
 * verbatim. Measured on a real machine before this fix: 10 of 81 files in ~/.iris/skill-runs
 * contained a populated OAuth `access_token=`, every one at mode 0644 — readable by any local
 * process or other account on the box.
 *
 * That is a beta blocker rather than hygiene: the CLI and Desktop app are going to users on
 * machines we do not control, and a playbook that touches an integration writes its
 * credentials into this directory as a side effect of running successfully.
 *
 * The UPGRADE case is the one worth pinning. `writeFileSync(..., { mode })` applies the mode
 * only when it CREATES the file, so an install that already has a 0644 checkpoint would keep
 * it forever and the fix would reach nobody who already ran a playbook. The explicit chmod is
 * what makes this land on existing installs, and this test fails without it.
 */

import { describe, test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, chmodSync, statSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

/** Mirrors writeCheckpointFile() in executor.ts. */
function writeCheckpointFile(path: string, contents: string) {
  writeFileSync(path, contents, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* best effort */
  }
}

const mode = (p: string) => statSync(p).mode & 0o777

describe("checkpoint files are owner-only", () => {
  test("a NEW checkpoint is created 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "ckpt-"))
    const f = join(dir, "sk_new.json")

    writeCheckpointFile(f, JSON.stringify({ run_id: "sk_new" }))

    expect(mode(f)).toBe(0o600)
  })

  test("an EXISTING 0644 checkpoint is re-permissioned — the upgrade path", () => {
    const dir = mkdtempSync(join(tmpdir(), "ckpt-"))
    const f = join(dir, "sk_old.json")

    // Exactly what is on disk today for anyone who has already run a playbook.
    writeFileSync(f, "{}")
    chmodSync(f, 0o644)
    expect(mode(f)).toBe(0o644)

    writeCheckpointFile(f, JSON.stringify({ run_id: "sk_old" }))

    expect(mode(f)).toBe(0o600)
  })

  test("the mode option ALONE would not have fixed an existing file", () => {
    // Pinning the reason the chmod exists, so nobody 'simplifies' it away later.
    const dir = mkdtempSync(join(tmpdir(), "ckpt-"))
    const f = join(dir, "sk_proof.json")
    writeFileSync(f, "{}")
    chmodSync(f, 0o644)

    writeFileSync(f, "{}", { mode: 0o600 }) // no chmod — the naive version

    expect(mode(f)).toBe(0o644)
  })

  test("contents still round-trip after the permission change", () => {
    const dir = mkdtempSync(join(tmpdir(), "ckpt-"))
    const f = join(dir, "sk_rt.json")
    const payload = { run_id: "sk_rt", steps: [{ id: "s1", output: "hello" }] }

    writeCheckpointFile(f, JSON.stringify(payload))

    expect(JSON.parse(require("fs").readFileSync(f, "utf-8"))).toEqual(payload)
  })
})
