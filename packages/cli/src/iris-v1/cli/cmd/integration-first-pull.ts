/**
 * After a connect works, show the person their own data — not `iris integrations list`.
 * (T3 #188213, EPIC #188210.)
 *
 * The first real data coming back is the activation moment (ADR-03): it is also what stamps
 * users.activated_at server-side, because it runs through execute-direct like every other call.
 * So the most useful thing a successful connect can do is offer that pull, right there.
 *
 * Read-only functions only, and an empty result is said plainly — "nothing came back" is a real
 * answer, a ✓ over an empty list is not.
 */
import * as prompts from "./clack"
import { irisFetch, IRIS_API, dim, bold, success } from "./iris-api"

/** The one read that returns something personal for each type. Functions verified in fl-iris-api. */
export const FIRST_PULL: Record<string, { action: string; params: Record<string, unknown>; what: string }> = {
  gmail: { action: "read_emails", params: { max_results: 5, query: "in:inbox" }, what: "your 5 most recent emails" },
  "google-drive": { action: "list_files", params: { page_size: 5 }, what: "your 5 most recent files" },
  "google-calendar": { action: "list_events", params: { max_results: 5 }, what: "your next 5 events" },
  slack: { action: "list_channels", params: { limit: 5 }, what: "5 of your channels" },
}

export function firstPullCommand(type: string): string | null {
  const p = FIRST_PULL[type]
  if (!p) return null
  const params = Object.entries(p.params)
    .map(([k, v]) => `--${k.replace(/_/g, "-")} ${typeof v === "string" && /\s|:/.test(v) ? JSON.stringify(v) : v}`)
    .join(" ")
  return `iris integrations exec ${type} ${p.action} ${params}`.trim()
}

/** The list inside an execute-direct result, wherever the service put it. */
export function rowsOf(result: any): any[] {
  if (!result || typeof result !== "object") return []
  for (const key of ["emails", "files", "events", "channels", "messages", "items", "results"]) {
    const v = result[key] ?? result?.data?.[key]
    if (Array.isArray(v)) return v
  }
  if (Array.isArray(result.data)) return result.data
  return []
}

/** One line per row: the most human field each service returns. */
export function describeRow(row: any): string {
  if (!row || typeof row !== "object") return String(row)
  const title = row.subject ?? row.summary ?? row.name ?? row.title ?? row.id ?? "(untitled)"
  const by = row.from ?? row.owner ?? row.organizer ?? row.start?.dateTime ?? row.start?.date ?? row.modifiedTime
  const s = by ? `${title} ${dim("— " + String(typeof by === "object" ? JSON.stringify(by) : by).replace(/\s*<[^>]+>/, ""))}` : String(title)
  return s.length > 110 ? s.slice(0, 107) + "…" : s
}

/**
 * Offer the first pull. Interactive terminals are asked (default yes); anything else gets the
 * exact command to run, because an agent or script must never be stopped by a question.
 */
export async function offerFirstPull(type: string, userId: number): Promise<void> {
  const pull = FIRST_PULL[type]
  if (!pull) return
  const command = firstPullCommand(type)!

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`  ${dim("See it work:")} ${command}`)
    return
  }

  const go = await prompts.confirm({ message: `Pull ${pull.what} now?`, initialValue: true })
  if (prompts.isCancel(go) || !go) {
    console.log(`  ${dim("Later:")} ${command}`)
    return
  }

  const sp = prompts.spinner()
  sp.start(`Reading ${pull.what}…`)
  try {
    const res = await irisFetch(
      `/api/v1/users/${userId}/integrations/execute-direct`,
      { method: "POST", body: JSON.stringify({ integration: type, action: pull.action, params: pull.params }) },
      IRIS_API,
    )
    const body = (await res.json().catch(() => null)) as any
    if (!res.ok || body?.success === false) {
      sp.stop("That didn't work", 1)
      prompts.log.error(String(body?.error ?? body?.message ?? `HTTP ${res.status}`))
      console.log(`  ${dim("Try again:")} ${command}`)
      return
    }
    const rows = rowsOf(body)
    if (rows.length === 0) {
      // Present-but-empty is not present.
      sp.stop(`Connected, but nothing came back from ${bold(type)} yet`)
      return
    }
    sp.stop(`${success("✓")} ${bold(type)} is working — here's ${pull.what}:`)
    for (const row of rows.slice(0, 5)) console.log(`  · ${describeRow(row)}`)
  } catch (e) {
    sp.stop("That didn't work", 1)
    prompts.log.error(e instanceof Error ? e.message : String(e))
    console.log(`  ${dim("Try again:")} ${command}`)
  }
}
