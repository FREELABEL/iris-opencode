/**
 * Pulse core — Sources, Stops and PulseScripts (#189244, epic #189242).
 *
 * Pulse answers "how warm is this?" by walking a route of STOPS, each of which reads one SOURCE
 * (a commit log, a transcript store, a mailbox, a board). This module is the vocabulary for that
 * and nothing else: no imports from the rest of the CLI, so it can move to `@heyiris/pulse-core`
 * unchanged.
 *
 * THREE RULES THE TYPES EXIST TO CARRY:
 *
 * 1. A source that could not look is not a source that found nothing. `measured: false` plus a
 *    `reason` travels all the way to the reader; a shut stop is shown SHUT, with its reason, never
 *    as 0.
 * 2. A capped count is a floor. `floor: true` means "at least `hits`" — shown as N+, and never
 *    compared as if it were exact.
 * 3. Reading never writes. `Source.read` must not change the record it reports on, and every
 *    PulseScript is `readOnly: true` — filing what a pulse found is a separate, explicit act.
 */

// ── sources ──────────────────────────────────────────────────────────────────

/** What one read of one source produced. `items` are trimmed for display; `hits` never is. */
export interface SourceResult<I = unknown> {
  /** Everything the source counted. A FLOOR when `floor` is set. */
  hits: number
  items: I[]
  /** False when the source could not look. Then `hits` means nothing and `reason` says why. */
  measured: boolean
  /** Why it could not look — or, when it did, a caveat about how. */
  reason?: string
  /** The search stopped at its own ceiling: `hits` is "at least". */
  floor?: boolean
  /** Where the answer came from — a path, an endpoint, a board — so a number can be traced. */
  provenance: string[]
}

export type Availability = { ok: true } | { ok: false; reason: string }

export interface Source<Q = unknown, R extends SourceResult = SourceResult> {
  id: string
  label: string
  /** Read, never write. May reject; the runner turns a rejection into a shut stop. */
  read(query: Q): Promise<R>
  /** A cheap pre-check. A source that says no is not read, and its stop is shut with this reason. */
  isAvailable?(query: Q): Availability | Promise<Availability>
}

// ── stops ────────────────────────────────────────────────────────────────────

/** The reading a stop takes from its source's result — the part a scorer or renderer consumes. */
export interface StopReading<I = unknown> {
  hits: number
  /** Things owed — replies, follow-ups — where the stop knows them. */
  owed?: number
  items: I[]
  provenance: string[]
}

/**
 * One stop on a route: a source, and what to take from it.
 *
 * `extract` turns the source's result into whatever the route's renderer reads (`O`).
 * `shutReason` decides whether the stop is shut; the default is "the source did not measure".
 * `unavailable` builds the output for a stop that never got a result — the source said it was
 * unavailable, or its read threw — so a shut stop still renders as shut, in the route's own shape.
 */
export interface Stop<Q = unknown, R extends SourceResult = SourceResult, O = R> {
  id: string
  label?: string
  source: Source<Q, R>
  extract(result: R, query: Q): O
  shutReason?(result: R): string | null
  unavailable(reason: string, query: Q): O
}

export interface StopOutcome<O = unknown> {
  id: string
  label: string
  /** Shut means NOT MEASURED. Never render a shut stop's count as a number. */
  shut: boolean
  /** Present exactly when `shut`. */
  reason: string | null
  floor: boolean
  provenance: string[]
  output: O
  /** Set when the read threw — the stop was isolated, the route went on. */
  error?: string
}

// ── scripts ──────────────────────────────────────────────────────────────────

/**
 * The routes Pulse walks. A contact is a lead — a person with a record; a topic is a thread of
 * work with no record at all. (There is deliberately no account route: users only have leads.)
 */
export type PulseRoute = "topic" | "contact"

export interface PulseScript<Q = any, O = any> {
  route: PulseRoute
  stops: Stop<Q, any, O>[]
  /** Always true. A pulse that writes changes what it measures. */
  readOnly: true
  /**
   * `sequential` (default): stops run one after another, outcomes in stop order.
   * `parallel`: every stop starts at once and outcomes arrive in COMPLETION order — for routes
   * whose stops are independent network reads, where waiting on each in turn would be slow.
   */
  mode?: "sequential" | "parallel"
}

export interface RunHooks<O> {
  /** Called as a stop starts (sequential mode: just before its read). */
  onStart?(stop: Stop<any, any, O>): void
  /** Called as each outcome is known, in the order outcomes are returned. */
  onOutcome?(outcome: StopOutcome<O>): void
  /** Run only the stops whose id passes. */
  only?(stop: Stop<any, any, O>): boolean
}

function describeError(e: unknown): string {
  return String((e as any)?.message ?? e).slice(0, 200)
}

/** One stop, isolated: whatever its source does, this resolves. */
export async function runStop<Q, R extends SourceResult, O>(stop: Stop<Q, R, O>, query: Q): Promise<StopOutcome<O>> {
  const label = stop.label ?? stop.source.label
  const shut = (reason: string, error?: string): StopOutcome<O> => ({
    id: stop.id,
    label,
    shut: true,
    reason,
    floor: false,
    provenance: [],
    output: stop.unavailable(reason, query),
    ...(error ? { error } : {}),
  })

  if (stop.source.isAvailable) {
    let avail: Availability
    try {
      avail = await stop.source.isAvailable(query)
    } catch (e) {
      return shut(`${label}: availability check failed — ${describeError(e)}`, describeError(e))
    }
    if (!avail.ok) return shut(avail.reason)
  }

  let result: R
  try {
    result = await stop.source.read(query)
  } catch (e) {
    return shut(`${label} failed: ${describeError(e)}`, describeError(e))
  }

  const reason = stop.shutReason ? stop.shutReason(result) : result.measured ? null : (result.reason ?? "not measured")
  return {
    id: stop.id,
    label,
    shut: reason !== null,
    reason,
    floor: !!result.floor,
    provenance: result.provenance,
    output: stop.extract(result, query),
  }
}

/** Walk a script. One stop failing never stops the route; every outcome keeps its provenance. */
export async function runScript<Q, O>(script: PulseScript<Q, O>, query: Q, hooks: RunHooks<O> = {}): Promise<StopOutcome<O>[]> {
  if (script.readOnly !== true) throw new Error(`pulse script for route "${script.route}" must be readOnly`)
  const stops = hooks.only ? script.stops.filter((s) => hooks.only!(s)) : script.stops
  const out: StopOutcome<O>[] = []

  if (script.mode === "parallel") {
    for (const stop of stops) hooks.onStart?.(stop)
    await Promise.all(
      stops.map((stop) =>
        runStop(stop, query).then((o) => {
          out.push(o)
          hooks.onOutcome?.(o)
        }),
      ),
    )
    return out
  }

  for (const stop of stops) {
    hooks.onStart?.(stop)
    const o = await runStop(stop, query)
    out.push(o)
    hooks.onOutcome?.(o)
  }
  return out
}

// ── registry ─────────────────────────────────────────────────────────────────

const defaults = new Map<PulseRoute, PulseScript>()
const extensions = new Map<PulseRoute, Stop<any, any, any>[]>()

/** The built-in script for a route. Registering again replaces it (the last registration wins). */
export function registerDefault<Q, O>(route: PulseRoute, script: PulseScript<Q, O>): void {
  if (script.route !== route) throw new Error(`script is for route "${script.route}", registered as "${route}"`)
  if (script.readOnly !== true) throw new Error(`pulse script for route "${route}" must be readOnly`)
  defaults.set(route, script)
}

/**
 * Add stops to a route, after its default ones. A stop whose id is already on the route replaces
 * it in place — that is how a script swaps one source for another without restating the rest.
 */
export function extend<Q, O>(route: PulseRoute, ...stops: Stop<Q, any, O>[]): void {
  extensions.set(route, [...(extensions.get(route) ?? []), ...stops])
}

/** The script a route runs: its default, with every extension applied. */
export function scriptFor<Q = any, O = any>(route: PulseRoute): PulseScript<Q, O> {
  const base = defaults.get(route)
  if (!base) throw new Error(`no pulse script registered for route "${route}"`)
  const extra = extensions.get(route) ?? []
  if (!extra.length) return base as PulseScript<Q, O>
  const stops = [...base.stops]
  for (const stop of extra) {
    const at = stops.findIndex((s) => s.id === stop.id)
    if (at >= 0) stops[at] = stop
    else stops.push(stop)
  }
  return { ...base, stops } as PulseScript<Q, O>
}

/** Drop every extension (all routes, or one). Defaults stay. For tests and for a fresh run. */
export function resetExtensions(route?: PulseRoute): void {
  if (route) extensions.delete(route)
  else extensions.clear()
}

// ── reading an outcome ───────────────────────────────────────────────────────

/** A count the way a person must read it: shut says so, a floor says "at least". Never a bare 0. */
export function formatCount(outcome: Pick<StopOutcome, "shut" | "reason" | "floor">, hits: number): string {
  if (outcome.shut) return `shut — ${outcome.reason ?? "not measured"}`
  return outcome.floor ? `${hits}+` : String(hits)
}

// ── health signals ───────────────────────────────────────────────────────────

/**
 * One weighted input to a health score. Defined here so scores can be assembled from stops later;
 * the contact score today is computed server-side (the readiness endpoint), so nothing in the CLI
 * wraps it yet — wrapping it would mean recomputing a number the server already owns.
 */
export interface HealthSignal<C = unknown> {
  id: string
  weight: number
  /** 0..1, or null when the signal could not be measured — which must not count as 0. */
  evaluate(context: C): number | null | Promise<number | null>
}
