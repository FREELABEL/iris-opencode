/**
 * Phone numbers as IDENTITIES, not search strings (#183513).
 *
 * Every local message store (WhatsApp JIDs, iMessage chat identifiers) used to be searched with
 * `LIKE '%digits%'`. A substring of a phone number is not a person: "5550100" is inside every
 * "+1 xxx 555-0100" in North America, and the store would hand back whichever chat came first.
 * Whatever came back was written to the lead's record. That is how a third party's private
 * messages ended up on a client.
 *
 * The rule here: both sides are parsed into the same shape and compared WHOLE.
 *
 *   full       country code + national significant number (E.164 digits, no "+").
 *              Written with "+" or "00", or a NANP number (10 digits, area code 2-9, gets "1"),
 *              or 11-15 digits already carrying a country code.
 *              Matches only the identical full number.
 *
 *   national   written with a trunk "0" and no country code ("07700 900123"). We cannot know the
 *              country, so it matches a full number that ENDS in the same national significant
 *              number with a 1-3 digit country code in front of it — never a longer or shorter
 *              run of digits, and the NSN must be at least 9 digits.
 *
 * Anything else (7-digit local numbers, fragments, extensions only) is not an identity and must
 * not be matched at all — the caller reports it and moves on.
 *
 * Why these lengths: a NANP number is exactly 10 digits once the area code is included; without
 * the area code the same 7 digits belong to a different person in each of ~400 area codes. Outside
 * NANP, national significant numbers for mobiles are 9-11 digits in the countries we see (UK 10,
 * FR/ES/IT/AU 9-10, DE 10-11, MX/IN/BR 10-11); 9 is the shortest that is still a whole number.
 * E.164 caps the full number at 15 digits; 8 is the floor we accept for a full number.
 */

export type PhoneIdentity =
  | { ok: true; kind: "full"; digits: string }
  | { ok: true; kind: "national"; nsn: string }
  | { ok: false; reason: string }

export const MIN_FULL_DIGITS = 8
export const MAX_FULL_DIGITS = 15
export const MIN_NATIONAL_DIGITS = 9

/** Parse a phone as written on a lead or in a message store. Never guesses past the rules above. */
export function parsePhoneIdentity(raw: unknown): PhoneIdentity {
  let s = String(raw ?? "").trim()
  if (!s) return { ok: false, reason: "no phone number" }
  // Drop an extension — it identifies a desk, not the line the messages came from.
  s = s.replace(/\s*(?:ext\.?|extension|x|#)\s*\d+\s*$/i, "")
  if (/[a-z]/i.test(s)) return { ok: false, reason: `"${raw}" is not a phone number` }

  let digits = s.replace(/\D/g, "")
  let international = s.startsWith("+")
  if (!international && digits.startsWith("00")) {
    international = true
    digits = digits.slice(2)
  }

  if (international) {
    if (digits.length < MIN_FULL_DIGITS || digits.length > MAX_FULL_DIGITS) {
      return { ok: false, reason: `"${raw}" has ${digits.length} digits — an international number needs ${MIN_FULL_DIGITS}-${MAX_FULL_DIGITS}` }
    }
    return { ok: true, kind: "full", digits }
  }

  // NANP: 10 digits with a real area code (first digit 2-9), or the same with its "1".
  if (digits.length === 10 && /^[2-9]/.test(digits)) return { ok: true, kind: "full", digits: `1${digits}` }
  if (digits.length === 11 && /^1[2-9]/.test(digits)) return { ok: true, kind: "full", digits }

  // Trunk-prefixed national number: the country is unknown, the national number is not.
  if (digits.startsWith("0")) {
    const nsn = digits.replace(/^0+/, "")
    if (nsn.length < MIN_NATIONAL_DIGITS || nsn.length > MAX_FULL_DIGITS - 1) {
      return { ok: false, reason: `"${raw}" is a national number of ${nsn.length} digits — too short to identify one person without a country code` }
    }
    return { ok: true, kind: "national", nsn }
  }

  // Already carries a country code, just without the "+".
  if (digits.length >= 11 && digits.length <= MAX_FULL_DIGITS && !digits.startsWith("1")) {
    return { ok: true, kind: "full", digits }
  }

  return {
    ok: false,
    reason:
      digits.length < 10
        ? `"${raw}" has only ${digits.length} digits — a partial number (no area code / country code) matches other people's chats`
        : `"${raw}" is not a whole phone number`,
  }
}

/** Do two parsed numbers name the same line? Whole-number comparison only. */
export function samePhone(a: PhoneIdentity, b: PhoneIdentity): boolean {
  if (!a.ok || !b.ok) return false
  if (a.kind === "full" && b.kind === "full") return a.digits === b.digits
  if (a.kind === "national" && b.kind === "national") return a.nsn === b.nsn
  const full = a.kind === "full" ? a.digits : (b as { digits: string }).digits
  const nsn = a.kind === "national" ? a.nsn : (b as { nsn: string }).nsn
  const cc = full.length - nsn.length
  return cc >= 1 && cc <= 3 && full.endsWith(nsn)
}

/** A stable key for "the same person" — used to tell one chat from two. */
export function phoneKey(p: PhoneIdentity): string | null {
  if (!p.ok) return null
  return p.kind === "full" ? `+${p.digits}` : `0${p.nsn}`
}

/**
 * A suffix every matching store identifier must end with. For prefiltering in SQL only — the
 * caller MUST confirm each candidate with samePhone(); a suffix is not an identity.
 */
export function phoneSuffix(p: PhoneIdentity): string | null {
  if (!p.ok) return null
  const d = p.kind === "full" ? p.digits : p.nsn
  return d.slice(-MIN_NATIONAL_DIGITS)
}

export type IdentityMatch<T> =
  | { status: "matched"; key: string; candidates: T[] }
  | { status: "ambiguous"; keys: string[] }
  | { status: "none" }
  | { status: "invalid"; reason: string }

/**
 * From store candidates, keep the ones that are the lead's number. More than one DISTINCT number
 * matching (possible only for a national number with no country code) is ambiguous: the caller
 * writes nothing. Several rows for the SAME number (an SMS and an iMessage thread, a re-added
 * WhatsApp chat) are one person and stay matched.
 */
export function matchPhoneCandidates<T>(leadPhone: unknown, candidates: T[], idOf: (c: T) => string): IdentityMatch<T> {
  const lead = parsePhoneIdentity(leadPhone)
  if (!lead.ok) return { status: "invalid", reason: lead.reason }
  const byKey = new Map<string, T[]>()
  for (const c of candidates) {
    const id = parsePhoneIdentity(idOf(c))
    if (!samePhone(lead, id)) continue
    const key = phoneKey(id)!
    byKey.set(key, [...(byKey.get(key) ?? []), c])
  }
  if (byKey.size === 0) return { status: "none" }
  if (byKey.size > 1) return { status: "ambiguous", keys: [...byKey.keys()] }
  const [[key, list]] = [...byKey.entries()]
  return { status: "matched", key, candidates: list }
}
