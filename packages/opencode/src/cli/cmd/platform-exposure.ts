/**
 * `iris exposure` — one verb for "who can reach this?", across every kind of thing.
 *
 * Epic #182344 G-09. Before this, the same question had five different answers
 * depending on which noun you happened to be holding: `pages visibility`,
 * `atlas make-public`, `playbook publish --scope`, `datasets feeds`, and nothing
 * at all for components. None of the five was a superset of the others, so there
 * was no "most capable" surface to standardise on — only a scatter.
 *
 * This does not replace those commands. It gives them a shared vocabulary and a
 * single place to ASK, and routes every widening through the one gate in
 * `exposure-gate.ts`. The old verbs keep working and now go THROUGH the gate
 * rather than around it — an alias that preserves the dangerous path is the old
 * bug wearing a new name.
 */

import { cmd } from "./cmd"
import { productCommand } from "./product-command"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  requireUserId,
  IRIS_API,
  dim,
  bold,
  success,
  highlight,
  printDivider,
  printKV,
  writeJson,
} from "./iris-api"
import { confirmWiden, isOpen, TIERS, type Tier } from "./exposure-gate"
import { getBySlug, pageGateFlags } from "./platform-pages"
import { collectPublishedItems, apiMakePrivate, PUBLISHED_SCAN_BLOQ_CAP } from "./bloq-item-shared"
import { privacyVerdict } from "./platform-playbook"

// ── addressing ───────────────────────────────────────────────────────────────

export type Noun = "page" | "note" | "playbook"
export interface Ref {
  noun: Noun
  id: string
  /** true when the noun was inferred rather than written. Worth saying out loud. */
  inferred: boolean
}

const NOUNS: Noun[] = ["page", "note", "playbook"]

/**
 * `page:atlas-console` · `note:182260` · `playbook:genesis-regression`
 *
 * The grammar deliberately mirrors Genesis collection addresses (`item:` `list:`
 * `bloq:`) so there is one addressing idea in the product rather than two.
 *
 * A bare value is inferred — all-digits is a note, anything else a page — and the
 * inference is REPORTED, never silent. Guessing quietly is how you end up
 * answering a question nobody asked.
 */
export function parseRef(input: string): Ref | { error: string } {
  const raw = String(input ?? "").trim()
  if (!raw) return { error: "empty reference" }

  const colon = raw.indexOf(":")
  if (colon > 0) {
    const noun = raw.slice(0, colon).toLowerCase()
    const id = raw.slice(colon + 1).trim()
    if (!NOUNS.includes(noun as Noun)) {
      return { error: `unknown kind "${noun}" — expected one of: ${NOUNS.join(", ")}` }
    }
    if (!id) return { error: `"${raw}" has no id after the colon` }
    return { noun: noun as Noun, id, inferred: false }
  }

  if (/^\d+$/.test(raw)) return { noun: "note", id: raw, inferred: true }
  return { noun: "page", id: raw, inferred: true }
}

// ── reading the current tier ─────────────────────────────────────────────────

export interface ExposureState {
  noun: Noun
  id: string
  tier: Tier
  /** false when we could not determine it — which is NOT the same as private. */
  measured: boolean
  urls: string[]
  notes: string[]
}

/**
 * A page's effective tier.
 *
 * The GATE WINS over visibility. A page can be `visibility: public` and still be
 * unreadable because an OTP gate sits in front of it — that is exactly the shape
 * of /p/exposure-architecture. Reporting "public" there would be true about a
 * column and false about the world.
 */
export function pageTier(page: any): Tier {
  if (pageGateFlags(page).gated) return "gated"
  if (page?.status && page.status !== "published") return "private"
  const v = page?.visibility ?? page?.effective_visibility
  if (v === "private") return "private"
  if (v === "unlisted") return "unlisted"
  return "public" // matches the server's fail-open default when unset
}

async function readPage(slug: string): Promise<ExposureState> {
  const page = await getBySlug(slug)
  if (!page) {
    return { noun: "page", id: slug, tier: "private", measured: false, urls: [], notes: ["no page with that slug"] }
  }
  const tier = pageTier(page)
  const notes: string[] = []
  const g = pageGateFlags(page)
  if (g.gated) notes.push(`gate on (${g.which}) — a visitor must prove who they are`)
  if (page.status !== "published") notes.push(`status: ${page.status} — /p/ 404s until published`)
  return {
    noun: "page",
    id: slug,
    tier,
    measured: true,
    urls: isOpen(tier) && page.status === "published" ? [page.public_url ?? `https://heyiris.io/p/${slug}`] : [],
    notes,
  }
}

async function readNote(id: string): Promise<ExposureState> {
  const userId = await requireUserId(undefined)
  if (!userId) {
    return { noun: "note", id, tier: "private", measured: false, urls: [], notes: ["could not resolve user"] }
  }
  const published = await collectPublishedItems(userId)
  const hit = published.find((p) => String(p.id) === String(id))
  if (!hit) {
    return {
      noun: "note",
      id,
      tier: "private",
      measured: true,
      urls: [],
      notes: [`not among the ${published.length} reachable notes (scan covers ${PUBLISHED_SCAN_BLOQ_CAP} boards)`],
    }
  }
  const lvl = String(hit.access_level ?? "public")
  const tier: Tier = lvl === "public" ? "public" : "gated"
  return {
    noun: "note",
    id,
    tier,
    measured: true,
    urls: [hit.public_url],
    notes: lvl === "public" ? [] : [`access level: ${lvl}`],
  }
}

async function readPlaybook(name: string): Promise<ExposureState> {
  const base = IRIS_API.replace(/\/$/, "")
  const UA = { "User-Agent": "iris-exposure" }
  let directStatus = 0
  try {
    directStatus = (await fetch(`${base}/api/v1/playbooks/${encodeURIComponent(name)}`, { headers: UA })).status
  } catch {
    directStatus = -1
  }
  let listed: boolean | null = null
  try {
    const res = await fetch(`${base}/api/v1/playbooks`, { headers: UA })
    if (res.ok) {
      const body: any = await res.json()
      const rows: any[] = body?.playbooks ?? (Array.isArray(body) ? body : [])
      listed = rows.some((p) => String(p?.name) === name)
    }
  } catch {
    listed = null
  }
  const v = privacyVerdict({ directStatus, listed })
  return {
    noun: "playbook",
    id: name,
    tier: v.private ? "private" : "public",
    measured: v.measured,
    urls: v.readable ? [`${base}/api/v1/playbooks/${encodeURIComponent(name)}`] : [],
    notes: v.measured ? [] : ["could not reach the public list — this is UNMEASURED, not private"],
  }
}

export async function readExposure(ref: Ref): Promise<ExposureState> {
  if (ref.noun === "page") return readPage(ref.id)
  if (ref.noun === "note") return readNote(ref.id)
  return readPlaybook(ref.id)
}

// ── commands ─────────────────────────────────────────────────────────────────

function tierBadge(t: Tier): string {
  return isOpen(t) ? `${UI.Style.TEXT_DANGER}${t.toUpperCase()}${UI.Style.TEXT_NORMAL}` : success(t.toUpperCase())
}

const ShowCmd = cmd({
  command: "show <ref>",
  aliases: ["status", "get"],
  describe: "who can reach this? — works for a page, a note or a playbook",
  builder: (y) =>
    y
      .positional("ref", { describe: "page:<slug> · note:<id> · playbook:<name>", type: "string", demandOption: true })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args: any) {
    const ref = parseRef(String(args.ref))
    if ("error" in ref) {
      prompts.log.error(ref.error)
      process.exitCode = 1
      return
    }
    if (!(await requireAuth())) return

    const st = await readExposure(ref)
    if (args.json) {
      await writeJson({ ...st, open: isOpen(st.tier), inferred_kind: ref.inferred })
      return
    }

    UI.empty()
    prompts.intro(`◈  Exposure — ${ref.noun}:${ref.id}`)
    printDivider()
    if (ref.inferred) UI.println(dim(`  read as a ${ref.noun} (no prefix given)`))
    printKV("Tier", tierBadge(st.tier))
    printKV("Reach", isOpen(st.tier) ? "anyone with the link — no sign-in" : "identity required")
    if (!st.measured) printKV("Measured", `${UI.Style.TEXT_WARNING}no — unmeasured is not the same as private${UI.Style.TEXT_NORMAL}`)
    for (const u of st.urls) printKV("Live url", u)
    for (const n of st.notes) UI.println(dim(`  ${n}`))
    printDivider()
    prompts.outro(dim(`iris exposure narrow ${ref.noun}:${ref.id}   ·   iris exposure widen ${ref.noun}:${ref.id} --to public`))
  },
})

const AuditCmd = cmd({
  command: "audit",
  aliases: ["open", "what-is-public"],
  describe: "everything of yours a stranger can currently reach",
  builder: (y) =>
    y
      .option("noun", { describe: "limit to one kind", type: "string", choices: NOUNS as string[] })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args: any) {
    if (!(await requireAuth())) return
    const only = args.noun as Noun | undefined
    const json = Boolean(args.json)

    if (!json) { UI.empty(); prompts.intro("◈  Exposure audit") }
    const sp = json ? null : prompts.spinner()
    sp?.start("Asking what a stranger can reach…")

    const openPages: any[] = []
    const openNotes: any[] = []
    const openPlaybooks: any[] = []
    const caveats: string[] = []

    if (!only || only === "page") {
      const res = await irisFetch("/api/v1/pages?per_page=200", {}, IRIS_API)
      if (res.ok) {
        const body: any = await res.json()
        const rows: any[] = body?.data?.data ?? body?.data ?? []
        for (const p of rows) {
          const t = pageTier(p)
          if (isOpen(t) && p.status === "published") {
            openPages.push({ id: p.id, slug: p.slug, title: p.title ?? "", tier: t, url: p.public_url ?? `https://heyiris.io/p/${p.slug}` })
          }
        }
        if (rows.length >= 200) caveats.push("page scan capped at 200 — there may be more")
      } else {
        caveats.push(`could not list pages (HTTP ${res.status}) — pages are UNMEASURED here`)
      }
    }

    if (!only || only === "note") {
      const userId = await requireUserId(undefined)
      if (userId) {
        const pub = await collectPublishedItems(userId)
        for (const n of pub) {
          openNotes.push({ id: n.id, title: n.title, tier: String(n.access_level ?? "public") === "public" ? "public" : "gated", url: n.public_url })
        }
        caveats.push(`note scan covers ${PUBLISHED_SCAN_BLOQ_CAP} boards`)
      } else {
        caveats.push("could not resolve user — notes are UNMEASURED here")
      }
    }

    if (!only || only === "playbook") {
      try {
        const res = await fetch(`${IRIS_API.replace(/\/$/, "")}/api/v1/playbooks`, { headers: { "User-Agent": "iris-exposure" } })
        if (res.ok) {
          const body: any = await res.json()
          const rows: any[] = body?.playbooks ?? (Array.isArray(body) ? body : [])
          for (const p of rows) openPlaybooks.push({ name: p.name, tier: "public" })
        } else caveats.push(`could not list playbooks (HTTP ${res.status}) — UNMEASURED`)
      } catch {
        caveats.push("could not reach the playbook list — UNMEASURED")
      }
    }

    sp?.stop("Done")

    if (json) {
      await writeJson({
        total: openPages.length + openNotes.length + openPlaybooks.length,
        pages: openPages,
        notes: openNotes,
        playbooks: openPlaybooks,
        caveats,
      })
      return
    }

    const section = (label: string, rows: any[], render: (r: any) => string) => {
      if (!rows.length) return
      UI.println("")
      UI.println(`  ${bold(label)} ${dim(`(${rows.length})`)}`)
      for (const r of rows) UI.println(`    ${render(r)}`)
    }
    printDivider()
    section("Pages", openPages, (p) => `${highlight(p.slug)} ${dim(p.tier)}  ${dim(p.url)}`)
    section("Notes", openNotes, (n) => `${dim("#" + n.id)} ${n.title.slice(0, 58)} ${dim(n.tier)}`)
    section("Playbooks", openPlaybooks, (p) => `${highlight(p.name)}`)
    UI.println("")
    printDivider()

    const total = openPages.length + openNotes.length + openPlaybooks.length
    UI.println(`  ${bold(String(total))} reachable by a stranger`)
    // A capped scan reported as a total is a confident partial answer — say the bound.
    for (const c of caveats) UI.println(dim(`  · ${c}`))
    prompts.outro(dim("iris exposure narrow <ref>   ·   iris exposure show <ref>"))
  },
})

const NarrowCmd = cmd({
  command: "narrow <ref>",
  aliases: ["close", "private"],
  describe: "make it private — never asks, because closing a door is recoverable",
  builder: (y) =>
    y
      .positional("ref", { describe: "page:<slug> · note:<id>", type: "string", demandOption: true })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args: any) {
    const ref = parseRef(String(args.ref))
    if ("error" in ref) { prompts.log.error(ref.error); process.exitCode = 1; return }
    if (!(await requireAuth())) return

    UI.empty()
    prompts.intro(`◈  Narrow — ${ref.noun}:${ref.id}`)

    if (ref.noun === "note") {
      const userId = await requireUserId(undefined)
      if (!userId) { prompts.outro("Done"); return }
      const ok = await apiMakePrivate(userId, Number(ref.id))
      if (ok) prompts.log.success("Now private — the public url 404s.")
      else process.exitCode = 1
      prompts.outro("Done")
      return
    }

    if (ref.noun === "page") {
      const page = await getBySlug(ref.id)
      if (!page) { prompts.log.error("No page with that slug"); process.exitCode = 1; prompts.outro("Done"); return }
      const res = await irisFetch(`/api/v1/pages/${page.id}`, { method: "PUT", body: JSON.stringify({ visibility: "private" }) }, IRIS_API)
      if (res.ok) prompts.log.success("Now private — every /p/ url for it 404s.")
      else { prompts.log.error(`Failed (HTTP ${res.status})`); process.exitCode = 1 }
      prompts.outro("Done")
      return
    }

    prompts.log.warn(`Narrowing a playbook is: iris playbook publish ${ref.id} --scope private`)
    prompts.outro("Done")
  },
})

const WidenCmd = cmd({
  command: "widen <ref>",
  aliases: ["open-up"],
  describe: "widen who can reach it — always confirms, and refuses without a terminal",
  builder: (y) =>
    y
      .positional("ref", { describe: "page:<slug> · note:<id>", type: "string", demandOption: true })
      .option("to", { describe: "target tier", type: "string", choices: TIERS as unknown as string[], demandOption: true })
      .option("force", { describe: "consent — REQUIRED when there is no terminal", type: "boolean", default: false }),
  async handler(args: any) {
    const ref = parseRef(String(args.ref))
    if ("error" in ref) { prompts.log.error(ref.error); process.exitCode = 1; return }
    if (!(await requireAuth())) return
    const to = String(args.to) as Tier

    UI.empty()
    prompts.intro(`◈  Widen — ${ref.noun}:${ref.id} → ${to}`)
    const st = await readExposure(ref)

    const verdict = await confirmWiden({
      noun: ref.noun,
      name: ref.id,
      from: st.tier,
      to,
      force: Boolean(args.force),
    })
    if (!verdict.ok) {
      process.exitCode = verdict.reason === "needs-force" ? 1 : 0
      prompts.outro(verdict.reason === "needs-force" ? "Refused — nothing changed" : "Cancelled — nothing changed")
      return
    }

    if (ref.noun === "page") {
      const page = await getBySlug(ref.id)
      if (!page) { prompts.log.error("No page with that slug"); process.exitCode = 1; prompts.outro("Done"); return }
      const res = await irisFetch(`/api/v1/pages/${page.id}`, { method: "PUT", body: JSON.stringify({ visibility: to }) }, IRIS_API)
      if (res.ok) prompts.log.success(`Now ${to}.`)
      else { prompts.log.error(`Failed (HTTP ${res.status})`); process.exitCode = 1 }
      prompts.outro("Done")
      return
    }

    prompts.log.warn(
      ref.noun === "note"
        ? `Widening a note is: iris atlas make-public ${ref.id} --force`
        : `Widening a playbook is: iris playbook publish ${ref.id} --scope public --force`,
    )
    prompts.outro("Done")
  },
})

export const PlatformExposureCommand = productCommand({
  name: "exposure",
  aliases: ["reach", "sharing"],
  purpose: "who can reach your pages, notes and playbooks — and what it takes to change that",
  keywords: ["public", "private", "share", "gated", "unlisted", "visibility", "audit", "expose", "reach"],
  subcommands: [ShowCmd, AuditCmd, NarrowCmd, WidenCmd],
})
