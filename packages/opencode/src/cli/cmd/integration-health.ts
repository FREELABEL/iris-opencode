import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, resolveUserId, IRIS_API, dim, bold, success, highlight, writeJson } from "./iris-api"

/**
 * `iris integrations health` / `iris integrations test <type>` — IH-08, epic bloq #503 list #2315.
 * Closes the reporting half of #182476.
 *
 * THE POINT IS THAT THE CLI AND THE PAGE CANNOT DISAGREE. Both read the verdicts written by the
 * server-side sweep, so there is one definition of "working" and one place it is computed. A
 * second, client-side opinion is how `list-connected` ended up printing [unverified] next to
 * connections that executed their functions fine (#182861).
 *
 * FOUR STATES, KEPT APART ON PURPOSE:
 *
 *   working        a probe ran and passed
 *   failing        a probe ran and was refused — there is a reason, and we print it
 *   never checked  nothing has ever probed this. NOT the same as working, and not a failure
 *   n/a            the connector runs in-process; there is no remote thing to check
 *
 * Collapsing "never checked" into either colour is the bug this whole epic exists to remove:
 * `status` says 'active' for a connection nobody has ever contacted, so anything reading status
 * alone reports a green that was never earned.
 */

type HealthState = "working" | "failing" | "never_checked" | "not_applicable"

export interface HealthRow {
  id: number
  type: string
  name?: string | null
  auth_mode?: string | null
  account?: string | null
  status: string
  state: HealthState
  last_tested: string | null
  last_error: string | null
  probe_state?: string
  probe_error?: string | null
  /** Which integration store holds the row. Absent means fl-api, the health API's own. */
  store?: "iris-api"
}

/**
 * Exit code for a probe. A type with no connection cannot be working, and a probe that could
 * not complete is not a pass — both used to exit 0, so a CI loop over a list of integrations
 * reported success for every typo (#190576). `never_checked` stays 0: nothing has answered,
 * which is an honest zero rather than a failure.
 */
export function probeExitCode(o: {
  notConnected: boolean
  failure: string | null
  rows: HealthRow[] | null
}): 0 | 1 {
  if (o.notConnected || o.failure) return 1
  if ((o.rows ?? []).some((r) => r.state === "failing")) return 1
  return 0
}

/** "4m ago" / "3d ago" — or the honest word when nothing has ever checked. */
export function describeAge(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never"
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return "unknown"

  const secs = Math.max(0, Math.round((now - then) / 1000))
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`
  return `${Math.round(secs / 86400)}d ago`
}

/**
 * The marker for a state.
 *
 * `never_checked` is deliberately NOT a red ✗ and NOT a green ✓. It is an absence, and drawing
 * it as either is a claim we cannot support — the same distinction `list-connected` already
 * makes between "we asked and were refused" and "we could not ask".
 */
export function markerFor(state: HealthState): string {
  switch (state) {
    case "working":
      return success("✓")
    case "failing":
      return "✗"
    case "not_applicable":
      return dim("∅")
    default:
      return dim("?")
  }
}

/** One printable line per connection. Exported so the formatting is testable without a network. */
export function formatRow(row: HealthRow, now: number = Date.now()): string {
  const label = row.account ? `${row.type} ${dim(`(${row.account})`)}` : row.type
  const age = describeAge(row.last_tested, now)

  const tail =
    row.state === "not_applicable"
      ? dim("runs in-process — nothing to check")
      : row.state === "never_checked"
        ? dim("never checked")
        : row.state === "failing"
          ? `${dim(`checked ${age}`)} — ${row.last_error ?? "no reason recorded"}`
          : dim(`checked ${age}`)

  return `  ${markerFor(row.state)} ${bold(label)}  ${tail}`
}

/**
 * The summary line.
 *
 * Reports every state including the empty ones, so "0 failing" is visible as a measured zero
 * rather than inferred from the absence of red lines — and so a run where NOTHING was ever
 * checked reads as exactly that instead of as a clean bill of health.
 */
export function formatSummary(rows: HealthRow[]): string {
  const n = (s: HealthState) => rows.filter((r) => r.state === s).length
  return `${n("working")} working · ${n("failing")} failing · ${n("never_checked")} never checked · ${n(
    "not_applicable",
  )} n/a`
}

/**
 * One iris-api row, in the four-state vocabulary (#186971).
 *
 * `probe` is iris-api's POST /v1/integrations-temp/{id}/test answer, or null when nothing was
 * probed. That endpoint says "credentials are present (live test not implemented)" for a type
 * with no probe of its own — which is NOT a pass, so it maps to never_checked. Exported for tests.
 */
export function irisRowToHealth(
  row: { id: number; type: string; name?: string | null; account_email?: string | null; status?: string | null },
  probe: { success?: boolean; message?: string | null; error?: string | null } | null,
  now: string = new Date().toISOString(),
): HealthRow {
  const base = {
    id: row.id,
    type: String(row.type ?? "").toLowerCase(),
    name: row.name ?? null,
    account: row.account_email ?? null,
    status: String(row.status ?? "active"),
    store: "iris-api" as const,
  }
  if (!probe || (probe.success && /not implemented/i.test(String(probe.message ?? "")))) {
    return { ...base, state: "never_checked", last_tested: null, last_error: null }
  }
  if (probe.success) return { ...base, state: "working", last_tested: now, last_error: null }
  return { ...base, state: "failing", last_tested: now, last_error: probe.error ?? probe.message ?? null }
}

/**
 * THE HEALTH API ONLY SEES fl-api's STORE (#186971). `connect` and `setup-native` write native
 * API-key rows (mailjet, apollo, …) to iris-api's own `integrations` table, so for those this
 * command answered "No mailjet connection on this account" about a Mailjet that answered every
 * call — and a client was told their link was down. Same split as list-connected (#181228).
 * Read iris-api's rows too, and probe them there when asked.
 */
async function fetchIrisRows(probe: boolean, onlyType?: string): Promise<HealthRow[]> {
  const userId = await resolveUserId()
  if (!userId) return []
  try {
    const res = await irisFetch(`/api/v1/users/${userId}/integrations`, {}, IRIS_API)
    if (!res.ok) return []
    const body = (await res.json()) as Record<string, any>
    const list: any[] = Array.isArray(body?.connections) ? body.connections : Array.isArray(body?.data) ? body.data : []
    // Only rows iris-api itself holds: a Composio-only connection has no local id to test.
    const own = list.filter(
      (r) => Number.isInteger(r?.id) && r.id > 0 && (!onlyType || String(r.type ?? "").toLowerCase() === onlyType),
    )
    const out: HealthRow[] = []
    for (const r of own) {
      let answer: any = null
      if (probe) {
        try {
          const t = await irisFetch(`/api/v1/integrations-temp/${r.id}/test`, { method: "POST" }, IRIS_API)
          answer = await t.json().catch(() => ({ success: false, error: `HTTP ${t.status}` }))
          if (!t.ok && answer && answer.success === undefined) answer.success = false
        } catch (e) {
          answer = { success: false, error: e instanceof Error ? e.message : String(e) }
        }
      }
      out.push(irisRowToHealth(r, answer))
    }
    return out
  } catch {
    return []
  }
}

async function fetchHealth(
  probe: boolean,
  onlyType?: string,
): Promise<{ rows: HealthRow[] | null; failure: string | null }> {
  let flRows: HealthRow[] | null = null
  let failure: string | null = null
  try {
    const res = await irisFetch(`/api/v1/integrations/health${probe ? "?probe=1" : ""}`)
    if (!res.ok) failure = `the health API returned HTTP ${res.status}`
    else flRows = ((await res.json()) as { data?: HealthRow[] })?.data ?? []
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e)
  }

  const irisRows = await fetchIrisRows(probe, onlyType)
  // fl-api unreachable but iris-api answered: report what we could measure, not a bare failure.
  if (failure && irisRows.length === 0) return { rows: null, failure }
  return { rows: [...(flRows ?? []), ...irisRows], failure: null }
}

export const IntegrationsHealthCommand = cmd({
  command: "health",
  describe: "show when each integration was last tested, and whether it is working",
  builder: (y) =>
    y
      .option("probe", {
        type: "boolean",
        describe: "probe every connection NOW instead of reading the last sweep's verdicts",
      })
      .option("json", { type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Integration Health")
    if (!(await requireAuth())) {
      prompts.outro("Done")
      return
    }

    const sp = prompts.spinner()
    sp.start(args.probe ? "Probing every connection…" : "Reading the last verdicts…")
    const { rows, failure } = await fetchHealth(Boolean(args.probe))
    sp.stop(failure ? "Failed" : "Done", failure ? 1 : 0)

    if (args.json) {
      // A lookup that FAILED and a user with NO integrations are different answers, and an
      // agent parsing `[]` will state the second one as fact. Emit the error rather than an
      // empty list it cannot tell apart. (Same failure that told a client her live Gmail was
      // not connected, and whose retry then created the dead connection it described.)
      await writeJson(failure ? { error: failure, connections: null } : rows)
      prompts.outro("Done")
      return
    }

    if (failure) {
      prompts.log.error(`Could not read integration health — ${failure}`)
      prompts.log.info(dim("This is NOT the same as everything being broken; the lookup did not complete."))
      prompts.outro("Done")
      return
    }

    if (!rows || rows.length === 0) {
      prompts.log.warn("No integrations connected.")
      prompts.outro(dim("iris integrations list-available"))
      return
    }

    const now = Date.now()
    for (const row of rows) console.log(formatRow(row, now))

    console.log("")
    console.log(`  ${formatSummary(rows)}`)

    const failing = rows.filter((r) => r.state === "failing")
    const unchecked = rows.filter((r) => r.state === "never_checked")

    if (failing.length) {
      console.log("")
      for (const f of failing) {
        console.log(`  ${dim("Reconnect:")} ${highlight(`iris connect ${f.type}`)}`)
      }
    }

    if (unchecked.length && !args.probe) {
      console.log("")
      console.log(`  ${dim(`${unchecked.length} never checked — probe now with:`)} ${highlight("iris integrations health --probe")}`)
    }

    prompts.outro("Done")
  },
})

export const IntegrationsTestCommand = cmd({
  command: "test <type>",
  describe: "probe one integration right now and report whether it works",
  builder: (y) =>
    y.positional("type", { type: "string", describe: "integration slug, e.g. gmail" }).option("json", {
      type: "boolean",
    }),
  async handler(args) {
    const type = String(args.type ?? "").toLowerCase()

    UI.empty()
    prompts.intro(`◈  Test ${type}`)
    if (!(await requireAuth())) {
      prompts.outro("Done")
      return
    }

    const sp = prompts.spinner()
    sp.start(`Probing ${type}…`)

    let rows: HealthRow[] | null = null
    let failure: string | null = null
    let notConnected = false

    // Probe every connection, then narrow to the one asked for.
    //
    // This used to POST /api/v1/integrations/health/{type}, a per-type route that was never
    // built. A 404 from a MISSING ROUTE carries no `code`, so it fell through to the generic
    // branch and the command reported "the health API returned HTTP 404" — which reads as
    // "your integration is broken" when it means "this endpoint does not exist". Every run of
    // `iris integrations test <type>` said that, about every integration.
    //
    // GET /api/v1/integrations/health?probe=1 exists and already probes live. Filtering its
    // rows answers the same question, and preserves the distinction that matters: a type with
    // no row is NOT CONNECTED, which is a different answer from a connection that failed.
    const probe = await fetchHealth(true, type)
    if (probe.failure) {
      failure = probe.failure
    } else {
      const match = (probe.rows ?? []).filter((r) => r.type?.toLowerCase() === type.toLowerCase())
      if (match.length === 0) {
        notConnected = true
      } else {
        rows = match
      }
    }

    sp.stop(failure || notConnected ? "Done" : "Done", failure ? 1 : 0)

    if (args.json) {
      await writeJson(
        notConnected
          ? { error: `no ${type} connection on this account`, code: "not_connected", connections: null }
          : failure
            ? { error: failure, connections: null }
            : rows,
      )
      process.exitCode = probeExitCode({ notConnected, failure, rows })
      prompts.outro("Done")
      return
    }

    // "You have not connected this" is a different answer from "it is broken", and the fix for
    // each is different. Never render the first as a failure.
    if (notConnected) {
      prompts.log.warn(`No ${type} connection on this account.`)
      console.log(`  ${dim("Connect it:")} ${highlight(`iris connect ${type}`)}`)
      // A missing integration is a failure of the probe, not a pass. It used to exit 0,
      // so `for t in …; do iris integrations test $t; done` reported success for a typo
      // (#190576).
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    if (failure) {
      prompts.log.error(`Could not probe ${type} — ${failure}`)
      prompts.log.info(dim("The probe did not complete. That says nothing about the integration."))
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    const now = Date.now()
    for (const row of rows ?? []) console.log(formatRow(row, now))

    process.exitCode = probeExitCode({ notConnected, failure, rows })
    if (process.exitCode === 1) {
      console.log("")
      console.log(`  ${dim("Reconnect:")} ${highlight(`iris connect ${type}`)}`)
    }

    prompts.outro("Done")
  },
})
