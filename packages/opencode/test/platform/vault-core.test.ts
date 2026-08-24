/**
 * IRIS Vault core — the rules a sovereign store cannot get wrong.
 *
 * Every assertion here is about a way a storage system can LIE: report a replica that cannot
 * restore, return bytes that are not the bytes, reassemble in the wrong order and produce a
 * file of the right length, or count a node with unknown capacity as room. Those are the same
 * failure shape this codebase has been chasing all week — a check that cannot distinguish a
 * healthy state from an unmeasured one — applied to something that holds the only copy.
 */

import { describe, test, expect } from "bun:test"
import {
  sha256,
  chunkBuffer,
  generateVaultKey,
  encryptChunk,
  decryptChunk,
  buildEntry,
  reassemble,
  nextManifest,
  manifestDigest,
  normalizePath,
  choosePlacement,
  replicationHealth,
  DEFAULT_CHUNK_SIZE,
  type VaultManifest,
} from "../../src/cli/cmd/vault-core"

const META = { vault_id: "v1", author_node: "laptop", created_at: "2026-08-23T00:00:00Z" }

describe("chunking", () => {
  test("splits on the boundary and keeps every byte", () => {
    const buf = Buffer.from("abcdefghij")
    const parts = chunkBuffer(buf, 4)
    expect(parts.map((p) => p.toString())).toEqual(["abcd", "efgh", "ij"])
    expect(Buffer.concat(parts).equals(buf)).toBe(true)
  })

  test("an EMPTY file yields zero chunks and must still round-trip", () => {
    // An empty file is a real thing a person stores. If "no chunks" is treated as "no entry"
    // it disappears silently, which is the worst possible outcome for a backup product.
    const key = generateVaultKey()
    const { entry, blobs } = buildEntry(key, Buffer.alloc(0))
    expect(blobs.length).toBe(0)
    expect(entry.size).toBe(0)
    expect(reassemble(key, entry, new Map()).length).toBe(0)
  })

  test("rejects a nonsense chunk size instead of looping forever", () => {
    expect(() => chunkBuffer(Buffer.from("x"), 0)).toThrow()
  })
})

describe("encryption — the sovereignty property", () => {
  const key = generateVaultKey()

  test("blobs are addressed by CIPHERTEXT hash, so a holder can verify without the key", () => {
    const c = encryptChunk(key, Buffer.from("patient record"), 0)
    // This is the whole trick: a replica node recomputes this and knows its copy is intact,
    // while being unable to read a byte of it.
    expect(c.ref.id).toBe(sha256(c.bytes))
    expect(c.bytes.includes(Buffer.from("patient record"))).toBe(false)
  })

  test("round-trips", () => {
    const c = encryptChunk(key, Buffer.from("hello"), 0)
    expect(decryptChunk(key, c.bytes, c.ref.id).toString()).toBe("hello")
  })

  test("the SAME plaintext encrypts differently every time — no nonce reuse", () => {
    // A counter-derived nonce would repeat across files at the same index, and nonce reuse
    // under GCM leaks the XOR of plaintexts and breaks the authenticator.
    const a = encryptChunk(key, Buffer.from("same"), 0)
    const b = encryptChunk(key, Buffer.from("same"), 0)
    expect(a.ref.id).not.toBe(b.ref.id)
  })

  test("a corrupted blob is REFUSED, not silently returned", () => {
    const c = encryptChunk(key, Buffer.from("hello"), 0)
    const tampered = Buffer.from(c.bytes)
    tampered[tampered.length - 3] ^= 0xff // flip a bit in the auth tag
    expect(() => decryptChunk(key, tampered, c.ref.id)).toThrow(/integrity failure/i)
  })

  test("a blob that hashes right but was forged fails the AUTH TAG", () => {
    // Address check and authenticity check are independent. Passing the first does not
    // establish the second.
    const c = encryptChunk(key, Buffer.from("hello"), 0)
    const forged = Buffer.from(c.bytes)
    forged[NONCE_OFFSET] ^= 0x01
    expect(() => decryptChunk(key, forged, sha256(forged))).toThrow()
  })
  const NONCE_OFFSET = 0

  test("the WRONG key cannot read a blob", () => {
    const c = encryptChunk(key, Buffer.from("phi"), 0)
    expect(() => decryptChunk(generateVaultKey(), c.bytes, c.ref.id)).toThrow()
  })

  test("rejects a key of the wrong length rather than deriving something weaker", () => {
    expect(() => encryptChunk(Buffer.alloc(16), Buffer.from("x"), 0)).toThrow(/32 bytes/)
  })
})

describe("reassembly", () => {
  const key = generateVaultKey()

  test("orders by chunk index, NOT by arrival order", () => {
    // Blobs come back from several nodes concurrently. Reassembling in arrival order yields a
    // file of exactly the right length that hashes wrong — and looks fine in a listing.
    const data = Buffer.from("0123456789abcdefghij")
    const { entry, blobs } = buildEntry(key, data, { chunkSize: 4 })
    expect(entry.chunks.length).toBe(5)
    const shuffled = new Map([...blobs].reverse().map((b) => [b.ref.id, b.bytes]))
    expect(reassemble(key, entry, shuffled).equals(data)).toBe(true)
  })

  test("a missing chunk NAMES itself instead of returning a short file", () => {
    const { entry, blobs } = buildEntry(key, Buffer.from("0123456789"), { chunkSize: 4 })
    const partial = new Map(blobs.slice(0, 2).map((b) => [b.ref.id, b.bytes]))
    expect(() => reassemble(key, entry, partial)).toThrow(/missing blob/)
  })

  test("verifies the PLAINTEXT digest end to end", () => {
    const { entry, blobs } = buildEntry(key, Buffer.from("abc"))
    const map = new Map(blobs.map((b) => [b.ref.id, b.bytes]))
    // Corrupt the recorded plaintext digest: reassembly must refuse even though every blob is
    // individually valid.
    const bad = { ...entry, plain_sha256: sha256(Buffer.from("different")) }
    expect(() => reassemble(key, bad, map)).toThrow(/digest mismatch/)
  })

  test("a 5 MiB file crosses the default chunk boundary and still round-trips", () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 7)
    const { entry, blobs } = buildEntry(key, big)
    expect(entry.chunks.length).toBe(2)
    expect(DEFAULT_CHUNK_SIZE).toBe(4 * 1024 * 1024)
    const map = new Map(blobs.map((b) => [b.ref.id, b.bytes]))
    expect(reassemble(key, entry, map).equals(big)).toBe(true)
  })
})

describe("paths", () => {
  test("normalises to relative POSIX", () => {
    expect(normalizePath("/a/b.txt")).toBe("a/b.txt")
    expect(normalizePath("a\\b.txt")).toBe("a/b.txt")
    expect(normalizePath("./a//b.txt")).toBe("a/b.txt")
  })

  test("REFUSES traversal — a get must not write outside its output directory", () => {
    expect(() => normalizePath("../etc/passwd")).toThrow(/\.\./)
    expect(() => normalizePath("a/../../b")).toThrow(/\.\./)
  })

  test("refuses an empty path", () => {
    expect(() => normalizePath("/")).toThrow()
    expect(() => normalizePath("")).toThrow()
  })

  test("keeps spaces — the file this system exists for has one in its name", () => {
    expect(normalizePath("controllers/Pioneer DDJ-T1.midi.xml")).toBe("controllers/Pioneer DDJ-T1.midi.xml")
  })
})

describe("manifests — append-only history", () => {
  const key = generateVaultKey()
  const e = (s: string) => buildEntry(key, Buffer.from(s)).entry

  test("chains by parent digest and increments seq", () => {
    const m1 = nextManifest(null, { put: { "a.txt": e("a") } }, META)
    const m2 = nextManifest(m1, { put: { "b.txt": e("b") } }, META)
    expect(m1.seq).toBe(1)
    expect(m1.parent).toBeNull()
    expect(m2.seq).toBe(2)
    expect(m2.parent).toBe(manifestDigest(m1))
    expect(Object.keys(m2.entries).sort()).toEqual(["a.txt", "b.txt"])
  })

  test("never mutates the previous manifest", () => {
    const m1 = nextManifest(null, { put: { "a.txt": e("a") } }, META)
    const before = manifestDigest(m1)
    nextManifest(m1, { put: { "b.txt": e("b") }, remove: ["a.txt"] }, META)
    expect(manifestDigest(m1)).toBe(before)
    expect(Object.keys(m1.entries)).toEqual(["a.txt"])
  })

  test("the digest is stable across key ordering", () => {
    // Otherwise the parent chain breaks on JSON ordering alone and reports a history gap that
    // does not exist.
    const m: VaultManifest = { vault_id: "v", seq: 1, parent: null, created_at: "t", author_node: "n", entries: {} }
    const reordered: any = { entries: {}, author_node: "n", created_at: "t", parent: null, seq: 1, vault_id: "v" }
    expect(manifestDigest(m)).toBe(manifestDigest(reordered))
  })

  test("remove drops the path from the new manifest but not from history", () => {
    const m1 = nextManifest(null, { put: { "a.txt": e("a") } }, META)
    const m2 = nextManifest(m1, { remove: ["a.txt"] }, META)
    expect(m2.entries["a.txt"]).toBeUndefined()
    expect(m1.entries["a.txt"]).toBeDefined()
  })
})

describe("placement — capacity is not optional", () => {
  const GB = 1024 * 1024 * 1024

  test("prefers the most headroom", () => {
    const r = choosePlacement(
      [
        { name: "roomy", online: true, freeBytes: 500 * GB },
        { name: "tight", online: true, freeBytes: 12 * GB },
      ],
      1,
      1024,
    )
    expect(r.chosen).toEqual(["roomy"])
  })

  test("refuses a node that cannot fit the payload plus margin", () => {
    // MacBookPro measured at 98% / 11 GiB free. Replicate-everywhere would take it down.
    const r = choosePlacement([{ name: "full", online: true, freeBytes: 11 * GB }], 1, 20 * GB)
    expect(r.chosen).toEqual([])
    expect(r.shortfall).toBe(1)
    expect(r.reason).toMatch(/without room/)
  })

  test("UNKNOWN capacity is not treated as room", () => {
    const r = choosePlacement([{ name: "mystery", online: true, freeBytes: null }], 1, 1024)
    expect(r.chosen).toEqual([])
    expect(r.reason).toMatch(/unknown is not treated as room/i)
  })

  test("offline nodes are never chosen, and the shortfall SAYS why", () => {
    const r = choosePlacement(
      [
        { name: "asleep", online: false, freeBytes: 900 * GB },
        { name: "up", online: true, freeBytes: 900 * GB },
      ],
      2,
      1024,
    )
    expect(r.chosen).toEqual(["up"])
    expect(r.shortfall).toBe(1)
    expect(r.reason).toMatch(/1 offline/)
  })

  test("reports a shortfall rather than silently accepting fewer replicas", () => {
    const r = choosePlacement([], 3, 1024)
    expect(r.shortfall).toBe(3)
    expect(r.chosen).toEqual([])
  })
})

describe("replication health — a partial copy restores nothing", () => {
  const key = generateVaultKey()
  const { entry } = buildEntry(key, Buffer.from("0123456789"), { chunkSize: 4 }) // 3 chunks
  const manifest: VaultManifest = { ...META, seq: 1, parent: null, entries: { "f.bin": entry } } as VaultManifest
  const ids = entry.chunks.map((c) => c.id)

  test("a node holding EVERY chunk counts as a replica", () => {
    const pins = Object.fromEntries(ids.map((id) => [id, ["a"]]))
    const h = replicationHealth(manifest, pins, 1)[0]
    expect(h.replicas).toBe(1)
    expect(h.fullyHeldBy).toEqual(["a"])
    expect(h.atRisk).toBe(false)
  })

  test("THE ONE THAT MATTERS: a node holding SOME chunks does not count", () => {
    // Counting it produces "2 of 2 replicas" over a file that cannot be recovered — the exact
    // reassuring-but-false number this system keeps getting caught by.
    const pins: Record<string, string[]> = {}
    ids.forEach((id, i) => { pins[id] = i === 0 ? ["a", "b"] : ["a"] })
    const h = replicationHealth(manifest, pins, 2)[0]
    expect(h.fullyHeldBy).toEqual(["a"])
    expect(h.partiallyHeldBy).toEqual(["b"])
    expect(h.replicas).toBe(1)
    expect(h.atRisk).toBe(true)
  })

  test("no pins at all is at risk, not healthy", () => {
    const h = replicationHealth(manifest, {}, 1)[0]
    expect(h.replicas).toBe(0)
    expect(h.atRisk).toBe(true)
  })

  test("an empty file is never at risk — it needs no blobs to restore", () => {
    const empty = buildEntry(key, Buffer.alloc(0)).entry
    const m: VaultManifest = { ...META, seq: 1, parent: null, entries: { "e.txt": empty } } as VaultManifest
    expect(replicationHealth(m, {}, 2)[0].atRisk).toBe(false)
  })
})
