/**
 * THE MARKETING TAB'S PINS (#192624, epic #192614) — which Genesis pages the signed-in account
 * pinned as Marketing sub-tabs, in what order, under what label. Pure, so the rules are tested
 * without a DOM or a network.
 *
 * 1.18.169 hardcoded FREELABEL's and Hive's ads pages as these sub-tabs and showed them to every
 * customer. Now there is no default: an account that pinned nothing has nothing, and the panel
 * says "Pin your review pages here". Nothing in this file names a page.
 *
 * WHERE IT LIVES: localStorage, one record per IRIS account (`iris.panel.marketing.pins.<user id>`).
 * Neither the engine nor the platform has a per-user settings store a panel can write arbitrary
 * keys to (fl-api's notification settings validate four booleans; the panel's state route is
 * in-memory and per session), so the pins follow the ACCOUNT on this machine — signing in as
 * someone else shows theirs — but not yet across machines.
 *
 * Whether a page MAY be pinned is the engine's decision (POST /iris/page-pin: the account's own
 * pages only), asked when it is picked. A record read back from storage is still only a list of
 * slugs; framing one shows what freelabel.net/p/ shows anyone, and a signed-in session is
 * granted by the platform only to a board member (#192482).
 */

export type MarketingPin = {
  slug: string
  label: string
  /** Open it signed in (#192482) — the engine said the page asks for a sign-in or is not public. */
  signIn?: boolean
}
export type MarketingPins = { pins: MarketingPin[]; selected?: string }

export const MARKETING_PINS_KEY = "iris.panel.marketing.pins"
/** Genesis slugs, as the engine's PAGE_SLUG. */
export const PIN_SLUG = /^[a-z0-9][a-z0-9-]{0,190}$/
export const PIN_LABEL_MAX = 40
/** More than fit in the sub-tab row at any panel width is a list, not a set of tabs. */
export const PIN_MAX = 12

export const EMPTY_PINS: MarketingPins = { pins: [] }

/** The storage key for one account, or null when nobody is known to be signed in — then nothing is read or written. */
export function pinsKey(accountId: number | null | undefined): string | null {
  return typeof accountId === "number" && Number.isInteger(accountId) && accountId > 0 ? `${MARKETING_PINS_KEY}.${accountId}` : null
}

export function cleanLabel(label: unknown, fallback: string): string {
  const s = typeof label === "string" ? label.replace(/\s+/g, " ").trim() : ""
  return (s || fallback).slice(0, PIN_LABEL_MAX)
}

/** A stored record, or no pins. Anything malformed is dropped, never repaired into a page. */
export function parsePins(raw: string | null | undefined): MarketingPins {
  try {
    const v = JSON.parse(raw ?? "null")
    const list = v && typeof v === "object" && Array.isArray(v.pins) ? (v.pins as unknown[]) : []
    const seen = new Set<string>()
    const pins: MarketingPin[] = []
    for (const p of list) {
      if (!p || typeof p !== "object") continue
      const slug = typeof (p as any).slug === "string" ? (p as any).slug.trim().toLowerCase() : ""
      if (!PIN_SLUG.test(slug) || seen.has(slug)) continue
      seen.add(slug)
      pins.push({ slug, label: cleanLabel((p as any).label, slug), ...((p as any).signIn === true ? { signIn: true } : {}) })
      if (pins.length >= PIN_MAX) break
    }
    const selected = typeof v?.selected === "string" && seen.has(v.selected) ? v.selected : undefined
    return selected ? { pins, selected } : { pins }
  } catch {
    return { pins: [] }
  }
}

export const serializePins = (s: MarketingPins) => JSON.stringify(s)

/** Pin a page at the end and open it. Pinning one already pinned just opens it. */
export function addPin(s: MarketingPins, pin: MarketingPin): MarketingPins {
  const slug = pin.slug.trim().toLowerCase()
  if (!PIN_SLUG.test(slug)) return s
  if (s.pins.some((p) => p.slug === slug)) return { ...s, selected: slug }
  if (s.pins.length >= PIN_MAX) return s
  const next: MarketingPin = { slug, label: cleanLabel(pin.label, slug), ...(pin.signIn ? { signIn: true } : {}) }
  return { pins: [...s.pins, next], selected: slug }
}

/** Unpin. The open tab moves to its neighbour (the one after, else the one before), or to nothing. */
export function removePin(s: MarketingPins, slug: string): MarketingPins {
  const i = s.pins.findIndex((p) => p.slug === slug)
  if (i < 0) return s
  const pins = s.pins.filter((p) => p.slug !== slug)
  if (s.selected !== slug) return s.selected ? { pins, selected: s.selected } : { pins }
  const neighbour = pins[i] ?? pins[i - 1]
  return neighbour ? { pins, selected: neighbour.slug } : { pins }
}

/** Rename. An empty name is the page's slug, not an empty tab. */
export function renamePin(s: MarketingPins, slug: string, label: string): MarketingPins {
  return { ...s, pins: s.pins.map((p) => (p.slug === slug ? { ...p, label: cleanLabel(label, p.slug) } : p)) }
}

/** Move one place left (-1) or right (+1). At an end, nothing moves. */
export function movePin(s: MarketingPins, slug: string, delta: -1 | 1): MarketingPins {
  const i = s.pins.findIndex((p) => p.slug === slug)
  const j = i + delta
  if (i < 0 || j < 0 || j >= s.pins.length) return s
  const pins = [...s.pins]
  ;[pins[i], pins[j]] = [pins[j], pins[i]]
  return { ...s, pins }
}

export function selectPin(s: MarketingPins, slug: string): MarketingPins {
  return s.pins.some((p) => p.slug === slug) ? { ...s, selected: slug } : s
}

/** The tab on screen: the one chosen, else the first, else none (the empty state). */
export function openPin(s: MarketingPins): MarketingPin | undefined {
  return s.pins.find((p) => p.slug === s.selected) ?? s.pins[0]
}
