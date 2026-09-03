import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, requireAuth, handleApiError, dim, bold, success, requireUserId } from "./iris-api"

/**
 * `iris feature report` — file a feature request, with credit attached.
 *
 * WHY A SEPARATE VERB FROM `bloqs add-item`.
 * Filing a request and adding an item to a list are different intents, and people reach for
 * the command that names what they are doing. `bug report` already proves that: nobody files
 * a bug with `bloqs add-item`, and before this existed the equivalent request had nowhere to
 * go, so feature work was filed as bloq items and lost its attribution.
 *
 * WHY BLOQ 652 AND NOT 503.
 * 503 ("IRIS Features + Capabilities") holds 84 lists and 914 items — those lists are EPICS,
 * not workflow stages, so it cannot be worked as a board and has nowhere for an untriaged
 * request to sit. 652 is the intake board: Requested / Triage / Accepted / Shipped / Declined.
 *
 * The split is also the PAYABILITY boundary, which is the part worth not losing. Bounty scope
 * is per-bloq (config bounty.credited_bloq_ids), so a request on 652 can earn while 503's 914
 * existing items cannot. Putting requests on 503 would mean either no payouts for features, or
 * making nine hundred old items payable in one sweep.
 *
 * Accepted requests graduate into an epic list on 503; the request stays here as the record of
 * who asked.
 */
const FEATURE_BLOQ_ID = 652
const REQUESTED_LIST_ID = 2292

export const PlatformFeatureCommand = cmd({
  command: "feature <subcommand>",
  describe: "report and track feature requests",
  builder: (yargs: any) =>
    yargs
      .command({
        command: "report [title..]",
        aliases: ["submit", "new", "request"],
        describe: "file a feature request (credited to a reporter for bounty attribution)",
        builder: (y: any) =>
          y
            .positional("title", { describe: "short title — quote it, or use --title", type: "array", default: [] })
            .option("title", { describe: "feature title", type: "string" })
            .option("description", { alias: "d", describe: "what it should do, and why", type: "string" })
            .option("reporter-lead", {
              describe: "lead ID of the person who asked for this (for bounty attribution)",
              type: "number",
            })
            .option("bloq", {
              describe: `board to file into (default ${FEATURE_BLOQ_ID}, the feature-requests board)`,
              type: "number",
            })
            .option("list", { describe: `list to file into (default ${REQUESTED_LIST_ID}, Requested)`, type: "number" })
            .option("json", { describe: "JSON output", type: "boolean", default: false })
            .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
        async handler(args: any) {
          const positional = Array.isArray(args.title) ? args.title.join(" ").trim() : ""
          let title: string = (typeof args.title === "string" ? args.title : positional) || ""

          if (!title) {
            if (args.json) {
              console.log(JSON.stringify({ success: false, error: "A title is required." }))
              process.exitCode = 2
              return
            }
            const asked = await prompts.text({
              message: "What should it do?",
              placeholder: "e.g. bloqs add-item should accept --reporter-lead",
              validate: (x: string | undefined) => (x && x.length > 0 ? undefined : "Required"),
            })
            if (prompts.isCancel(asked)) { prompts.outro("Cancelled"); return }
            title = asked as string
          }

          const token = await requireAuth()
          if (!token) { if (!args.json) prompts.outro("Done"); return }

          const userId = await requireUserId(args["user-id"])
          if (!userId) { if (!args.json) prompts.outro("Done"); return }

          const bloqId = args.bloq ?? FEATURE_BLOQ_ID
          const listId = args.list ?? REQUESTED_LIST_ID

          // `Reported by ...` as the FIRST line of the body, not only as structured data.
          // The payout pipeline reads attachments.reporter_lead_id, but that is invisible to a
          // human reading the board — and an attribution that only exists as data is one bug
          // away from being unreadable by the person it belongs to.
          const parts: string[] = []
          if (args["reporter-lead"]) parts.push(`Reported by lead #${args["reporter-lead"]}.`)
          if (args.description) parts.push(String(args.description))
          const content = parts.join("\n\n") || title

          const spinner = args.json ? null : prompts.spinner()
          spinner?.start("Filing…")

          const payload: Record<string, unknown> = {
            content,
            title,
            list_id: listId,
            type: "default",
          }
          if (args["reporter-lead"]) payload.reporter_lead_id = args["reporter-lead"]

          const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}/items`, {
            method: "POST",
            body: JSON.stringify(payload),
          })

          if (!res.ok) {
            spinner?.stop("Failed", 1)
            if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
            await handleApiError(res, "Feature report")
            prompts.outro("Done")
            return
          }

          const body = (await res.json().catch(() => null)) as any
          const id = body?.data?.id ?? body?.data?.data?.id ?? body?.id ?? null
          spinner?.stop("Filed")

          if (args.json) {
            console.log(JSON.stringify({ success: true, id, bloq_id: bloqId, list_id: listId }))
            return
          }

          console.log()
          console.log(`  ${success("✓")} ${bold("Feature request filed")}`)
          if (id) console.log(`  ${dim("Item:")} #${id}`)
          console.log(`  ${dim("Board:")} #${bloqId} ${dim("· list")} #${listId}`)
          if (args["reporter-lead"]) {
            console.log(`  ${dim("Credited to lead:")} #${args["reporter-lead"]}`)
            console.log(`  ${dim("Standing:")} iris bounty me`)
          } else {
            console.log(`  ${dim("No reporter credited — add --reporter-lead <id> to attribute it.")}`)
          }
          prompts.outro("Done")
        },
      })
      .demandCommand(1, "Pick a subcommand")
      .strict(false),
  async handler() {},
})
