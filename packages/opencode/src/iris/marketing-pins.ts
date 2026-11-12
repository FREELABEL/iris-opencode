import { FL_API, irisFetch } from "./platform"

/**
 * DESKTOP › MARKETING'S PINS, ON THE ACCOUNT (#193357, follows #192624).
 *
 * Until now the pins lived in one machine's localStorage: a second Mac, or `iris marketing` in a
 * terminal, saw none of them. fl-api #298 adds the account's own settings store, and this is the
 * engine's door to its `marketing.pins` key:
 *
 *   GET  /api/v1/me/settings/marketing.pins                → { value, version }   version 0 = never saved
 *   PUT  /api/v1/me/settings/marketing.pins {value,version}→ the saved value, or 409 + current
 *
 * The engine translates only: `available: false` while fl-api doesn't have the route yet (the panel
 * then keeps using localStorage exactly as before), and a 409 handed back with the server's current
 * value so the panel can show what is really saved. Validation is fl-api's (AccountSettingKeys).
 */

export type PinsValue = { readonly pins: ReadonlyArray<{ readonly slug: string; readonly label: string; readonly signIn?: boolean }>; readonly selected?: string }
export type PinsRead = { measured: boolean; available: boolean; reason?: string; value?: PinsValue; version?: number }
export type PinsWrite = { ok: boolean; conflict?: boolean; reason?: string; value?: PinsValue; version?: number }

const PATH = "/api/v1/me/settings/marketing.pins"

/** The seam a test replaces. */
export const marketingPinsDeps = {
  fetch: (init?: RequestInit) => irisFetch(PATH, FL_API, init),
}

const asValue = (v: unknown): PinsValue | undefined =>
  v && typeof v === "object" && Array.isArray((v as any).pins) ? (v as PinsValue) : undefined
const asVersion = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0)

export async function readMarketingPins(): Promise<PinsRead> {
  const res = await marketingPinsDeps.fetch().catch(() => undefined)
  if (!res) return { measured: false, available: false, reason: "IRIS isn't answering" }
  if (res.status === 404 || res.status === 405) return { measured: true, available: false, reason: "pins on the account aren't switched on yet" }
  if (res.status === 401) return { measured: false, available: false, reason: "not signed in" }
  if (!res.ok) return { measured: false, available: false, reason: "your pins couldn't be read" }
  const j = (await res.json().catch(() => null)) as { data?: { value?: unknown; version?: unknown } } | null
  const value = asValue(j?.data?.value)
  if (!value) return { measured: false, available: false, reason: "IRIS answered without pins" }
  return { measured: true, available: true, value, version: asVersion(j?.data?.version) }
}

export async function writeMarketingPins(input: { value: PinsValue; version: number }): Promise<PinsWrite> {
  const res = await marketingPinsDeps
    .fetch({ method: "PUT", body: JSON.stringify({ value: input.value, version: input.version }) })
    .catch(() => undefined)
  if (!res) return { ok: false, reason: "IRIS isn't answering" }
  const j = (await res.json().catch(() => null)) as any
  if (res.ok) return { ok: true, value: asValue(j?.data?.value) ?? input.value, version: asVersion(j?.data?.version) }
  if (res.status === 409) return { ok: false, conflict: true, reason: "changed elsewhere", value: asValue(j?.current?.value), version: asVersion(j?.current?.version) }
  if (res.status === 404 || res.status === 405) return { ok: false, reason: "pins on the account aren't switched on yet" }
  if (res.status === 422) return { ok: false, reason: typeof j?.error === "string" ? j.error : "IRIS refused those pins" }
  return { ok: false, reason: res.status === 401 ? "not signed in" : "your pins couldn't be saved" }
}
