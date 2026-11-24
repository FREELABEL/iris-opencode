import { cmd } from "./cmd"
import { irisFetch, dim, bold, writeJson, isJsonMode, emitJsonError } from "./iris-api"

/**
 * `iris usage storage` — how much your account stores with us, #193867.
 *
 *   iris usage storage           your files: total now, by workspace, the last 30 days
 *   iris usage storage --all     every client, largest first (platform admins)
 *   iris usage storage --json
 *
 * The server works out whose usage this is from the token. The CLI never sends a user id —
 * a client cannot ask for someone else's numbers by naming them, and an admin's `--all` is
 * checked server-side (User::isPlatformAdmin), not here.
 *
 * Sizes are decimal (1 GB = 1,000,000,000 bytes) to match the server's GB-month figure.
 */

export const STORAGE_PATH = "/api/v1/usage/storage"

/** The request path. Never carries user_id — the server derives it from the token. */
export function storagePath(all: boolean): string {
  return all ? `${STORAGE_PATH}?all=1` : STORAGE_PATH
}

export function formatSize(bytes: number | null | undefined): string {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return "0 B"
  if (n < 1e3) return `${n} B`
  const units = ["KB", "MB", "GB", "TB", "PB"]
  let v = n / 1e3
  let i = 0
  while (v >= 1e3 && i < units.length - 1) {
    v /= 1e3
    i++
  }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`
}

/** One client's view, as plain lines (no colour — the caller styles headings). */
export function formatOwnStorage(d: any): string[] {
  const cur = d?.current ?? {}
  const lines: string[] = []
  lines.push(`You are storing ${formatSize(cur.bytes)} across ${plural(Number(cur.files ?? 0), "file")}.`)

  const ws: any[] = Array.isArray(d?.by_workspace) ? d.by_workspace : []
  if (ws.length) {
    lines.push("")
    lines.push("By workspace")
    for (const w of ws) {
      const name = w.bloq_id ? (w.name ? `${w.name} (#${w.bloq_id})` : `Workspace #${w.bloq_id}`) : "Not in a workspace"
      lines.push(`  ${name.padEnd(36)} ${formatSize(w.bytes).padStart(10)}  ${plural(Number(w.files ?? 0), "file")}`)
    }
  }

  const hist: any[] = Array.isArray(d?.history) ? d.history : []
  lines.push("")
  if (hist.length) {
    const first = hist[0]
    const last = hist[hist.length - 1]
    const peak = hist.reduce((a, b) => (Number(b.bytes) > Number(a.bytes) ? b : a), first)
    lines.push(`Last ${hist.length === 1 ? "day" : `${hist.length} days`} recorded`)
    lines.push(`  ${first.day}  ${formatSize(first.bytes)}`)
    if (last !== first) lines.push(`  ${last.day}  ${formatSize(last.bytes)}`)
    if (peak !== first && peak !== last) lines.push(`  peak ${peak.day}  ${formatSize(peak.bytes)}`)
  } else {
    lines.push("No daily history yet — storage is recorded once a day.")
  }

  const mtd = d?.month_to_date
  if (mtd && mtd.month) {
    lines.push("")
    lines.push(`This month (${mtd.month}): ${Number(mtd.gb_months ?? 0).toFixed(3)} GB-months so far, ${plural(Number(mtd.days_recorded ?? 0), "day")} recorded`)
  }
  return lines
}

/** The admin view: every client, largest first. */
export function formatAllStorage(d: any): string[] {
  const t = d?.total ?? {}
  const rows: any[] = Array.isArray(d?.clients) ? d.clients : []
  const lines: string[] = []
  lines.push(`${plural(Number(t.clients ?? rows.length), "client")} storing ${formatSize(t.bytes)} in ${plural(Number(t.files ?? 0), "file")}.`)
  if (!rows.length) return lines
  lines.push("")
  for (const r of rows) {
    const who = (r.name || r.email || `user #${r.user_id}`).slice(0, 34)
    lines.push(
      `  ${String(r.rank ?? "").padStart(3)}. ${who.padEnd(34)} ${formatSize(r.bytes).padStart(10)}  ${plural(Number(r.files ?? 0), "file").padEnd(12)} #${r.user_id}`,
    )
  }
  if (Number(t.clients) > rows.length) lines.push(`  … and ${Number(t.clients) - rows.length} more`)
  return lines
}

export const PlatformUsageStorageCommand = cmd({
  command: "storage",
  describe: "how much your account stores — files, by workspace, last 30 days (--all: every client, for admins)",
  builder: (yargs) =>
    yargs
      .option("all", { type: "boolean", default: false, describe: "every client ranked by storage (platform admins only)" })
      .option("json", { type: "boolean", default: false, describe: "machine-readable" })
      .example("$0 usage storage", "what you store, by workspace")
      .example("$0 usage storage --all", "every client, largest first (admins)"),
  async handler(args) {
    const all = Boolean(args.all)
    const json = Boolean(args.json) || isJsonMode()

    let res: Response
    try {
      res = await irisFetch(storagePath(all))
    } catch (e: any) {
      const msg = `Could not reach the API: ${e?.message ?? e}`
      if (json) emitJsonError(msg)
      else console.error(msg)
      process.exitCode = 1
      return
    }

    const text = await res.text()
    let body: any = null
    try {
      body = JSON.parse(text)
    } catch {}

    if (!res.ok) {
      const msg =
        res.status === 401
          ? "Not signed in — run: iris auth login"
          : res.status === 403 && all
            ? "Only platform admins can see every client's storage."
            : res.status === 404
              ? "This API does not have storage usage yet (needs fl-api with #193867)."
              : body?.message || `${res.status} ${text.slice(0, 200)}`
      if (json) emitJsonError(msg, { status: res.status })
      else console.error(msg)
      process.exitCode = 1
      return
    }

    const data = body?.data ?? body
    if (json) {
      await writeJson(data)
      return
    }

    console.log()
    console.log(bold(all ? "  Storage · all clients" : "  Your storage"))
    console.log()
    for (const line of all ? formatAllStorage(data) : formatOwnStorage(data)) console.log(line ? `  ${line}` : "")
    console.log()
    if (data?.as_of) console.log(dim(`  as of ${data.as_of}`))
    console.log()
  },
})
