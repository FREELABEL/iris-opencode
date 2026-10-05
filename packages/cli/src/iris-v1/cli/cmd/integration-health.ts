import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, dim, bold, success, highlight, writeJson } from "./iris-api"

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

interface HealthRow {
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

async function fetchHealth(probe: boolean): Promise<{ rows: HealthRow[] | null; failure: string | null }> {
  try {
    const res = await irisFetch(`/api/v1/integrations/health${probe ? "?probe=1" : ""}`)
    if (!res.ok) {
      return { rows: null, failure: `the health API returned HTTP ${res.status}` }
    }
    const body = (await res.json()) as { data?: HealthRow[] }
    return { rows: body?.data ?? [], failure: null }
  } catch (e) {
    return { rows: null, failure: e instanceof Error ? e.message : String(e) }
  }
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
    const probe = await fetchHealth(true)
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
      prompts.outro("Done")
      return
    }

    // "You have not connected this" is a different answer from "it is broken", and the fix for
    // each is different. Never render the first as a failure.
    if (notConnected) {
      prompts.log.warn(`No ${type} connection on this account.`)
      console.log(`  ${dim("Connect it:")} ${highlight(`iris connect ${type}`)}`)
      prompts.outro("Done")
      return
    }

    if (failure) {
      prompts.log.error(`Could not probe ${type} — ${failure}`)
      prompts.log.info(dim("The probe did not complete. That says nothing about the integration."))
      prompts.outro("Done")
      return
    }

    const now = Date.now()
    for (const row of rows ?? []) console.log(formatRow(row, now))

    if ((rows ?? []).some((r) => r.state === "failing")) {
      console.log("")
      console.log(`  ${dim("Reconnect:")} ${highlight(`iris connect ${type}`)}`)
      process.exitCode = 1
    }

    prompts.outro("Done")
  },
})
