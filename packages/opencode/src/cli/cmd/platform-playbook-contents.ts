import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  handleApiError,
  printDivider,
  dim,
  bold,
  success,
  writeJson,
  IRIS_API,
} from "./iris-api"

/**
 * A playbook's contents, and attaching one to a bounty (#180756).
 *
 * These live under `iris playbook` rather than beside it because that is what the data model
 * says: a playbook CONTAINS procedures, skills and an org chart. `iris sop` stays for plain
 * document SOPs — a document attachment is still a legitimate shape — but anything
 * playbook-shaped belongs here.
 *
 * Two services are in play and the distinction matters:
 *   IRIS_API  — playbooks and their contents live in iris-api
 *   FL_API    — bounties and their requirements live in fl-api (the default base)
 */

const typeIcon = (t: string) => (t === "skill" ? "◆" : "▸")

// ---------------------------------------------------------------------------
// Items — the procedures and skills a playbook holds
// ---------------------------------------------------------------------------

const ItemsListCommand = cmd({
  command: "list <name>",
  aliases: ["ls"],
  describe: "list the procedures and skills in a playbook",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Playbook contents — ${args.name}`)
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const res = await irisFetch(`/api/v1/playbooks/${encodeURIComponent(String(args.name))}/items`, {}, IRIS_API)
    const ok = await handleApiError(res, "List items")
    if (!ok) {
      prompts.outro("Done")
      return
    }

    const data = (await res.json()) as any
    const items: any[] = data?.items ?? []
    if (args.json) {
      await writeJson(data)
      prompts.outro("Done")
      return
    }

    printDivider()
    console.log(`  ${dim(`playbook #${data?.playbook?.id} · version ${data?.playbook?.version}`)}`)
    if (items.length === 0) {
      // An empty state that only says "empty" teaches nothing. This container
      // shipped and sat unused because nothing told anyone what it was for, so
      // the one moment a person is definitely looking at it is worth spending.
      console.log(`  ${dim("(no procedures or skills yet)")}`)
      console.log("")
      console.log(`  ${dim("A playbook can hold the written SOPs a person follows, alongside")}`)
      console.log(`  ${dim("the skills an agent runs:")}`)
      console.log("")
      console.log(`    ${dim(`iris playbook items add ${args.name} --label "<name>" --bloq-item <atlas-item-id>`)}`)
      console.log(`    ${dim(`iris playbook items add ${args.name} --label "<name>" --skill <skill-id>`)}`)
      console.log("")
      console.log(`  ${dim("Draft an SOP from a recording or transcript with `iris playbook sop <file>`,")}`)
      console.log(`  ${dim("publish it as an Atlas item, then attach it here by id.")}`)
    }
    for (const i of items) {
      const req = i.is_required ? "" : dim(" (optional)")
      console.log(`  ${typeIcon(i.item_type)} ${bold(String(i.label))}  ${dim(`#${i.id}`)}${req}`)
      // A requirement that points at nothing is a real defect and should be visible as one,
      // not listed as though it could be satisfied.
      if (!i.resolves) console.log(`      ${dim("⚠ points at no content — nobody can read this")}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

const ItemsAddCommand = cmd({
  command: "add <name>",
  describe: "attach a human SOP (Atlas item) or a runnable skill to a playbook",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .option("label", { type: "string", demandOption: true, describe: "what a person will see" })
      .option("type", { type: "string", choices: ["sop", "skill"], default: "sop" })
      .option("description", { type: "string" })
      .option("bloq-item", {
        type: "number",
        describe: "Atlas item id holding the written SOP — attached by reference, never copied",
      })
      .option("skill", { type: "number", describe: "marketplace skill id — a runnable capability" })
      .option("role", { type: "number", describe: "role that owns this; omit for everyone" })
      .option("optional", { type: "boolean", default: false, describe: "not required to be read" })
      .example(
        "$0 playbook items add onboarding --label 'Intake approval SOP' --bloq-item 182265",
        "attach a written SOP a person follows",
      )
      .example(
        "$0 playbook items add onboarding --label 'Score a case' --skill 41 --role 3",
        "attach a runnable skill, owned by a role",
      ),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Add to playbook")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const payload: any = {
      item_type: args.type,
      label: args.label,
      is_required: !args.optional,
    }
    if (args.description) payload.description = args.description
    if (args["bloq-item"]) payload.bloq_item_id = args["bloq-item"]
    if (args.skill) payload.skill_id = args.skill
    if (args.role) payload.role_id = args.role

    const res = await irisFetch(
      `/api/v1/playbooks/${encodeURIComponent(String(args.name))}/items`,
      { method: "POST", body: JSON.stringify(payload) },
      IRIS_API,
    )
    const ok = await handleApiError(res, "Add item")
    if (!ok) {
      prompts.outro("Done")
      return
    }

    const item = ((await res.json()) as any)?.item ?? {}
    if (item.resolves === false) {
      console.log(`  ${dim("⚠ added, but it points at no content yet — pass --bloq-item or --skill so it can be read")}`)
    }
    prompts.outro(`${success("✓")} Added #${item.id ?? ""} — ${item.label ?? ""}`)
  },
})

const ItemsRemoveCommand = cmd({
  command: "rm <name> <itemId>",
  aliases: ["remove", "delete"],
  describe: "remove a procedure or skill from a playbook",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .positional("itemId", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Remove from playbook")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const res = await irisFetch(
      `/api/v1/playbooks/${encodeURIComponent(String(args.name))}/items/${args.itemId}`,
      { method: "DELETE" },
      IRIS_API,
    )
    const ok = await handleApiError(res, "Remove item")
    if (!ok) {
      prompts.outro("Done")
      return
    }

    const data = (await res.json()) as any
    // Say the version moved, because that is what expires people's acknowledgements.
    prompts.outro(`${success("✓")} Removed. Playbook is now version ${data?.version ?? "?"} — anyone who acknowledged the old version must read it again.`)
  },
})

const PlaybookItemsCommand = cmd({
  command: "items <subcommand>",
  describe: "hold human SOPs + skills inside a playbook — attach a written SOP (Atlas item) or a runnable skill",
  builder: (yargs) =>
    yargs
      .command(ItemsListCommand)
      .command(ItemsAddCommand)
      .command(ItemsRemoveCommand)
      .demandCommand(1, "")
      // A playbook is a CONTAINER, not just a list of steps — and nothing in the
      // command names said so, so the capability shipped and went unused. Every
      // playbook's contents were empty because people did not know this existed.
      .epilogue(
        [
          "A playbook holds two kinds of thing:",
          "",
          "  · a HUMAN SOP  — the written procedure a person reads and follows,",
          "                   stored as an Atlas item and attached BY REFERENCE",
          "  · a SKILL      — a runnable capability an agent executes",
          "",
          "The SOP lives in exactly one place and the playbook points at it, so",
          "editing the Atlas item updates every playbook that carries it — nothing",
          "is copied, nothing goes stale.",
          "",
          "  iris playbook items add <playbook> --label 'Intake approval SOP' --bloq-item 182265",
          "  iris playbook items add <playbook> --label 'Score a case' --skill 41",
          "  iris playbook items list <playbook>",
          "",
          "Draft the SOP first with `iris playbook sop <transcript>`, publish it as an",
          "Atlas item, then attach it here by id. `iris playbook roles` says who owns what.",
        ].join("\n"),
      ),
  handler() {},
})

// ---------------------------------------------------------------------------
// Roles — the org chart
// ---------------------------------------------------------------------------

const RolesListCommand = cmd({
  command: "list <name>",
  aliases: ["ls"],
  describe: "show the org chart",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Org chart — ${args.name}`)
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const res = await irisFetch(`/api/v1/playbooks/${encodeURIComponent(String(args.name))}/roles`, {}, IRIS_API)
    const ok = await handleApiError(res, "List roles")
    if (!ok) {
      prompts.outro("Done")
      return
    }

    const data = (await res.json()) as any
    const roles: any[] = data?.roles ?? []
    if (args.json) {
      await writeJson(data)
      prompts.outro("Done")
      return
    }

    printDivider()
    if (roles.length === 0) console.log(`  ${dim("(no roles defined)")}`)

    // Render the hierarchy rather than a flat list — a chart printed flat is just a list, and
    // the whole point of the chart is who reports to whom.
    const byParent = new Map<number | null, any[]>()
    for (const r of roles) {
      const key = r.reports_to_role_id ?? null
      byParent.set(key, [...(byParent.get(key) ?? []), r])
    }

    const seen = new Set<number>()
    const walk = (parent: number | null, depth: number) => {
      for (const r of byParent.get(parent) ?? []) {
        if (seen.has(r.id)) continue // a cycle is a data error, not a reason to hang
        seen.add(r.id)
        const owns = r.item_count ? dim(` · owns ${r.item_count}`) : ""
        console.log(`  ${"  ".repeat(depth)}${depth ? dim("└ ") : ""}${bold(String(r.title))}  ${dim(`#${r.id}`)}${owns}`)
        walk(r.id, depth + 1)
      }
    }
    walk(null, 0)

    // Anything unreachable from a root is in a cycle or points at a deleted seat. Printing it
    // separately beats omitting it, which would make the chart look complete when it is not.
    const orphans = roles.filter((r) => !seen.has(r.id))
    if (orphans.length) {
      console.log(`  ${dim("— unreachable (broken reports-to):")}`)
      for (const r of orphans) console.log(`    ${bold(String(r.title))}  ${dim(`#${r.id}`)}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

const RolesAddCommand = cmd({
  command: "add <name>",
  describe: "add a role to the org chart",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .option("title", { type: "string", demandOption: true })
      .option("reports-to", { type: "number", describe: "role id this one reports to" })
      .option("responsibilities", { type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Add role")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const payload: any = { title: args.title }
    if (args["reports-to"]) payload.reports_to_role_id = args["reports-to"]
    if (args.responsibilities) payload.responsibilities = args.responsibilities

    const res = await irisFetch(
      `/api/v1/playbooks/${encodeURIComponent(String(args.name))}/roles`,
      { method: "POST", body: JSON.stringify(payload) },
      IRIS_API,
    )
    const ok = await handleApiError(res, "Add role")
    if (!ok) {
      prompts.outro("Done")
      return
    }

    const role = ((await res.json()) as any)?.role ?? {}
    prompts.outro(`${success("✓")} Added role #${role.id ?? ""} — ${role.title ?? ""}`)
  },
})

const RolesRemoveCommand = cmd({
  command: "rm <name> <roleId>",
  aliases: ["remove", "delete"],
  describe: "remove a role (its reports move up, its work becomes unassigned)",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .positional("roleId", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Remove role")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const res = await irisFetch(
      `/api/v1/playbooks/${encodeURIComponent(String(args.name))}/roles/${args.roleId}`,
      { method: "DELETE" },
      IRIS_API,
    )
    const ok = await handleApiError(res, "Remove role")
    if (!ok) {
      prompts.outro("Done")
      return
    }

    const data = (await res.json()) as any
    prompts.outro(`${success("✓")} Removed. Reports moved up a level; their work is now unassigned. Playbook is version ${data?.version ?? "?"}.`)
  },
})

const PlaybookRolesCommand = cmd({
  command: "roles <subcommand>",
  describe: "the org chart — roles, who reports to whom, and which procedures each owns",
  builder: (yargs) =>
    yargs.command(RolesListCommand).command(RolesAddCommand).command(RolesRemoveCommand).demandCommand(1, ""),
  handler() {},
})

// ---------------------------------------------------------------------------
// Attaching a playbook to a bounty — this one talks to FL_API
// ---------------------------------------------------------------------------

const PlaybookAttachBountyCommand = cmd({
  command: "require <name> <opportunityId>",
  describe: "require this playbook on a bounty — pins the version, so a revision expires it",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .positional("opportunityId", { type: "number", demandOption: true })
      .option("item", { type: "number", describe: "scope to ONE procedure — an exact claim rather than 'accepted the playbook'" })
      .option("optional", { type: "boolean", default: false })
      .option("label", { type: "string", describe: "override what the listing calls it" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Require playbook on bounty")
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    // Resolve the playbook first, for its id and CURRENT version. The version is pinned at
    // attach time deliberately: an unpinned requirement can never expire, so an
    // acknowledgement of it would stay green through every later revision.
    const pbRes = await irisFetch(`/api/v1/playbooks/${encodeURIComponent(String(args.name))}`, {}, IRIS_API)
    if (!(await handleApiError(pbRes, "Resolve playbook"))) {
      prompts.outro("Done")
      return
    }
    const playbook = ((await pbRes.json()) as any)?.playbook ?? {}
    if (!playbook?.id) {
      prompts.outro(`Could not resolve playbook "${args.name}"`)
      return
    }

    const payload: any = {
      type: "playbook",
      playbook_id: playbook.id,
      playbook_version: playbook.version,
      playbook_name: playbook.name ?? args.name,
      is_required: !args.optional,
    }
    if (args.label) payload.label = args.label

    // Scoping needs a label the listing can render without calling iris-api, so look it up here
    // rather than making the API refuse.
    if (args.item) {
      const itemsRes = await irisFetch(
        `/api/v1/playbooks/${encodeURIComponent(String(args.name))}/items`,
        {},
        IRIS_API,
      )
      if (!(await handleApiError(itemsRes, "Resolve item"))) {
        prompts.outro("Done")
        return
      }
      const found = (((await itemsRes.json()) as any)?.items ?? []).find((i: any) => Number(i.id) === Number(args.item))
      if (!found) {
        prompts.outro(`Playbook "${args.name}" has no item #${args.item}`)
        return
      }
      payload.playbook_item_id = found.id
      payload.playbook_item_label = found.label
    }

    const res = await irisFetch(`/api/v1/marketplace/opportunities/${args.opportunityId}/sops`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
    const ok = await handleApiError(res, "Attach playbook")
    if (!ok) {
      prompts.outro("Done")
      return
    }

    const scope = args.item ? `${payload.playbook_item_label}` : `the whole playbook`
    prompts.outro(
      `${success("✓")} Bounty #${args.opportunityId} now requires ${bold(scope)} at version ${playbook.version}.`,
    )
  },
})

// ---------------------------------------------------------------------------
// Acknowledging a requirement — FL_API
// ---------------------------------------------------------------------------

const PlaybookAckCommand = cmd({
  command: "ack <opportunityId> [sopItemId]",
  describe: "what a bounty requires you to read — run with no item id to just see what is outstanding",
  builder: (yargs) =>
    yargs
      .positional("opportunityId", { type: "number", demandOption: true })
      .positional("sopItemId", { type: "number", describe: "omit to just list what is outstanding" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Requirements — bounty #${args.opportunityId}`)
    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    // Listing before acting is the default on purpose: `ack <id>` with no item is safe and
    // shows what is outstanding, so nobody has to guess an id to find out what they owe.
    if (!args.sopItemId) {
      const res = await irisFetch(`/api/v1/marketplace/opportunities/${args.opportunityId}`)
      if (!(await handleApiError(res, "Load bounty"))) {
        prompts.outro("Done")
        return
      }

      const sops: any[] = ((await res.json()) as any)?.data?.sops ?? []
      if (args.json) {
        await writeJson(sops)
        prompts.outro("Done")
        return
      }

      printDivider()
      if (sops.length === 0) console.log(`  ${dim("(this bounty requires nothing)")}`)
      for (const s of sops) {
        // acknowledged is null when the API could not identify the caller — which is a
        // different state from "not read" and must not be printed as one.
        const mark =
          s.acknowledged === true ? success("✓") : s.acknowledged === null ? dim("?") : dim("○")
        const req = s.is_required ? "" : dim(" (optional)")
        const label = s.playbook?.item_label ?? s.label ?? s.playbook?.name ?? "Untitled"
        console.log(`  ${mark} ${bold(String(label))}  ${dim(`#${s.id}`)}${req}`)
        if (s.playbook) {
          const scope = s.playbook.scoped ? `from ${s.playbook.name}` : `${s.playbook.name} (whole)`
          console.log(`      ${dim(`${scope} · v${s.playbook.version}`)}`)
        }
        if (s.resolves === false) console.log(`      ${dim("⚠ no content attached — the owner needs to fix this")}`)
      }
      printDivider()
      console.log(`  ${dim(`iris playbook ack ${args.opportunityId} <id>  to mark one as read`)}`)
      prompts.outro("Done")
      return
    }

    const res = await irisFetch(
      `/api/v1/marketplace/opportunities/${args.opportunityId}/sops/${args.sopItemId}/acknowledge`,
      { method: "POST" },
    )
    const ok = await handleApiError(res, "Acknowledge")
    if (!ok) {
      prompts.outro("Done")
      return
    }

    const data = ((await res.json()) as any)?.data ?? {}
    // Say what this actually claims. A container acknowledgement is not evidence the contents
    // were read, and the person doing it should know which one they just made.
    const note =
      data.claim_strength === "container"
        ? " (covers the playbook as a whole, not each procedure in it)"
        : ""
    const version = data.acknowledged_version ? ` at version ${data.acknowledged_version}` : ""
    prompts.outro(`${success("✓")} Marked as read${version}.${note}`)
  },
})

export const PlaybookContentsCommands = {
  items: PlaybookItemsCommand,
  roles: PlaybookRolesCommand,
  require: PlaybookAttachBountyCommand,
  ack: PlaybookAckCommand,
}
