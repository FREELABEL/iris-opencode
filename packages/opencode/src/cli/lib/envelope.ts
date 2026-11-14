import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "crypto"

/**
 * ihw.v1 — Hive transfer envelope encryption, sender edge.
 *
 * THE PHP SIDE OF THIS LIVES IN fl-iris-api's App\Services\Crypto\EnvelopeCrypto, AND THE TWO
 * MUST AGREE BYTE FOR BYTE. That is unusual for this codebase and it is not an oversight: content
 * is sealed before it leaves the sending machine, so the sender edge has to own an
 * implementation. It cannot be collapsed into one the way the audit chain was.
 *
 * Which makes the failure mode nasty. A drift in the AAD, the HKDF info string or the field order
 * does not throw on either side — both keep working alone, and only cross-party transfers break.
 * For PHI that has already been sent and stored, "the other side can no longer open it" is
 * indistinguishable from data loss. So test/envelope-vectors.test.ts decrypts fixed ciphertexts
 * produced by the PHP implementation, and PHP has a matching test for ciphertexts produced here.
 * Neither side is allowed to test only against itself.
 *
 * WHAT THIS REPLACES. platform-hive-send.ts currently does:
 *
 *     key = SHA-256(node_api_key from ~/.iris/config.json);  AES-256-CBC;  IV in the task config
 *
 * which is unauthenticated (CBC, no tag — blobs are malleable), uses one static key for every
 * transfer forever (one leaked credential opens the whole archive), breaks all history the moment
 * that credential is rotated, and has no recipient key at all — which is why `iris hive send`
 * cannot cross a tenant boundary today.
 *
 * PRIMITIVES: X25519 + HKDF-SHA256 + AES-256-GCM, all Node stdlib. Deliberately NOT libsodium's
 * crypto_box_seal, which is one call in PHP but has no Node equivalent (XSalsa20-Poly1305 with a
 * Blake2b-derived nonce, neither in stdlib) and would have forced a native dependency here.
 */

/** FROZEN. Bytes inside every stored ciphertext's AAD and key derivation, not a label. */
export const ENVELOPE_VERSION = "ihw.v1"

const DEK_BYTES = 32
const GCM_NONCE_BYTES = 12
const GCM_TAG_BYTES = 16
const X25519_BYTES = 32

// Record / unit separators, matching the PHP side and AuditChain's framing. See bind().
const RS = "\x1e"
const US = "\x1f"

// DER wrappers for raw X25519 keys. Node's crypto works in KeyObjects, the wire format is 32 raw
// bytes, and these fixed prefixes are the bridge. Values are from RFC 8410 (id-X25519 1.3.101.110).
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex")
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex")

export class EnvelopeFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EnvelopeFormatError"
  }
}

export interface Wrap {
  ephPublic: Buffer
  nonce: Buffer
  ciphertext: Buffer
  tag: Buffer
}

export interface SealedContent {
  nonce: Buffer
  ciphertext: Buffer
  tag: Buffer
}

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

export function generateKeypair(): { publicKey: Buffer; secretKey: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519")

  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length),
    secretKey: privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_PREFIX.length),
  }
}

export function generateDek(): Buffer {
  return randomBytes(DEK_BYTES)
}

function publicKeyObject(raw: Buffer) {
  assertLength(raw, X25519_BYTES, "public key")
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" })
}

function privateKeyObject(raw: Buffer) {
  assertLength(raw, X25519_BYTES, "secret key")
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" })
}

// ---------------------------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------------------------

/** Seal content under the DEK. `transferId` is bound into the AAD — see wrapDek on replay. */
export function sealContent(plaintext: Buffer | string, dek: Buffer, transferId: string): SealedContent {
  assertLength(dek, DEK_BYTES, "DEK")

  const nonce = randomBytes(GCM_NONCE_BYTES)
  const cipher = createCipheriv("aes-256-gcm", dek, nonce, { authTagLength: GCM_TAG_BYTES })
  cipher.setAAD(Buffer.from(contentAad(transferId), "utf8"))

  const ciphertext = Buffer.concat([
    cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext),
    cipher.final(),
  ])

  return { nonce, ciphertext, tag: cipher.getAuthTag() }
}

/**
 * Open sealed content, or throw. Never returns garbage.
 *
 * A failure means the tag did not verify: the blob was altered, the DEK is wrong, or it belongs to
 * a different transfer. All three are integrity failures, and the CBC construction this replaces
 * could not detect any of them.
 */
export function openContent(sealed: SealedContent, dek: Buffer, transferId: string): Buffer {
  assertLength(dek, DEK_BYTES, "DEK")

  try {
    const decipher = createDecipheriv("aes-256-gcm", dek, sealed.nonce, { authTagLength: GCM_TAG_BYTES })
    decipher.setAAD(Buffer.from(contentAad(transferId), "utf8"))
    decipher.setAuthTag(sealed.tag)

    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()])
  } catch {
    throw new EnvelopeFormatError(
      "content failed authentication — the ciphertext was altered, the DEK is wrong, or it belongs to a different transfer",
    )
  }
}

// ---------------------------------------------------------------------------------------------
// Key wrapping — DHKEM(X25519) + HKDF-SHA256 + AES-256-GCM
// ---------------------------------------------------------------------------------------------

/**
 * Wrap the DEK to one recipient public key.
 *
 * A FRESH ephemeral keypair per call, so two wraps of the same DEK to the same recipient share no
 * key material and no (key, nonce) pair is ever reused — which under GCM is catastrophic rather
 * than merely untidy. The ephemeral secret is discarded immediately.
 *
 * `targetId` is bound into both the derived key and the AAD. Without it, a valid wrapped DEK could
 * be lifted from one transfer and replayed into a forged one for the same recipient, and GCM would
 * authenticate it — it IS a genuine ciphertext, just not for that transfer.
 */
export function wrapDek(dek: Buffer, recipientPublic: Buffer, transferId: string, targetId: string): Wrap {
  assertLength(dek, DEK_BYTES, "DEK")

  const ephemeral = generateKeypair()
  const shared = sharedSecret(ephemeral.secretKey, recipientPublic, "recipient public key")
  const wrapKey = deriveWrapKey(shared, ephemeral.publicKey, recipientPublic, transferId, targetId)

  const nonce = randomBytes(GCM_NONCE_BYTES)
  const cipher = createCipheriv("aes-256-gcm", wrapKey, nonce, { authTagLength: GCM_TAG_BYTES })
  cipher.setAAD(Buffer.from(wrapAad(transferId, targetId), "utf8"))

  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()])

  wipe(shared)
  wipe(wrapKey)
  wipe(ephemeral.secretKey)

  return { ephPublic: ephemeral.publicKey, nonce, ciphertext, tag: cipher.getAuthTag() }
}

/** Unwrap a DEK with the recipient's (or an escrow holder's) secret key. */
export function unwrapDek(
  wrap: Wrap,
  recipientSecret: Buffer,
  recipientPublic: Buffer,
  transferId: string,
  targetId: string,
): Buffer {
  for (const field of ["ephPublic", "nonce", "ciphertext", "tag"] as const) {
    if (!Buffer.isBuffer(wrap?.[field])) throw new EnvelopeFormatError(`wrap is missing '${field}'`)
  }

  const shared = sharedSecret(recipientSecret, wrap.ephPublic, "ephemeral public key")
  const wrapKey = deriveWrapKey(shared, wrap.ephPublic, recipientPublic, transferId, targetId)

  try {
    const decipher = createDecipheriv("aes-256-gcm", wrapKey, wrap.nonce, { authTagLength: GCM_TAG_BYTES })
    decipher.setAAD(Buffer.from(wrapAad(transferId, targetId), "utf8"))
    decipher.setAuthTag(wrap.tag)

    return Buffer.concat([decipher.update(wrap.ciphertext), decipher.final()])
  } catch {
    throw new EnvelopeFormatError(
      "DEK unwrap failed authentication — wrong key, altered wrap, or a wrap belonging to a different transfer or target",
    )
  } finally {
    wipe(shared)
    wipe(wrapKey)
  }
}

// ---------------------------------------------------------------------------------------------
// Frozen derivation + binding — these three functions ARE the cross-language contract
// ---------------------------------------------------------------------------------------------

/**
 * wrap_key = HKDF-SHA256(ikm = X25519 shared secret, salt = "", info = binding)
 *
 * The info string carries the full context, so two targets on the same transfer derive different
 * wrap keys from an identical shared secret. Field list, order and separator are all inside every
 * existing ciphertext's key derivation — frozen.
 *
 * The empty salt matters and is the likeliest place for the two languages to diverge: PHP's
 * hash_hkdf and Node's hkdfSync must both follow RFC 5869 and substitute HashLen zero bytes. The
 * golden-vector test is what proves they do, rather than assuming it.
 */
function deriveWrapKey(
  shared: Buffer,
  ephPublic: Buffer,
  recipientPublic: Buffer,
  transferId: string,
  targetId: string,
): Buffer {
  const info = bind("wrap", [ephPublic.toString("hex"), recipientPublic.toString("hex"), transferId, targetId])

  return Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from(info, "utf8"), DEK_BYTES))
}

/**
 * The binding string used as AAD and as HKDF info — LENGTH-PREFIXED, NOT JOINED.
 *
 * The first version was `fields.join(RS)`, which was a real defect, caught by probing rather than
 * review. With two variable fields adjacent, a separator appearing INSIDE a value makes distinct
 * inputs produce identical bytes:
 *
 *     transferId = "tx-a\x1fnode:7", targetId = "escrow:x"
 *     transferId = "tx-a",           targetId = "node:7\x1fescrow:x"
 *
 * Both joined to the same string, derived the same wrap key, and authenticated under the same AAD.
 * Verified on the PHP side: a wrap made for the first pair unwrapped cleanly under the second and
 * returned the same DEK — defeating exactly the non-transplantability the binding provides.
 *
 * Length-prefixing removes the ambiguity: no value can impersonate a delimiter. Same construction
 * as fl-api's AuditChain::canonicalPayload, and the inconsistency between the two WAS the bug.
 *
 *     segment = byte_length US value
 *     binding = VERSION RS purpose RS segment RS segment ...
 *
 * Byte length, not UTF-16 length — `Buffer.byteLength`, so a multi-byte transfer id agrees with
 * PHP's strlen(). `"é".length` is 1 in JS and 2 in PHP; that mismatch alone would have split the
 * two implementations on any non-ASCII input.
 */
function bind(purpose: string, fields: string[]): string {
  const parts = [ENVELOPE_VERSION, purpose]

  for (const value of fields) {
    parts.push(`${Buffer.byteLength(value, "utf8")}${US}${value}`)
  }

  return parts.join(RS)
}

/** FROZEN. Binds sealed content to its transfer so a blob cannot be replayed elsewhere. */
function contentAad(transferId: string): string {
  return bind("content", [transferId])
}

/** FROZEN. Binds a wrap to both its transfer and its specific target. */
function wrapAad(transferId: string, targetId: string): string {
  return bind("wrap", [transferId, targetId])
}

// ---------------------------------------------------------------------------------------------

/**
 * X25519, with every failure normalised to EnvelopeFormatError.
 *
 * An invalid or small-order public key drives the shared secret to all zeroes, which would mean
 * deriving a wrap key an attacker chose. Node throws on that itself, but as a generic crypto
 * error — translated here so callers have one exception type, matching the PHP side which does the
 * same for SodiumException. The explicit zero check is a second line for a runtime that stops
 * throwing.
 */
function sharedSecret(secret: Buffer, publicRaw: Buffer, what: string): Buffer {
  let shared: Buffer
  try {
    shared = diffieHellman({ privateKey: privateKeyObject(secret), publicKey: publicKeyObject(publicRaw) })
  } catch (e: any) {
    if (e instanceof EnvelopeFormatError) throw e
    throw new EnvelopeFormatError(`X25519 refused the ${what} — it is invalid or of small order: ${e?.message ?? e}`)
  }

  if (isAllZero(shared)) {
    throw new EnvelopeFormatError(`X25519 produced an all-zero shared secret — the ${what} is invalid or of small order`)
  }

  return shared
}

function isAllZero(bytes: Buffer): boolean {
  // Constant-time: the comparison is on a shared secret.
  return timingSafeEqual(bytes, Buffer.alloc(bytes.length))
}

function assertLength(value: Buffer, expected: number, what: string): void {
  if (!Buffer.isBuffer(value) || value.length !== expected) {
    throw new EnvelopeFormatError(`${what} must be exactly ${expected} bytes, got ${value?.length ?? "none"}`)
  }
}

function wipe(buffer: Buffer): void {
  buffer.fill(0)
}
