// `iris leads tag` / `iris leads untag` — change ONE lead's tags (#191744).
//
// The API's only removal route, DELETE user/{id}/lead-tags/{tagId}, detaches a tag from every
// lead and deletes it, so five wrong tags on one lead (#30324) had no safe way off. These call
// POST /api/v1/leads/{id}/tags[/remove], which change that lead only and never delete a tag.

import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, success, failNoOp } from "./iris-api"

export type TagResult = {
  added?: string[]
  already_present?: string[]
  removed?: string[]
  not_on_lead?: string[]
  tags?: { id: number; name: string }[]
}

/** Tag arguments as the API takes them: numeric ids as numbers, everything else as a name. */
export function parseTagArgs(raw: (string | number)[]): (string | number)[] {
  return raw
    .flatMap((t) => String(t).split(","))
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => (/^\d+$/.test(t) ? Number(t) : t))
}

export function tagPath(leadId: number, mode: "tag" | "untag"): string {
  return `/api/v1/leads/${leadId}/tags${mode === "untag" ? "/remove" : ""}`
}

/** One line per outcome, so a tag that did nothing is never reported as done. */
export function describeTagResult(mode: "tag" | "untag", r: TagResult): string[] {
  const lines: string[] = []
  const list = (xs?: string[]) => (xs ?? []).join(", ")
  if (mode === "tag") {
    if (r.added?.length) lines.push(`added: ${list(r.added)}`)
    if (r.already_present?.length) lines.push(`already on the lead: ${list(r.already_present)}`)
  } else {
    if (r.removed?.length) lines.push(`removed: ${list(r.removed)}`)
    if (r.not_on_lead?.length) lines.push(`not on the lead: ${list(r.not_on_lead)}`)
  }
  const now = (r.tags ?? []).map((t) => t.name)
  lines.push(`tags now: ${now.length ? now.join(", ") : "(none)"}`)
  return lines
}

function tagCommand(mode: "tag" | "untag") {
  const verb = mode === "tag" ? "add tags to" : "remove tags from"
  return cmd({
    command: `${mode} <id> <tags..>`,
    describe:
      mode === "tag"
        ? "add existing tags to one lead (by tag id or name)"
        : "remove tags from one lead only — the tag and every other lead keep it",
    builder: (yargs) =>
      yargs
        .positional("id", { describe: "lead ID", type: "number", demandOption: true })
        .positional("tags", { describe: "tag ids or names (comma or space separated)", type: "string", array: true })
        .option("json", { describe: "JSON output", type: "boolean", default: false })
        .example(`iris leads ${mode} 30324 3595 3596`, `${verb} lead 30324 by tag id`)
        .example(`iris leads ${mode} 30324 "craft soda"`, `${verb} lead 30324 by tag name`),
    async handler(args) {
      const isJson = args.json === true
      if (!isJson) UI.empty()
      const token = await requireAuth()
      if (!token) return

      const leadId = Number(args.id)
      if (!Number.isInteger(leadId) || leadId <= 0) failNoOp(mode, `"${args.id}" is not a lead ID`)
      const tags = parseTagArgs((args.tags as (string | number)[] | undefined) ?? [])
      if (tags.length === 0) failNoOp(mode, `name at least one tag, e.g. iris leads ${mode} ${leadId} 3595`)

      const res = await irisFetch(tagPath(leadId, mode), { method: "POST", body: JSON.stringify({ tags }) })
      if (!(await handleApiError(res, mode === "tag" ? "Tag lead" : "Untag lead"))) return
      const body = (await res.json()) as { data?: TagResult }
      const result = body.data ?? {}

      if (isJson) {
        console.log(JSON.stringify({ lead_id: leadId, ...result }))
        return
      }
      const changed = (mode === "tag" ? result.added : result.removed)?.length ?? 0
      for (const line of describeTagResult(mode, result)) prompts.log.info(line)
      prompts.outro(changed ? success(`Lead #${leadId} updated`) : dim(`Lead #${leadId} unchanged`))
    },
  })
}

export const LeadsTagCommand = tagCommand("tag")
export const LeadsUntagCommand = tagCommand("untag")
