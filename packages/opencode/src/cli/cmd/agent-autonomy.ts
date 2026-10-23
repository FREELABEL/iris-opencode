/**
 * An agent's trust level — `config.autonomy` (#187906).
 *
 * WHY THIS EXISTS. Approval used to be set per SCHEDULE (`--approval-mode autonomous|gated`), so
 * chat and Slack runs — which have no schedule — were never gated. The level now lives on the
 * agent and the server gate (fl-iris-api ToolTrustGate) holds a call by what the tool declares it
 * does (`effect:`, #187905):
 *
 *   intern      holds every write, send and payment; reads run
 *   specialist  works in its own space; holds shared writes, sends and payments
 *   lead        runs freely; holds payments only
 *   (not set)   today's behaviour — ungated in chat, gated only where a schedule asks
 *
 * Mirrors AgentTrustLevel in fl-iris-api. Kept here so the CLI can refuse a typo BEFORE the
 * write: the server treats an unknown stored value as intern, which is safe but surprising.
 */

export const AUTONOMY_LEVELS = ["intern", "specialist", "lead"] as const
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number]

/** What `iris agents create` sets when --autonomy is not given (#187906: CLI agents start as specialist). */
export const CLI_DEFAULT_AUTONOMY: AutonomyLevel = "specialist"

/** Values `--autonomy` accepts on update: a level, or `none` to clear the key. */
export const AUTONOMY_CHOICES = [...AUTONOMY_LEVELS, "none"] as const

const MEANING: Record<AutonomyLevel, string> = {
  intern: "holds every write, send and payment for approval; reads run",
  specialist: "works in its own space; holds shared writes, sends and payments",
  lead: "runs freely; holds payments only",
}

/**
 * Parse a level for WRITING. `none` / empty → null (clear the key). Anything else unknown throws
 * with the accepted list.
 */
export function parseAutonomy(raw: unknown): AutonomyLevel | null {
  if (raw === undefined || raw === null) return null
  const v = String(raw).trim().toLowerCase()
  if (v === "" || v === "none") return null
  if ((AUTONOMY_LEVELS as readonly string[]).includes(v)) return v as AutonomyLevel
  throw new Error(`--autonomy must be one of ${AUTONOMY_CHOICES.join(", ")}; got '${String(raw)}'`)
}

/**
 * What a reader of `iris agents get` should see, read the way the server reads it: missing →
 * not set (today's behaviour); a known level → that level; anything else → intern, flagged.
 */
export function describeAutonomy(config: unknown): { level: AutonomyLevel | null; label: string } {
  const raw = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>).autonomy : undefined
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return { level: null, label: "not set — runs as before (ungated in chat; gated only where a schedule asks)" }
  }
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : ""
  if ((AUTONOMY_LEVELS as readonly string[]).includes(v)) {
    const level = v as AutonomyLevel
    return { level, label: `${level} — ${MEANING[level]}` }
  }
  return { level: "intern", label: `intern — stored value '${String(raw)}' is not a level, so the server treats it as intern` }
}
