import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, success, printDivider, printKV } from "./iris-api"
import {
  loadIdentities,
  saveIdentities,
  linkHandles,
  suggestMerges,
  resolveIdentity,
  normaliseHandle,
  IDENTITY_PATH,
  type CardLike,
} from "../lib/identity"
import { readPayments } from "../lib/payments"
import { findContactsByName, resolveFromAddressBook } from "../lib/address-book"

/**
 * `iris identity` (#178599).
 *
 * One human fragments differently at every layer — Flo is two contact cards,
 * two user accounts and one lead; Rashad is five leads across two emails. Flo's
 * $50 landed on the "Flozzel Smith" card while every lookup for "Flo" resolved
 * to "Flo Smith", so the platform reported no payments with total confidence.
 *
 * Merging is deliberately NOT automatic. Two people wrongly merged means money
 * attributed to the wrong human, which is worse than the fragmentation. This
 * suggests; you confirm.
 */

const IdentityListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "show known identities and their aliases",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(args) {
    const map = loadIdentities()
    if (args.json) {
      console.log(JSON.stringify({ success: true, path: IDENTITY_PATH, ...map }, null, 2))
      return
    }
    UI.empty()
    prompts.intro("◈  Identities")
    if (!map.identities.length) {
      prompts.log.info("No identities linked yet.")
      prompts.outro(dim("Find candidates:  iris identity suggest"))
      return
    }
    printDivider()
    for (const i of map.identities) {
      console.log(`  ${bold(i.name)}  ${dim(i.id)}`)
      console.log(`     handles: ${i.handles.join(", ")}`)
      if (i.aliases?.length) console.log(`     ${dim(`also known as: ${i.aliases.join(", ")}`)}`)
      if (i.leadIds?.length) console.log(`     ${dim(`leads: ${i.leadIds.join(", ")}`)}`)
      if (i.userIds?.length) console.log(`     ${dim(`users: ${i.userIds.join(", ")}`)}`)
    }
    printDivider()
    prompts.outro(dim(IDENTITY_PATH))
  },
})

const IdentitySuggestCommand = cmd({
  command: "suggest",
  aliases: ["candidates", "scan"],
  describe: "find contact cards that look like the same person (suggests only — never merges)",
  builder: (y) =>
    y
      .option("days", { describe: "how far back to scan payments", type: "number", default: 365 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const res = readPayments({ days: args.days, limit: 5000 })
    if (!res.available) {
      if (args.json) console.log(JSON.stringify({ success: false, error: res.reason }))
      else prompts.log.warn(res.reason ?? "Messages unavailable")
      process.exitCode = 1
      return
    }

    // Distinct counterparties seen paying or being paid.
    const seen = new Map<string, CardLike>()
    for (const p of res.payments) {
      const key = normaliseHandle(p.handle)
      if (!key || seen.has(key)) continue
      seen.set(key, { name: p.contact ?? p.handle, handle: p.handle })
    }

    // Payment counterparties alone are not enough: only ONE of Flo's two numbers
    // has ever been paid, so her duplicate card never enters this set and the
    // real duplicate stays invisible. Pull in every contact sharing a surname
    // with someone we have paid — that is where the twin actually lives.
    const surnames = new Set<string>()
    for (const c of seen.values()) {
      const parts = c.name.trim().split(/\s+/)
      if (parts.length > 1) surnames.add(parts[parts.length - 1])
    }
    for (const surname of surnames) {
      for (const match of findContactsByName(surname)) {
        const handle = match.phones[0] ?? match.emails[0]
        if (!handle) continue
        const key = normaliseHandle(handle)
        if (!key || seen.has(key)) continue
        seen.set(key, { name: match.name, handle })
      }
    }

    const map = loadIdentities()
    const suggestions = suggestMerges([...seen.values()]).filter(
      // Hide pairs already linked.
      (s) => {
        const ids = s.members.map((m) => resolveIdentity(map, { handle: m.handle })?.id)
        return !(ids[0] && ids[0] === ids[1])
      },
    )

    if (args.json) {
      console.log(JSON.stringify({ success: true, cards: seen.size, suggestions }, null, 2))
      return
    }

    UI.empty()
    prompts.intro("◈  Identity Suggestions")
    printDivider()
    if (!suggestions.length) {
      prompts.log.info(`No candidates among ${seen.size} counterparties.`)
      prompts.outro(dim("Nothing to merge."))
      return
    }
    for (const s of suggestions) {
      const badge = s.confidence === "high" ? success("high") : dim("medium")
      console.log(`  ${badge}  ${s.members.map((m) => bold(m.name)).join(dim("  ⟷  "))}`)
      console.log(`        ${dim(s.reason)}`)
      console.log(`        ${dim(`link: iris identity link ${s.members.map((m) => m.handle).join(" ")}`)}`)
    }
    printDivider()
    prompts.outro(dim(`${suggestions.length} candidate(s) from ${seen.size} counterparties — confirm each yourself`))
  },
})

const IdentityLinkCommand = cmd({
  command: "link <handles..>",
  aliases: ["merge"],
  describe: "declare two or more handles to be the same person",
  builder: (y) =>
    y
      .positional("handles", { describe: "phone numbers or emails", type: "string" })
      .option("name", { describe: "canonical name for this person", type: "string" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const handles = (args.handles as unknown as string[]) ?? []
    if (handles.length < 2) {
      const msg = "Give at least two handles — linking one to itself does nothing."
      if (args.json) console.log(JSON.stringify({ success: false, error: msg }))
      else prompts.log.warn(msg)
      process.exitCode = 2
      return
    }

    const before = loadIdentities()
    let after = linkHandles(before, handles, args.name)

    // Capture the contact-card name behind each handle as an alias, so a later
    // `iris identity show "Flozzel Smith"` resolves. Without this the merge
    // knows the numbers but forgets every name the person is filed under —
    // which is the same amnesia that hid the payment in the first place.
    const rec0 = resolveIdentity(after, { handle: handles[0] })
    if (rec0) {
      const names = new Set(rec0.aliases ?? [])
      for (const h of handles) {
        const cardName = resolveFromAddressBook(h)
        if (cardName && cardName !== rec0.name) names.add(cardName)
      }
      if (names.size) {
        after = {
          identities: after.identities.map((i) =>
            i.id === rec0.id ? { ...i, aliases: [...names] } : i,
          ),
        }
      }
    }

    saveIdentities(after)

    const rec = resolveIdentity(after, { handle: handles[0] })
    if (args.json) {
      console.log(JSON.stringify({ success: true, identity: rec, count: after.identities.length }, null, 2))
      return
    }
    UI.empty()
    prompts.log.info(`${success("✓")} Linked as ${bold(rec?.name ?? handles[0])}`)
    printKV("Handles", rec?.handles.join(", ") ?? "")
    if (before.identities.length > after.identities.length) {
      prompts.log.info(dim(`merged ${before.identities.length - after.identities.length + 1} identities into one`))
    }
    prompts.outro(dim("iris imessage payments --by-person"))
  },
})

const IdentityShowCommand = cmd({
  command: "show <who>",
  aliases: ["who"],
  describe: "resolve a name, number or email to its identity",
  builder: (y) =>
    y.positional("who", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    const map = loadIdentities()
    const who = String(args.who)
    const rec = resolveIdentity(map, { handle: who, name: who })

    if (args.json) {
      console.log(JSON.stringify({ success: Boolean(rec), query: who, identity: rec }, null, 2))
      return
    }
    UI.empty()
    if (!rec) {
      prompts.log.warn(`No identity linked for "${who}".`)
      prompts.outro(dim("iris identity suggest"))
      return
    }
    prompts.intro(`◈  ${rec.name}`)
    printDivider()
    printKV("id", rec.id)
    printKV("handles", rec.handles.join(", "))
    if (rec.aliases?.length) printKV("also known as", rec.aliases.join(", "))
    if (rec.leadIds?.length) printKV("leads", rec.leadIds.join(", "))
    if (rec.userIds?.length) printKV("users", rec.userIds.join(", "))
    printDivider()
    prompts.outro(dim(`iris imessage payments --contact "${rec.name}"`))
  },
})

export const PlatformIdentityCommand = cmd({
  command: "identity",
  aliases: ["identities", "who"],
  describe: "link the handles, cards and accounts that belong to one person",
  builder: (yargs) =>
    yargs
      .command(IdentityListCommand)
      .command(IdentitySuggestCommand)
      .command(IdentityLinkCommand)
      .command(IdentityShowCommand)
      .command({
        command: "$0",
        describe: false as unknown as string,
        handler: (a: any) => (IdentityListCommand as any).handler(a),
      }),
  async handler() {},
})
