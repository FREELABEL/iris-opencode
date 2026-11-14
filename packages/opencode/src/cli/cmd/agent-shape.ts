/**
 * An agent's Shape — its icon, drawn from its id (IRIS Shapes, epic #190375).
 *
 * The CHOICE is `bloq_agents.shape` in fl-api: an option number 0–9, or null for "never chosen",
 * which draws as option 0 (SH-03, #190378). It is its own column on purpose — `icon` is the web
 * UI's Font Awesome class and is rewritten on every web save, and `settings` is round-tripped
 * whole by the web UI, so a Shape kept in either would not survive.
 *
 * The PICTURE is fl-iris-api `GET /api/v1/public/shapes/agent/{id}/{n}.svg` (SH-01, #190376): a
 * pure function of the two numbers, byte-identical to the iris-shapes playbook's shape.py.
 */

export const SHAPE_MAX = 9

/** Values `--shape` accepts: an option 0–9, or `none` to clear the choice. */
export const SHAPE_CHOICES = [...Array.from({ length: SHAPE_MAX + 1 }, (_, n) => String(n)), "none"] as const

/**
 * Parse `--shape` for WRITING: "0".."9" (or the number) → n; "none" → null (clear). Anything else
 * throws, so a typo is refused before a request is sent — the server refuses it too (422).
 */
export function parseShape(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= SHAPE_MAX) return raw
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase()
    if (v === "none") return null
    if (/^[0-9]$/.test(v)) return Number(v)
  }
  throw new Error(`--shape must be a whole number from 0 to ${SHAPE_MAX}, or none; got '${String(raw)}'`)
}

/** The option an agent shows: its stored choice, or 0 when it never chose (or the value is not one the server stores). */
export function shapeOf(agent: Record<string, unknown>): number {
  const raw = agent?.shape
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^[0-9]$/.test(raw) ? Number(raw) : NaN
  return Number.isInteger(n) && n >= 0 && n <= SHAPE_MAX ? n : 0
}

/** For `iris agents get`: the option, and whether it was chosen or is the default. */
export function describeShape(agent: Record<string, unknown>): string {
  const chosen = agent?.shape !== undefined && agent?.shape !== null && shapeOf(agent) === Number(agent.shape)
  return chosen ? String(shapeOf(agent)) : "0 (default — not chosen)"
}

/** The public SVG for an agent's Shape option. */
export function shapeUrl(agentId: number | string, option: number, base: string): string {
  return `${base.replace(/\/+$/, "")}/api/v1/public/shapes/agent/${agentId}/${option}.svg`
}

/**
 * The agent as `--json` prints it, plus `shape` (null when never chosen) and `shape_url`.
 * `icon` is passed through untouched. No id → no URL, never a link to /agent/undefined.
 */
export function withShapeUrl<T extends Record<string, unknown>>(agent: T, base: string): T & { shape: number | null; shape_url?: string } {
  const id = agent?.id
  const stored = agent?.shape === undefined || agent?.shape === null ? null : shapeOf(agent)
  const out: Record<string, unknown> = { ...agent, shape: stored }
  if (typeof id === "number" || (typeof id === "string" && /^[1-9][0-9]*$/.test(id))) {
    out.shape_url = shapeUrl(id, shapeOf(agent), base)
  }
  return out as T & { shape: number | null; shape_url?: string }
}
