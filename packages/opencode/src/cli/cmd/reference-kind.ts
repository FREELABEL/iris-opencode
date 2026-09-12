// ============================================================================
// What KIND of reference is this? (#184599)
//
// A user holding "a reference to the thing" could not tell which command would
// take it, and one failure actively misdiagnosed itself:
//
//   $ iris atlas get-item 01a09279-8f43-73ca-b401-1169abe5f942
//   No item NaN visible to this account. Check the id, or whether the board is
//   shared with you.
//
// The uuid was coerced to a number by `type: "number"`, produced NaN, and the
// parse failure was then reported as a VISIBILITY problem. That is a wrong-cause
// error, which costs more than a plain refusal: it sends someone to check board
// sharing for what is a type mismatch, and leaks "NaN" into user-facing text.
//
// These really are different objects — a bloq item id addresses a DOCUMENT; a
// node_task uuid addresses a DELIVERY that lives under the recipient's account and
// is correctly invisible to the sender. The user should not have to know that
// taxonomy to read their own work, so the classifier names the kind it got and the
// command that takes it.
// ============================================================================

export type RefKind =
  /** A bloq item id — `iris atlas get-item 184598`. */
  | "item-id"
  /** A uuid, bare or inside a URL — `iris atlas use <uuid>`. */
  | "uuid"
  /** Nothing we recognise. */
  | "unknown"

export type ClassifiedRef = {
  kind: RefKind
  /** The normalized address: a numeric string for item-id, a lowercase uuid for uuid. */
  value: string | null
  raw: string
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

export function classifyRef(raw: unknown): ClassifiedRef {
  const s = String(raw ?? "").trim()
  if (!s) return { kind: "unknown", value: null, raw: s }

  // A uuid check comes FIRST. `Number("01a09279-…")` is NaN, but a leading-digit
  // uuid looks numeric enough to fool a looser test, and that is the exact coercion
  // this file exists to stop.
  const uuid = s.match(UUID_RE)
  if (uuid) return { kind: "uuid", value: uuid[0].toLowerCase(), raw: s }

  if (/^\d+$/.test(s)) return { kind: "item-id", value: s, raw: s }

  return { kind: "unknown", value: null, raw: s }
}

/**
 * What to tell someone who handed a command the wrong kind of reference — naming
 * what they gave us and which command takes it, instead of guessing at a cause.
 */
export function explainWrongRef(ref: ClassifiedRef, wanted: RefKind): string {
  if (ref.kind === "uuid" && wanted === "item-id") {
    return (
      `That is a uuid, not a bloq item id.\n` +
      `  A uuid addresses a published note or a delivery:  iris atlas use ${ref.value}\n` +
      `  A bloq item id is a plain number:                 iris atlas get-item 184598\n` +
      `  If it came from a hive handoff it is a DELIVERY id — those live under the\n` +
      `  recipient's account and are not readable by the sender.`
    )
  }
  if (ref.kind === "item-id" && wanted === "uuid") {
    return `That is a bloq item id, not a uuid.\n` + `  Read it directly with:  iris atlas get-item ${ref.value}`
  }
  return (
    `Not a reference this command recognises: ${ref.raw}\n` +
    `  Expected ${wanted === "item-id" ? "a bloq item id (a plain number)" : "a uuid, or a URL containing one"}.`
  )
}
