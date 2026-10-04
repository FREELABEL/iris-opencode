import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync, utimesSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { hold, listHeld, readHeld, release } from "../../src/transcribe/held"

const dir = mkdtempSync(join(tmpdir(), "held-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// 44-byte header + one second of 16 kHz mono 16-bit audio.
const wav = new Uint8Array(44 + 32000).fill(7)

describe("held recordings", () => {
  test("hold writes a private file that can be listed, read back and released", () => {
    const held = hold(wav, dir)
    expect(held.seconds).toBe(1)
    expect(statSync(join(dir, `${held.id}.wav`)).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(listHeld(dir).map((h) => h.id)).toContain(held.id)
    expect(readHeld(held.id, dir)).toEqual(wav)
    release(held.id, dir)
    expect(readHeld(held.id, dir)).toBeNull()
    expect(listHeld(dir).map((h) => h.id)).not.toContain(held.id)
  })

  test("ids that could reach outside the directory are refused", () => {
    expect(readHeld("../../etc/passwd", dir)).toBeNull()
    expect(readHeld("1234567890123-abcdef/../x", dir)).toBeNull()
  })

  test("recordings older than a week are pruned when listed", () => {
    const old = hold(wav, dir)
    const fresh = hold(wav, dir)
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(join(dir, `${old.id}.wav`), eightDaysAgo, eightDaysAgo)
    const ids = listHeld(dir).map((h) => h.id)
    expect(ids).toContain(fresh.id)
    expect(ids).not.toContain(old.id)
    expect(readHeld(old.id, dir)).toBeNull()
  })

  test("a missing directory lists as empty", () => {
    expect(listHeld(join(dir, "does-not-exist"))).toEqual([])
  })
})
