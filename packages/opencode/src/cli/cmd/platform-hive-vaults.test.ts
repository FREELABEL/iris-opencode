import { describe, expect, test } from "bun:test"
import { formatVaultRow, humanBytes } from "./platform-hive-vaults"

describe("iris hive vaults list formatting", () => {
  test("a row carries name, bloq, lock state and size — and nothing else", () => {
    const row = formatVaultRow({ name: "phi-bloq-7", bloq_id: "7", locked: true, key_source: "passphrase", files: 3, bytes: 2048, escrow: "escrowed" })
    expect(row).toContain("phi-bloq-7")
    expect(row).toContain("bloq 7")
    expect(row).toContain("locked")
    expect(row).toContain("3 file(s)")
    expect(row).toContain("2.0 KB")
    expect(row).toContain("escrow:escrowed")
  })

  test("an unbound vault shows bloq -, and sizes scale", () => {
    expect(formatVaultRow({ name: "phi-unbound", bloq_id: null, locked: false, files: 0, bytes: 0 })).toContain("bloq -")
    expect(humanBytes(512)).toBe("512 B")
    expect(humanBytes(5 * 1024 * 1024)).toBe("5.0 MB")
    expect(humanBytes(300 * 1024 * 1024 * 1024)).toBe("300 GB")
  })
})
