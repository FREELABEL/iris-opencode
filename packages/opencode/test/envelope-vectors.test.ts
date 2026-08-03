import { describe, test, expect } from "bun:test"
import {
  ENVELOPE_VERSION,
  EnvelopeFormatError,
  generateDek,
  generateKeypair,
  openContent,
  sealContent,
  unwrapDek,
  wrapDek,
} from "../src/cli/lib/envelope"

/**
 * ihw.v1 — THE CROSS-LANGUAGE CONTRACT (#177946 phase 3).
 *
 * This format has two implementations that must agree byte for byte: EnvelopeCrypto in PHP
 * (fl-iris-api) and envelope.ts here. They cannot be collapsed into one, because content is sealed
 * before it leaves the sending machine.
 *
 * WHY THE VECTORS BELOW ARE THE POINT, AND ROUND TRIPS ARE NOT. A round-trip test encrypts and
 * decrypts with the same code, so it passes just as happily against a drifted implementation. If
 * the AAD, the HKDF info string or the field order diverged, both sides would keep working alone —
 * and only cross-party transfers would break. For PHI already sent and stored, "the other side can
 * no longer open it" is indistinguishable from data loss, and nothing would have failed loudly at
 * the moment the drift was introduced.
 *
 * So: THE HEX BELOW WAS PRODUCED BY THE PHP IMPLEMENTATION. If a change here breaks these tests,
 * the change is a new wire format, not a refactor — it needs a new version tag and readers for both
 * on both sides. Never edit a vector to make a test pass.
 */

// Produced by fl-iris-api's App\Services\Crypto\EnvelopeCrypto. Frozen.
const TRANSFER = "transfer-0000-1111-2222"
const TARGET = "recipient:node-7"

const V = {
  dek: "0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d",
  plaintext: "the quick brown fox",
  nonce: "789e909961451dafe3870c11",
  ciphertext: "4db3fea83211d80aec4351249b2f66858a4852",
  tag: "76daa7731b21cdc7ab0f536839f476d6",
  recipPub: "ca2aa0a1e65e40a9892f08ed3ec67c82aaf9d73d75954266807967ffbf44513f",
  recipSec: "de9805cd8fcbe6e96c42947f933a32c2067ce13d629635db62da2dbc56abb09c",
  ephPub: "b970bdc411ec8cd8216078c478f839a8fb100a4c0161f88918b4aacc903dd52b",
  wNonce: "d92c44c63106c48a08033186",
  wCipher: "e4d4a4611e73aa3703945ac06300d4c0291955229b5ded852293c33f5349891a",
  wTag: "c4614a9765221eb368e441e85c4388e3",
}

const hex = (s: string) => Buffer.from(s, "hex")

describe("ihw.v1 golden vectors from the PHP implementation", () => {
  test("decrypts content sealed by PHP", () => {
    // Proves the content AAD, the cipher and the tag length all match across languages.
    const plaintext = openContent(
      { nonce: hex(V.nonce), ciphertext: hex(V.ciphertext), tag: hex(V.tag) },
      hex(V.dek),
      TRANSFER,
    )

    expect(plaintext.toString("utf8")).toBe(V.plaintext)
  })

  test("unwraps a DEK wrapped by PHP", () => {
    // The whole contract in one assertion: X25519 raw<->DER handling, the HKDF info string
    // (version, both public keys, transfer, target — in that order), RFC 5869's empty-salt
    // behaviour in two different HKDF implementations, and the wrap AAD.
    const dek = unwrapDek(
      { ephPublic: hex(V.ephPub), nonce: hex(V.wNonce), ciphertext: hex(V.wCipher), tag: hex(V.wTag) },
      hex(V.recipSec),
      hex(V.recipPub),
      TRANSFER,
      TARGET,
    )

    expect(dek.toString("hex")).toBe(V.dek)
  })

  test("keeps the version tag frozen", () => {
    expect(ENVELOPE_VERSION).toBe("ihw.v1")
  })

  test("unwraps a PHP wrap whose ids are MULTIBYTE", () => {
    // The two per-language multibyte tests only prove each side is self-consistent, which is the
    // exact weakness golden vectors exist to close. This is the real proof: PHP wrapped using
    // strlen() (BYTES), TS unwraps using Buffer.byteLength. Had TS used String.length (UTF-16 code
    // units) the two would derive different wrap keys and this would fail — while every
    // ASCII-only test kept passing, and the only symptom in production would be "the far side
    // cannot open this file".
    const id = "transfer-café-🔐"
    const target = "recipient:node-café"

    const dek = unwrapDek(
      {
        ephPublic: hex("c2af3fd963410082513d8f2bb6d7851da78cfcc829fbf7e1e5aa92ff3b8c0c09"),
        nonce: hex("8359ca728175e6dbb81b5c1f"),
        ciphertext: hex("27c6500afb404958b89a74fac237483f043f92c8be9c86052f6d911118f270eb"),
        tag: hex("1d9399d0e8968ca9250d7bf38cf5447c"),
      },
      hex(V.recipSec),
      hex(V.recipPub),
      id,
      target,
    )

    expect(dek.toString("hex")).toBe(V.dek)
  })

  test("derives the PHP keypair's public key from its secret", () => {
    // Independent of the envelope: if the raw<->DER conversion were wrong, the vectors above could
    // still pass by coincidence of a compensating error. This pins the conversion on its own.
    const { createPrivateKey, createPublicKey } = require("crypto")
    const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), hex(V.recipSec)])
    const derived = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }))
      .export({ format: "der", type: "spki" })
      .subarray(12)

    expect(derived.toString("hex")).toBe(V.recipPub)
  })
})

describe("ihw.v1 properties", () => {
  test("round trips content", () => {
    const dek = generateDek()
    const sealed = sealContent("PHI: referral letter", dek, TRANSFER)

    expect(openContent(sealed, dek, TRANSFER).toString("utf8")).toBe("PHI: referral letter")
  })

  test("detects an altered ciphertext", () => {
    // The property the CBC construction in platform-hive-send.ts does not have at all: under it,
    // this bit-flip decrypts to corrupted-but-accepted plaintext with no signal.
    const dek = generateDek()
    const sealed = sealContent("PHI: referral letter", dek, TRANSFER)
    sealed.ciphertext[0] ^= 0x01

    expect(() => openContent(sealed, dek, TRANSFER)).toThrow(EnvelopeFormatError)
  })

  test("refuses content replayed into another transfer", () => {
    const dek = generateDek()
    const sealed = sealContent("PHI", dek, TRANSFER)

    expect(() => openContent(sealed, dek, "some-other-transfer")).toThrow(EnvelopeFormatError)
  })

  test("round trips a DEK through a wrap", () => {
    const dek = generateDek()
    const kp = generateKeypair()
    const wrap = wrapDek(dek, kp.publicKey, TRANSFER, TARGET)

    expect(unwrapDek(wrap, kp.secretKey, kp.publicKey, TRANSFER, TARGET).toString("hex")).toBe(dek.toString("hex"))
  })

  test("refuses a wrap opened by a different keyholder", () => {
    const dek = generateDek()
    const recipient = generateKeypair()
    const stranger = generateKeypair()
    const wrap = wrapDek(dek, recipient.publicKey, TRANSFER, TARGET)

    expect(() => unwrapDek(wrap, stranger.secretKey, stranger.publicKey, TRANSFER, TARGET)).toThrow(
      EnvelopeFormatError,
    )
  })

  test("refuses a recipient wrap passed off as an escrow wrap", () => {
    const dek = generateDek()
    const kp = generateKeypair()
    const wrap = wrapDek(dek, kp.publicKey, TRANSFER, TARGET)

    expect(() => unwrapDek(wrap, kp.secretKey, kp.publicKey, TRANSFER, "escrow:compliance-officer")).toThrow(
      EnvelopeFormatError,
    )
  })

  test("shares no bytes between two wraps of the same DEK", () => {
    const dek = generateDek()
    const kp = generateKeypair()
    const a = wrapDek(dek, kp.publicKey, TRANSFER, TARGET)
    const b = wrapDek(dek, kp.publicKey, TRANSFER, TARGET)

    expect(a.ephPublic.equals(b.ephPublic)).toBe(false)
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
    expect(a.nonce.equals(b.nonce)).toBe(false)
  })

  test("gives every transfer a distinct DEK", () => {
    // The defect in the current hive-send path, stated as a test: its key is
    // SHA-256(node_api_key) — identical for every transfer forever.
    const deks = new Set(Array.from({ length: 50 }, () => generateDek().toString("hex")))

    expect(deks.size).toBe(50)
  })

  test("refuses an all-zero public key", () => {
    expect(() => wrapDek(generateDek(), Buffer.alloc(32), TRANSFER, TARGET)).toThrow(EnvelopeFormatError)
  })

  test("refuses a malformed public key", () => {
    expect(() => wrapDek(generateDek(), Buffer.from("short"), TRANSFER, TARGET)).toThrow(EnvelopeFormatError)
  })

  test("refuses a wrap whose context merely joins to the same string", () => {
    // THE DELIMITER-COLLISION REGRESSION. The binding was originally fields.join(RS), and with two
    // variable fields adjacent, a separator INSIDE a value made distinct inputs produce identical
    // bytes — so a wrap made for one (transfer, target) pair unwrapped cleanly under a different
    // one and returned the same DEK. Found by probing the PHP side, fixed in both.
    const dek = generateDek()
    const kp = generateKeypair()
    const wrap = wrapDek(dek, kp.publicKey, "tx-a\x1fnode:7", "escrow:x")

    expect(() => unwrapDek(wrap, kp.secretKey, kp.publicKey, "tx-a", "node:7\x1fescrow:x")).toThrow(
      EnvelopeFormatError,
    )
  })

  test("binds multibyte ids by BYTE length, matching PHP", () => {
    // The trap this guards: String.length is UTF-16 code units, PHP's strlen() is bytes. Using
    // .length here would derive a different wrap key from PHP for any non-ASCII id — invisible to
    // ASCII-only tests, and it would only ever surface as "the far side cannot open this".
    const id = "transfer-café-🔐"

    expect(Buffer.byteLength(id, "utf8")).not.toBe(id.length)

    const dek = generateDek()
    const kp = generateKeypair()
    const wrap = wrapDek(dek, kp.publicKey, id, "recipient:node-café")

    expect(unwrapDek(wrap, kp.secretKey, kp.publicKey, id, "recipient:node-café").toString("hex")).toBe(
      dek.toString("hex"),
    )
  })

  test("refuses a short DEK", () => {
    expect(() => sealContent("x", Buffer.alloc(8), TRANSFER)).toThrow(EnvelopeFormatError)
  })
})

/**
 * Emits vectors produced by THIS implementation, for the PHP side to verify against.
 *
 * The tests above prove TS can read PHP. That is only half the contract — an implementation can be
 * a correct reader and a broken writer. Run with EMIT_ENVELOPE_VECTORS=1 and paste the output into
 * the PHP test.
 */
test("emits vectors for the PHP side", () => {
  if (!process.env.EMIT_ENVELOPE_VECTORS) return

  const dek = hex(V.dek)
  const sealed = sealContent(V.plaintext, dek, TRANSFER)
  const wrap = wrapDek(dek, hex(V.recipPub), TRANSFER, TARGET)

  console.log(
    JSON.stringify(
      {
        content: {
          nonce: sealed.nonce.toString("hex"),
          ciphertext: sealed.ciphertext.toString("hex"),
          tag: sealed.tag.toString("hex"),
        },
        wrap: {
          eph_public: wrap.ephPublic.toString("hex"),
          nonce: wrap.nonce.toString("hex"),
          ciphertext: wrap.ciphertext.toString("hex"),
          tag: wrap.tag.toString("hex"),
        },
      },
      null,
      2,
    ),
  )
})
