import { cmd } from "./cmd"
import { requireAuth, requireUserId, writeJson, dim, bold, success } from "./iris-api"
import { hiveFetch } from "./platform-hive-nodes"

/**
 * Rent, list and release compute (#183399).
 *
 * A rental is NOT an ephemeral task worker. `cloud_droplets` back workers that are
 * credit-metered per minute and destroyed after 300 idle seconds; a lease stays up until it is
 * released. That distinction is the product, and it is why these are separate commands rather
 * than flags on `hive nodes`.
 */

type Lease = {
  id: number
  name: string
  provider: string
  status: string
  endpoint: string | null
  enrolled_as_node: boolean
  external_id: string
  last_error: string | null
  created_at: string | null
  released_at: string | null
}

async function api(path: string, init: RequestInit = {}) {
  const res = await hiveFetch(`/api/v6/compute${path}`, init)
  const body = await res.json().catch(() => ({}) as any)
  if (!res.ok) {
    // Surface the server's own message. A rental failure that says only "HTTP 502" cannot
    // tell an operator whether a machine is still billing.
    const msg = (body as any)?.message || (body as any)?.error || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return body as any
}

function renderLease(l: Lease): string {
  const node = l.enrolled_as_node ? "hive node" : dim("not enrolled")
  const where = l.endpoint ? ` ${dim(l.endpoint)}` : ""
  return `  ${String(l.id).padStart(4)}  ${bold(l.name.padEnd(22))} ${l.provider.padEnd(13)} ${l.status.padEnd(10)} ${node}${where}`
}

const RentCommand = cmd({
  command: "rent <name>",
  describe: "rent a machine — it joins your Hive by default",
  builder: (yargs) =>
    yargs
      .positional("name", { describe: "a label for this machine", type: "string", demandOption: true })
      .option("provider", { describe: "railway (default) | digitalocean", type: "string" })
      .option("image", { describe: "container or OS image", type: "string" })
      // Enrolment is the DEFAULT. Declining is explicit, and is recorded so a declined rental
      // shows as declined rather than being silently absent from the fleet.
      .option("no-hive", {
        describe: "do NOT install IRIS — the machine will not accept work from you",
        type: "boolean",
        default: false,
      })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const enrol = !argv["no-hive"]
    try {
      const { lease } = await api(`/?user_id=${userId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: argv.name,
          provider: argv.provider,
          image: argv.image,
          enrol_as_node: enrol,
          user_id: userId,
        }),
      })
      if (argv.json) return void (await writeJson(lease))

      console.log()
      console.log(success(`✓ rented ${bold(lease.name)}  ${dim(`#${lease.id} · ${lease.provider}`)}`))
      console.log(renderLease(lease))
      console.log()
      if (enrol) {
        console.log(dim("  It is joining your Hive — it will appear in `iris hive nodes list` shortly."))
        console.log(dim("  Run work on it:  iris hive run " + lease.name + ' "python3 -c \'print(1)\'"'))
      } else {
        console.log(dim("  IRIS was NOT installed, so you cannot dispatch work to it."))
      }
      console.log(dim(`  Stop paying for it:  iris hive release ${lease.id}`))
      console.log()
    } catch (e: any) {
      console.error(`Could not rent: ${e.message}`)
      console.error(dim("  Check providers:  iris hive providers"))
      process.exit(1)
    }
  },
})

const RentalsCommand = cmd({
  command: "rentals",
  describe: "list machines you are renting",
  builder: (yargs) =>
    yargs
      .option("all", { describe: "include released machines", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const { leases } = await api(`/?user_id=${userId}&include_released=${argv.all ? 1 : 0}`)
    if (argv.json) return void (await writeJson(leases))

    console.log()
    if (!leases?.length) {
      console.log(dim("  No machines rented.  Rent one:  iris hive rent my-box"))
      console.log()
      return
    }
    console.log(`  ${dim("id".padStart(4))}  ${dim("name".padEnd(22))} ${dim("provider".padEnd(13))} ${dim("status".padEnd(10))} ${dim("hive")}`)
    for (const l of leases as Lease[]) console.log(renderLease(l))
    console.log()
    console.log(dim(`  ${leases.length} machine(s).  Release one:  iris hive release <id>`))
    console.log()
  },
})

const ReleaseCommand = cmd({
  command: "release <id>",
  describe: "release a rented machine and stop paying for it",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lease id from `iris hive rentals`", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    try {
      const { lease } = await api(`/${argv.id}?user_id=${userId}`, { method: "DELETE" })
      if (argv.json) return void (await writeJson(lease))
      console.log()
      console.log(success(`✓ released ${bold(lease.name)} — it is no longer billing.`))
      console.log()
    } catch (e: any) {
      // The server distinguishes "released" from "release failed" precisely so this can too.
      // Reporting a failed teardown as success would hide a machine that is still billing.
      console.error(`Release FAILED: ${e.message}`)
      console.error(dim("  The machine may still be running and billing. Check: iris hive rentals"))
      process.exit(1)
    }
  },
})

const ProvidersCommand = cmd({
  command: "providers",
  describe: "which compute providers are available, and which are usable",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    const { providers } = await api(`/providers`)
    if (argv.json) return void (await writeJson(providers))

    console.log()
    for (const p of providers) {
      // "not configured" is stated, not implied by absence — an unconfigured provider that
      // simply does not appear is indistinguishable from one that does not exist.
      const state = p.configured ? success("ready") : dim("not configured — needs an API token")
      const gpu = p.has_gpu ? " · GPU" : ""
      const def = p.default ? dim(" (default)") : ""
      console.log(`  ${bold(p.name.padEnd(14))} ${state}${gpu}${def}`)
    }
    console.log()
  },
})

export const HiveRentCommand = RentCommand
export const HiveRentalsCommand = RentalsCommand
export const HiveReleaseCommand = ReleaseCommand
export const HiveProvidersCommand = ProvidersCommand
